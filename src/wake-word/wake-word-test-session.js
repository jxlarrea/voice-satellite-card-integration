/**
 * Standalone Wake Word Test Session
 *
 * Self-contained mic + AudioContext + AudioWorklet + TFLite inference
 * loop used by the sidebar panel's Wake Word Tester card. Independent
 * of the main wake word engine — works whether the engine is dormant,
 * running with on-device wake word, or using HA-side wake word.
 *
 * Uses an *isolated* TFLite runner (createIsolatedModelRunner) so it can
 * run in parallel with the main engine without sharing — and corrupting —
 * the cached runner's stateful VarHandleOps.
 */

import {
  loadTFLite,
  createIsolatedModelRunner,
  getMicroModelParams,
} from './micro-models.js';
import { MicroWakeWordInference } from './micro-inference.js';

const CHUNK_SIZE = 1280; // 80ms @ 16 kHz
const TARGET_RATE = 16000;

// Silent logger — the tester shouldn't spam the console.
const SILENT_LOG = { log: () => {}, error: () => {} };

export class WakeWordTestSession {
  constructor() {
    this._modelName = null;
    this._stream = null;
    this._audioContext = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._silentGain = null;
    this._inference = null;
    this._isolatedRunner = null;
    this._actualSampleRate = TARGET_RATE;
    this._sampleBuf = new Float32Array(CHUNK_SIZE * 2);
    this._sampleBufLen = 0;
    this._frameQueue = [];
    this._processing = false;
    this._running = false;

    // Resampler scratch buffer
    this._resampleBuf = null;
    this._resampleBufLen = 0;
  }

  get running() { return this._running; }
  get latestRms() { return this._inference?.latestRms ?? 0; }
  /**
   * Sliding-window mean over recent inferences — what the engine actually
   * compares against the cutoff. The Wake Word Tester graphs this value.
   */
  getLatestSmoothedProbability() {
    return this._inference?.getLatestSmoothedProbability(this._modelName) ?? 0;
  }

  /**
   * Start the wake word tester loop with the given model name.
   * @param {string} modelName
   * @param {object} [opts]
   * @param {object} [opts.constraints] - Browser DSP constraints to mirror the
   *   main engine's mic settings (echoCancellation, noiseSuppression,
   *   autoGainControl, voiceIsolation). The tester must run with the same
   *   browser DSP that the engine will use at runtime so the live readouts
   *   match what the engine sees.
   */
  async start(modelName, opts = {}) {
    if (this._running) await this.stop();
    this._modelName = modelName;
    this._constraints = opts.constraints || null;

    await this._acquireMic();
    await this._setupAudioContext();
    await this._setupWorklet();
    await this._setupInference();

    this._running = true;
  }

  /** Tear down the entire test loop and release resources. */
  async stop() {
    this._running = false;
    this._frameQueue.length = 0;
    this._sampleBufLen = 0;

    try { this._sourceNode?.disconnect(); } catch (_) {}
    try { this._workletNode?.disconnect(); } catch (_) {}
    try { this._silentGain?.disconnect(); } catch (_) {}
    this._sourceNode = null;
    this._workletNode = null;
    this._silentGain = null;

    if (this._stream) {
      try { this._stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      this._stream = null;
    }

    if (this._audioContext) {
      try { await this._audioContext.close(); } catch (_) {}
      this._audioContext = null;
    }

    if (this._isolatedRunner) {
      try { this._isolatedRunner.cleanUp?.(); } catch (_) {}
      this._isolatedRunner = null;
    }

    this._inference = null;
  }

  /**
   * Switch to a different wake word model (tears down inference and rebuilds).
   * @param {string} modelName
   */
  async switchModel(modelName) {
    if (modelName === this._modelName || !this._running) return;
    this._modelName = modelName;

    if (this._isolatedRunner) {
      try { this._isolatedRunner.cleanUp?.(); } catch (_) {}
      this._isolatedRunner = null;
    }
    this._inference = null;

    await this._setupInference();
  }

  // ─── Internal setup ─────────────────────────────────────────────────

  async _acquireMic() {
    // Mirror the main engine's mic constraints so the tester runs against
    // the same processed signal the engine will see at runtime. If the
    // caller didn't supply constraints, default to "raw" — every DSP off —
    // so the user tests against the unmodified mic.
    const c = this._constraints || {};
    const audioConstraints = {
      sampleRate: TARGET_RATE,
      channelCount: 1,
      echoCancellation: c.echoCancellation === true,
      noiseSuppression: c.noiseSuppression === true,
      autoGainControl: c.autoGainControl === true,
    };
    if (c.voiceIsolation === true) {
      audioConstraints.advanced = [{ voiceIsolation: true }];
    }
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });
  }

  async _setupAudioContext() {
    try {
      this._audioContext = new AudioContext({ sampleRate: TARGET_RATE });
    } catch (_) {
      this._audioContext = new AudioContext();
    }
    this._actualSampleRate = this._audioContext.sampleRate;
    if (this._audioContext.state === 'suspended') {
      try { await this._audioContext.resume(); } catch (_) {}
    }
  }

  async _setupWorklet() {
    // 10 render quanta = 1280 samples at 128/quanta. The worklet name is
    // distinct from the main engine's so they coexist on a shared origin.
    const BATCH_QUANTA = 10;
    const code =
      'var B=' + BATCH_QUANTA + ';' +
      'class VsCalibProc extends AudioWorkletProcessor{' +
      'constructor(){super();this._buf=null;this._sz=0;this._pos=0;}' +
      'process(inputs){' +
      'var input=inputs[0];' +
      'if(input&&input[0]){' +
      'var ch=input[0];var len=ch.length;' +
      'if(!this._buf){this._sz=len*B;this._buf=new Float32Array(this._sz);}' +
      'this._buf.set(ch,this._pos);this._pos+=len;' +
      'if(this._pos>=this._sz){' +
      'this.port.postMessage(this._buf,[this._buf.buffer]);' +
      'this._buf=new Float32Array(this._sz);this._pos=0;}}' +
      'return true;}}' +
      'registerProcessor("vs-calib-processor",VsCalibProc);';

    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this._audioContext.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);
    this._workletNode = new AudioWorkletNode(this._audioContext, 'vs-calib-processor');
    this._workletNode.port.onmessage = (e) => this._onAudioChunk(e.data);
    this._sourceNode.connect(this._workletNode);

    // Silent gain keeps the graph alive without routing mic to speakers.
    this._silentGain = this._audioContext.createGain();
    this._silentGain.gain.value = 0;
    this._workletNode.connect(this._silentGain);
    this._silentGain.connect(this._audioContext.destination);
  }

  async _setupInference() {
    const tfweb = await loadTFLite();
    this._isolatedRunner = await createIsolatedModelRunner(tfweb, this._modelName);
    const params = getMicroModelParams(this._modelName);

    this._inference = await MicroWakeWordInference.create(
      [{
        runner: this._isolatedRunner,
        name: this._modelName,
        // Use the model's natural cutoff. The tester is for visualization
        // only — there's no override knob anymore.
        cutoff: params.cutoff,
        slidingWindow: params.slidingWindow,
        stepSize: params.stepSize,
        inputScale: params.inputScale,
        inputZeroPoint: params.inputZeroPoint,
      }],
      SILENT_LOG,
      'Moderately sensitive',
      false, // energy gate disabled — keep RMS readout always live
      false, // direct runner disabled — keep simple Embind path
    );
  }

  // ─── Audio processing ───────────────────────────────────────────────

  _onAudioChunk(samples) {
    if (!this._running || !this._inference) return;

    // Resample to 16 kHz if the AudioContext didn't honor our sampleRate hint.
    let s = samples;
    if (this._actualSampleRate !== TARGET_RATE) {
      s = this._resample(samples, this._actualSampleRate, TARGET_RATE);
    }

    // Buffer and chunk to fixed CHUNK_SIZE frames.
    const needed = this._sampleBufLen + s.length;
    if (needed > this._sampleBuf.length) {
      const newBuf = new Float32Array(needed * 2);
      newBuf.set(this._sampleBuf.subarray(0, this._sampleBufLen));
      this._sampleBuf = newBuf;
    }
    this._sampleBuf.set(s, this._sampleBufLen);
    this._sampleBufLen += s.length;

    while (this._sampleBufLen >= CHUNK_SIZE) {
      const chunk = new Float32Array(CHUNK_SIZE);
      chunk.set(this._sampleBuf.subarray(0, CHUNK_SIZE));
      this._frameQueue.push(chunk);
      this._sampleBuf.copyWithin(0, CHUNK_SIZE, this._sampleBufLen);
      this._sampleBufLen -= CHUNK_SIZE;
    }

    this._drainQueue();
  }

  async _drainQueue() {
    if (this._processing) return;
    this._processing = true;
    try {
      while (this._frameQueue.length > 0 && this._running && this._inference) {
        const frame = this._frameQueue.shift();
        try {
          await this._inference.processChunk(frame);
        } catch (_) { /* swallow — the tester is best-effort */ }
      }
    } finally {
      this._processing = false;
    }
  }

  _resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const outLen = Math.round(input.length / ratio);
    if (outLen !== this._resampleBufLen) {
      this._resampleBuf = new Float32Array(outLen);
      this._resampleBufLen = outLen;
    }
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, input.length - 1);
      const frac = srcIdx - lo;
      this._resampleBuf[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return this._resampleBuf;
  }
}
