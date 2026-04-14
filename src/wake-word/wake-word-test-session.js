/**
 * Standalone Wake Word Test Session
 *
 * Self-contained mic + AudioContext + AudioWorklet + wake-word inference
 * loop used by the sidebar panel's Wake Word Tester card. Independent
 * of the main wake word engine — works whether the engine is dormant,
 * running with on-device wake word, or using HA-side wake word.
 *
 * Uses an *isolated* model runner (createIsolatedModelRunner) so it can
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
    this._threshold = null;
    this._sampleBuf = new Float32Array(CHUNK_SIZE * 2);
    this._sampleBufLen = 0;
    this._frameQueue = [];
    this._processing = false;
    this._running = false;
    this._detectionSeq = 0;
    this._lastDetectionAt = 0;
    this._lastDetectionInfo = null;

    // Resampler scratch buffer
    this._resampleBuf = null;
    this._resampleBufLen = 0;

    // Per-session event log.  Panel subscribes via `onLogMessage()` and renders
    // the entries in the Wake Word Tester's log pane instead of the browser
    // console.  Categories: 'diag' (probability/RMS trace), 'trigger' (a
    // detection fired), 'info' (lifecycle), 'warn' (clip-guard, etc).
    this._logSubscribers = new Set();
    this._instanceLog = {
      log: (cat, msg) => this._emitLog(cat, msg),
      error: (cat, msg) => this._emitLog('warn', `[${cat}] ${msg}`),
    };

    // Rolling capture for offline inspection.  Holds the most recent
    // CAPTURE_SECONDS of 16 kHz mono Float32 samples that were fed to the
    // frontend, so the user can dump exactly what the JS pipeline saw right
    // before a (possibly false) trigger.  Overwrites itself — ring buffer.
    this._captureSeconds = 6;
    this._captureBuf = new Float32Array(TARGET_RATE * this._captureSeconds);
    this._captureHead = 0;      // next write index
    this._captureFilled = 0;    // total samples ever written (for "how full")
  }

  /**
   * Export the last few seconds of audio fed to the frontend as a 16 kHz
   * mono WAV (Int16 PCM).  Triggers a browser download.  Useful when live
   * probabilities diverge from offline WAV tests — the returned file is the
   * exact signal the JS frontend processed, including mic + DSP + resampling.
   */
  exportCapture(filename = 'voice-satellite-capture.wav') {
    const n = Math.min(this._captureFilled, this._captureBuf.length);
    if (n === 0) return false;
    // Rotate ring buffer so the oldest sample is first.
    const out = new Float32Array(n);
    if (this._captureFilled < this._captureBuf.length) {
      out.set(this._captureBuf.subarray(0, n));
    } else {
      out.set(this._captureBuf.subarray(this._captureHead));
      out.set(this._captureBuf.subarray(0, this._captureHead), this._captureBuf.length - this._captureHead);
    }
    // Float32 [-1, 1] → Int16 PCM.
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = out[i] * 32768;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      pcm[i] = v | 0;
    }
    // Build a minimal WAV container.
    const header = new ArrayBuffer(44);
    const dv = new DataView(header);
    const writeAscii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    const byteLen = pcm.byteLength;
    writeAscii(0, 'RIFF');  dv.setUint32(4, 36 + byteLen, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');  dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);              // PCM
    dv.setUint16(22, 1, true);              // mono
    dv.setUint32(24, TARGET_RATE, true);
    dv.setUint32(28, TARGET_RATE * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeAscii(36, 'data');  dv.setUint32(40, byteLen, true);
    const blob = new Blob([header, pcm.buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  get running() { return this._running; }
  get latestRms() { return this._inference?.latestRms ?? 0; }
  get detectionSeq() { return this._detectionSeq; }
  get lastDetectionAt() { return this._lastDetectionAt; }
  get lastDetectionInfo() { return this._lastDetectionInfo; }
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
    this._threshold = typeof opts.threshold === 'number' ? opts.threshold : null;
    this._detectionSeq = 0;
    this._lastDetectionAt = 0;
    this._lastDetectionInfo = null;

    await this._acquireMic();
    await this._setupAudioContext();
    await this._setupWorklet();
    await this._setupInference();

    this._running = true;
    // Park a convenience pointer on window so a user can trigger a capture
    // export from the browser devtools: `__vsTester.exportCapture()`.
    try { if (typeof window !== 'undefined') window.__vsTester = this; } catch (_) {}
  }

  /** Tear down the entire test loop and release resources. */
  async stop() {
    this._running = false;
    this._frameQueue.length = 0;
    this._sampleBufLen = 0;
    this._detectionSeq = 0;
    this._lastDetectionAt = 0;
    this._lastDetectionInfo = null;

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

    if (this._inference) {
      try { this._inference.destroy(); } catch (_) {}
      this._inference = null;
    }
  }

  /**
   * Switch to a different wake word model (tears down inference and rebuilds).
   * @param {string} modelName
   */
  async switchModel(modelName, opts = {}) {
    const nextThreshold =
      typeof opts.threshold === 'number' ? opts.threshold : this._threshold;
    if (modelName === this._modelName && nextThreshold === this._threshold) return;
    if (!this._running) {
      this._modelName = modelName;
      this._threshold = nextThreshold;
      return;
    }
    this._modelName = modelName;
    this._threshold = nextThreshold;
    this._detectionSeq = 0;
    this._lastDetectionAt = 0;
    this._lastDetectionInfo = null;

    if (this._isolatedRunner) {
      try { this._isolatedRunner.cleanUp?.(); } catch (_) {}
      this._isolatedRunner = null;
    }
    if (this._inference) {
      try { this._inference.destroy(); } catch (_) {}
      this._inference = null;
    }
    await this._setupInference();
  }

  setThreshold(threshold) {
    this._threshold = typeof threshold === 'number' ? threshold : null;
    if (!this._running || !this._inference || !this._modelName) return;
    this._inference.updateThresholds([{
      name: this._modelName,
      threshold: this._threshold ?? getMicroModelParams(this._modelName).cutoff,
    }]);
  }

  // ─── Internal setup ─────────────────────────────────────────────────

  async _acquireMic() {
    // Mirror the main engine's mic constraints so the tester runs against
    // the same processed signal the engine will see at runtime. If the
    // caller didn't supply constraints, default to "raw" — every DSP off —
    // so the user tests against the unmodified mic.
    const c = this._constraints || {};
    const requested = {
      echoCancellation: c.echoCancellation === true,
      noiseSuppression: c.noiseSuppression === true,
      autoGainControl: c.autoGainControl === true,
      voiceIsolation: c.voiceIsolation === true,
    };
    const audioConstraints = {
      sampleRate: TARGET_RATE,
      channelCount: 1,
      echoCancellation: requested.echoCancellation,
      noiseSuppression: requested.noiseSuppression,
      autoGainControl: requested.autoGainControl,
    };
    if (requested.voiceIsolation) {
      audioConstraints.advanced = [{ voiceIsolation: true }];
    }
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    // Surface both the requested DSP toggles and what the browser actually
    // applied, so the user can see at a glance whether their mic driver
    // honored the request or silently overrode it (common on Windows with
    // some USB mics).
    this._emitLog(
      'info',
      `DSP requested: EC=${requested.echoCancellation} `
      + `NS=${requested.noiseSuppression} AGC=${requested.autoGainControl} `
      + `VI=${requested.voiceIsolation}`,
    );
    try {
      const track = this._stream.getAudioTracks()[0];
      if (track) {
        const s = track.getSettings() || {};
        const label = track.label ? ` "${track.label}"` : '';
        this._emitLog(
          'info',
          `DSP applied:   EC=${!!s.echoCancellation} NS=${!!s.noiseSuppression} `
          + `AGC=${!!s.autoGainControl} VI=${!!s.voiceIsolation} `
          + `rate=${s.sampleRate ?? '?'}Hz ch=${s.channelCount ?? '?'}${label}`,
        );
        // Call out mismatches between what we asked for and what the driver
        // actually gave us — these are the common root cause of "I turned
        // AGC off but clipping guard still fires" reports.
        const mism = [];
        for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'voiceIsolation']) {
          if (!!s[key] !== requested[key]) mism.push(`${key}: requested ${requested[key]}, got ${!!s[key]}`);
        }
        if (mism.length) {
          this._emitLog('warn', `mic driver overrode DSP request — ${mism.join('; ')}`);
        }
      }
    } catch (_) { /* best-effort diagnostic */ }
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
    const runtime = await loadTFLite();
    this._isolatedRunner = await createIsolatedModelRunner(runtime, this._modelName);
    const params = getMicroModelParams(this._modelName);

    this._inference = await MicroWakeWordInference.create(
      [{
        runner: this._isolatedRunner,
        name: this._modelName,
        cutoff: this._threshold ?? params.cutoff,
        slidingWindow: params.slidingWindow,
        stepSize: params.stepSize,
        inputScale: params.inputScale,
        inputZeroPoint: params.inputZeroPoint,
      }],
      this._instanceLog,
      'Moderately sensitive',
      false, // energy gate disabled — keep RMS readout always live
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

    // Ring-buffer the post-resample samples so `exportCapture()` can write
    // out the exact signal the frontend saw.
    const cap = this._captureBuf;
    let head = this._captureHead;
    for (let i = 0; i < s.length; i++) {
      cap[head] = s[i];
      head = (head + 1) % cap.length;
    }
    this._captureHead = head;
    this._captureFilled += s.length;

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
          const result = await this._inference.processChunk(frame);
          if (result?.detected) {
            this._detectionSeq++;
            this._lastDetectionAt =
              (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? performance.now()
                : Date.now();
            this._lastDetectionInfo = result;
            const model = result.model ?? this._modelName ?? '?';
            const mean = typeof result.score === 'number' ? result.score.toFixed(3) : '?';
            const cutoff = typeof result.cutoff === 'number' ? result.cutoff.toFixed(2) : '?';
            this._emitLog(
              'trigger',
              `DETECTED "${model}" mean=${mean} cutoff=${cutoff} rms=${(result.rms ?? 0).toFixed(3)}`,
            );
          }
        } catch (_) { /* swallow — the tester is best-effort */ }
      }
    } finally {
      this._processing = false;
    }
  }

  /**
   * Subscribe to tester log events.  Returns an unsubscribe function.
   * The callback receives `(category, message, timestamp)`.  Categories:
   * 'diag', 'trigger', 'info', 'warn'.
   */
  onLogMessage(cb) {
    if (typeof cb !== 'function') return () => {};
    this._logSubscribers.add(cb);
    return () => this._logSubscribers.delete(cb);
  }

  _emitLog(cat, msg) {
    if (!msg || !this._logSubscribers.size) return;
    const ts = Date.now();
    for (const cb of this._logSubscribers) {
      try { cb(cat, msg, ts); } catch (_) { /* ignore */ }
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
