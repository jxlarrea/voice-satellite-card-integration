/**
 * openWakeWord 3-stage streaming inference pipeline.
 *
 *   raw 16 kHz int16 audio  →  mel spec model  →  embedding model  →  classifier
 *
 * Mirrors openWakeWord's reference behavior in `openwakeword/utils.py`
 * exactly: pre-prepends 480 samples of historical audio context to every
 * mel call (for STFT continuity), keeps the mel buffer pre-warmed with
 * ones, and pre-warms the embedding buffer with embeddings produced from
 * 4 s of pseudo-random int16 noise so the classifier doesn't see all-
 * zero padding before real speech arrives.
 *
 * Per 1280-sample audio chunk:
 *   1. Prepend last 480 samples of audio history → 1760 samples → mel.
 *   2. Apply mel transform: x/10 + 2.
 *   3. Append all new mel frames to the rolling mel buffer.
 *   4. Take the latest 76 mel frames → embedding model → 96-dim vector.
 *   5. Append embedding to the rolling classifier window.
 *   6. Run classifier on the latest 16 embeddings → wake-word probability.
 */

import { compileOwwModel } from './model-runner.js';
import {
  MELSPECTROGRAM_SHAPES_1280,
  MELSPECTROGRAM_SHAPES_1760,
} from './melspectrogram-shapes.js';
import { FusedOwwGpuFrontend } from './gpu/fused-frontend.js';

export const CHUNK_SAMPLES = 1280;
export const MEL_BINS = 32;
export const MEL_WINDOW = 76;
export const EMBEDDING_DIM = 96;
export const EMBEDDING_WINDOW = 16;
const MEL_PREFIX_SAMPLES = 160 * 3;
const MEL_BUFFER_MAX = 970;

/**
 * Compile a model from raw .tflite bytes.  Mel spec needs the 1760-sample
 * shape override; the embedding model and classifiers compile bare.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {'melspectrogram'|'embedding'|'classifier'} kind
 */
export function compileModel(arrayBuffer, kind) {
  if (kind === 'melspectrogram') {
    return compileOwwModel(arrayBuffer, {
      tensorShapeOverrides: MELSPECTROGRAM_SHAPES_1760,
    });
  }
  return compileOwwModel(arrayBuffer);
}

/**
 * Compile a mel spec model bound to a single-chunk (1280-sample) input
 * shape.  Used only for unit tests / validation against the pre-streaming
 * reference dump - the streaming pipeline always uses the 1760 variant.
 */
export function compileMelspectrogramSingleChunk(arrayBuffer) {
  return compileOwwModel(arrayBuffer, {
    tensorShapeOverrides: MELSPECTROGRAM_SHAPES_1280,
  });
}

/**
 * Streaming inference engine - feed one 1280-sample int16 PCM chunk at a
 * time and read back wake-word probabilities.
 *
 * Multiple classifiers share the same mel spec + embedding stages so
 * running two simultaneous wake words (slot 1 + slot 2) costs only one
 * extra classifier inference per chunk on top of the shared front-end.
 */
export class OwwInference {
  /**
   * @param {object} models
   * @param {ReturnType<typeof compileOwwModel>} models.melspectrogram - 1760-sample variant
   * @param {ReturnType<typeof compileOwwModel>} models.embedding
   * @param {object<string, ReturnType<typeof compileOwwModel>>} [models.classifiers]
   *   Map of wake-word name → compiled classifier.  Either this or
   *   `classifier` must be provided.
   * @param {ReturnType<typeof compileOwwModel>} [models.classifier]
   *   Single-classifier convenience form - equivalent to
   *   `{ classifiers: { default: classifier } }`.
   */
  constructor({
    melspectrogram, embedding, classifiers, classifier,
    embeddingGpuRunner, melspectrogramGpuRunner,
  }) {
    this.melspec = melspectrogram;
    this.embedding = embedding;
    // Optional GPU-accelerated runners.  Each model can independently
    // run on the GPU - embedding is the heavyweight one (~80 ms CPU JS
    // on Pixel tablet → ~5 ms GPU), mel spec is the secondary cost
    // (~28 ms → ~5 ms on tablet).  Classifiers always stay on CPU
    // (already <1 ms each).
    this._embeddingGpuRunner = embeddingGpuRunner || null;
    this._melGpuRunner = melspectrogramGpuRunner || null;
    this._fusedGpuFrontend = null;
    if (this._melGpuRunner && this._embeddingGpuRunner) {
      try {
        this._fusedGpuFrontend = new FusedOwwGpuFrontend(this._melGpuRunner, this._embeddingGpuRunner);
      } catch (err) {
        console.warn('openWakeWord fused GPU frontend unavailable; falling back to unfused GPU path', err);
      }
    }
    if (!classifiers && classifier) classifiers = { default: classifier };
    if (!classifiers || Object.keys(classifiers).length === 0) {
      throw new Error('OwwInference: must provide at least one classifier');
    }
    this.classifiers = classifiers;
    this._classifierEntries = Object.entries(classifiers);
    this._probOutput = {};
    this._lastTimings = null;

    // Audio history: last 480 samples, prepended to each new chunk so
    // the mel CNN can produce continuous STFT frames across the chunk
    // boundary.  Initialized to zeros - matches the upstream behavior
    // for the very first call.
    this._audioHistory = new Float32Array(MEL_PREFIX_SAMPLES);
    // Mel input scratch buffer (1760 samples).
    this._melInput = new Float32Array(CHUNK_SAMPLES + MEL_PREFIX_SAMPLES);

    // Pre-allocated state objects so we don't recompile/realloc per call.
    this._melState = this.melspec.createState();
    this._embeddingState = this.embedding.createState();
    // One state per classifier (each classifier may have its own internal
    // state, e.g. the IF-branch BatchNorm in hey_jarvis subgraph 0).
    this._classifierStates = {};
    for (const [name, model] of this._classifierEntries) {
      this._classifierStates[name] = model.createState();
    }
    // Reusable rolling input buffer for the classifier stage. It always
    // holds the latest 16 embeddings in chronological order, so we do not
    // rebuild a classifier window from a larger feature history per chunk.
    this._classifierInput = new Float32Array(EMBEDDING_WINDOW * EMBEDDING_DIM);

    // Rolling buffers - sized just shy of the upper bounds we'll trim to.
    // Mel and embedding buffers are flat ring storage so per-chunk
    // appends don't allocate.  The mel buffer's effective length is
    // tracked by `_melBufferLen`; new frames are written at the head
    // and old ones drop off when we exceed MEL_BUFFER_MAX.
    this._melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS);
    this._melBufferLen = 0;
    // Initialize mel buffer with ones (76 × 32) - openWakeWord upstream.
    this._initMelBuffer();
    // Warmup is now async-capable so it can drive the GPU embedding
    // runner - caller must `await this.ready` before the first
    // processChunk.  CPU-only callers can ignore the promise (it
    // resolves synchronously within the same microtask).
    this.ready = this._warmupFeatureBuffer();
  }

  _initMelBuffer() {
    // Match openWakeWord's `melspectrogram_buffer = np.ones((76, 32))`.
    this._melBuffer.fill(1, 0, MEL_WINDOW * MEL_BINS);
    this._melBufferLen = MEL_WINDOW;
  }

  /**
   * Match openWakeWord's `feature_buffer = self._get_embeddings(noise)`
   * pattern, but only fill enough chunks to populate the classifier's
   * input window.  Upstream pre-fills 50 chunks (4 s of audio); we only
   * need the latest 16 (= EMBEDDING_WINDOW) for the classifier to fire
   * on the very first real chunk, and any additional pre-fill is just
   * noise that gets pushed out of the window over the next 1.3 s
   * anyway.  Cutting from 50 → 16 saves ~70 % of init time on slow
   * tablets where each warmup chunk runs the full mel + embedding
   * pipeline (~30 ms × 50 = 1.5 s on a Pixel-class device).
   */
  async _warmupFeatureBuffer() {
    const WARMUP_CHUNKS = EMBEDDING_WINDOW;
    // Deterministic pseudo-random noise.  16 chunks × 1280 samples each,
    // values in int16 range to match the live audio scaling done by
    // OwwBackend (samples * 32768 before reaching this code path).
    const audio = new Float32Array(WARMUP_CHUNKS * CHUNK_SAMPLES);
    let state = 0x9E3779B1;  // Weyl sequence seed
    for (let i = 0; i < audio.length; i++) {
      state = (state + 0x9E3779B1) >>> 0;
      // Map [0, 0xFFFFFFFF] → [-1000, 1000)
      audio[i] = Math.floor((state / 0x100000000) * 2000) - 1000;
    }

    const history = new Float32Array(MEL_PREFIX_SAMPLES);
    const input = new Float32Array(CHUNK_SAMPLES + MEL_PREFIX_SAMPLES);

    const nChunks = WARMUP_CHUNKS;
    for (let c = 0; c < nChunks; c++) {
      input.set(history, 0);
      input.set(audio.subarray(c * CHUNK_SAMPLES, (c + 1) * CHUNK_SAMPLES), MEL_PREFIX_SAMPLES);
      history.set(audio.subarray((c + 1) * CHUNK_SAMPLES - MEL_PREFIX_SAMPLES, (c + 1) * CHUNK_SAMPLES));

      const emb = await this._runFrontend(input);
      this._appendEmbedding(emb);
    }
  }

  _appendEmbedding(emb) {
    this._classifierInput.copyWithin(0, EMBEDDING_DIM);
    this._classifierInput.set(emb, (EMBEDDING_WINDOW - 1) * EMBEDDING_DIM);
  }

  /**
   * Wipe per-stream history so the next chunk is processed as if from a
   * cold start.  Required when wake-word inference resumes after the
   * mic was diverted (e.g. STT) - without this, the classifier's 16-frame
   * embedding window still holds the embeddings around the original
   * detection, and the very first post-resume classification fires
   * 0.95+ on what the model thinks is still "ok nabu" history.
   *
   * Cheap (no model invocations): zeros out audio history + mel buffer,
   * recreates per-model TFLite state, fills the classifier window with
   * zero-embeddings.  Recall: ok_nabu(zeros) ≈ 1e-3 in our offline tests,
   * so an all-zero classifier window produces near-zero score until real
   * audio embeddings replace the reset state.
   */
  reset() {
    this._audioHistory.fill(0);
    this._initMelBuffer();
    this._melState = this.melspec.createState();
    this._embeddingState = this.embedding.createState();
    if (this._fusedGpuFrontend) this._fusedGpuFrontend.reset();
    for (const [name, model] of this._classifierEntries) {
      this._classifierStates[name] = model.createState();
    }
    this._classifierInput.fill(0);
  }

  destroy() {
    this._fusedGpuFrontend?.destroy?.();
    this._fusedGpuFrontend = null;
    this._melGpuRunner?.destroy?.();
    this._embeddingGpuRunner?.destroy?.();
    this._melGpuRunner = null;
    this._embeddingGpuRunner = null;
  }

  consumeLastTimings() {
    const out = this._lastTimings;
    this._lastTimings = null;
    return out;
  }

  async _runFrontend(melInput, timings = null) {
    if (this._fusedGpuFrontend) {
      const t0 = timings ? nowMs() : 0;
      const emb = await this._fusedGpuFrontend.invoke(melInput);
      if (timings) {
        timings.frontendMs = nowMs() - t0;
        timings.fusedFrontend = true;
      }
      return emb;
    }

    const melStart = timings ? nowMs() : 0;
    const melOut = this._melGpuRunner
      ? await this._melGpuRunner.invoke(melInput)
      : this.melspec.invoke(melInput, { state: this._melState });
    if (timings) timings.melMs = nowMs() - melStart;

    const appendStart = timings ? nowMs() : 0;
    this._appendMelFrames(melOut);
    if (timings) timings.melAppendMs = nowMs() - appendStart;

    const embIn = this._latestMelWindow();
    const embeddingStart = timings ? nowMs() : 0;
    const emb = this._embeddingGpuRunner
      ? this._embeddingGpuRunner.invoke(embIn)
      : this.embedding.invoke(embIn, { state: this._embeddingState });
    const resolved = await emb;
    if (timings) {
      timings.embeddingMs = nowMs() - embeddingStart;
      timings.frontendMs = (timings.melMs || 0) + (timings.melAppendMs || 0) + timings.embeddingMs;
      timings.fusedFrontend = false;
    }
    return resolved;
  }

  /**
   * Apply x/10 + 2 to mel output and append each frame to the flat ring
   * buffer.  When the buffer would exceed MEL_BUFFER_MAX frames we
   * memmove the trailing window down to the front instead of growing.
   */
  _appendMelFrames(melOut) {
    const numFrames = (melOut.length / MEL_BINS) | 0;
    const buf = this._melBuffer;
    let len = this._melBufferLen;
    // If appending would overflow, slide the buffer so the trailing
    // (MEL_BUFFER_MAX - numFrames) frames stay at the front.
    if (len + numFrames > MEL_BUFFER_MAX) {
      const keep = MEL_BUFFER_MAX - numFrames;
      const dropFrames = len - keep;
      buf.copyWithin(0, dropFrames * MEL_BINS, len * MEL_BINS);
      len = keep;
    }
    const writeOff = len * MEL_BINS;
    for (let i = 0; i < numFrames * MEL_BINS; i++) {
      buf[writeOff + i] = melOut[i] * 0.1 + 2;
    }
    this._melBufferLen = len + numFrames;
  }

  /** Pack the latest 76 mel frames into the embedding model's input. */
  _latestMelWindow() {
    if (!this._embeddingInput) {
      this._embeddingInput = new Float32Array(MEL_WINDOW * MEL_BINS);
    }
    const out = this._embeddingInput;
    const start = (this._melBufferLen - MEL_WINDOW) * MEL_BINS;
    out.set(this._melBuffer.subarray(start, start + MEL_WINDOW * MEL_BINS));
    return out;
  }

  /**
   * Ingest one chunk's audio WITHOUT running the embedding or
   * classifiers - the backpressure path for stale chunks.  Keeps the
   * audio history and the rolling mel window (GPU-resident on the
   * fused path, CPU buffer otherwise) gap-free so the next full
   * processChunk operates on current, contiguous features.  Costs the
   * mel stage only - the embedding model is the dominant per-chunk
   * cost this path exists to skip.
   *
   * Same input contract as processChunk (int16-range float32).
   *
   * @param {Float32Array} chunk - exactly CHUNK_SAMPLES = 1280 samples
   */
  async ingestChunk(chunk) {
    if (chunk.length !== CHUNK_SAMPLES) {
      throw new Error(`Chunk must be exactly ${CHUNK_SAMPLES} samples, got ${chunk.length}`);
    }
    this._melInput.set(this._audioHistory, 0);
    this._melInput.set(chunk, MEL_PREFIX_SAMPLES);
    this._audioHistory.set(chunk.subarray(CHUNK_SAMPLES - MEL_PREFIX_SAMPLES));

    if (this._fusedGpuFrontend) {
      this._fusedGpuFrontend.ingest(this._melInput);
      return;
    }
    const melOut = this._melGpuRunner
      ? await this._melGpuRunner.invoke(this._melInput)
      : this.melspec.invoke(this._melInput, { state: this._melState });
    this._appendMelFrames(melOut);
  }

  /**
   * Feed one 1280-sample chunk of audio.  Audio values must be int16-range
   * float32 (i.e. raw PCM cast to float, NOT divided by 32767) to match
   * openWakeWord's training-time preprocessing.
   *
   * @param {Float32Array} chunk - exactly CHUNK_SAMPLES = 1280 samples
   * @param {object} [opts]
   * @param {Set<string>} [opts.activeKeywords] - if set, only the named
   *   classifiers run inference this chunk; inactive ones are skipped
   *   entirely (no probability emitted).  Mirrors microWakeWord's
   *   addKeyword/removeKeyword physical-attach pattern: stop-only mode
   *   skips the wake-word classifiers, normal listening skips the stop
   *   classifier - saves the per-chunk classifier inference time.
   * @returns {{probs: object<string, number>}}
   */
  async processChunk(chunk, opts = {}) {
    if (chunk.length !== CHUNK_SAMPLES) {
      throw new Error(`Chunk must be exactly ${CHUNK_SAMPLES} samples, got ${chunk.length}`);
    }
    const activeKeywords = opts.activeKeywords || null;
    const timings = opts.collectTimings ? {
      engine: 'oww',
      fusedFrontend: !!this._fusedGpuFrontend,
    } : null;
    const totalStart = timings ? nowMs() : 0;

    // Stage 1: build [history(480) || chunk(1280)] and run mel spec.
    const prepareStart = timings ? totalStart : 0;
    this._melInput.set(this._audioHistory, 0);
    this._melInput.set(chunk, MEL_PREFIX_SAMPLES);
    // Save the trailing 480 samples as the next call's history.
    this._audioHistory.set(chunk.subarray(CHUNK_SAMPLES - MEL_PREFIX_SAMPLES));
    if (timings) timings.prepareMs = nowMs() - prepareStart;

    // Stage 2: one embedding from the latest 76 mel frames (shared across
    // all classifiers).  When both WebGPU runners are available, the mel
    // output stays on the GPU and feeds the embedding input without a JS
    // readback/upload in between.
    const emb = await this._runFrontend(this._melInput, timings);
    this._appendEmbedding(emb);

    // Stage 3: classify the latest 16 embeddings - only for active
    // classifiers.  Inactive ones are skipped entirely (no inference
    // run), matching microWakeWord's addKeyword/removeKeyword behavior.
    const probs = this._probOutput;
    for (let i = 0; i < this._classifierEntries.length; i++) {
      delete probs[this._classifierEntries[i][0]];
    }
    const classifyStart = timings ? nowMs() : 0;
    for (const [name, model] of this._classifierEntries) {
      if (activeKeywords && !activeKeywords.has(name)) continue;
      const out = model.invoke(this._classifierInput, { state: this._classifierStates[name] });
      probs[name] = out[0];
    }
    if (timings) {
      timings.classifyMs = nowMs() - classifyStart;
      timings.inferenceTotalMs = nowMs() - totalStart;
      this._lastTimings = timings;
    }

    return { probs };
  }
}

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}
