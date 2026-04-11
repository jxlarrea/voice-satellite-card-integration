/**
 * microWakeWord TFLite Inference Pipeline
 *
 * Processes raw 16kHz audio through the micro_frontend feature extractor
 * and runs TFLite keyword models with sliding window detection.
 *
 * Implements the processChunk() interface used by WakeWordManager.
 *
 * Each keyword model is stateful (internal ring buffers via TFLite VarHandleOp).
 * V2 models have feature_step_size=10 meaning we accumulate 10 feature frames
 * before running inference. The model's input tensor may be [1, 1, 40] (streaming
 * one frame at a time with internal state) — in that case we call infer() per
 * frame and use the final probability. Output is uint8 [0–255].
 * Detection uses a circular buffer of recent probabilities compared against
 * the cutoff threshold.
 */

import { createWasmMicroFrontend } from './micro-frontend-wasm/index.js';
import { DirectModelRunner } from './direct-runner.js';

const COOLDOWN_MS = 2000;
// Ignore the first N feature frames after init/reset (~2s warmup)
const WARMUP_FRAMES = 100;

// Energy-based sleep mode — skip TFLite inference during silence.
// RMS thresholds are for float32 audio in [-1, 1] range.
// Keyed by sensitivity label; higher thresholds = more noise filtered out.
const ENERGY_THRESHOLDS = {
  'Slightly sensitive':   { sleep: 0.10,  wake: 0.12  },
  'Moderately sensitive': { sleep: 0.05,  wake: 0.06  },
  'Very sensitive':       { sleep: 0.02,  wake: 0.025 },
};
const DEFAULT_ENERGY = ENERGY_THRESHOLDS['Moderately sensitive'];
const SLEEP_CHUNKS = 30;            // ~2.4s of silence before sleeping
// Buffer recent feature frames during sleep so we can replay them on wake.
// Each 80ms chunk produces ~8 feature frames. 8 chunks = ~640ms of lookback,
// enough to capture the onset of a wake word that triggered the energy gate.
const SLEEP_BUFFER_CHUNKS = 8;

export class MicroWakeWordInference {
  /**
   * @param {object[]} keywordConfigs - array of keyword configurations:
   *   {runner, name, cutoff, slidingWindow, stepSize}
   *   - runner: TFLiteWebModelRunner instance
   *   - name: keyword identifier (e.g. 'ok_nabu', 'stop')
   *   - cutoff: probability threshold [0, 1] (e.g. 0.97)
   *   - slidingWindow: number of probabilities to average (e.g. 5)
   *   - stepSize: feature frames per inference (10 for V2 models)
   * @param {object} log - logger with .log(category, message) method
   * @param {string} [sensitivityLabel] - sensitivity level for energy gate
   * @param {boolean} [energyGateEnabled=false] - enable energy-based sleep mode
   * @param {boolean} [useDirect=false] - use DirectModelRunner (zero-leak WASM access)
   */
  /**
   * Async factory — replaces direct `new MicroWakeWordInference(...)`.
   * Loads the WASM micro_frontend module before constructing the
   * inference engine, so we get a bit-exact-to-reference feature
   * pipeline (same C code that runs on Voice PE and the HA Android app).
   *
   * @returns {Promise<MicroWakeWordInference>}
   */
  static async create(keywordConfigs, log, sensitivityLabel, energyGateEnabled = false, useDirect = false) {
    const frontend = await createWasmMicroFrontend();
    return new MicroWakeWordInference(
      frontend, keywordConfigs, log, sensitivityLabel, energyGateEnabled, useDirect,
    );
  }

  /**
   * Direct constructor — takes a pre-loaded WASM frontend. Prefer the
   * static `create()` factory unless you already have a frontend
   * instance you want to reuse (e.g. in tests).
   */
  constructor(frontend, keywordConfigs, log, sensitivityLabel, energyGateEnabled = false, useDirect = false) {
    this._frontend = frontend;
    this._log = log;
    this._keywords = [];
    this._lastDetectionTime = 0;
    this._useDirect = useDirect;

    // Energy-based sleep mode state
    this._energyGateEnabled = energyGateEnabled;
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    this._sleepRms = energy.sleep;
    this._wakeRms = energy.wake;
    this._sleeping = false;
    this._silentChunks = 0;

    // Live mic level — read by the Wake Word Tester to draw the meter.
    this._latestRms = 0;

    // Ring buffer for feature frames during sleep (avoids splice/shift)
    this._sleepBufCap = SLEEP_BUFFER_CHUNKS * 8; // max ~64 frames
    this._sleepBuf = new Array(this._sleepBufCap);
    this._sleepBufHead = 0; // next write index
    this._sleepBufLen = 0;  // current frame count

    // Initialize per-keyword state
    for (const cfg of keywordConfigs) {
      this._keywords.push(this._initKeyword(cfg));
    }
  }

  /**
   * Initialize tracking state for a keyword model.
   * Auto-detects the model's input tensor size to determine the correct
   * number of feature frames per inference call (framesPerInfer).
   */
  _initKeyword(cfg) {
    // Always run Embind init to detect framesPerInfer from the input tensor.
    let framesPerInfer = cfg.stepSize || 1;
    try {
      const inputs = cfg.runner.getInputs();
      if (inputs && inputs.length > 0) {
        const bufLen = inputs[0].data().length;
        const detected = Math.floor(bufLen / 40);
        if (detected > 0) framesPerInfer = detected;
        for (const t of inputs) t.delete();
      }
    } catch (_) { /* use fallback */ }

    // Push this keyword's input quantization params to the shared frontend.
    // The TFLite Web API does not expose per-tensor quantization at runtime,
    // so we extract scale + zero_point ourselves by parsing the .tflite
    // flatbuffer in tflite-quant-reader.js when the model is fetched. This
    // works for any model — bundled or user-supplied custom — without a
    // build-time step.
    if (typeof cfg.inputScale === 'number' && typeof cfg.inputZeroPoint === 'number') {
      this._frontend.setQuantization(cfg.inputScale, cfg.inputZeroPoint);
    }

    // Create DirectRunner if enabled (lazy -- probes on first inference)
    let direct = null;
    if (this._useDirect) {
      try {
        direct = new DirectModelRunner(cfg.runner);
        this._log.log('wake-word', `Direct runner created for ${cfg.name} (will probe on first inference)`);
      } catch (e) {
        this._log.error('wake-word', `Direct runner failed for ${cfg.name}: ${e.message}`);
      }
    }

    return {
      runner: cfg.runner,
      direct,
      name: cfg.name,
      cutoff: cfg.cutoff,
      slidingWindow: cfg.slidingWindow,
      framesPerInfer,
      // Cached output TypedArray view (Embind path only; direct path uses direct.outputView)
      outputView: null,
      // Probability ring buffer + running sum
      probBuffer: new Float32Array(cfg.slidingWindow),
      probIndex: 0,
      probCount: 0,
      probSum: 0,
      // Pre-allocated feature frame accumulator (fixed capacity = framesPerInfer)
      featureAccum: new Array(framesPerInfer),
      featureAccumLen: 0,
      // Warmup counter (ignore first N frames)
      framesProcessed: 0,
    };
  }

  /**
   * Process one 1280-sample (80ms) audio chunk.
   * Same interface as WakeWordInference.processChunk().
   *
   * @param {Float32Array} samples - 1280 float32 samples, 16kHz, [-1, 1]
   * @returns {Promise<{detected: boolean, score: number, vadScore: number, model: string|null}>}
   */
  async processChunk(samples) {
    // Always compute RMS so the wake word tester UI can display a live
    // mic level meter.
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    const rms = Math.sqrt(sumSq / samples.length);
    this._latestRms = rms;

    // Energy-based sleep: use RMS to decide whether to run inference
    if (this._energyGateEnabled) {
      if (rms < this._sleepRms) {
        this._silentChunks++;
        if (!this._sleeping && this._silentChunks >= SLEEP_CHUNKS) {
          this._sleeping = true;
          this._sleepBufLen = 0;
          this._sleepBufHead = 0;
          this._log.log('wake-word', `Sleep — inference paused (rms=${rms.toFixed(4)})`);
        }
      } else if (rms >= this._wakeRms) {
        this._silentChunks = 0;
        if (this._sleeping) {
          this._sleeping = false;
          this._log.log('wake-word', `Wake — inference resumed (rms=${rms.toFixed(4)}, buffered=${this._sleepBufLen} frames)`);
        }
      }
    }

    // Generate feature frames (always — keeps noise estimate warm)
    const features = this._frontend.feed(samples);

    if (this._sleeping) {
      // Buffer features during sleep in ring buffer (no splice/copy)
      for (const f of features) {
        this._sleepBuf[this._sleepBufHead] = f;
        this._sleepBufHead = (this._sleepBufHead + 1) % this._sleepBufCap;
        if (this._sleepBufLen < this._sleepBufCap) this._sleepBufLen++;
      }
      return { detected: false, score: 0, vadScore: 0, model: null };
    }

    // Drain ring buffer on wake — oldest-first order for correct replay
    let allFeatures = features;
    let replayCount = 0;
    if (this._sleepBufLen > 0) {
      replayCount = this._sleepBufLen;
      const drained = new Array(replayCount);
      let readIdx = (this._sleepBufHead - this._sleepBufLen + this._sleepBufCap) % this._sleepBufCap;
      for (let i = 0; i < replayCount; i++) {
        drained[i] = this._sleepBuf[readIdx];
        readIdx = (readIdx + 1) % this._sleepBufCap;
      }
      allFeatures = drained.concat(features);
      this._sleepBufLen = 0;
      this._sleepBufHead = 0;
    }

    if (allFeatures.length === 0) {
      return { detected: false, score: 0, vadScore: 0, model: null };
    }

    const now = Date.now();
    const cooldownOk = now - this._lastDetectionTime > COOLDOWN_MS;

    // Process each feature frame through all keyword models.
    // During sleep-buffer replay (many frames at once), yield to the
    // browser every REPLAY_YIELD_INTERVAL frames so the UI can paint
    // instead of freezing on the TFLite inference burst.
    const REPLAY_YIELD_INTERVAL = 10;
    for (let fi = 0; fi < allFeatures.length; fi++) {
      if (replayCount > 0 && fi > 0 && fi < replayCount && fi % REPLAY_YIELD_INTERVAL === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const frame = allFeatures[fi];
      for (const kw of this._keywords) {
        kw.framesProcessed++;

        // Accumulate frames until we have enough for one inference call
        kw.featureAccum[kw.featureAccumLen++] = frame;

        if (kw.featureAccumLen < kw.framesPerInfer) continue;

        // Run model inference with exactly framesPerInfer frames
        const probability = this._runModel(kw);
        // Recycle feature buffers back to the pool
        for (let j = 0; j < kw.featureAccumLen; j++) {
          this._frontend.recycleFeature(kw.featureAccum[j]);
          kw.featureAccum[j] = null; // release reference
        }
        kw.featureAccumLen = 0;

        // Skip warmup period — model state from previous detection may still
        // be warm, so don't store probs until state has flushed with silence.
        if (kw.framesProcessed < WARMUP_FRAMES) continue;

        // Store probability in ring buffer with running sum (only after warmup)
        if (kw.probCount >= kw.slidingWindow) {
          kw.probSum -= kw.probBuffer[kw.probIndex]; // subtract value being overwritten
        }
        kw.probBuffer[kw.probIndex] = probability;
        kw.probSum += probability;
        kw.probIndex = (kw.probIndex + 1) % kw.slidingWindow;
        if (kw.probCount < kw.slidingWindow) kw.probCount++;

        // Check detection: mean of sliding window > cutoff
        if (kw.probCount >= kw.slidingWindow && cooldownOk) {
          const mean = kw.probSum / kw.slidingWindow;

          if (mean > kw.cutoff) {
            this._lastDetectionTime = now;
            return {
              detected: true,
              score: mean,
              vadScore: 0, // microWakeWord doesn't use a separate VAD
              model: kw.name,
            };
          }
        }
      }
    }

    return { detected: false, score: 0, vadScore: 0, model: null };
  }

  /**
   * Run model inference with exactly framesPerInfer accumulated feature frames.
   * Uses direct WASM buffer I/O — no tfjs tensor overhead.
   *
   * featureAccum always contains exactly kw.framesPerInfer frames (set by
   * processChunk). We copy them into the input tensor and run inference.
   *
   * @param {object} kw - keyword state with runner and featureAccum
   * @returns {number} probability [0, 1]
   */
  _runModel(kw) {
    if (kw.direct?.ready) return this._runModelDirect(kw);
    return this._runModelEmbind(kw);
  }

  /**
   * Direct path: write to cached WASM views, call cpp.Infer() directly.
   * Zero Embind wrapper allocation per inference.
   */
  _runModelDirect(kw) {
    const d = kw.direct;

    let offset = 0;
    for (let i = 0; i < kw.featureAccumLen; i++) {
      d.inputView.set(kw.featureAccum[i], offset);
      offset += kw.featureAccum[i].length;
    }

    if (!d.infer()) return 0;
    return d.outputView[0] / 255.0;
  }

  /**
   * Embind path: uses getInputs()/getOutputs() wrappers (original behavior).
   * Leaks ~31 bytes/call in WASM linear memory from Embind wrapper allocation.
   */
  _runModelEmbind(kw) {
    const inputs = kw.runner.getInputs();
    if (!inputs || inputs.length === 0) return 0;

    const inputTensor = inputs[0];
    const inputBuffer = inputTensor.data();

    let offset = 0;
    for (let i = 0; i < kw.featureAccumLen; i++) {
      inputBuffer.set(kw.featureAccum[i], offset);
      offset += kw.featureAccum[i].length;
    }

    inputTensor.delete();

    const success = kw.runner.infer();
    if (!success) return 0;

    if (!kw.outputView || kw.outputView.buffer.byteLength === 0) {
      try {
        const outputs = kw.runner.getOutputs();
        kw.outputView = outputs[0].data();
        for (const t of outputs) t.delete();
      }
      catch (_) { return 0; }
    }

    // Capture pointers for DirectRunner after warmup completes.
    // VarHandle stateful models need many Embind inferences to fully
    // initialize internal ring buffer state before we can bypass Embind.
    if (kw.direct && !kw.direct.ready && kw.outputView && kw.framesProcessed >= WARMUP_FRAMES) {
      kw.direct.capturePointers(inputBuffer, kw.outputView);
      this._log.log('wake-word', `Direct runner ready for ${kw.name} (after ${kw.framesProcessed} frames)`);
    }

    return kw.outputView[0] / 255.0;
  }

  /** Current input level RMS (last chunk). */
  get latestRms() { return this._latestRms; }

  /**
   * Sliding-window mean of recent inferences for the given keyword. This
   * is the value the engine actually compares against the cutoff for
   * detection, so it's the right signal to display in the Wake Word
   * Tester — single-shot inference probabilities have high natural
   * variance even on identical input, but the smoothed mean is what
   * determines whether the wake word fires. Returns 0 until the window
   * has filled (after warmup).
   */
  getLatestSmoothedProbability(name) {
    const kw = this._keywords.find((k) => k.name === name);
    if (!kw || kw.probCount === 0) return 0;
    return kw.probSum / kw.probCount;
  }

  /**
   * Update thresholds for keyword models (live, no restart needed).
   * @param {{name: string, threshold: number}[]} updates
   */
  updateThresholds(updates) {
    for (const u of updates) {
      const kw = this._keywords.find((k) => k.name === u.name);
      if (kw) kw.cutoff = u.threshold;
    }
  }

  /**
   * Update energy gate thresholds (live, no restart needed).
   * @param {string} sensitivityLabel
   */
  updateEnergyThresholds(sensitivityLabel) {
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    this._sleepRms = energy.sleep;
    this._wakeRms = energy.wake;
  }

  /**
   * Enable or disable the energy gate at runtime.
   * When disabled, any active sleep state is immediately cleared.
   * @param {boolean} enabled
   */
  setEnergyGateEnabled(enabled) {
    this._energyGateEnabled = enabled;
    if (!enabled && this._sleeping) {
      this._sleeping = false;
      this._silentChunks = 0;
      this._sleepBufLen = 0;
      this._sleepBufHead = 0;
      this._log.log('wake-word', 'Energy gate disabled — inference always active');
    }
  }

  /**
   * Dynamically add a keyword model (e.g. stop model).
   * @param {{runner, name, cutoff, slidingWindow, stepSize}} config
   */
  addKeyword(config) {
    if (this._keywords.some((k) => k.name === config.name)) return;
    this._keywords.push(this._initKeyword(config));
  }

  /**
   * Remove a keyword model by name.
   * @param {string} name
   */
  removeKeyword(name) {
    const idx = this._keywords.findIndex((k) => k.name === name);
    if (idx !== -1) this._keywords.splice(idx, 1);
  }

  /**
   * Reset all internal state (for restarting detection).
   */
  reset() {
    this._frontend.reset();
    this._sleeping = false;
    this._silentChunks = 0;
    this._sleepBufLen = 0;
    this._sleepBufHead = 0;
    // Preserve _lastDetectionTime — the 2s cooldown prevents false
    // re-detection from stale model state (VarHandle ring buffers persist).
    for (const kw of this._keywords) {
      kw.probBuffer.fill(0);
      kw.probIndex = 0;
      kw.probCount = 0;
      kw.probSum = 0;
      kw.featureAccum.fill(null);
      kw.featureAccumLen = 0;
      kw.framesProcessed = 0;
    }
  }
}
