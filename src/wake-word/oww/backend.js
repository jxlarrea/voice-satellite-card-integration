/**
 * openWakeWord backend that mirrors the public interface of
 * MicroWakeWordInference so WakeWordManager can dispatch to either
 * engine with minimal branching.
 *
 * Per-chunk output shape (matches MicroWakeWordInference.processChunk):
 *   { detected, score, vadScore, model, cutoff, rms }
 *
 * Differences from MWW worth knowing about:
 *   - vadScore is always 0 (OWW has no separate VAD head).
 *   - rms is computed from the raw chunk so the tester meter still works.
 *   - OWW's classifier output is a frame-level probability and we
 *     threshold it directly.
 */

import { OwwInference, CHUNK_SAMPLES } from './inference.js';
import { loadOwwSharedModels, loadOwwClassifier } from './models.js';
import { acquireWebGpuDevice, WebGpuUnavailableError } from './gpu/device.js';
import { GpuModelRunner } from './gpu/runner.js';

export { WebGpuUnavailableError };

const DEFAULT_CUTOFF = 0.5;
// Energy gate - same threshold table the microWakeWord backend uses.
// Keying off the same Sensitivity select as MWW means the user gets
// consistent gate behavior regardless of which engine is active.  RMS
// is computed on the raw ±1 worklet input.  Higher thresholds = more
// aggressive silence filtering.
const ENERGY_THRESHOLDS = {
  'Slightly sensitive':   { sleep: 0.10,  wake: 0.12  },
  'Moderately sensitive': { sleep: 0.05,  wake: 0.06  },
  'Very sensitive':       { sleep: 0.02,  wake: 0.025 },
};
const DEFAULT_ENERGY = ENERGY_THRESHOLDS['Moderately sensitive'];
const SLEEP_CHUNKS = 30; // ~2.4 s of silence before sleeping
// Minimum gap between successive triggers - prevents one extended
// utterance from firing multiple times.  Same value microWakeWord uses.
const COOLDOWN_MS = 2000;
// Detection uses the current frame-level OWW probability, matching
// upstream openWakeWord.  Averaging before thresholding made low-SNR/noisy
// wake words miss when they produced one strong frame surrounded by weaker
// frames.
// Buffer recent raw audio while the optional energy gate sleeps.  MWW
// keeps feature lookback for the same reason: the chunk that wakes the
// gate may already be partway through the wake phrase.
const SLEEP_BUFFER_CHUNKS = 8; // ~640 ms
// Borderline-confirmation gate, mirrored from microWakeWord
// (micro-inference.js _shouldTriggerKeyword).  Current frame scores
// strictly above (cutoff + margin) fire immediately.  Scores in the
// narrow (cutoff, cutoff + margin] band must repeat within
// BORDERLINE_CONFIRM_WINDOW_MS to fire - otherwise the candidate is
// dropped.  Catches the "ok google" → ok_nabu pattern where one
// chunk's score grazes cutoff before fading.
const BORDERLINE_CONFIRM_MARGIN = 0.03;
const BORDERLINE_CONFIRM_WINDOW_MS = 750;
export class OwwBackend {
  /**
   * @param {OwwInference} inference
   * @param {object} log - logger with .log(category, message)
   * @param {object<string, number>} cutoffs - per-keyword threshold map
   */
  constructor(inference, log, cutoffs, energyGateEnabled = true, sensitivityLabel = 'Moderately sensitive') {
    this._inference = inference;
    this._log = log;
    this._cutoffs = { ...cutoffs };
    this._latestRms = 0;
    // Wired to the user-facing "Wake word noise gate" switch.  When off,
    // we run inference on every chunk regardless of RMS - matches the
    // semantics of the same switch on the microWakeWord path.
    this._energyGateEnabled = !!energyGateEnabled;
    // Per-instance RMS thresholds, keyed off the same Sensitivity select
    // MWW uses so flipping engines keeps the gate behavior consistent.
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    this._sleepRms = energy.sleep;
    this._wakeRms = energy.wake;
    // Active set of keywords whose probabilities count toward `detected`.
    // OWW classifiers are baked in at OwwInference construction time, so
    // "remove" doesn't unload - it just stops considering that keyword's
    // score as a possible trigger.  Used by stop-word standby + stop-only
    // mode in WakeWordManager.
    this._activeKeywords = new Set(Object.keys(cutoffs));
    this._keywordNames = Object.keys(cutoffs);
    // Latest per-keyword classifier scores from the most recent processChunk.
    // The panel tester polls this to draw its probability chart.
    this._latestScores = {};
    // Per-keyword state for borderline confirmation.
    // Trigger logic uses the current frame score.
    this._scoreWindows = {};
    for (const name of this._keywordNames) {
      this._scoreWindows[name] = this._makeWindow();
    }
    // Last accepted-trigger timestamp (any keyword).  Used to enforce
    // COOLDOWN_MS so a single utterance can't fire repeatedly.
    this._lastTriggerAt = 0;
    // Energy-gate state.  Default to "sleeping" so the first burst of
    // real audio takes the wake path (cheap on/off transition logged
    // once).  _silentChunks counts consecutive low-RMS chunks; we sleep
    // when it crosses SLEEP_CHUNKS and wake immediately on RMS ≥ WAKE_RMS.
    this._sleeping = true;
    this._silentChunks = SLEEP_CHUNKS;
    this._sleepBuf = [];
    for (let i = 0; i < SLEEP_BUFFER_CHUNKS; i++) {
      this._sleepBuf.push(new Float32Array(CHUNK_SAMPLES));
    }
    this._sleepBufHead = 0;
    this._sleepBufLen = 0;
  }

  /**
   * Async factory - loads shared models + classifiers and assembles an
   * OwwInference wrapped in a backend.
   *
   * @param {Array<{name: string, cutoff: number}>} keywordConfigs
   * @param {object} log
   */
  static async create(keywordConfigs, log, energyGateEnabled = true, sensitivityLabel = 'Moderately sensitive') {
    if (!keywordConfigs?.length) {
      throw new Error('OwwBackend.create needs at least one keyword');
    }

    // WebGPU is required.  The pure-JS embedding model takes ~80 ms per
    // chunk on a Pixel-class tablet - over our 80 ms real-time budget.
    // Devices without WebGPU support can't sustain OWW; the manager
    // surfaces a toast suggesting microWakeWord instead.
    const device = await acquireWebGpuDevice();

    const shared = await loadOwwSharedModels();
    const classifiers = {};
    const cutoffs = {};
    for (const cfg of keywordConfigs) {
      classifiers[cfg.name] = await loadOwwClassifier(cfg.name);
      cutoffs[cfg.name] = typeof cfg.cutoff === 'number' ? cfg.cutoff : DEFAULT_CUTOFF;
    }

    // Build GPU runners for the heavy stages.  Embedding is dominant
    // (~80 ms CPU JS on Pixel tablet → 5 ms GPU); mel spec is the
    // secondary cost (~28 ms → 5 ms).  Classifiers stay on CPU
    // (already <1 ms each, GPU overhead would dominate).
    const tGpu = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now() : Date.now();
    log?.log?.('wake-word', 'OWW: building GPU embedding pipeline...');
    const embeddingGpuRunner = await GpuModelRunner.create(device, shared.embedding);
    log?.log?.('wake-word', 'OWW: building GPU mel-spec pipeline...');
    const melspectrogramGpuRunner = await GpuModelRunner.create(device, shared.melspectrogram);
    const gpuMs = ((typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now() : Date.now()) - tGpu;
    log?.log?.('wake-word', `OWW: GPU pipelines ready (${gpuMs.toFixed(0)} ms total)`);

    const inference = new OwwInference({
      melspectrogram: shared.melspectrogram,
      embedding: shared.embedding,
      classifiers,
      embeddingGpuRunner,
      melspectrogramGpuRunner,
    });
    // The constructor kicks off the noise-warmup loop; await it here so
    // the very first processChunk call doesn't race with the GPU warmup.
    await inference.ready;

    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    log?.log?.(
      'wake-word',
      `OWW backend ready: ${Object.keys(classifiers).join(', ')} `
      + `(energy gate ${energyGateEnabled ? 'on' : 'off'}, `
      + `sensitivity=${sensitivityLabel}, sleep=${energy.sleep} wake=${energy.wake})`,
    );
    return new OwwBackend(inference, log, cutoffs, energyGateEnabled, sensitivityLabel);
  }

  /** Build a fresh per-keyword sliding-window + pending-confirm record. */
  _makeWindow() {
    return {
      pendingConfirm: false,
      pendingConfirmAt: 0,
      pendingConfirmScore: 0,
    };
  }

  /** Compute per-chunk RMS (in the input's native ±1 range) for the meter. */
  _rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  _bufferSleepingChunk(samples) {
    const slot = this._sleepBuf[this._sleepBufHead];
    slot.set(samples);
    this._sleepBufHead = (this._sleepBufHead + 1) % SLEEP_BUFFER_CHUNKS;
    if (this._sleepBufLen < SLEEP_BUFFER_CHUNKS) this._sleepBufLen++;
  }

  _clearSleepBuffer() {
    this._sleepBufHead = 0;
    this._sleepBufLen = 0;
  }

  _sleepBufferOrdered() {
    const out = [];
    let idx = (this._sleepBufHead - this._sleepBufLen + SLEEP_BUFFER_CHUNKS) % SLEEP_BUFFER_CHUNKS;
    for (let i = 0; i < this._sleepBufLen; i++) {
      out.push(this._sleepBuf[idx]);
      idx = (idx + 1) % SLEEP_BUFFER_CHUNKS;
    }
    return out;
  }

  /**
   * Process one 1280-sample chunk of normalized ±1 float32 audio
   * (the format coming out of the AudioWorklet).  Internally we scale
   * by 32768 to match openWakeWord's training-time input range - the
   * mel spec model was trained on raw int16 PCM cast to float32, so
   * feeding ±1 directly underflows the calibrated convolution kernels.
   *
   * Returns the same shape MicroWakeWordInference uses so WakeWordManager
   * can consume both engines via one code path.
   */
  async processChunk(samples) {
    if (samples.length !== CHUNK_SAMPLES) {
      throw new Error(`OWW chunk must be ${CHUNK_SAMPLES} samples, got ${samples.length}`);
    }
    const rms = this._energyGateEnabled ? this._rms(samples) : null;
    if (rms !== null) this._latestRms = rms;

    // Energy gate: hysteresis-based silence skip.  Saves the entire
    // mel + embedding + classifier pipeline (~25 ms per chunk) when
    // nothing is being said.  Crossing WAKE_RMS ends sleep immediately;
    // we re-enter sleep only after SLEEP_CHUNKS consecutive sub-SLEEP
    // chunks, so a brief noise burst won't churn state.  Only active
    // when the user-facing "Wake word noise gate" switch is on.
    if (this._energyGateEnabled) {
      if (this._sleeping) {
        if (rms >= this._wakeRms) {
          this._sleeping = false;
          this._silentChunks = 0;
          this._log?.log?.(
            'wake-word',
            `OWW wake - inference resumed (rms=${rms.toFixed(4)}, buffered=${this._sleepBufLen} chunks)`,
          );
        } else {
          this._bufferSleepingChunk(samples);
          // Stay asleep - return a no-detection result.  perModelScores
          // intentionally stays empty so the panel chart visibly idles
          // (the fallback in getLatestSmoothedProbability returns 0).
          this._latestScores = {};
          return {
            detected: false,
            score: 0,
            vadScore: 0,
            model: null,
            cutoff: 0,
            rms,
            triggerType: null,
            perModelScores: {},
          };
        }
      } else {
        // Hysteresis while awake: any chunk *not* loud enough to count
        // as speech (rms < wakeRms) ticks the silence counter; only
        // chunks at or above wakeRms reset it.  Without this, ambient
        // noise sitting between sleepRms and wakeRms would never trigger
        // sleep and the energy gate would stay perpetually open.
        if (rms < this._wakeRms) {
          this._silentChunks++;
          if (this._silentChunks >= SLEEP_CHUNKS) {
            this._sleeping = true;
            this._log?.log?.('wake-word', `OWW sleep - inference paused (rms=${rms.toFixed(4)})`);
          }
        } else {
          this._silentChunks = 0;
        }
      }
    }

    if (this._energyGateEnabled && this._sleepBufLen > 0) {
      const replay = this._sleepBufferOrdered();
      this._clearSleepBuffer();
      for (const buffered of replay) {
        const replayResult = await this._processInferenceChunk(buffered, this._rms(buffered));
        if (replayResult.detected) return replayResult;
      }
    }

    return this._processInferenceChunk(samples, rms);
  }

  async _processInferenceChunk(samples, rms) {
    // Scale ±1 float32 to int16 range for the OWW pipeline.  Use a
    // pre-allocated scratch buffer so we don't churn the GC every chunk.
    if (!this._scaledChunk) this._scaledChunk = new Float32Array(CHUNK_SAMPLES);
    const scaled = this._scaledChunk;
    if (rms === null) {
      let sumSq = 0;
      for (let i = 0; i < CHUNK_SAMPLES; i++) {
        const sample = samples[i];
        sumSq += sample * sample;
        scaled[i] = sample * 32768;
      }
      rms = Math.sqrt(sumSq / CHUNK_SAMPLES);
      this._latestRms = rms;
    } else {
      for (let i = 0; i < CHUNK_SAMPLES; i++) scaled[i] = samples[i] * 32768;
    }

    const { probs } = await this._inference.processChunk(scaled, {
      activeKeywords: this._activeKeywords,
    });
    this._latestScores = probs;

    // Two passes over the active keywords on their current frame scores:
    //   1. Track the leader (highest score) for display, even if no trigger
    //      fires - keeps the panel chart sensible during silence/idle.
    //   2. Run the borderline-confirm gate per keyword and pick the
    //      highest-scoring TRIGGERED one as the wake event.
    // Inactive keywords still run through the shared pipeline but don't
    // count toward leader or trigger.
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now() : Date.now();
    let leaderName = null;
    let leaderScore = 0;
    let leaderCutoff = 0;
    let triggerName = null;
    let triggerScore = 0;
    let triggerCutoff = 0;
    let triggerType = null;
    for (const name in probs) {
      const p = probs[name];
      if (!this._activeKeywords.has(name)) continue;
      const w = this._scoreWindows[name];
      if (!w) continue;
      const cutoff = this._cutoffs[name] ?? DEFAULT_CUTOFF;
      if (p > leaderScore) {
        leaderName = name;
        leaderScore = p;
        leaderCutoff = cutoff;
      }
      const tt = this._gateBorderline(w, p, cutoff, name, now);
      if (tt && p > triggerScore) {
        triggerName = name;
        triggerScore = p;
        triggerCutoff = cutoff;
        triggerType = tt;
      }
    }

    let detected = false;
    const cooldownActive = (now - this._lastTriggerAt) < COOLDOWN_MS;
    if (triggerName) {
      detected = !cooldownActive;
      if (detected) this._lastTriggerAt = now;
    }

    return {
      detected,
      score: triggerName ? triggerScore : leaderScore,
      vadScore: 0,
      model: triggerName || leaderName,
      cutoff: triggerName ? triggerCutoff : leaderCutoff,
      rms,
      triggerType,
      // Per-keyword raw OWW scores.  The worker proxy caches this for
      // the tester/chart; for OWW this is the value that actually drives
      // detection, unlike MWW where the model's own sliding mean is used.
      perModelScores: probs,
    };
  }

  /**
   * Per-keyword borderline-confirm gate, run on the current frame score.
   *   - score <= cutoff               → no trigger, clear pending
   *   - score >= cutoff + margin      → 'immediate', clear pending
   *   - cutoff < score < cutoff+margin (borderline):
   *       * if a fresh pending exists for this keyword → 'confirmed', clear
   *       * else park as pending, no trigger
   *   - borderline + stale pending   → drop pending, no trigger
   * Mirrors microWakeWord (micro-inference.js _shouldTriggerKeyword).
   */
  _gateBorderline(w, score, cutoff, name, now) {
    if (score <= cutoff) {
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmScore = 0;
      return null;
    }
    if (score >= cutoff + BORDERLINE_CONFIRM_MARGIN) {
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmScore = 0;
      return 'immediate';
    }
    // Borderline band
    if (w.pendingConfirm && (now - w.pendingConfirmAt) <= BORDERLINE_CONFIRM_WINDOW_MS) {
      const firstScore = w.pendingConfirmScore;
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmScore = 0;
      this._log?.log?.(
        'wake-word',
        `OWW borderline confirm passed: ${name} first=${firstScore.toFixed(3)} second=${score.toFixed(3)} cutoff=${cutoff.toFixed(3)}`,
      );
      return 'confirmed';
    }
    if (w.pendingConfirm) {
      this._log?.log?.(
        'wake-word',
        `OWW borderline confirm expired: ${name} second=${score.toFixed(3)} cutoff=${cutoff.toFixed(3)}`,
      );
    } else {
      this._log?.log?.(
        'wake-word',
        `OWW borderline candidate parked: ${name} score=${score.toFixed(3)} cutoff=${cutoff.toFixed(3)}`,
      );
    }
    w.pendingConfirm = true;
    w.pendingConfirmAt = now;
    w.pendingConfirmScore = score;
    return null;
  }

  /** Update per-keyword detection thresholds. */
  updateThresholds(thresholds) {
    for (const t of thresholds) {
      if (typeof t.threshold === 'number') this._cutoffs[t.name] = t.threshold;
    }
  }

  /**
   * Re-include a keyword in the "active for detection" set.  Mirrors
   * MicroWakeWordInference.addKeyword so WakeWordManager's
   * enableStopModel / disableStopModel paths work for both engines.
   * For OWW the classifier must already be loaded by the constructor -
   * this only touches the active set + cutoff.
   * @param {{name: string, cutoff?: number}} cfg
   */
  addKeyword(cfg) {
    if (!cfg?.name) return;
    if (typeof cfg.cutoff === 'number') this._cutoffs[cfg.name] = cfg.cutoff;
    this._activeKeywords.add(cfg.name);
    if (!this._keywordNames.includes(cfg.name)) this._keywordNames.push(cfg.name);
    if (!this._scoreWindows[cfg.name]) {
      this._scoreWindows[cfg.name] = this._makeWindow();
    }
  }

  /** Suppress a keyword's score from counting toward detected. */
  removeKeyword(name) {
    this._activeKeywords.delete(name);
  }

  /**
   * MWW exposes `_keywords` as an array of {name, cutoff, ...} for
   * introspection in stop-only mode (see WakeWordManager.enableStopModel
   * around line 992).  Mirror that shape so the same code path works
   * for OWW without branching on engine.
   */
  get _keywords() {
    return [...this._activeKeywords].map((name) => ({
      name,
      cutoff: this._cutoffs[name],
      // Stub fields so MWW's restore-suspended-keyword code (which spreads
      // these into addKeyword({...})) doesn't choke; OWW's addKeyword
      // ignores everything except name + cutoff.
      slidingWindow: 1,
      stepSize: 1,
      inputScale: 1,
      inputZeroPoint: 0,
    }));
  }

  /**
   * Latest OWW frame score for `keywordName` (or the highest active score
   * if no name is supplied).  For OWW this is what trigger logic compares
   * against the cutoff; MWW's same-named method returns its window mean.
   */
  getLatestSmoothedProbability(keywordName) {
    const scores = this._latestScores || {};
    if (keywordName === undefined) {
      let best = 0;
      for (const name in scores) {
        const score = scores[name];
        if (this._activeKeywords.has(name) && score > best) best = score;
      }
      return best;
    }
    return scores[keywordName] ?? 0;
  }

  // The MWW interface has updateEnergyThresholds + reset for sleep/wake
  // gating; OWW doesn't have an equivalent gate built in, so these are
  // no-ops.  Kept on the prototype so WakeWordManager doesn't have to
  // branch on engine before calling them.
  /**
   * Re-tune the energy gate to a new sensitivity label.  Wired to live
   * changes of the Wake-word Sensitivity select via WakeWordManager
   * (mirrors MWW's MicroWakeWordInference.updateEnergyThresholds).
   */
  updateEnergyThresholds(sensitivityLabel) {
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    this._sleepRms = energy.sleep;
    this._wakeRms = energy.wake;
    this._log?.log?.(
      'wake-word',
      `OWW energy gate retuned: sensitivity=${sensitivityLabel} sleep=${energy.sleep} wake=${energy.wake}`,
    );
  }
  reset() {
    this._latestScores = {};
    this._lastTriggerAt = 0;
    for (const name of this._keywordNames) {
      const w = this._scoreWindows[name];
      if (!w) continue;
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmScore = 0;
    }
    // Reset gate to sleeping so the next chunk has to cross the wake
    // threshold before inference resumes - prevents post-pause stale
    // chunks (e.g. residual room noise) from triggering before fresh
    // user audio actually arrives.
    this._sleeping = true;
    this._silentChunks = SLEEP_CHUNKS;
    this._clearSleepBuffer();
    // Critical: clear the inference's internal audio history + 16-frame
    // feature buffer.  Without this the classifier sees stale embeddings
    // from around the previous wake-word detection and re-fires within
    // immediately after resume - the post-STT self-trigger loop the user
    // hits when STT errors out.
    this._inference?.reset?.();
  }

  /**
   * Live-toggle the energy gate.  When turned off, force-wake any
   * currently-sleeping state so inference resumes on the next chunk.
   */
  setEnergyGateEnabled(enabled) {
    const prev = this._energyGateEnabled;
    this._energyGateEnabled = !!enabled;
    if (prev !== this._energyGateEnabled) {
      this._sleeping = false;
      this._silentChunks = 0;
      this._clearSleepBuffer();
      this._log?.log?.(
        'wake-word',
        `OWW energy gate ${this._energyGateEnabled ? 'enabled' : 'disabled'}`,
      );
    }
  }

  /** Free references so GC can reclaim the inference state. */
  destroy() {
    this._inference?.destroy?.();
    this._inference = null;
  }

  /** Latest RMS (read by the tester meter). */
  get latestRms() {
    return this._latestRms;
  }
}
