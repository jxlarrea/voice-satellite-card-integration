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

import { MicroFrontend } from './micro-frontend.js';

const COOLDOWN_MS = 2000;
// Ignore the first N feature frames after init/reset (~2s warmup)
const WARMUP_FRAMES = 100;

// Energy-based sleep mode — skip TFLite inference during silence.
// RMS thresholds are for float32 audio in [-1, 1] range.
// Keyed by sensitivity label; higher thresholds = more noise filtered out.
const ENERGY_THRESHOLDS = {
  'Slightly sensitive':   { sleep: 0.12,  wake: 0.15  },
  'Moderately sensitive': { sleep: 0.07,  wake: 0.09  },
  'Very sensitive':       { sleep: 0.035, wake: 0.045 },
};
const DEFAULT_ENERGY = ENERGY_THRESHOLDS['Moderately sensitive'];
const SLEEP_CHUNKS = 30;            // ~2.4s of silence before sleeping

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
   */
  constructor(keywordConfigs, log, sensitivityLabel) {
    this._frontend = new MicroFrontend();
    this._log = log;
    this._keywords = [];
    this._lastDetectionTime = 0;

    // Energy-based sleep mode state
    const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
    this._sleepRms = energy.sleep;
    this._wakeRms = energy.wake;
    this._sleeping = false;
    this._silentChunks = 0;

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
    // Determine actual frames per inference from the model's input tensor
    let framesPerInfer = cfg.stepSize || 1;
    try {
      const inputs = cfg.runner.getInputs();
      if (inputs && inputs.length > 0) {
        const inputBuf = inputs[0].data();
        const bufLen = inputBuf.length;
        const detected = Math.floor(bufLen / 40);
        if (detected > 0) {
          framesPerInfer = detected;
        }
      }
    } catch (_) { /* use fallback */ }

    return {
      runner: cfg.runner,
      name: cfg.name,
      cutoff: cfg.cutoff,
      slidingWindow: cfg.slidingWindow,
      framesPerInfer,
      // Probability ring buffer
      probBuffer: new Float32Array(cfg.slidingWindow),
      probIndex: 0,
      probCount: 0,
      // Feature frame accumulator (fills to framesPerInfer before inference)
      featureAccum: [],
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
    // Energy-based sleep: compute RMS to decide whether to run inference
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    const rms = Math.sqrt(sumSq / samples.length);

    if (rms < this._sleepRms) {
      this._silentChunks++;
      if (!this._sleeping && this._silentChunks >= SLEEP_CHUNKS) {
        this._sleeping = true;
        this._log.log('wake-word', `Sleep — inference paused (rms=${rms.toFixed(4)})`);
      }
    } else if (rms >= this._wakeRms) {
      this._silentChunks = 0;
      if (this._sleeping) {
        this._sleeping = false;
        this._log.log('wake-word', `Wake — inference resumed (rms=${rms.toFixed(4)})`);
      }
    }

    // Generate feature frames (always — keeps noise estimate warm)
    const features = this._frontend.feed(samples);
    if (features.length === 0 || this._sleeping) {
      return { detected: false, score: 0, vadScore: 0, model: null };
    }

    const now = Date.now();
    const cooldownOk = now - this._lastDetectionTime > COOLDOWN_MS;

    // Process each feature frame through all keyword models
    for (const frame of features) {
      for (const kw of this._keywords) {
        kw.framesProcessed++;

        // Accumulate frames until we have enough for one inference call
        kw.featureAccum.push(frame);

        if (kw.featureAccum.length < kw.framesPerInfer) continue;

        // Run model inference with exactly framesPerInfer frames
        const probability = this._runModel(kw);
        kw.featureAccum = [];

        // Skip warmup period — model state from previous detection may still
        // be warm, so don't store probs until state has flushed with silence.
        if (kw.framesProcessed < WARMUP_FRAMES) continue;

        // Store probability in ring buffer (only after warmup)
        kw.probBuffer[kw.probIndex] = probability;
        kw.probIndex = (kw.probIndex + 1) % kw.slidingWindow;
        if (kw.probCount < kw.slidingWindow) kw.probCount++;

        // Check detection: mean of sliding window > cutoff
        if (kw.probCount >= kw.slidingWindow && cooldownOk) {
          let sum = 0;
          for (let i = 0; i < kw.slidingWindow; i++) sum += kw.probBuffer[i];
          const mean = sum / kw.slidingWindow;

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
    const inputs = kw.runner.getInputs();
    if (!inputs || inputs.length === 0) return 0;

    const inputBuffer = inputs[0].data();

    // Copy framesPerInfer feature frames into the input tensor
    // Input shape: [1, framesPerInfer, 40] e.g. [1, 3, 40] = 120 bytes
    let offset = 0;
    for (const frame of kw.featureAccum) {
      inputBuffer.set(frame, offset);
      offset += frame.length;
    }

    const success = kw.runner.infer();
    if (!success) return 0;
    return this._readOutput(kw);
  }

  /**
   * Read the output probability from the model.
   * @returns {number} probability [0, 1]
   */
  _readOutput(kw) {
    const outputs = kw.runner.getOutputs();
    if (!outputs || outputs.length === 0) return 0;
    const rawValue = outputs[0].data()[0];
    // Output is uint8 [0-255], normalize to [0, 1]
    return rawValue / 255.0;
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
    // Preserve _lastDetectionTime — the 2s cooldown prevents false
    // re-detection from stale model state (VarHandle ring buffers persist).
    for (const kw of this._keywords) {
      kw.probBuffer.fill(0);
      kw.probIndex = 0;
      kw.probCount = 0;
      kw.featureAccum = [];
      kw.framesProcessed = 0;
    }
  }
}
