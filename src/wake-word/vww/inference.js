/**
 * vsWakeWord inference pipeline.
 *
 *   raw 16 kHz ±1 float32 audio → log-mel features → ONNX CNN → probability
 *
 * One `VwwInference` instance owns a single 1-second ring buffer, a single
 * log-mel feature extractor, and a GpuModelRunner per active keyword. All
 * keywords share the buffer + feature extractor (audio is the same across
 * keywords), so multi-keyword inference costs one log-mel extraction + one
 * GPU invoke per keyword per chunk.
 *
 * Buffer policy: we accumulate the latest 16000 samples (1 s). Each
 * 80 ms (1280-sample) chunk slides the window forward by 80 ms. Once the
 * buffer is first filled, every subsequent chunk triggers inference; the
 * fill phase (first ~12 chunks) returns no detection.
 */

import { compileOwwOnnxModel } from './onnx-runner.js';
import { GpuModelRunner, invokeAll } from './gpu/runner.js';
import { CtcDecoder } from './ctc-decoder.js';

export const CHUNK_SAMPLES = 1280;     // 80 ms @ 16 kHz, matches OWW
const WINDOW_SAMPLES_DEFAULT = 16000;  // 1 s @ 16 kHz

const DEFAULT_FEATURE_CONFIG = {
  sample_rate: 16000,
  window_ms: 1000,
  frame_ms: 25,
  hop_ms: 10,
  n_fft: 512,
  n_mels: 40,
  f_min: 80,
  f_max: 7600,
  log_floor: 1e-6,
};

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

/**
 * @typedef {Object} VwwKeyword
 * @property {string} name
 * @property {object} compiled       parsed CompiledOwwModel
 * @property {GpuModelRunner} runner GPU-compiled inference pipeline
 * @property {Float32Array} outputView  scratch view for runner output
 */

export class VwwInference {
  /**
   * Construct an inference instance owning audio + feature buffers.
   * Pass the resolved feature config from the model's JSON manifest
   * (or omit to use the default 16 kHz / 1000 ms / 40 mel config).
   *
   * @param {GPUDevice} device
   * @param {object} [featureConfig]  resolved JSON manifest feature_config
   */
  constructor(device, featureConfig = null, options = {}) {
    this._device = device;
    this._log = options.log || null;
    this._pipelineLog = options.pipelineLog === true;
    this._int8 = options.int8;
    this._featureConfig = { ...DEFAULT_FEATURE_CONFIG, ...(featureConfig || {}) };
    const cfg = this._featureConfig;
    this._featureKind = cfg.feature === 'microfrontend' ? 'microfrontend' : 'log_mel';
    this._streamingOnnx = this._featureKind === 'microfrontend'
      && (
        cfg.format === 'vs-wake-word-microfrontend-stream-cnn-v1'
        || cfg.streaming_onnx?.enabled === true
      );
    this._windowSamples = Math.round(cfg.sample_rate * cfg.window_ms / 1000);
    this._frameSamples = Math.round(cfg.sample_rate * cfg.frame_ms / 1000);
    this._hopSamples = Math.round(cfg.sample_rate * cfg.hop_ms / 1000);
    this._nFft = cfg.n_fft;
    this._nMels = cfg.n_mels;
    this._frames = 1 + Math.floor((this._windowSamples - this._frameSamples) / this._hopSamples);

    // 1-second ring buffer of audio samples, written in CHUNK_SAMPLES
    // bursts.  We keep it linearly contiguous + use a head index so the
    // "give me the latest 1 s" extraction is one slice instead of a copy.
    this._ring = new Float32Array(this._windowSamples);
    this._ringHead = 0;
    this._ringFilled = 0;
    this._ringSumSq = 0;
    this._linearBuf = new Float32Array(this._windowSamples);

    // Pre-allocated feature scratch (98 × 40 = 3920 f32 for the default).
    this._featureBuf = new Float32Array(this._frames * this._nMels);
    this._featuresInitialized = false;
    this._microFrontend = this._featureKind === 'microfrontend'
      ? (options.microFrontend || null)
      : null;
    this._streamStepFrames = Math.max(1, Math.floor(Number(cfg.streaming_onnx?.step_frames ?? 3)));
    this._streamDefaultSlidingWindow = Math.max(1, Math.floor(Number(cfg.streaming_onnx?.sliding_window ?? 5)));
    this._streamFeaturesSinceInfer = 0;
    this._streamFeatureRing = this._streamingOnnx
      ? new Float32Array(this._frames * this._nMels)
      : null;
    this._streamFeatureScratch = this._streamingOnnx
      ? new Float32Array(this._frames * this._nMels)
      : null;
    this._streamFeatureHead = 0;
    this._streamFeatureFilled = 0;
    // Pre-allocated FFT working buffers (re-used per frame).
    this._fftRe = new Float32Array(this._nFft);
    this._fftIm = new Float32Array(this._nFft);
    this._hannWindow = makeHannWindow(this._frameSamples);
    this._melFilterbank = makeMelFilterbank(cfg);
    this._fft = new FFT(this._nFft);

    /** @type {Map<string, VwwKeyword>} */
    this._keywords = new Map();
  }

  /**
   * Add a keyword.  Compiles the model graph onto the GPU; the returned
   * promise resolves once the pipeline is ready to invoke.
   *
   * @param {string} name
   * @param {object} compiled - parsed CompiledOwwModel (from loadVwwModel)
   * @param {object} [ctcConfig] - if provided, this keyword's ONNX output
   *   is interpreted as (T_out, vocab_size) frame-level phoneme posteriors
   *   and decoded via a wake-word phoneme substring match.  Score is 0/1
   *   (match / no-match) instead of a binary CNN probability.
   */
  async addKeyword(name, compiled, ctcConfig = null, manifest = null) {
    if (this._keywords.has(name)) return;
    const runner = await GpuModelRunner.create(this._device, compiled, {
      log: this._log,
      pipelineLog: this._pipelineLog,
      int8: this._int8,
    });
    const keyword = { name, compiled, runner, ctcDecoder: null, stream: null };
    if (ctcConfig) {
      // Output shape is (1, T_out, V).  compiled.outputs[0].dims has
      // it if the trainer wrote a concrete shape (we do).
      const outputId = compiled.outputIds?.[0];
      const outShape = (outputId != null ? compiled.tensors?.[outputId]?.shape : null)
        || compiled.outputs?.[0]?.dims
        || compiled.outputs?.[0]?.shape
        || null;
      try {
        keyword.ctcDecoder = new CtcDecoder(ctcConfig, outShape || [1, 64, ctcConfig.vocab_size || 52]);
        // Cross-window stream matching (pause-tolerant): on unless the
        // manifest disables it.  Buffer/lag are manifest-tunable.
        const rt = manifest?.runtime || {};
        if (rt.stream_match !== false) {
          keyword.ctcDecoder.enableStreamMatch({
            windowSamples: this._windowSamples,
            windowMs: this._featureConfig?.window_ms ?? 1300,
            bufferMs: rt.stream_buffer_ms,
            lagFrames: rt.stream_lag_frames,
          });
        }
      } catch (err) {
        throw new Error(`CTC decoder init failed for keyword "${name}": ${err.message}`);
      }
    } else if (this._streamingOnnx) {
      const streamCfg = manifest?.streaming_onnx || manifest?.feature_config?.streaming_onnx || {};
      const slidingWindow = Math.max(1, Math.floor(Number(streamCfg.sliding_window ?? this._streamDefaultSlidingWindow)));
      keyword.stream = {
        slidingWindow,
        probBuffer: new Float32Array(slidingWindow),
        probIndex: 0,
        probCount: 0,
        probSum: 0,
        lastRaw: 0,
        lastMean: 0,
      };
    }
    this._keywords.set(name, keyword);
  }

  /**
   * Scale the CTC matched-confidence gates (wake word sensitivity
   * setting).  No-op for keywords without a CTC decoder.
   *
   * @param {number} scale multiplicative factor (1 = manifest truth)
   * @param {string[]|null} [names] keywords to retune (default: all)
   */
  setConfidenceScale(scale, names = null) {
    const only = Array.isArray(names) ? new Set(names) : null;
    for (const [name, kw] of this._keywords) {
      if (only && !only.has(name)) continue;
      kw.ctcDecoder?.setConfidenceScale(scale);
    }
  }

  /** Drop a keyword and free its GPU resources. */
  removeKeyword(name) {
    const kw = this._keywords.get(name);
    if (!kw) return;
    try { kw.runner.destroy(); } catch (_) { /* ignore */ }
    this._keywords.delete(name);
  }

  /** All keyword names currently loaded. */
  keywordNames() {
    return [...this._keywords.keys()];
  }

  /**
   * Process one 80 ms audio chunk (1280 samples). Slides the window
   * forward, then if the window is full runs inference for each active
   * keyword in `activeKeywords`. Returns a `{name: probability}` map.
   *
   * @param {Float32Array} samples ±1 float32 at 16 kHz, length CHUNK_SAMPLES
   * @param {Set<string>} [activeKeywords] subset of loaded keywords to score
   * @returns {Promise<{probs: object}>}
   */
  async processChunk(samples, { activeKeywords = null, collectTimings = false } = {}) {
    if (samples.length !== CHUNK_SAMPLES) {
      throw new Error(`VWW chunk must be ${CHUNK_SAMPLES} samples, got ${samples.length}`);
    }
    const timings = collectTimings ? {
      featureKind: this._featureKind,
      frontendStreaming: this._streamingOnnx,
    } : null;
    const totalStart = timings ? nowMs() : 0;
    const appendStart = timings ? totalStart : 0;
    this._appendRing(samples);
    const windowRms = this.currentWindowRms();
    if (timings) timings.appendMs = nowMs() - appendStart;
    const featureStart = timings ? nowMs() : 0;
    if (this._streamingOnnx) {
      const result = await this._processStreamingMicroFrontend(samples, {
        activeKeywords,
        timings,
        featureStart,
        totalStart,
      });
      return { ...result, windowRms };
    }
    const features = this._featureKind === 'microfrontend'
      ? (this._ringFilled < this._windowSamples ? null : this._extractMicroFrontendWindow())
      : (this._ringFilled < this._windowSamples ? null : this._extractLogMel());
    if (timings) {
      timings.frontendMs = features ? nowMs() - featureStart : 0;
      timings.fusedFrontend = this._featureKind === 'microfrontend';
      timings.classifyMs = 0;
      timings.inferenceTotalMs = nowMs() - totalStart;
      this._lastTimings = timings;
    }
    if (!features) return { probs: {}, windowRms };
    const probs = {};
    const ctc = {};
    const cnn = {};
    let classifyMs = 0;
    // All active keywords score the same feature tensor, so their GPU
    // graphs go out in ONE queue submission (invokeAll) instead of a
    // sequential invoke-per-keyword loop that pays a full GPU→CPU
    // readback round trip per model.
    const active = [];
    for (const [name, kw] of this._keywords) {
      if (activeKeywords && !activeKeywords.has(name)) continue;
      active.push([name, kw]);
    }
    const modelCount = active.length;
    const invokeStart = timings ? nowMs() : 0;
    const outputs = await invokeAll(active.map(([, kw]) => kw.runner), features);
    if (timings) classifyMs = nowMs() - invokeStart;
    for (let ki = 0; ki < active.length; ki++) {
      const [name, kw] = active[ki];
      const out = outputs[ki];
      if (kw.ctcDecoder) {
        // CTC: flat (T_out * V) output gets greedy-decoded and substring-
        // matched into 0 (no wake) or 1 (wake).  Plugs into the existing
        // cutoff/required_hits gates without further changes.  Also
        // capture the decoded phoneme sequence + edit distance + per-
        // matched-phoneme confidence so the test-session UI can log
        // what the model heard AND how confident it was (useful for
        // tuning the confidence gate and debugging FPs).
        const info = kw.ctcDecoder.analyzeWithConfidence(out);
        // Stream path: append this window's fresh frames, then match on
        // the stitched stream.  Catches "okay <pause> nabu" that no
        // single 1300 ms window can contain.  Per-window match stays
        // primary (instant); stream fires arrive ~400 ms later.
        kw.ctcDecoder.streamUpdate(out, samples.length);
        const streamInfo = kw.ctcDecoder.streamAnalyze();
        const streamMatched = !!(streamInfo && streamInfo.matched);
        probs[name] = (info.matched || streamMatched) ? 1.0 : 0.0;
        ctc[name] = {
          streamMatched,
          streamDecoded: streamInfo ? streamInfo.decoded : [],
          streamConfidence: streamInfo ? streamInfo.matchedConfidence : 0,
          decoded: info.decoded,
          phonemes: kw.ctcDecoder.toPhonemes(info.decoded),
          minEditDistance: info.minEditDistance,
          matched: info.matched,
          matchedTargetIndex: info.matchedTargetIndex,
          matchedTargetGroupIndex: info.matchedTargetGroupIndex,
          matchedTargetGroupSize: info.matchedTargetGroupSize,
          matchedConfidence: info.matchedConfidence,
          totalConfidence: info.totalConfidence,
          gateThreshold: info.gateThreshold,
          maxEditDistance: kw.ctcDecoder.maxEditDistance,
          targetMaxEditDistance: kw.ctcDecoder.targetMaxEditDistance,
          trailTolerance: kw.ctcDecoder.trailTolerance,
        };
      } else {
        const wake = out.length > 0 ? out[0] : 0;
        probs[name] = wake;
        if (out.length >= 3) {
          cnn[name] = {
            wake,
            prefix: out[1],
            completion: out[2],
          };
        }
      }
    }
    if (timings) {
      timings.classifyMs = classifyMs;
      timings.modelCount = modelCount;
      timings.inferenceTotalMs = nowMs() - totalStart;
      this._lastTimings = timings;
    }
    return { probs, ctc, cnn, windowRms };
  }

  consumeLastTimings() {
    const out = this._lastTimings || null;
    this._lastTimings = null;
    return out;
  }

  /**
   * Append a chunk to the audio ring and update the incremental log-mel
   * window WITHOUT running GPU inference.  Used by the worker to absorb
   * stale chunks when inference can't keep up with real time: the
   * window stays gap-free while only fresh chunks pay for the CNN.
   * The mel update costs ~1 ms of CPU vs >100 ms of GPU on the devices
   * where this matters.  Must be called exactly once per chunk - the
   * incremental extractor assumes one CHUNK_SAMPLES slide per call.
   */
  ingestChunk(samples) {
    if (samples.length !== CHUNK_SAMPLES) {
      throw new Error(`VWW chunk must be ${CHUNK_SAMPLES} samples, got ${samples.length}`);
    }
    this._appendRing(samples);
    if (this._streamingOnnx) {
      this._ingestStreamingMicroFrontend(samples);
    } else if (this._featureKind !== 'microfrontend' && this._ringFilled >= this._windowSamples) {
      this._extractLogMel();
    }
  }

  /** Reset the audio buffer state.  Doesn't unload models. */
  reset() {
    this._ringHead = 0;
    this._ringFilled = 0;
    this._ringSumSq = 0;
    this._ring.fill(0);
    this._linearBuf.fill(0);
    this._featureBuf.fill(0);
    this._featuresInitialized = false;
    if (this._microFrontend) this._microFrontend.reset();
    this._streamFeaturesSinceInfer = 0;
    this._streamFeatureHead = 0;
    this._streamFeatureFilled = 0;
    if (this._streamFeatureRing) this._streamFeatureRing.fill(0);
    if (this._streamFeatureScratch) this._streamFeatureScratch.fill(0);
    for (const kw of this._keywords.values()) {
      if (!kw.stream) continue;
      kw.stream.probBuffer.fill(0);
      kw.stream.probIndex = 0;
      kw.stream.probCount = 0;
      kw.stream.probSum = 0;
      kw.stream.lastRaw = 0;
      kw.stream.lastMean = 0;
    }
  }

  /** Free all GPU resources owned by this inference. */
  destroy() {
    for (const kw of this._keywords.values()) {
      try { kw.runner.destroy(); } catch (_) { /* ignore */ }
    }
    try { this._microFrontend?.destroy?.(); } catch (_) { /* ignore */ }
    this._keywords.clear();
  }

  // ─── Internals ──────────────────────────────────────────────────────

  _appendRing(samples) {
    const ring = this._ring;
    const n = ring.length;
    let head = this._ringHead;
    let sumSq = this._ringSumSq;
    const updateSumSq = (src, dstStart) => {
      for (let i = 0; i < src.length; i++) {
        const old = ring[dstStart + i];
        const value = src[i];
        sumSq += value * value - old * old;
      }
    };
    // Bulk copy without modulo per sample.  At most two copy operations
    // (one wraps the end of the ring, one fills the start).
    const first = Math.min(samples.length, n - head);
    updateSumSq(samples.subarray(0, first), head);
    ring.set(samples.subarray(0, first), head);
    const remaining = samples.length - first;
    if (remaining > 0) {
      updateSumSq(samples.subarray(first), 0);
      ring.set(samples.subarray(first), 0);
    }
    this._ringHead = (head + samples.length) % n;
    this._ringFilled = Math.min(n, this._ringFilled + samples.length);
    this._ringSumSq = Math.max(0, sumSq);
  }

  _appendStreamFeature(frame) {
    if (!this._streamFeatureRing) return;
    const nMels = this._nMels;
    const dst = this._streamFeatureHead * nMels;
    const copy = Math.min(nMels, frame.length);
    for (let i = 0; i < copy; i++) this._streamFeatureRing[dst + i] = frame[i];
    for (let i = copy; i < nMels; i++) this._streamFeatureRing[dst + i] = 0;
    this._streamFeatureHead = (this._streamFeatureHead + 1) % this._frames;
    this._streamFeatureFilled = Math.min(this._frames, this._streamFeatureFilled + 1);
  }

  _streamFeatureWindow() {
    if (!this._streamFeatureRing || !this._streamFeatureScratch) return null;
    if (this._streamFeatureFilled < this._frames) return null;
    const nMels = this._nMels;
    const frames = this._frames;
    const head = this._streamFeatureHead;
    const ring = this._streamFeatureRing;
    const out = this._streamFeatureScratch;
    let dst = 0;
    for (let f = 0; f < frames; f++) {
      const srcFrame = (head + f) % frames;
      out.set(ring.subarray(srcFrame * nMels, srcFrame * nMels + nMels), dst);
      dst += nMels;
    }
    return out;
  }

  _pushStreamProbability(kw, probability) {
    const state = kw.stream;
    if (!state) return probability;
    if (state.probCount >= state.slidingWindow) {
      state.probSum -= state.probBuffer[state.probIndex];
    }
    state.probBuffer[state.probIndex] = probability;
    state.probSum += probability;
    state.probIndex = (state.probIndex + 1) % state.slidingWindow;
    if (state.probCount < state.slidingWindow) state.probCount++;
    state.lastRaw = probability;
    state.lastMean = state.probCount > 0 ? state.probSum / state.probCount : probability;
    return state.lastMean;
  }

  async _processStreamingMicroFrontend(samples, { activeKeywords = null, timings = null, featureStart = 0, totalStart = 0 } = {}) {
    if (!this._microFrontend) {
      throw new Error('VWW streaming microfrontend model loaded without a microfrontend instance');
    }
    const features = this._microFrontend.feed(samples);
    const probs = {};
    const cnn = {};
    let classifyMs = 0;
    let steps = 0;
    let invoked = false;
    for (const frame of features) {
      this._appendStreamFeature(frame);
      this._microFrontend.recycleFeature?.(frame);
      this._streamFeaturesSinceInfer++;
      if (this._streamFeatureFilled < this._frames) continue;
      if (this._streamFeaturesSinceInfer < this._streamStepFrames) continue;
      this._streamFeaturesSinceInfer = 0;
      const context = this._streamFeatureWindow();
      if (!context) continue;
      steps++;
      const active = [];
      for (const [name, kw] of this._keywords) {
        if (activeKeywords && !activeKeywords.has(name)) continue;
        if (kw.ctcDecoder) continue;
        active.push([name, kw]);
      }
      const invokeStart = timings ? nowMs() : 0;
      const outputs = await invokeAll(active.map(([, kw]) => kw.runner), context);
      if (timings) classifyMs += nowMs() - invokeStart;
      for (let ki = 0; ki < active.length; ki++) {
        const [name, kw] = active[ki];
        const out = outputs[ki];
        const raw = out.length > 0 ? out[0] : 0;
        const mean = this._pushStreamProbability(kw, raw);
        if (mean >= (probs[name] ?? -Infinity)) {
          probs[name] = mean;
          cnn[name] = {
            wake: raw,
            streamMean: mean,
            streamSteps: steps,
            slidingWindow: kw.stream?.slidingWindow ?? this._streamDefaultSlidingWindow,
          };
          if (out.length >= 3) {
            cnn[name].prefix = out[1];
            cnn[name].completion = out[2];
          }
        }
        invoked = true;
      }
    }
    if (timings) {
      timings.frontendMs = nowMs() - featureStart;
      timings.fusedFrontend = true;
      timings.streamingOnnx = true;
      timings.streamSteps = steps;
      timings.classifyMs = classifyMs;
      timings.modelCount = Object.keys(probs).length;
      timings.inferenceTotalMs = nowMs() - totalStart;
      this._lastTimings = timings;
    }
    return {
      probs: invoked ? probs : {},
      ctc: {},
      cnn,
    };
  }

  _ingestStreamingMicroFrontend(samples) {
    if (!this._microFrontend) return;
    const features = this._microFrontend.feed(samples);
    for (const frame of features) {
      this._appendStreamFeature(frame);
      this._microFrontend.recycleFeature?.(frame);
      this._streamFeaturesSinceInfer++;
    }
    if (this._streamFeaturesSinceInfer > this._streamStepFrames) {
      this._streamFeaturesSinceInfer = this._streamStepFrames;
    }
  }

  currentWindowRms() {
    const denom = this._ringFilled > 0 ? this._ringFilled : this._windowSamples;
    return Math.sqrt(Math.max(0, this._ringSumSq) / denom);
  }

  /** Copy the latest 1-second window into a linear buffer in time order. */
  _linearWindow() {
    const ring = this._ring;
    const n = ring.length;
    if (this._ringFilled < n) {
      // Not yet wrapped; ring[0 .. head) is the latest data.
      return ring.subarray(0, this._ringHead);
    }
    // Wrapped; latest data starts at head, runs to end, then 0 .. head-1.
    const out = this._linearBuf;
    const head = this._ringHead;
    out.set(ring.subarray(head));
    out.set(ring.subarray(0, head), n - head);
    return out;
  }

  _extractMicroFrontendWindow() {
    if (!this._microFrontend) {
      throw new Error('VWW microfrontend model loaded without a microfrontend instance');
    }
    // Training/benchmark extraction resets the TFLM microfrontend for every
    // window. Keep runtime identical; a persistent streaming frontend changes
    // the noise/PCAN state and shifts scores enough to break hit gating.
    this._microFrontend.reset();
    const frames = this._microFrontend.feed(this._linearWindow());
    const out = this._featureBuf;
    const nMels = this._nMels;
    const cap = this._frames;
    out.fill(0);
    const count = Math.min(cap, frames.length);
    for (let f = 0; f < count; f++) {
      const frame = frames[f];
      const base = f * nMels;
      const copy = Math.min(nMels, frame.length);
      for (let i = 0; i < copy; i++) out[base + i] = frame[i];
      this._microFrontend.recycleFeature?.(frame);
    }
    return out;
  }

  /**
   * Compute log-mel features for the current 1-second window.  Output
   * shape is [frames, n_mels] flattened row-major - same layout the
   * exported vsWakeWord ONNX expects as `input`.
   */
  _extractLogMel() {
    const audio = this._linearWindow();
    const out = this._featureBuf;
    const window = this._hannWindow;
    const fftRe = this._fftRe;
    const fftIm = this._fftIm;
    const mel = this._melFilterbank;
    const nFft = this._nFft;
    const nMels = this._nMels;
    const frameSamples = this._frameSamples;
    const hopSamples = this._hopSamples;
    const frames = this._frames;
    const logFloor = this._featureConfig.log_floor;
    let firstFrame = 0;
    if (
      this._featuresInitialized
      && CHUNK_SAMPLES > 0
      && CHUNK_SAMPLES % hopSamples === 0
      && CHUNK_SAMPLES < this._windowSamples
    ) {
      const shiftFrames = Math.min(frames, CHUNK_SAMPLES / hopSamples);
      if (shiftFrames < frames) {
        out.copyWithin(0, shiftFrames * nMels);
        firstFrame = frames - shiftFrames;
      }
    }

    for (let f = firstFrame; f < frames; f++) {
      const start = f * hopSamples;
      fftRe.fill(0);
      fftIm.fill(0);
      for (let i = 0; i < frameSamples; i++) {
        fftRe[i] = audio[start + i] * window[i];
      }
      this._fft.forward(fftRe, fftIm);
      const outBase = f * nMels;
      for (let m = 0; m < nMels; m++) {
        let energy = 0;
        const filter = mel[m];
        const half = nFft / 2;
        for (let k = 0; k <= half; k++) {
          const power = fftRe[k] * fftRe[k] + fftIm[k] * fftIm[k];
          energy += filter[k] * power;
        }
        out[outBase + m] = Math.log(Math.max(energy, logFloor));
      }
    }
    this._featuresInitialized = true;
    return out;
  }
}

// ─── Log-mel building blocks (ported from the trainer's JS reference) ─

function makeHannWindow(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return out;
}

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function makeMelFilterbank(cfg) {
  const melMin = hzToMel(cfg.f_min);
  const melMax = hzToMel(cfg.f_max);
  const hz = [];
  const bins = [];
  for (let i = 0; i < cfg.n_mels + 2; i++) {
    const mel = melMin + (i / (cfg.n_mels + 1)) * (melMax - melMin);
    hz.push(melToHz(mel));
    bins.push(Math.max(0, Math.min(cfg.n_fft / 2, Math.floor((cfg.n_fft + 1) * hz[i] / cfg.sample_rate))));
  }
  const fb = [];
  for (let m = 1; m <= cfg.n_mels; m++) {
    const filter = new Float32Array(cfg.n_fft / 2 + 1);
    let left = bins[m - 1];
    let center = bins[m];
    let right = bins[m + 1];
    if (center <= left) center = left + 1;
    if (right <= center) right = center + 1;
    for (let k = left; k < Math.min(center, filter.length); k++) {
      filter[k] = (k - left) / Math.max(1, center - left);
    }
    for (let k = center; k < Math.min(right, filter.length); k++) {
      filter[k] = (right - k) / Math.max(1, right - center);
    }
    const enorm = 2 / Math.max(1e-6, hz[m + 1] - hz[m - 1]);
    for (let k = 0; k < filter.length; k++) filter[k] *= enorm;
    fb.push(filter);
  }
  return fb;
}

class FFT {
  constructor(size) {
    this.size = size;
    this.levels = Math.log2(size) | 0;
    if ((1 << this.levels) !== size) throw new Error('FFT size must be a power of two');
    this.rev = new Uint16Array(size);
    for (let i = 0; i < size; i++) this.rev[i] = reverseBits(i, this.levels);
  }

  forward(re, im) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = -2 * Math.PI / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const angle = step * j;
          const wr = Math.cos(angle);
          const wi = Math.sin(angle);
          const even = i + j;
          const odd = even + half;
          const tr = wr * re[odd] - wi * im[odd];
          const ti = wr * im[odd] + wi * re[odd];
          re[odd] = re[even] - tr;
          im[odd] = im[even] - ti;
          re[even] += tr;
          im[even] += ti;
        }
      }
    }
  }
}

function reverseBits(x, bits) {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>= 1;
  }
  return y;
}
