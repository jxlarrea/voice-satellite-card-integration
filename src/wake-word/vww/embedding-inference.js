/**
 * vsWakeWord embedding-architecture inference pipeline.
 *
 *   raw 16 kHz int16-range audio
 *       -> OWW melspectrogram.onnx (vendored)
 *       -> OWW embedding_model.onnx (vendored)
 *       -> our trained classifier (per keyword)
 *
 * Streaming design ported from oww/inference.js:
 *   1. Prepend last 480 samples of audio history to the 1280-sample chunk
 *      so the mel STFT has frame-continuity context.
 *   2. Run mel spec (1760 samples in -> ~5 new mel frames out).
 *   3. Apply mel transform: x * 0.1 + 2.
 *   4. Append new frames to a rolling mel buffer (max MEL_BUFFER_MAX frames).
 *   5. Take the latest MEL_WINDOW=76 mel frames -> embedding model
 *      -> single 96-dim embedding.
 *   6. Slide the new embedding into each keyword's rolling classifier
 *      window (default 9 embeddings for our v11.x trainer's 1.5s window).
 *   7. Run the per-keyword classifier on its window -> raw logit;
 *      caller applies sigmoid.
 *
 * Audio scale: ±1 normalized float32.  Our Python trainer feeds the
 * OWW melspec ONNX raw ±1 audio (NOT int16-scaled like OWW's own
 * runtime does).  Because the trained classifier saw the resulting
 * "unconventional" embeddings, the JS pipeline must do the same -
 * no int16 scaling, no `x*0.1+2` mel post-transform.  Doing either
 * would produce a different embedding distribution than the
 * classifier was trained on.
 */

import { compileOwwOnnxModel } from './onnx-runner.js';  // noqa: F401 - re-export consumer
import { GpuModelRunner } from './gpu/runner.js';

export const CHUNK_SAMPLES = 1280;
export const MEL_BINS = 32;
export const MEL_WINDOW = 76;
export const EMBEDDING_DIM = 96;
const MEL_PREFIX_SAMPLES = 160 * 3;  // 480
const MEL_BUFFER_MAX = 970;
const DEFAULT_EMBEDDING_WINDOW = 9;  // matches our 1.5s training window

/**
 * Streaming inference engine for embedding-architecture VWW models.
 *
 * Owns the shared mel-spec + embedding GPU runners (one each, regardless
 * of how many keywords are attached) and a per-keyword classifier runner
 * + rolling embedding window.
 */
export class VwwEmbeddingInference {
  /**
   * @param {object} opts
   * @param {GPUDevice} opts.device
   * @param {object} opts.sharedMelspec     - compiled OWW melspec ONNX
   * @param {object} opts.sharedEmbedding   - compiled OWW embedding ONNX
   */
  constructor({ device, sharedMelspec, sharedEmbedding }) {
    this._device = device;
    this._sharedMelspec = sharedMelspec;
    this._sharedEmbedding = sharedEmbedding;
    this._melGpuRunner = null;
    this._embeddingGpuRunner = null;

    /** @type {Map<string, {classifierRunner, embeddingWindow:number, classifierInput:Float32Array}>} */
    this._keywords = new Map();

    // Rolling audio history (last 480 samples) prepended to each chunk
    // so the mel STFT has frame continuity across chunk boundaries.
    this._audioHistory = new Float32Array(MEL_PREFIX_SAMPLES);
    this._melInput = new Float32Array(CHUNK_SAMPLES + MEL_PREFIX_SAMPLES);

    // Rolling mel buffer (flat, row-major frames × MEL_BINS).
    this._melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS);
    this._melBufferLen = 0;
    this._initMelBuffer();

    // Scratch for the latest 76 mel frames passed to the embedding model.
    this._embeddingInput = new Float32Array(MEL_WINDOW * MEL_BINS);

    // Warmup runs synthetic noise through the pipeline to pre-fill the
    // per-keyword classifier windows.  Caller must `await this.ready`
    // before the first processChunk.
    this.ready = this._init();
  }

  async _init() {
    this._melGpuRunner = await GpuModelRunner.create(this._device, this._sharedMelspec);
    this._embeddingGpuRunner = await GpuModelRunner.create(this._device, this._sharedEmbedding);
    // Defer per-keyword warmup until addKeyword() so each new keyword's
    // window is filled with its own embedding history.
  }

  /**
   * Attach a per-keyword classifier.  Allocates a rolling embedding
   * window and pre-fills it by running enough synthetic-noise chunks
   * through the shared front-end to fill the window.
   *
   * @param {string} name
   * @param {object} classifierCompiled - parsed CompiledOwwModel
   * @param {number} [embeddingWindow]  - T_emb count expected by the
   *   classifier's input (default 9, matching our v11.x 1.5s training).
   */
  async addKeyword(name, classifierCompiled, embeddingWindow = DEFAULT_EMBEDDING_WINDOW) {
    if (this._keywords.has(name)) return;
    const classifierRunner = await GpuModelRunner.create(this._device, classifierCompiled);
    const kw = {
      classifierRunner,
      embeddingWindow,
      classifierInput: new Float32Array(embeddingWindow * EMBEDDING_DIM),
    };
    this._keywords.set(name, kw);
    // Pre-fill this keyword's classifier window by running `embeddingWindow`
    // synthetic noise chunks through the shared front-end.  Avoids the
    // first real-audio chunk seeing a window of zero embeddings (would
    // score near zero on most classifiers but is undefined behavior).
    await this._warmupKeyword(kw);
  }

  /** Drop a keyword and free its classifier GPU resources. */
  removeKeyword(name) {
    const kw = this._keywords.get(name);
    if (!kw) return;
    try { kw.classifierRunner.destroy(); } catch (_) { /* ignore */ }
    this._keywords.delete(name);
  }

  keywordNames() {
    return [...this._keywords.keys()];
  }

  /**
   * Process one 80 ms (1280-sample) audio chunk.  Audio values must be
   * int16-range float32 (samples scaled by 32768) to match the
   * OWW-trained melspectrogram model.  Returns `{name: probability}`
   * for every active keyword.
   *
   * @param {Float32Array} samples
   * @param {object} [opts]
   * @param {Set<string>} [opts.activeKeywords]
   */
  async processChunk(samples, { activeKeywords = null } = {}) {
    if (samples.length !== CHUNK_SAMPLES) {
      throw new Error(`VwwEmbeddingInference chunk must be ${CHUNK_SAMPLES} samples, got ${samples.length}`);
    }
    if (!this._melGpuRunner || !this._embeddingGpuRunner) {
      throw new Error('VwwEmbeddingInference not ready; await this.ready first');
    }

    // Build [history(480) || chunk(1280)] and run mel+embedding.
    this._melInput.set(this._audioHistory, 0);
    this._melInput.set(samples, MEL_PREFIX_SAMPLES);
    this._audioHistory.set(samples.subarray(CHUNK_SAMPLES - MEL_PREFIX_SAMPLES));
    const emb = await this._runFrontend(this._melInput);

    // Update every keyword's rolling embedding window with this chunk's
    // new embedding, then classify only the active subset.  We always
    // update inactive keywords' windows too so they stay temporally
    // valid (otherwise activating mid-stream would see a stale buffer).
    const probs = {};
    for (const [name, kw] of this._keywords) {
      this._slideEmbedding(kw, emb);
      if (activeKeywords && !activeKeywords.has(name)) continue;
      const logit = await kw.classifierRunner.invoke(kw.classifierInput);
      const v = logit && logit.length > 0 ? logit[0] : 0;
      probs[name] = 1 / (1 + Math.exp(-v));
    }
    return { probs };
  }

  /** Zero all rolling state so the next chunk is treated as a cold start. */
  reset() {
    this._audioHistory.fill(0);
    this._initMelBuffer();
    for (const kw of this._keywords.values()) {
      kw.classifierInput.fill(0);
    }
  }

  /** Free all GPU resources owned by this inference. */
  destroy() {
    try { this._melGpuRunner?.destroy(); } catch (_) { /* ignore */ }
    try { this._embeddingGpuRunner?.destroy(); } catch (_) { /* ignore */ }
    this._melGpuRunner = null;
    this._embeddingGpuRunner = null;
    for (const kw of this._keywords.values()) {
      try { kw.classifierRunner.destroy(); } catch (_) { /* ignore */ }
    }
    this._keywords.clear();
  }

  // ─── Internals ──────────────────────────────────────────────────────

  _initMelBuffer() {
    // Match openWakeWord's `melspectrogram_buffer = np.ones((76, 32))`.
    // Our trained classifier saw the same convention since the OWW
    // melspec + embedding models are unchanged.
    this._melBuffer.fill(1, 0, MEL_WINDOW * MEL_BINS);
    this._melBufferLen = MEL_WINDOW;
  }

  async _runFrontend(melInput) {
    const melOut = await this._melGpuRunner.invoke(melInput);
    this._appendMelFrames(melOut);
    const embIn = this._latestMelWindow();
    return this._embeddingGpuRunner.invoke(embIn);
  }

  _appendMelFrames(melOut) {
    const numFrames = (melOut.length / MEL_BINS) | 0;
    const buf = this._melBuffer;
    let len = this._melBufferLen;
    // If appending would overflow, slide the buffer down so the trailing
    // (MEL_BUFFER_MAX - numFrames) frames stay at the front.
    if (len + numFrames > MEL_BUFFER_MAX) {
      const keep = MEL_BUFFER_MAX - numFrames;
      const dropFrames = len - keep;
      buf.copyWithin(0, dropFrames * MEL_BINS, len * MEL_BINS);
      len = keep;
    }
    // NB: do NOT apply OWW's `x*0.1+2` mel transform here.  Our Python
    // trainer feeds the embedding model raw mel output (no transform),
    // so the classifier was trained against the untransformed
    // distribution.  Applying the transform would produce embeddings
    // outside the trained distribution.
    buf.set(melOut.subarray(0, numFrames * MEL_BINS), len * MEL_BINS);
    this._melBufferLen = len + numFrames;
  }

  _latestMelWindow() {
    const out = this._embeddingInput;
    const start = (this._melBufferLen - MEL_WINDOW) * MEL_BINS;
    out.set(this._melBuffer.subarray(start, start + MEL_WINDOW * MEL_BINS));
    return out;
  }

  _slideEmbedding(kw, emb) {
    // Drop the oldest embedding, append the new one at the end.
    kw.classifierInput.copyWithin(0, EMBEDDING_DIM);
    kw.classifierInput.set(emb, (kw.embeddingWindow - 1) * EMBEDDING_DIM);
  }

  /** Run `embeddingWindow` synthetic-noise chunks through the shared
   * front-end to pre-fill the keyword's classifier window with real
   * embeddings instead of zeros.  Noise is scaled to ±0.03 (matching
   * the ±1 normalized audio convention of our trainer). */
  async _warmupKeyword(kw) {
    const audio = new Float32Array(CHUNK_SAMPLES);
    let state = 0x9E3779B1 >>> 0;
    for (let chunkIdx = 0; chunkIdx < kw.embeddingWindow; chunkIdx++) {
      for (let i = 0; i < audio.length; i++) {
        state = (state + 0x9E3779B1) >>> 0;
        // Map [0, 2^32) to [-0.03, 0.03) - quiet pseudo-noise.
        audio[i] = ((state / 0x100000000) - 0.5) * 0.06;
      }
      this._melInput.set(this._audioHistory, 0);
      this._melInput.set(audio, MEL_PREFIX_SAMPLES);
      this._audioHistory.set(audio.subarray(CHUNK_SAMPLES - MEL_PREFIX_SAMPLES));
      const emb = await this._runFrontend(this._melInput);
      this._slideEmbedding(kw, emb);
    }
  }
}
