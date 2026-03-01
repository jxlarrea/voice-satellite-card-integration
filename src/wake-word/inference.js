/**
 * Wake Word Inference Pipeline
 *
 * Implements the openWakeWord 4-model inference chain:
 * melspectrogram → embedding → VAD → keyword classifier.
 *
 * Processes 1280-sample (80ms @ 16kHz) audio chunks and returns
 * detection results. Stateful — maintains mel buffer, embedding
 * history, and VAD LSTM state across calls.
 *
 * Matches the openWakeWord Python streaming pipeline:
 * - Mel model fed with 480 samples of left context (1760 total) → 8 frames/chunk
 * - Mel input scaled to int16 range (model expects int16-magnitude float32)
 * - Mel buffer pre-filled with ones for immediate embedding warmup
 * - Streaming embedding: one per chunk from the last 76 mel frames
 * - VAD run on 2×640-sample sub-chunks (averaged)
 */

const CHUNK_SIZE = 1280; // 80ms @ 16kHz
const MEL_CONTEXT_SAMPLES = 480; // 3 × hop_length (160) left context
const MEL_INPUT_SIZE = CHUNK_SIZE + MEL_CONTEXT_SAMPLES; // 1760
const MEL_FRAMES_PER_CHUNK = 8; // frames from 1760 samples (with context)
const MEL_BINS = 32;
const MEL_WINDOW = 76; // frames needed for one embedding
const MEL_MAX_BUFFER = 970;
const EMBEDDING_DIM = 96;
const EMBEDDING_MAX_BUFFER = 120;
const DEFAULT_KEYWORD_WINDOW = 16;
const VAD_H_SIZE = 2 * 1 * 64;
const VAD_FRAME_SIZE = 640; // Silero VAD sub-chunk size
const DETECTION_THRESHOLD = 0.5;
const COOLDOWN_MS = 2000;

export class WakeWordInference {
  /**
   * @param {object} ort - onnxruntime-web module
   * @param {{melspec: object, embedding: object, vad: object, keyword: object}} models
   * @param {number} [keywordWindow=16] - keyword model window size
   * @param {number} [threshold=0.5] - detection threshold (0-1, lower = more sensitive)
   */
  constructor(ort, models, keywordWindow = DEFAULT_KEYWORD_WINDOW, threshold = DETECTION_THRESHOLD) {
    this._ort = ort;
    this._models = models;
    this._keywordWindow = keywordWindow;
    this._threshold = threshold;

    // Mel buffer: pre-filled with ones (matching Python reference init)
    this._melBuffer = [];
    for (let i = 0; i < MEL_WINDOW; i++) {
      this._melBuffer.push(new Float32Array(MEL_BINS).fill(1.0));
    }

    // Raw audio context: last 480 samples from previous chunk for mel overlap
    this._melContext = new Float32Array(MEL_CONTEXT_SAMPLES);

    // Embedding history: array of Float32Array(96)
    this._embeddingBuffer = [];

    // VAD state (silero v3: separate h and c, [2, 1, 64])
    this._vadH = new ort.Tensor('float32', new Float32Array(VAD_H_SIZE).fill(0), [2, 1, 64]);
    this._vadC = new ort.Tensor('float32', new Float32Array(VAD_H_SIZE).fill(0), [2, 1, 64]);
    this._vadScores = []; // rolling history for hangover check
    this._vadMaxHistory = 125;

    // Detection state
    this._lastDetectionTime = 0;
  }

  /** @param {number} val */
  set threshold(val) { this._threshold = val; }

  /**
   * Process one 1280-sample audio chunk.
   * Audio must be float32 in [-1, 1] range (Web Audio API format).
   * Internally scales to int16 range for the mel model.
   * @param {Float32Array} samples - 1280 float32 samples pre-resampled to 16kHz
   * @returns {Promise<{detected: boolean, score: number, vadScore: number}>}
   */
  async processChunk(samples) {
    if (samples.length !== CHUNK_SIZE) {
      return { detected: false, score: 0, vadScore: 0 };
    }

    const ort = this._ort;

    // 1. VAD inference (2×640-sample sub-chunks, averaged — matching Python)
    const vadScore = await this._runVad(ort, samples);
    this._vadScores.push(vadScore);
    if (this._vadScores.length > this._vadMaxHistory) {
      this._vadScores.shift();
    }

    // 2. Melspectrogram inference (with 480-sample left context → 8 frames)
    await this._runMelspec(ort, samples);

    // 3. Streaming embedding: one per chunk from the last 76 mel frames
    let newEmbedding = false;
    if (this._melBuffer.length >= MEL_WINDOW) {
      await this._runEmbedding(ort);
      newEmbedding = true;
    }

    // 4. Keyword inference (when enough embeddings accumulated)
    if (newEmbedding && this._embeddingBuffer.length >= this._keywordWindow) {
      const score = await this._runKeyword(ort);
      const speechActive = this._checkVadHangover();

      if (score > this._threshold && speechActive) {
        const now = Date.now();
        if (now - this._lastDetectionTime > COOLDOWN_MS) {
          this._lastDetectionTime = now;
          return { detected: true, score, vadScore };
        }
      }

      return { detected: false, score, vadScore };
    }

    return { detected: false, score: 0, vadScore };
  }

  /**
   * Run Silero VAD on 2×640-sample sub-chunks (matching Python reference).
   * Audio stays in [-1, 1] range (Silero expects normalized audio).
   * @param {object} ort
   * @param {Float32Array} samples - 1280 samples in [-1, 1]
   * @returns {Promise<number>} average speech probability
   */
  async _runVad(ort, samples) {
    const srTensor = new ort.Tensor('int64', new BigInt64Array([16000n]), []);
    let totalScore = 0;
    let count = 0;

    for (let offset = 0; offset < CHUNK_SIZE; offset += VAD_FRAME_SIZE) {
      const chunk = samples.slice(offset, offset + VAD_FRAME_SIZE);
      const inputTensor = new ort.Tensor('float32', chunk, [1, VAD_FRAME_SIZE]);

      const result = await this._models.vad.run({
        input: inputTensor,
        sr: srTensor,
        h: this._vadH,
        c: this._vadC,
      });

      totalScore += result.output.data[0];
      this._vadH = result.hn;
      this._vadC = result.cn;
      count++;
    }

    return totalScore / count;
  }

  /**
   * Run melspectrogram with 480-sample left context (matching Python streaming).
   * Python feeds raw_data_buffer[-n_samples - 480:] to get continuous mel frames.
   * Without context, mel model produces only 5 frames per 1280 samples (missing 3).
   * With 480 context: 1760 samples → 8 continuous frames per chunk.
   * @param {object} ort
   * @param {Float32Array} samples - 1280 samples in [-1, 1]
   */
  async _runMelspec(ort, samples) {
    // Build context + new audio (1760 samples), scaled to int16 range
    const melInput = new Float32Array(MEL_INPUT_SIZE);
    for (let i = 0; i < MEL_CONTEXT_SAMPLES; i++) {
      melInput[i] = this._melContext[i] * 32767;
    }
    for (let i = 0; i < CHUNK_SIZE; i++) {
      melInput[MEL_CONTEXT_SAMPLES + i] = samples[i] * 32767;
    }

    // Save last 480 samples as context for next chunk
    this._melContext = samples.slice(CHUNK_SIZE - MEL_CONTEXT_SAMPLES);

    const inputName = this._models.melspec.inputNames[0];
    const inputTensor = new ort.Tensor('float32', melInput, [1, MEL_INPUT_SIZE]);

    const result = await this._models.melspec.run({ [inputName]: inputTensor });
    const outputName = this._models.melspec.outputNames[0];
    const rawData = result[outputName].data;
    const totalFrames = rawData.length / MEL_BINS;

    // Take the last MEL_FRAMES_PER_CHUNK frames (matching Python: mel[-n_new:])
    const startFrame = totalFrames - MEL_FRAMES_PER_CHUNK;
    for (let i = 0; i < MEL_FRAMES_PER_CHUNK; i++) {
      const frame = new Float32Array(MEL_BINS);
      const srcOffset = (startFrame + i) * MEL_BINS;
      for (let j = 0; j < MEL_BINS; j++) {
        frame[j] = rawData[srcOffset + j] / 10.0 + 2.0;
      }
      this._melBuffer.push(frame);
    }

    // Trim if too large (mel buffer grows, only trimmed at max)
    if (this._melBuffer.length > MEL_MAX_BUFFER) {
      this._melBuffer.splice(0, this._melBuffer.length - MEL_MAX_BUFFER);
    }
  }

  /**
   * Run embedding model on the last 76 mel frames (streaming mode).
   * One embedding per chunk — mel buffer is NOT consumed, just grows.
   */
  async _runEmbedding(ort) {
    // Extract last 76 frames (matching Python streaming: buffer[-76:])
    const start = this._melBuffer.length - MEL_WINDOW;
    const inputData = new Float32Array(MEL_WINDOW * MEL_BINS);
    for (let i = 0; i < MEL_WINDOW; i++) {
      inputData.set(this._melBuffer[start + i], i * MEL_BINS);
    }

    const inputTensor = new ort.Tensor('float32', inputData, [1, MEL_WINDOW, MEL_BINS, 1]);
    const result = await this._models.embedding.run({ input_1: inputTensor });
    const outputName = this._models.embedding.outputNames[0];
    const embeddingData = result[outputName].data;

    // Squeeze [1, 1, 1, 96] → 96-dim vector
    const embedding = new Float32Array(EMBEDDING_DIM);
    embedding.set(embeddingData.subarray(0, EMBEDDING_DIM));
    this._embeddingBuffer.push(embedding);

    // Trim embedding buffer
    if (this._embeddingBuffer.length > EMBEDDING_MAX_BUFFER) {
      this._embeddingBuffer.splice(0, this._embeddingBuffer.length - EMBEDDING_MAX_BUFFER);
    }
  }

  /**
   * Run keyword classifier on the last N embeddings.
   * @returns {Promise<number>} detection score
   */
  async _runKeyword(ort) {
    const window = this._keywordWindow;
    const start = this._embeddingBuffer.length - window;
    const inputData = new Float32Array(window * EMBEDDING_DIM);

    for (let i = 0; i < window; i++) {
      inputData.set(this._embeddingBuffer[start + i], i * EMBEDDING_DIM);
    }

    const inputName = this._models.keyword.inputNames[0];
    const inputTensor = new ort.Tensor('float32', inputData, [1, window, EMBEDDING_DIM]);
    const result = await this._models.keyword.run({ [inputName]: inputTensor });
    const outputName = this._models.keyword.outputNames[0];
    return result[outputName].data[0];
  }

  /**
   * Check VAD hangover — look at scores from ~7-4 frames ago
   * to compensate for keyword model latency.
   * @returns {boolean} true if speech was active recently
   */
  _checkVadHangover() {
    const len = this._vadScores.length;
    if (len < 4) return false;

    // Look at VAD scores from 4-7 frames back (matching Python [-7:-4])
    const lookbackStart = Math.max(0, len - 7);
    const lookbackEnd = Math.max(0, len - 4);
    for (let i = lookbackStart; i < lookbackEnd; i++) {
      if (this._vadScores[i] > 0.5) return true;
    }
    return false;
  }

  /**
   * Reset all internal state (for restarting detection).
   */
  reset() {
    // Re-fill mel buffer with ones (matching Python reference init)
    this._melBuffer = [];
    for (let i = 0; i < MEL_WINDOW; i++) {
      this._melBuffer.push(new Float32Array(MEL_BINS).fill(1.0));
    }
    this._melContext = new Float32Array(MEL_CONTEXT_SAMPLES);
    this._embeddingBuffer = [];
    this._vadH = new this._ort.Tensor('float32', new Float32Array(VAD_H_SIZE).fill(0), [2, 1, 64]);
    this._vadC = new this._ort.Tensor('float32', new Float32Array(VAD_H_SIZE).fill(0), [2, 1, 64]);
    this._vadScores = [];
    this._lastDetectionTime = 0;
  }
}
