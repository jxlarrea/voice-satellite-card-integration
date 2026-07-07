/**
 * vsWakeWord backend that mirrors the public interface of
 * MicroWakeWordInference / OwwBackend so WakeWordManager can dispatch
 * to either engine without engine-specific branching.
 *
 * Per-chunk output shape (matches OwwBackend.processChunk):
 *   { detected, score, vadScore, model, cutoff, rms, windowRms, triggerType, perModelScores }
 *
 * Differences from OWW worth knowing about:
 *   - VWW models are single-stage (no shared mel + embedding); each
 *     keyword runs its own ONNX graph on the GPU.
 *   - No int16 scaling - VWW was trained on +/-1 audio so we feed the
 *     worklet samples through unmodified.
 *   - No "warmup" required (OWW primes a 16-embedding ring with
 *     synthetic noise; VWW just waits for the first 1 s of real audio).
 */

import { VwwInference, CHUNK_SAMPLES } from './inference.js';
import { VwwEmbeddingInference } from './embedding-inference.js';
import { loadVwwModel } from './models.js';
import { acquireWebGpuDevice, WebGpuUnavailableError } from './gpu/device.js';
import { clearVwwStartupBreadcrumb, checkpointVwwStartup } from './startup-breadcrumb.js';
import { createJsMicroFrontend } from '../micro-frontend-js/index.js';

export { WebGpuUnavailableError };

const DEFAULT_CUTOFF = 0.6;

// Energy-gate thresholds keyed off the same Sensitivity select MWW / OWW
// use, so the user gets consistent gate behavior across engines.  RMS is
// computed on the raw +/-1 worklet input - identical to OWW.
const ENERGY_THRESHOLDS = {
  'Slightly sensitive':   { sleep: 0.10,  wake: 0.12  },
  'Moderately sensitive': { sleep: 0.05,  wake: 0.06  },
  'Very sensitive':       { sleep: 0.02,  wake: 0.025 },
};
const DEFAULT_ENERGY = ENERGY_THRESHOLDS['Moderately sensitive'];

// Sensitivity -> CTC matched-confidence gate scaling.  Deployed per-target
// confidence gates are calibrated between the measured forge band and the
// real-clip confidence floor, which sit ~10-20% apart, so one notch is
// +/-10%: 'Slightly' raises gates toward the real floor (fewer FPs, trims
// only the faintest wakes), 'Very' lowers them toward the forge band
// (catches fainter single-window wakes, admits marginal forges).  Stop
// classifiers get a gentler +/-5% notch, mirroring the OWW/MWW stop
// tables.  The global min_matched_confidence scales along with the
// per-target gates (deployed manifests set it to the lowest calibrated
// gate, so holding it fixed would neutralize 'Very').  required_hits,
// edit distance, anchors, and trail tolerance are deliberately NOT scaled:
// those are measured cliffs, not dials (hits=2 collapses degraded-audio
// recall; ed changes admit whole confusable families).
const VWW_SENSITIVITY_CONF_FACTORS = {
  'Slightly sensitive':   1.10,
  'Moderately sensitive': 1.00,
  'Very sensitive':       0.90,
};
const VWW_STOP_SENSITIVITY_CONF_FACTORS = {
  'Slightly sensitive':   1.05,
  'Moderately sensitive': 1.00,
  'Very sensitive':       0.95,
};
const SLEEP_CHUNKS = 30;        // ~2.4 s of silence before sleeping
const COOLDOWN_MS = 2000;       // matches OWW / MWW so triggers don't cascade
const SLEEP_BUFFER_CHUNKS = 13; // ~1.04 s - one full window + a couple chunks
const HARD_SILENCE_VETO_RMS = 0.002;

// Borderline confirmation: same shape as OWW so a freshly-trained VWW
// model that produces a single-frame TV spike still gets filtered.
const BORDERLINE_CONFIRM_MARGIN = 0.03;
const WAKE_CONFIRM_MIN_FRAMES = 1;
const BORDERLINE_CONFIRM_WINDOW_FRAMES = 8;
// Effective single-frame bypass = max(cutoff + MARGIN, MIN_SCORE).
// At the default 0.6 cutoff that lands at 0.93 - tightened from 0.85
// after observing a live FP at score=0.918 on TV speech.  Clean wake-
// word utterances in the field peak around 0.95-0.97 on v3 so they
// still bypass; sub-0.93 borderline spikes now route through the
// confirmation gate.
const HIGH_CONFIDENCE_BYPASS_MARGIN = 0.25;
const HIGH_CONFIDENCE_BYPASS_MIN_SCORE = 0.93;
const BORDERLINE_CONFIRM_ENABLED = true;

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function runtimeModeFromManifest(cfg) {
  const requiredHits = cfg && typeof cfg.required_hits === 'number' && cfg.required_hits > 0
    ? Math.max(1, Math.floor(cfg.required_hits))
    : 0;
  const targetRequiredHits = Array.isArray(cfg?.target_required_hits)
    ? cfg.target_required_hits.map((value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : null;
      })
    : null;
  const cooldown = cfg && typeof cfg.cooldown_ms === 'number' && cfg.cooldown_ms > 0
    ? cfg.cooldown_ms
    : COOLDOWN_MS;
  const highConfidenceBypass = cfg && typeof cfg.high_confidence_bypass === 'number'
    && Number.isFinite(cfg.high_confidence_bypass)
    ? cfg.high_confidence_bypass
    : null;
  const highConfidenceBypassMinHits = cfg && typeof cfg.high_confidence_bypass_min_hits === 'number'
    && Number.isFinite(cfg.high_confidence_bypass_min_hits)
    ? Math.max(1, Math.floor(cfg.high_confidence_bypass_min_hits))
    : 1;
  const hitMode = cfg?.hit_mode === 'consecutive' ? 'consecutive' : 'consecutive';
  const minWindowRmsRaw = Number(cfg?.min_window_rms);
  const minWindowRms = Number.isFinite(minWindowRmsRaw) && minWindowRmsRaw > 0
    ? minWindowRmsRaw
    : HARD_SILENCE_VETO_RMS;
  const rawSequenceGate = cfg?.cnn_sequence_gate;
  const cnnSequenceGate = (
    rawSequenceGate
    && typeof rawSequenceGate === 'object'
    && rawSequenceGate.enabled !== false
  ) ? {
      enabled: true,
      wakeIndex: Number.isFinite(Number(rawSequenceGate.wake_index)) ? Number(rawSequenceGate.wake_index) : 0,
      prefixIndex: Number.isFinite(Number(rawSequenceGate.prefix_index)) ? Number(rawSequenceGate.prefix_index) : 1,
      completionIndex: Number.isFinite(Number(rawSequenceGate.completion_index)) ? Number(rawSequenceGate.completion_index) : 2,
      prefixThreshold: Number.isFinite(Number(rawSequenceGate.prefix_threshold)) ? Number(rawSequenceGate.prefix_threshold) : 0.5,
      completionThreshold: Number.isFinite(Number(rawSequenceGate.completion_threshold)) ? Number(rawSequenceGate.completion_threshold) : 0.5,
    } : null;
  return requiredHits > 0
    ? {
        mode: 'counter',
        requiredHits,
        targetRequiredHits,
        hitMode,
        highConfidenceBypass,
        // Manifest-declared bypass, kept pristine so the sensitivity
        // scale is re-applied from the base on every retune.
        baseHighConfidenceBypass: highConfidenceBypass,
        highConfidenceBypassMinHits,
        minWindowRms,
        cnnSequenceGate,
        cooldownMs: cooldown,
      }
    : { mode: 'borderline', minWindowRms, cnnSequenceGate, cooldownMs: cooldown };
}

function evaluateCnnSequenceGate(mode, cnnInfo) {
  const gate = mode?.cnnSequenceGate;
  if (!gate) return { enabled: false, passed: true };
  const prefixScore = Number(cnnInfo?.prefix);
  const completionScore = Number(cnnInfo?.completion);
  const passed = (
    Number.isFinite(prefixScore)
    && Number.isFinite(completionScore)
    && prefixScore >= gate.prefixThreshold
    && completionScore >= gate.completionThreshold
  );
  return {
    enabled: true,
    passed,
    prefixScore,
    completionScore,
    prefixThreshold: gate.prefixThreshold,
    completionThreshold: gate.completionThreshold,
  };
}

function requiredHitsForTarget(mode, targetIndex) {
  const fallback = Math.max(1, Math.floor(mode?.requiredHits || 1));
  if (!Number.isInteger(targetIndex) || targetIndex < 0) return fallback;
  const hits = mode?.targetRequiredHits;
  const targetHits = Array.isArray(hits) ? hits[targetIndex] : null;
  return Number.isFinite(targetHits) ? targetHits : fallback;
}

function bypassMinHitsForTarget(mode, targetIndex, requiredHits) {
  const fallback = Math.max(1, Math.floor(mode?.highConfidenceBypassMinHits || 1));
  if (!Number.isInteger(targetIndex) || targetIndex < 0) return fallback;
  const hits = mode?.targetRequiredHits;
  const targetHits = Array.isArray(hits) ? hits[targetIndex] : null;
  if (Number.isFinite(targetHits) && targetHits > mode.requiredHits) {
    return Math.max(fallback, requiredHits);
  }
  return fallback;
}

function formatRuntimeStatus(status, triggerType = null) {
  if (!status || status.mode !== 'counter') return '';
  const parts = [];
  if (triggerType) parts.push(`runtime_type=${triggerType}`);
  if (Number.isFinite(status.hits) && Number.isFinite(status.requiredHits)) {
    parts.push(`runtime_hits=${status.hits}/${status.requiredHits}`);
  }
  if (Number.isInteger(status.matchedTargetIndex) && status.matchedTargetIndex >= 0) {
    parts.push(`runtime_target=${status.matchedTargetIndex + 1}`);
  }
  if (Number.isInteger(status.matchedTargetGroupIndex) && status.matchedTargetGroupIndex >= 0) {
    parts.push(`runtime_group=${status.matchedTargetGroupIndex + 1}`);
  }
  if (typeof status.highConfidenceBypass === 'number' && Number.isFinite(status.highConfidenceBypass)) {
    parts.push(`runtime_bypass=${status.highConfidenceBypass.toFixed(2)}`);
  }
  if (
    Number.isFinite(status.highConfidenceBypassMinHits)
    && Number.isFinite(status.hits)
    && status.highConfidence === true
  ) {
    parts.push(`runtime_bypass_hits=${status.hits}/${status.highConfidenceBypassMinHits}`);
  }
  if (status.bypassed === true) parts.push('runtime_bypassed=true');
  if (status.grouped === true) parts.push('runtime_grouped=true');
  if (status.cnnSequenceGate === true) {
    const p = Number(status.cnnPrefixScore);
    const c = Number(status.cnnCompletionScore);
    if (Number.isFinite(p)) parts.push(`cnn_prefix=${p.toFixed(3)}`);
    if (Number.isFinite(c)) parts.push(`cnn_completion=${c.toFixed(3)}`);
    if (status.cnnSequencePassed === false) parts.push('cnn_sequence=blocked');
    else if (status.cnnSequencePassed === true) parts.push('cnn_sequence=passed');
  }
  return parts.join(' ');
}

export class VwwBackend {
  constructor(inference, log, cutoffs, energyGateEnabled = true, sensitivityLabel = 'Moderately sensitive', enableTimings = false, runtime = {}, stopClassifiers = {}) {
    this._inference = inference;
    this._log = log;
    this._cutoffs = { ...cutoffs };
    this._enableTimings = enableTimings === true;
    this._latestRms = 0;
    this._energyGateEnabled = !!energyGateEnabled;
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    this._sleepRms = energy.sleep;
    this._wakeRms = energy.wake;
    this._activeKeywords = new Set(Object.keys(cutoffs));
    this._keywordNames = Object.keys(cutoffs);
    this._latestScores = {};
    // Per-keyword stop-classifier flag.  Built from each model's
    // manifest at load time (manifest.stop_classifier: true).  Used
    // to give VWW stop classifiers (e.g. 'ok_stop' loaded from
    // ok_stop.onnx) the same "fire immediately on high confidence,
    // skip the borderline-confirm gate" treatment that OWW's 'stop'
    // gets.  Hardcoding `name === 'stop'` would only work for OWW.
    this._stopClassifiers = { ...stopClassifiers };

    // Per-keyword runtime config from each model's manifest.  When a
    // manifest specifies runtime.required_hits, that keyword runs in
    // simple N-consecutive-frames mode instead of the borderline-
    // confirm gate.  Per-keyword so a single backend can mix counter
    // and borderline keywords without branching at chunk time.
    this._runtimeMode = {};
    this._hitCounters = {};
    this._runtimeStatus = {};
    for (const name of this._keywordNames) {
      this._runtimeMode[name] = runtimeModeFromManifest(runtime?.[name]);
      this._hitCounters[name] = this._makeHitCounter();
      this._runtimeStatus[name] = this._makeRuntimeStatus(name, 0, false);
    }

    // Apply the sensitivity setting to the CTC matcher confidence
    // gates (energy thresholds above only pre-gate the audio).
    this._applySensitivityConfScale(sensitivityLabel);

    // Per-keyword borderline-confirmation state (only consulted for
    // keywords whose runtimeMode is 'borderline').
    this._scoreWindows = {};
    for (const name of this._keywordNames) {
      this._scoreWindows[name] = this._makeWindow();
    }
    this._lastTriggerAt = 0;
    this._confirmFrameIndex = 0;
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
   * Async factory.  Acquires a WebGPU device, loads every keyword's
   * .onnx + .json, compiles GPU pipelines, and wraps it all in a backend.
   *
   * @param {Array<{name: string, cutoff?: number}>} keywordConfigs
   * @param {object} log
   * @param {boolean} energyGateEnabled
   * @param {string} sensitivityLabel
   * @param {boolean} enableTimings
   */
  static async create(keywordConfigs, log, energyGateEnabled = true, sensitivityLabel = 'Moderately sensitive', enableTimings = false, options = {}) {
    if (!keywordConfigs?.length) {
      throw new Error('VwwBackend.create needs at least one keyword');
    }
    await checkpointVwwStartup('backend:create', {
      models: keywordConfigs.map((cfg) => cfg.name),
    });
    // WebGPU is mandatory for vsWakeWord too (matches OWW). Devices
    // without WebGPU surface the same toast suggesting microWakeWord.
    const { device, compatibilityTier } = await acquireWebGpuDevice();
    if (compatibilityTier) {
      log?.log?.(
        'wake-word',
        'WebGPU compatibility-tier adapter (GLES-backed) acquired',
      );
    }

    // Load every keyword's manifest first so we can group them by
    // architecture.  All keywords sharing the same architecture use a
    // single inference instance (cnn or embedding); mixed architecture
    // gets one inference per arch.
    const entries = {};
    for (const cfg of keywordConfigs) {
      await checkpointVwwStartup('model:load', { model: cfg.name });
      entries[cfg.name] = await loadVwwModel(cfg.name);
    }
    const archs = new Set(Object.values(entries).map(e => e.architecture));
    if (archs.size > 1) {
      throw new Error(
        `VWW backend does not yet support mixed architectures in one deployment: `
        + `${[...archs].join(', ')}.  Run separate slots per architecture.`,
      );
    }
    const architecture = [...archs][0];

    let inference;
    if (architecture === 'embedding') {
      // Use the first keyword's shared melspec/embedding ONNX (all
      // embedding-arch keywords share these via models.js cache).
      const firstEntry = entries[keywordConfigs[0].name];
      inference = new VwwEmbeddingInference({
        device,
        sharedMelspec: firstEntry.sharedMelspec,
        sharedEmbedding: firstEntry.sharedEmbedding,
        log,
        pipelineLog: options.pipelineLog === true,
        int8: options.int8,
      });
      await inference.ready;
    } else {
      // CNN and CTC use the same single-stage ONNX runner.  The feature
      // frontend is selected from the manifest so microfrontend CNNs do
      // not accidentally receive log-mel tensors.
      const firstEntry = entries[keywordConfigs[0].name];
      const featureCfg = {
        ...(firstEntry.manifest?.feature_config || {}),
        format: firstEntry.manifest?.format,
        streaming_onnx: firstEntry.manifest?.streaming_onnx
          || firstEntry.manifest?.feature_config?.streaming_onnx,
        feature: firstEntry.manifest?.input?.feature
          || firstEntry.manifest?.feature_config?.feature
          || 'log_mel',
      };
      const microFrontend = featureCfg.feature === 'microfrontend'
        ? await createJsMicroFrontend()
        : null;
      inference = new VwwInference(device, featureCfg, {
        log,
        pipelineLog: options.pipelineLog === true,
        int8: options.int8,
        microFrontend,
      });
    }

    const cutoffs = {};
    const runtime = {};
    const stopClassifiers = {};
    for (const cfg of keywordConfigs) {
      const entry = entries[cfg.name];
      await checkpointVwwStartup('model:add-keyword', {
        model: cfg.name,
        architecture,
      });
      if (architecture === 'embedding') {
        // Classifier ONNX input shape carries T_emb (e.g. 9 for our 1.5s
        // training); fall back to manifest.input.shape[1] or default 9.
        const tEmb = entry.manifest?.input_shape?.[1]
          ?? entry.manifest?.input?.shape?.[1]
          ?? 9;
        await inference.addKeyword(cfg.name, entry.compiled, tEmb);
      } else if (architecture === 'ctc') {
        // CTC: pass the manifest.ctc block (vocab + wake_word_targets)
        // so VwwInference decodes the (T_out, V) output into 0/1.
        await inference.addKeyword(cfg.name, entry.compiled, entry.ctcConfig);
      } else {
        await inference.addKeyword(cfg.name, entry.compiled, null, entry.manifest);
      }
      const manifestCutoff = entry.manifest?.recommended_threshold;
      cutoffs[cfg.name] = typeof cfg.cutoff === 'number'
        ? cfg.cutoff
        : (typeof manifestCutoff === 'number' ? manifestCutoff : DEFAULT_CUTOFF);
      if (entry.manifest && typeof entry.manifest.runtime === 'object' && entry.manifest.runtime !== null) {
        runtime[cfg.name] = entry.manifest.runtime;
      }
      if (entry.manifest && entry.manifest.stop_classifier === true) {
        stopClassifiers[cfg.name] = true;
      }
    }
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    const modesDesc = keywordConfigs.map((c) => {
      const entry = entries[c.name];
      const r = runtime[c.name];
      if (r && typeof r.required_hits === 'number' && r.required_hits > 0) {
        const bypass = typeof r.high_confidence_bypass === 'number'
          ? `, bypass=${r.high_confidence_bypass.toFixed(1)}`
          : '';
        const bypassMinHits = typeof r.high_confidence_bypass_min_hits === 'number'
          ? `, bypass_hits=${Math.max(1, Math.floor(r.high_confidence_bypass_min_hits))}`
          : '';
        const targetHits = Array.isArray(r.target_required_hits)
          ? `, target_hits=[${r.target_required_hits.map((value) => {
              const n = Number(value);
              return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : '-';
            }).join(',')}]`
          : '';
        const targetMinConf = Array.isArray(entry.manifest?.ctc?.target_min_matched_confidence)
          ? `, target_min_conf=[${entry.manifest.ctc.target_min_matched_confidence.map((value) => {
              const n = Number(value);
              return Number.isFinite(n) ? n.toFixed(2) : '-';
            }).join(',')}]`
          : '';
        const targetMaxEd = Array.isArray(entry.manifest?.ctc?.target_max_edit_distance)
          ? `, target_max_ed=[${entry.manifest.ctc.target_max_edit_distance.map((value) => {
              const n = Number(value);
              return Number.isFinite(n) && n >= 0 ? Math.floor(n) : '-';
            }).join(',')}]`
          : '';
        return `${c.name}(c=${cutoffs[c.name].toFixed(3)}, hits=${r.required_hits}${targetHits}${targetMaxEd}${targetMinConf}${bypass}${bypassMinHits})`;
      }
      return `${c.name}(c=${cutoffs[c.name].toFixed(3)}, borderline)`;
    }).join(', ');
    log?.log?.(
      'wake-word',
      `VWW backend ready: ${modesDesc} `
      + `(energy gate ${energyGateEnabled ? 'on' : 'off'}, `
      + `sensitivity=${sensitivityLabel}, sleep=${energy.sleep} wake=${energy.wake}, `
      + `conf gate scale x${(VWW_SENSITIVITY_CONF_FACTORS[sensitivityLabel] ?? 1).toFixed(2)}`
      + `${compatibilityTier ? ', adapter=compat-tier' : ''})`,
    );
    clearVwwStartupBreadcrumb({
      models: keywordConfigs.map((cfg) => cfg.name),
      architecture,
    });
    return new VwwBackend(inference, log, cutoffs, energyGateEnabled, sensitivityLabel, enableTimings, runtime, stopClassifiers);
  }

  _makeHitCounter() {
    return {
      hits: 0,
      targetIndex: -1,
      targetGroupIndex: -1,
      grouped: false,
      requiredHits: null,
      bypassMinHits: null,
    };
  }

  _makeWindow() {
    return {
      pendingConfirm: false,
      pendingConfirmAt: 0,
      pendingConfirmFrame: -1,
      pendingConfirmScore: 0,
    };
  }

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

  _clearScoreWindows() {
    for (const name of this._keywordNames) {
      const w = this._scoreWindows[name];
      if (!w) continue;
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmFrame = -1;
      w.pendingConfirmScore = 0;
    }
    // Counter-mode state needs the same wipe on stream reset (sleep
    // wake / playback resume) so partial hit-counts before the pause
    // don't combine with frames after the pause to early-trigger.
    for (const name of this._keywordNames) {
      this._hitCounters[name] = this._makeHitCounter();
      this._runtimeStatus[name] = this._makeRuntimeStatus(name, 0, false);
    }
  }

  _resetStreamState() {
    this._latestScores = {};
    this._clearScoreWindows();
    this._inference?.reset?.();
  }

  async processChunk(samples) {
    if (samples.length !== CHUNK_SAMPLES) {
      throw new Error(`VWW chunk must be ${CHUNK_SAMPLES} samples, got ${samples.length}`);
    }
    const rms = this._energyGateEnabled ? this._rms(samples) : null;
    if (rms !== null) this._latestRms = rms;

    if (this._energyGateEnabled) {
      if (this._sleeping) {
        if (rms >= this._wakeRms) {
          this._sleeping = false;
          this._silentChunks = 0;
          this._log?.log?.(
            'wake-word',
            `VWW wake - inference resumed (rms=${rms.toFixed(4)}, buffered=${this._sleepBufLen} chunks)`,
          );
        } else {
          this._bufferSleepingChunk(samples);
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
        if (rms < this._wakeRms) {
          this._silentChunks++;
          if (this._silentChunks >= SLEEP_CHUNKS) {
            this._sleeping = true;
            this._resetStreamState();
            this._log?.log?.('wake-word', `VWW sleep - inference paused (rms=${rms.toFixed(4)})`);
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

  /**
   * Ingest one chunk's audio without running GPU inference - the
   * backpressure path for stale chunks (see the worker's processChunk
   * dispatch).  Keeps the energy-gate state machine and the inference
   * feature window in sync so the next full inference operates on a
   * gap-free, current window.
   */
  ingestChunk(samples) {
    if (samples.length !== CHUNK_SAMPLES) {
      throw new Error(`VWW chunk must be ${CHUNK_SAMPLES} samples, got ${samples.length}`);
    }
    if (typeof this._inference.ingestChunk !== 'function') {
      // Embedding-arch inference has no ingest fast-path - process fully.
      return this.processChunk(samples);
    }
    const rms = this._rms(samples);
    this._latestRms = rms;

    if (this._energyGateEnabled) {
      if (this._sleeping) {
        if (rms >= this._wakeRms) {
          this._sleeping = false;
          this._silentChunks = 0;
          this._log?.log?.(
            'wake-word',
            `VWW wake - inference resumed (rms=${rms.toFixed(4)}, buffered=${this._sleepBufLen} chunks)`,
          );
        } else {
          this._bufferSleepingChunk(samples);
          this._latestScores = {};
          return this._skippedResult(rms);
        }
      } else if (rms < this._wakeRms) {
        this._silentChunks++;
        if (this._silentChunks >= SLEEP_CHUNKS) {
          this._sleeping = true;
          this._resetStreamState();
          this._log?.log?.('wake-word', `VWW sleep - inference paused (rms=${rms.toFixed(4)})`);
        }
      } else {
        this._silentChunks = 0;
      }
      // Buffered sleep chunks must enter the window before this one so
      // the audio stays ordered and gap-free.
      if (this._sleepBufLen > 0) {
        const replay = this._sleepBufferOrdered();
        this._clearSleepBuffer();
        for (const buffered of replay) this._inference.ingestChunk(buffered);
      }
    }

    this._inference.ingestChunk(samples);
    const windowRms = typeof this._inference.currentWindowRms === 'function'
      ? this._inference.currentWindowRms()
      : rms;
    if (rms < HARD_SILENCE_VETO_RMS && windowRms < HARD_SILENCE_VETO_RMS) {
      this._clearScoreWindows();
      this._latestScores = {};
    }
    return this._skippedResult(rms, windowRms);
  }

  _skippedResult(rms, windowRms = null) {
    return {
      detected: false,
      score: 0,
      vadScore: 0,
      model: null,
      cutoff: 0,
      rms,
      windowRms,
      triggerType: null,
      skipped: true,
      perModelScores: this._latestScores || {},
    };
  }

  _windowSilenceVetoResult(rms, windowRms) {
    // Veto only when the full model window is silent.  A valid wake score
    // often lands on a quiet tail chunk while the rolling window still
    // contains the spoken wake word, so chunk RMS alone is misleading.
    this._clearScoreWindows();
    this._latestScores = {};
    return this._skippedResult(rms, windowRms);
  }

  async _processInferenceChunk(samples, rms) {
    const totalStart = this._enableTimings ? nowMs() : 0;
    if (rms === null) {
      // No energy gate active - still compute RMS for the meter.
      let sumSq = 0;
      for (let i = 0; i < CHUNK_SAMPLES; i++) sumSq += samples[i] * samples[i];
      rms = Math.sqrt(sumSq / CHUNK_SAMPLES);
      this._latestRms = rms;
    }

    // CNN and CTC consume normalized audio directly. Embedding inference
    // receives the same normalized chunk and restores openWakeWord's
    // int16 frontend scale internally.
    const { probs, ctc, cnn, windowRms } = await this._inference.processChunk(samples, {
      activeKeywords: this._activeKeywords,
      collectTimings: this._enableTimings,
    });
    if (
      rms < HARD_SILENCE_VETO_RMS
      && typeof windowRms === 'number'
      && windowRms < HARD_SILENCE_VETO_RMS
    ) {
      return this._windowSilenceVetoResult(rms, windowRms);
    }
    const inferenceTimings = this._enableTimings ? this._inference.consumeLastTimings?.() : null;
    this._latestCtc = ctc || null;
    this._latestCnn = cnn || null;
    const confirmFrame = ++this._confirmFrameIndex;
    const effectiveProbs = {};

    const now = nowMs();
    let leaderName = null;
    let leaderScore = 0;
    let leaderCutoff = 0;
    let triggerName = null;
    let triggerScore = 0;
    let triggerCutoff = 0;
    let triggerType = null;
    let triggerCooldownMs = COOLDOWN_MS;
    for (const name in probs) {
      if (!this._activeKeywords.has(name)) continue;
      const mode = this._runtimeMode[name] || { mode: 'borderline', minWindowRms: HARD_SILENCE_VETO_RMS, cooldownMs: COOLDOWN_MS };
      const minWindowRms = Number.isFinite(mode.minWindowRms)
        ? mode.minWindowRms
        : HARD_SILENCE_VETO_RMS;
      const energyVetoed = (
        typeof windowRms === 'number'
        && Number.isFinite(windowRms)
        && windowRms < minWindowRms
      );
      const cnnSequence = evaluateCnnSequenceGate(mode, cnn?.[name]);
      const sequenceVetoed = cnnSequence.enabled && !cnnSequence.passed;
      const p = (energyVetoed || sequenceVetoed) ? 0 : probs[name];
      effectiveProbs[name] = p;
      const cutoff = this._cutoffs[name] ?? DEFAULT_CUTOFF;
      if (p > leaderScore) {
        leaderName = name;
        leaderScore = p;
        leaderCutoff = cutoff;
      }
      let tt = null;
      if (mode.mode === 'counter') {
        tt = this._gateCounter(name, p, cutoff, mode, ctc?.[name], cnnSequence);
      } else {
        const w = this._scoreWindows[name];
        if (w) tt = this._gateBorderline(w, p, cutoff, name, now, confirmFrame);
      }
      if (tt && p > triggerScore) {
        triggerName = name;
        triggerScore = p;
        triggerCutoff = cutoff;
        triggerType = tt;
        triggerCooldownMs = mode.cooldownMs;
      }
    }
    this._latestScores = effectiveProbs;

    let detected = false;
    const cooldownActive = (now - this._lastTriggerAt) < triggerCooldownMs;
    if (triggerName) {
      detected = !cooldownActive;
      if (detected) this._lastTriggerAt = now;
    }

    // CTC detection log: surface what phonemes the model decoded so
    // production logs show WHY a trigger fired, not just THAT it did.
    // Useful for debugging both legitimate detections and FPs (if a
    // TV-speech trigger happens, the log records the exact decoded
    // sequence that matched).  Only emitted on actual detection -
    // per-chunk near-miss logging would spam at 12.5/s.
    if (detected && this._latestCtc && triggerName) {
      const info = this._latestCtc[triggerName];
      if (info && Array.isArray(info.phonemes) && this._log?.log) {
        // Include matched-window confidence + gate threshold so every
        // production trigger log shows whether the confidence gate
        // saw this match and what threshold it compared against.
        // Critical for diagnosing FPs: a trigger with conf<gate would
        // indicate the gate path failed; conf>=gate means the model
        // actually decoded with high confidence on non-wake audio.
        const mc = (typeof info.matchedConfidence === 'number')
          ? ` conf=${info.matchedConfidence.toFixed(2)}`
          : '';
        const tc = (typeof info.totalConfidence === 'number')
          ? ` total_conf=${info.totalConfidence.toFixed(2)}`
          : '';
        const gt = (typeof info.gateThreshold === 'number'
                    && Number.isFinite(info.gateThreshold))
          ? ` gate=${info.gateThreshold.toFixed(2)}`
          : '';
        const runtimeBits = formatRuntimeStatus(this._runtimeStatus?.[triggerName], triggerType);
        this._log.log(
          'wake-word',
          `VWW CTC trigger "${triggerName}" decoded=[${info.phonemes.join(' ')}] `
          + `ed=${info.minEditDistance}${mc}${tc}${gt} type=${triggerType}`
          + `${runtimeBits ? ` ${runtimeBits}` : ''}`,
        );
      }
    }

    // CTC near-miss diagnostic (debug-only - no-op unless vs_debug=true).
    // Same format and threshold as wake-word-test-session.js so users
    // debugging production behavior see the same log they're used to
    // from the tester.  Only decodes within one edit of the matcher gate
    // are legitimate near misses: pretrained-backbone models (ok_nabu
    // v121+) honestly decode ALL speech, so looser thresholds log every
    // window of ambient TV audio.
    if (this._log?.isDebug && this._latestCtc) {
      for (const [name, info] of Object.entries(this._latestCtc)) {
        if (!info || !Array.isArray(info.phonemes)) continue;
        if (info.phonemes.length < 3) continue;
        const ed = info.minEditDistance;
        const nearMaxEd = ((typeof info.maxEditDistance === 'number')
          ? info.maxEditDistance : 1) + 1;
        if (!Number.isFinite(ed) || ed > nearMaxEd) continue;
        // Skip the same decode that just triggered - already logged above.
        if (detected && name === triggerName) continue;
        const mc = (typeof info.matchedConfidence === 'number')
          ? ` conf=${info.matchedConfidence.toFixed(2)}`
          : '';
        const tc = (typeof info.totalConfidence === 'number')
          ? ` total_conf=${info.totalConfidence.toFixed(2)}`
          : '';
        const gateThreshold = info.gateThreshold;
        const gt = (typeof gateThreshold === 'number' && Number.isFinite(gateThreshold))
          ? ` gate=${gateThreshold.toFixed(2)}`
          : '';
        const reasons = [];
        const maxEd = (typeof info.maxEditDistance === 'number')
          ? info.maxEditDistance : 1;
        if (ed > maxEd) reasons.push(`ed>${maxEd}`);
        if (typeof info.matchedConfidence === 'number'
            && typeof gateThreshold === 'number'
            && Number.isFinite(gateThreshold)
            && info.matchedConfidence < gateThreshold) {
          reasons.push('conf<gate');
        }
        const runtimeStatus = this._runtimeStatus?.[name];
        const runtimeCandidate = !!(
          runtimeStatus
          && runtimeStatus.mode === 'counter'
          && ed <= maxEd
          && !(typeof info.matchedConfidence === 'number'
            && typeof gateThreshold === 'number'
            && Number.isFinite(gateThreshold)
            && info.matchedConfidence < gateThreshold)
        );
        if (
          runtimeCandidate
          && runtimeStatus.highConfidence === true
          && Number.isFinite(runtimeStatus.highConfidenceBypassMinHits)
          && Number.isFinite(runtimeStatus.hits)
          && runtimeStatus.hits < runtimeStatus.highConfidenceBypassMinHits
        ) {
          reasons.push(`runtime_bypass_hits<${runtimeStatus.highConfidenceBypassMinHits}`);
        } else if (
          runtimeCandidate
          && Number.isFinite(runtimeStatus.hits)
          && Number.isFinite(runtimeStatus.requiredHits)
          && runtimeStatus.hits < runtimeStatus.requiredHits
        ) {
          reasons.push(`runtime_hits<${runtimeStatus.requiredHits}`);
        }
        const reason = reasons.length ? ` reason=${reasons.join('+')}` : ' reason=other';
        const runtimeBits = formatRuntimeStatus(runtimeStatus, null);
        this._log.logDebug(
          'wake-word',
          `CTC near-miss "${name}" ed=${ed}${mc}${tc}${gt}`
          + `${runtimeBits ? ` ${runtimeBits}` : ''}${reason} `
          + `decoded=[${info.phonemes.join(' ')}]`,
        );
      }
    }

    const result = {
      detected,
      score: triggerName ? triggerScore : leaderScore,
      vadScore: 0,
      model: triggerName || leaderName,
      cutoff: triggerName ? triggerCutoff : leaderCutoff,
      rms,
      windowRms,
      triggerType,
      perModelScores: effectiveProbs,
      // CTC: per-keyword decode info (phonemes + edit distance to
      // nearest wake-word target).  Null/undefined for non-CTC keywords.
      // Test session uses this to log what the model heard, so a
      // missed pronunciation or a triggering FP can be debugged
      // without rebuilding the panel.
      ctc: ctc || null,
      cnn: cnn || null,
      runtime: this._runtimeStatus ? { ...this._runtimeStatus } : {},
    };
    if (this._enableTimings) {
      result.timings = {
        engine: 'vww',
        ...(inferenceTimings || {}),
        backendTotalMs: nowMs() - totalStart,
      };
    }
    return result;
  }

  /**
   * Counter mode: trigger after N consecutive frames above cutoff.
   * Models can declare runtime.high_confidence_bypass so a very confident
   * score still uses the bypass label. CTC uses matched phoneme
   * confidence; binary/embedding models use the model probability.
   * Any sub-cutoff frame resets the counter.  Simpler than the
   * borderline-confirm gate, well-suited to high-cutoff models whose
   * real triggers sustain confident scores across multiple frames
   * (observed empirically with v4 at cutoff 0.87 - zero parked events
   * over an hour of TV-background field testing).  Per-keyword
   * counters live in this._hitCounters keyed by name.
   */
  _gateCounter(name, score, cutoff, mode, ctcInfo = null, cnnSequence = null) {
    const matchedTargetIndex = Number.isInteger(ctcInfo?.matchedTargetIndex)
      ? ctcInfo.matchedTargetIndex
      : -1;
    const matchedTargetGroupIndex = Number.isInteger(ctcInfo?.matchedTargetGroupIndex)
      ? ctcInfo.matchedTargetGroupIndex
      : matchedTargetIndex;
    const baseRequiredHits = requiredHitsForTarget(mode, matchedTargetIndex);
    const baseBypassMinHits = bypassMinHitsForTarget(mode, matchedTargetIndex, baseRequiredHits);
    if (score > cutoff) {
      const prev = this._hitCounters[name] || this._makeHitCounter();
      const hasTargetGroup = (
        Number.isInteger(matchedTargetGroupIndex)
        && matchedTargetGroupIndex >= 0
      );
      const sameGroup = hasTargetGroup
        ? prev.targetGroupIndex === matchedTargetGroupIndex
        : (prev.hits > 0 && prev.targetGroupIndex < 0);
      const requiredHits = sameGroup && Number.isFinite(prev.requiredHits)
        ? Math.max(baseRequiredHits, prev.requiredHits)
        : baseRequiredHits;
      const bypassMinHits = sameGroup && Number.isFinite(prev.bypassMinHits)
        ? Math.max(baseBypassMinHits, prev.bypassMinHits)
        : baseBypassMinHits;
      const grouped = !!(
        sameGroup
        && Number.isInteger(prev.targetIndex)
        && prev.targetIndex >= 0
        && Number.isInteger(matchedTargetIndex)
        && matchedTargetIndex >= 0
        && prev.targetIndex !== matchedTargetIndex
      ) || (sameGroup && prev.grouped === true);
      const nextHits = sameGroup ? prev.hits + 1 : 1;
      this._hitCounters[name] = {
        hits: nextHits,
        targetIndex: matchedTargetIndex,
        targetGroupIndex: matchedTargetGroupIndex,
        grouped,
        requiredHits,
        bypassMinHits,
      };
      const bypass = mode?.highConfidenceBypass;
      const confidenceForBypass = (
        ctcInfo
        && typeof ctcInfo.matchedConfidence === 'number'
      )
        ? ctcInfo.matchedConfidence
        : score;
      const isHighConfidence = (
        typeof bypass === 'number'
        && Number.isFinite(confidenceForBypass)
        && confidenceForBypass >= bypass
      );
      if (isHighConfidence && nextHits >= bypassMinHits) {
        this._runtimeStatus[name] = this._makeRuntimeStatus(name, nextHits, true, true, requiredHits, matchedTargetIndex, bypassMinHits, matchedTargetGroupIndex, grouped, cnnSequence);
        this._hitCounters[name] = this._makeHitCounter();
        return 'bypass';
      }
      if (nextHits >= requiredHits) {
        this._runtimeStatus[name] = this._makeRuntimeStatus(name, requiredHits, false, isHighConfidence, requiredHits, matchedTargetIndex, bypassMinHits, matchedTargetGroupIndex, grouped, cnnSequence);
        this._hitCounters[name] = this._makeHitCounter();
        return 'counter';
      }
      this._runtimeStatus[name] = this._makeRuntimeStatus(name, nextHits, false, isHighConfidence, requiredHits, matchedTargetIndex, bypassMinHits, matchedTargetGroupIndex, grouped, cnnSequence);
    } else {
      this._hitCounters[name] = this._makeHitCounter();
      this._runtimeStatus[name] = this._makeRuntimeStatus(name, 0, false, false, baseRequiredHits, matchedTargetIndex, baseBypassMinHits, matchedTargetGroupIndex, false, cnnSequence);
    }
    return null;
  }

  _makeRuntimeStatus(name, hits = 0, bypassed = false, highConfidence = false, requiredHits = null, matchedTargetIndex = -1, bypassMinHits = null, matchedTargetGroupIndex = -1, grouped = false, cnnSequence = null) {
    const mode = this._runtimeMode[name] || { mode: 'borderline', cooldownMs: COOLDOWN_MS };
    if (mode.mode !== 'counter') {
      return { mode: 'borderline', cooldownMs: mode.cooldownMs };
    }
    const status = {
      mode: 'counter',
      hitMode: mode.hitMode || 'consecutive',
      hits,
      requiredHits: Number.isFinite(requiredHits) ? requiredHits : mode.requiredHits,
      baseRequiredHits: mode.requiredHits,
      matchedTargetIndex,
      matchedTargetGroupIndex,
      grouped,
      highConfidenceBypass: mode.highConfidenceBypass,
      highConfidenceBypassMinHits: Number.isFinite(bypassMinHits)
        ? bypassMinHits
        : mode.highConfidenceBypassMinHits,
      baseHighConfidenceBypassMinHits: mode.highConfidenceBypassMinHits,
      highConfidence,
      bypassed,
      cooldownMs: mode.cooldownMs,
    };
    if (cnnSequence?.enabled) {
      status.cnnSequenceGate = true;
      status.cnnSequencePassed = cnnSequence.passed === true;
      status.cnnPrefixScore = cnnSequence.prefixScore;
      status.cnnCompletionScore = cnnSequence.completionScore;
      status.cnnPrefixThreshold = cnnSequence.prefixThreshold;
      status.cnnCompletionThreshold = cnnSequence.completionThreshold;
    }
    return status;
  }

  _gateBorderline(w, score, cutoff, name, now, frameIndex) {
    if (score <= cutoff) {
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmFrame = -1;
      w.pendingConfirmScore = 0;
      return null;
    }
    if (!BORDERLINE_CONFIRM_ENABLED) {
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmFrame = -1;
      w.pendingConfirmScore = 0;
      return 'immediate';
    }
    if (
      typeof HIGH_CONFIDENCE_BYPASS_MARGIN === 'number'
      && score >= cutoff + HIGH_CONFIDENCE_BYPASS_MARGIN
      && score >= HIGH_CONFIDENCE_BYPASS_MIN_SCORE
    ) {
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmFrame = -1;
      w.pendingConfirmScore = 0;
      return 'immediate';
    }
    const highConfidence = score >= cutoff + BORDERLINE_CONFIRM_MARGIN;
    // Stop classifiers fire immediately on high confidence - no
    // borderline-confirm gate.  Accepts the OWW-style hardcoded name
    // 'stop' AND any VWW model whose manifest declares
    // stop_classifier: true (e.g. 'ok_stop').
    const isStopClassifier = name === 'stop' || this._stopClassifiers[name] === true;
    if (isStopClassifier && highConfidence) {
      w.pendingConfirm = false;
      w.pendingConfirmAt = 0;
      w.pendingConfirmFrame = -1;
      w.pendingConfirmScore = 0;
      return 'immediate';
    }
    if (w.pendingConfirm) {
      const frameGap = frameIndex - w.pendingConfirmFrame;
      const ageMs = now - w.pendingConfirmAt;
      if (frameGap >= 1 && frameGap <= BORDERLINE_CONFIRM_WINDOW_FRAMES) {
        if (!isStopClassifier && frameGap < WAKE_CONFIRM_MIN_FRAMES) {
          w.pendingConfirmScore = Math.max(w.pendingConfirmScore, score);
          return null;
        }
        const firstScore = w.pendingConfirmScore;
        w.pendingConfirm = false;
        w.pendingConfirmAt = 0;
        w.pendingConfirmFrame = -1;
        w.pendingConfirmScore = 0;
        this._log?.log?.(
          'wake-word',
          `VWW borderline confirm passed: ${name} first=${firstScore.toFixed(3)} second=${score.toFixed(3)} frames=${frameGap} age=${ageMs.toFixed(0)}ms cutoff=${cutoff.toFixed(3)}`,
        );
        return 'confirmed';
      }
      if (frameGap <= 0) {
        w.pendingConfirmScore = Math.max(w.pendingConfirmScore, score);
        return null;
      }
      this._log?.log?.(
        'wake-word',
        `VWW confirm expired: ${name} second=${score.toFixed(3)} frames=${frameGap} cutoff=${cutoff.toFixed(3)}`,
      );
    } else {
      this._log?.log?.(
        'wake-word',
        `VWW confirm candidate parked: ${name} score=${score.toFixed(3)} cutoff=${cutoff.toFixed(3)}`,
      );
    }
    w.pendingConfirm = true;
    w.pendingConfirmAt = now;
    w.pendingConfirmFrame = frameIndex;
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
   * Re-include a keyword in the active set.  VWW classifiers are loaded
   * at construction time too (one ONNX per keyword), so a runtime
   * addKeyword can either (a) re-activate a keyword we already loaded
   * or (b) lazily load a new one.  For now we only support (a) to match
   * OWW; lazy-load lands in the worker's addKeyword resolver.
   */
  async addKeyword(cfg) {
    if (!cfg?.name) return;
    if (typeof cfg.cutoff === 'number') this._cutoffs[cfg.name] = cfg.cutoff;
    if (!this._keywordNames.includes(cfg.name)) {
      // Late-bound load: pull the model + manifest, register with the
      // inference orchestrator.
      const entry = await loadVwwModel(cfg.name);
      // Late-bound architecture must match the existing inference type;
      // mixed-arch isn't supported yet.
      const isEmb = this._inference instanceof VwwEmbeddingInference;
      if (isEmb !== (entry.architecture === 'embedding')) {
        throw new Error(
          `Cannot add ${entry.architecture} keyword '${cfg.name}' to a `
          + `${isEmb ? 'embedding' : 'cnn'}-architecture backend`,
        );
      }
      if (isEmb) {
        const tEmb = entry.manifest?.input_shape?.[1]
          ?? entry.manifest?.input?.shape?.[1]
          ?? 9;
        await this._inference.addKeyword(cfg.name, entry.compiled, tEmb);
      } else if (entry.architecture === 'ctc') {
        await this._inference.addKeyword(cfg.name, entry.compiled, entry.ctcConfig);
      } else {
        await this._inference.addKeyword(cfg.name, entry.compiled, null, entry.manifest);
      }
      if (typeof this._cutoffs[cfg.name] !== 'number') {
        const mc = entry.manifest?.recommended_threshold;
        this._cutoffs[cfg.name] = typeof mc === 'number' ? mc : DEFAULT_CUTOFF;
      }
      // Pick up the manifest's runtime hint (if any) for this newly
      // loaded keyword.  Keeps counter-vs-borderline behavior
      // consistent whether the keyword was created upfront or added
      // later via enableStopModel / panel slot 2 changes.
      const r = entry.manifest?.runtime;
      this._runtimeMode[cfg.name] = runtimeModeFromManifest(r);
      this._hitCounters[cfg.name] = this._makeHitCounter();
      this._runtimeStatus[cfg.name] = this._makeRuntimeStatus(cfg.name, 0, false);
      this._keywordNames.push(cfg.name);
      // Pick up the manifest's stop_classifier flag so a lazy-loaded
      // VWW stop model (e.g. 'ok_stop' enabled mid-session via
      // enableStopModel) gets the same special-case treatment as one
      // that was loaded at backend create() time.
      if (entry.manifest?.stop_classifier === true) {
        this._stopClassifiers[cfg.name] = true;
      }
    }
    this._activeKeywords.add(cfg.name);
    if (!this._scoreWindows[cfg.name]) {
      this._scoreWindows[cfg.name] = this._makeWindow();
    }
  }

  removeKeyword(name) {
    this._activeKeywords.delete(name);
  }

  get _keywords() {
    return [...this._activeKeywords].map((name) => ({
      name,
      cutoff: this._cutoffs[name],
      slidingWindow: 1,
      stepSize: 1,
      inputScale: 1,
      inputZeroPoint: 0,
    }));
  }

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

  /**
   * Apply the wake-word sensitivity setting to the CTC matcher gates:
   * scales every target's min matched confidence (in the decoder, which
   * covers the per-window AND stream matchers) plus the high-confidence
   * bypass by the label's factor.  Stop classifiers use the gentler stop
   * table.  Idempotent - always recomputed from manifest-declared bases.
   */
  _applySensitivityConfScale(sensitivityLabel) {
    const wakeK = VWW_SENSITIVITY_CONF_FACTORS[sensitivityLabel] ?? 1;
    const stopK = VWW_STOP_SENSITIVITY_CONF_FACTORS[sensitivityLabel] ?? 1;
    if (typeof this._inference.setConfidenceScale === 'function') {
      const wakeNames = this._keywordNames.filter((n) => !this._stopClassifiers[n]);
      const stopNames = this._keywordNames.filter((n) => this._stopClassifiers[n]);
      if (wakeNames.length) this._inference.setConfidenceScale(wakeK, wakeNames);
      if (stopNames.length) this._inference.setConfidenceScale(stopK, stopNames);
    }
    for (const name of this._keywordNames) {
      const mode = this._runtimeMode[name];
      if (!mode || typeof mode.baseHighConfidenceBypass !== 'number') continue;
      const k = this._stopClassifiers[name] ? stopK : wakeK;
      mode.highConfidenceBypass = mode.baseHighConfidenceBypass * k;
    }
    this._confScaleWake = wakeK;
    this._confScaleStop = stopK;
  }

  updateEnergyThresholds(sensitivityLabel) {
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    this._sleepRms = energy.sleep;
    this._wakeRms = energy.wake;
    this._applySensitivityConfScale(sensitivityLabel);
    this._log?.log?.(
      'wake-word',
      `VWW sensitivity retuned: ${sensitivityLabel} - energy sleep=${energy.sleep} wake=${energy.wake}, `
      + `conf gate scale wake=x${this._confScaleWake.toFixed(2)} stop=x${this._confScaleStop.toFixed(2)}`,
    );
  }

  reset() {
    this._lastTriggerAt = 0;
    this._confirmFrameIndex = 0;
    this._resetStreamState();
    this._sleeping = true;
    this._silentChunks = SLEEP_CHUNKS;
    this._clearSleepBuffer();
  }

  setEnergyGateEnabled(enabled) {
    const prev = this._energyGateEnabled;
    this._energyGateEnabled = !!enabled;
    if (prev !== this._energyGateEnabled) {
      this._sleeping = false;
      this._silentChunks = 0;
      this._clearSleepBuffer();
      this._resetStreamState();
      this._log?.log?.(
        'wake-word',
        `VWW energy gate ${this._energyGateEnabled ? 'enabled' : 'disabled'}`,
      );
    }
  }

  destroy() {
    this._inference?.destroy?.();
    this._inference = null;
  }

  get latestRms() {
    return this._latestRms;
  }
}
