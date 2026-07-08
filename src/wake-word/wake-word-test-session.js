/**
 * Standalone Wake Word Test Session
 *
 * Self-contained mic + AudioContext + AudioWorklet + wake-word inference
 * loop used by the sidebar panel's Wake Word Tester card. Independent
 * of the main wake word engine - works whether the engine is dormant,
 * running with on-device wake word, or using HA-side wake word.
 *
 * Uses its own worker-backed inference session so it can run independently
 * of the main wake-word engine.
 */

import { WorkerProxyBackend } from './worker/proxy-backend.js';
import { describeAudioInputDevices, describeSelectedAudioTrack } from '../audio/devices.js';
import { loadVwwModelParams } from './vww/manifest-cache.js';

const CHUNK_SIZE = 1280; // 80ms @ 16 kHz
const TARGET_RATE = 16000;
const CHUNK_DURATION_MS = (CHUNK_SIZE / TARGET_RATE) * 1000;
const SPEECH_ONSET_RMS = 0.020;
const SPEECH_RELEASE_RMS = 0.010;
const SPEECH_RELEASE_CHUNKS = 8;
const SPEECH_ASSOCIATION_WINDOW_MS = 2500;

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
    this._lastLatencyInfo = null;
    this._latencySeq = 0;
    this._processedChunkCount = 0;
    this._thresholdTrackers = new Map();
    this._pendingLatencyFinals = [];
    this._speechActive = false;
    this._speechStartAudioMs = null;
    this._speechLastActiveAudioMs = null;
    this._lastSpeechStartAudioMs = null;
    this._lastSpeechEndAudioMs = null;
    this._speechQuietChunks = 0;

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

    // Rolling capture for offline inspection and diagnostic submission.
    // Holds the most recent CAPTURE_SECONDS of 16 kHz mono Float32 samples
    // that were fed to the frontend, so the user can dump/submit exactly
    // what the JS pipeline saw (mic + DSP + resampling included).
    // Overwrites itself - ring buffer.
    this._captureSeconds = 10;
    this._captureBuf = new Float32Array(TARGET_RATE * this._captureSeconds);
    this._captureHead = 0;      // next write index
    this._captureFilled = 0;    // total samples ever written (for "how full")
    this._workletBatchQuanta = 10;

    // Recent tester log lines (ring).  Snapshotted into diagnostic
    // submissions so the CTC decode/confidence timeline travels with the
    // audio it describes.
    this._recentLog = [];
    this._recentLogMax = 400;

    // Per-chunk inference latency telemetry.  Used to compare CPU MWW vs
    // GPU OWW on the user's actual hardware.  Logs a summary every
    // PERF_LOG_INTERVAL chunks via the 'diag' category so the tester's
    // log pane shows it.
    this._perfTimes = [];           // ring of recent ms readings
    this._perfRingSize = 200;       // last ~16 s at 80 ms/chunk
    this._perfTimingRows = new Array(this._perfRingSize);
    this._perfRingHead = 0;
    this._perfRingFilled = 0;
    this._perfReportEvery = 25;     // 25 chunks ≈ 2 s
    this._perfChunksSinceReport = 0;
    this._rmsHistory = new Float32Array(25); // ~2 s at 80 ms/chunk
    this._rmsHistoryHead = 0;
    this._rmsHistoryFilled = 0;
    this._micHealth = null;
    this._micHealthTimer = null;
  }

  /**
   * Export the last few seconds of audio fed to the frontend as a 16 kHz
   * mono WAV (Int16 PCM).  Triggers a browser download.  Useful when live
   * probabilities diverge from offline WAV tests - the returned file is the
   * exact signal the JS frontend processed, including mic + DSP + resampling.
   */
  exportCapture(filename = 'voice-satellite-capture.wav') {
    const wav = this.getCaptureWavBlob();
    if (!wav) return false;
    const url = URL.createObjectURL(wav.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  /**
   * Snapshot the rolling capture as a 16 kHz mono 16-bit PCM WAV Blob.
   * Returns { blob, seconds } or null when nothing has been captured.
   * Survives stop() - the ring is only overwritten by a new session.
   */
  getCaptureWavBlob() {
    const n = Math.min(this._captureFilled, this._captureBuf.length);
    if (n === 0) return null;
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
    return {
      blob: new Blob([header, pcm.buffer], { type: 'audio/wav' }),
      seconds: n / TARGET_RATE,
    };
  }

  /**
   * Recent tester log lines (oldest first) formatted for diagnostic
   * submission - covers at least the same window as the audio capture.
   */
  getRecentLogLines(max = 250) {
    const entries = this._recentLog.slice(-max);
    return entries.map((e) => `${new Date(e.ts).toISOString()} [${e.cat}] ${e.msg}`);
  }

  /**
   * Settings + runtime context for diagnostic submissions.
   */
  getDiagnosticInfo() {
    const perf = [];
    for (let i = 0; i < this._perfRingFilled; i++) perf.push(this._perfTimes[i]);
    perf.sort((a, b) => a - b);
    const pct = (q) => (perf.length ? Math.round(perf[Math.min(perf.length - 1, Math.floor(perf.length * q))] * 10) / 10 : null);
    return {
      engine: this._engine,
      model: this._modelName,
      threshold: this._threshold,
      sensitivity: this._sensitivityLabel,
      energy_gate: this._energyGateEnabled,
      dsp_constraints: this._constraints || null,
      perf_ms: perf.length ? { p50: pct(0.5), p95: pct(0.95), n: perf.length } : null,
      audio_capture: this._getCaptureStats(),
    };
  }

  _getCaptureStats() {
    const n = Math.min(this._captureFilled, this._captureBuf.length);
    if (n === 0) return null;

    const cap = this._captureBuf;
    const start = this._captureFilled < cap.length ? 0 : this._captureHead;
    const nearZero = 1 / 32768;
    let sumSq = 0;
    let peak = 0;
    let exactZero = 0;
    let nearZeroSamples = 0;
    let clipped = 0;
    let currentNearZeroRun = 0;
    let longestNearZeroRun = 0;
    let longNearZeroRuns = 0;
    const longRunSamples = Math.round(TARGET_RATE * 0.08);

    for (let i = 0; i < n; i++) {
      const v = cap[(start + i) % cap.length] || 0;
      const a = Math.abs(v);
      sumSq += v * v;
      if (a > peak) peak = a;
      if (v === 0) exactZero++;
      if (a <= nearZero) {
        nearZeroSamples++;
        currentNearZeroRun++;
      } else {
        if (currentNearZeroRun >= longRunSamples) longNearZeroRuns++;
        if (currentNearZeroRun > longestNearZeroRun) longestNearZeroRun = currentNearZeroRun;
        currentNearZeroRun = 0;
      }
      if (a >= 0.999) clipped++;
    }
    if (currentNearZeroRun >= longRunSamples) longNearZeroRuns++;
    if (currentNearZeroRun > longestNearZeroRun) longestNearZeroRun = currentNearZeroRun;

    return {
      sample_rate: TARGET_RATE,
      source_rate: this._actualSampleRate,
      worklet_batch_quanta: this._workletBatchQuanta,
      seconds: Math.round((n / TARGET_RATE) * 1000) / 1000,
      peak_abs: Math.round(peak * 10000) / 10000,
      rms: Math.round(Math.sqrt(sumSq / n) * 10000) / 10000,
      exact_zero_pct: Math.round((exactZero / n) * 10000) / 100,
      near_zero_pct: Math.round((nearZeroSamples / n) * 10000) / 100,
      clipped_pct: Math.round((clipped / n) * 10000) / 100,
      longest_near_zero_ms: Math.round((longestNearZeroRun / TARGET_RATE) * 1000),
      long_near_zero_runs: longNearZeroRuns,
    };
  }

  get running() { return this._running; }
  get latestRms() { return this._inference?.latestRms ?? 0; }
  get detectionSeq() { return this._detectionSeq; }
  get lastDetectionAt() { return this._lastDetectionAt; }
  get lastDetectionInfo() { return this._lastDetectionInfo; }
  get lastLatencyInfo() { return this._lastLatencyInfo; }
  get latencySeq() { return this._latencySeq; }
  /**
   * Sliding-window mean over recent inferences - what the engine actually
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
    // Engine selector: 'mww' (default) or 'oww'.  Determines which
    // inference backend the tester instantiates in _setupInference().
    // Tester supports any of the three on-device engines.  Defaults to
    // MWW (matches the panel's tester engine select default).
    this._engine = ['oww', 'vww', 'mww'].includes(opts.engine) ? opts.engine : 'mww';
    // Mirror the live engine's noise-gate behavior so the tester gives
    // a faithful preview of what the user will experience at runtime.
    this._energyGateEnabled = opts.energyGateEnabled === true;
    this._sensitivityLabel = opts.sensitivityLabel || 'Moderately sensitive';
    this._detectionSeq = 0;
    this._lastDetectionAt = 0;
    this._lastDetectionInfo = null;
    this._resetLatencyStats();
    this._resetPerfStats();

    await this._acquireMic();
    await this._setupAudioContext();
    await this._setupWorklet();
    await this._setupInference();
    this._startMicHealthProbe();

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
    this._resetLatencyStats();

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
    this._stopMicHealthProbe();

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
    this._resetLatencyStats();
    this._resetPerfStats();

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
    const update = { name: this._modelName };
    if (typeof this._threshold === 'number') {
      update.threshold = this._threshold;
    } else if (this._engine === 'oww') {
      update.threshold = 0.5;
    } else if (this._engine === 'vww') {
      // Worker resolves the actual cutoff from the model's manifest when
      // no explicit threshold is provided.  Pass undefined so the cached
      // recommended_threshold wins instead of clobbering it with 0.5.
      delete update.threshold;
    }
    this._inference.updateThresholds([update]);
  }

  /**
   * Apply a sensitivity change to the RUNNING session backend.  Rides the
   * same updateEnergyThresholds path the live engine uses, which retunes
   * the energy gate on every engine and (VWW) the CTC matched-confidence
   * gate scaling.  Without this, a mid-session sensitivity change only
   * moved the cosmetic threshold line - for CTC models the cutoff is
   * inert (0/1 match score), so the select silently did nothing until
   * the next Start.
   */
  setSensitivity(sensitivityLabel) {
    this._sensitivityLabel = sensitivityLabel || 'Moderately sensitive';
    if (!this._running || !this._inference) return;
    this._inference.updateEnergyThresholds?.(this._sensitivityLabel);
  }

  // ─── Internal setup ─────────────────────────────────────────────────

  async _acquireMic() {
    // Mirror the main engine's mic constraints so the tester runs against
    // the same processed signal the engine will see at runtime. If the
    // caller didn't supply constraints, default to "raw" - every DSP off -
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
    if (c.deviceId && c.deviceId !== 'default') {
      audioConstraints.deviceId = { exact: c.deviceId };
    }
    this._stream = await this._getUserMediaWithDeviceFallback(audioConstraints, c.deviceId);

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
        this._emitLog('info', describeSelectedAudioTrack(track));
        this._emitLog('info', await describeAudioInputDevices(track));
        this._emitLog(
          'info',
          `DSP applied:   EC=${!!s.echoCancellation} NS=${!!s.noiseSuppression} `
          + `AGC=${!!s.autoGainControl} VI=${!!s.voiceIsolation} `
          + `rate=${s.sampleRate ?? '?'}Hz ch=${s.channelCount ?? '?'}${label}`,
        );
        // Call out mismatches between what we asked for and what the driver
        // actually gave us - these are the common root cause of "I turned
        // AGC off but clipping guard still fires" reports.
        const mism = [];
        for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'voiceIsolation']) {
          if (!!s[key] !== requested[key]) mism.push(`${key}: requested ${requested[key]}, got ${!!s[key]}`);
        }
        if (mism.length) {
          this._emitLog('warn', `mic driver overrode DSP request - ${mism.join('; ')}`);
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
    // Batch roughly 80 ms of source audio per post. 10 render quanta is
    // correct at 16 kHz, but a 48 kHz AudioContext needs 30 quanta; otherwise
    // the tester sends 3x as many main-thread capture/resample messages.
    const BATCH_QUANTA = Math.max(1, Math.round((this._actualSampleRate / TARGET_RATE) * 10));
    this._workletBatchQuanta = BATCH_QUANTA;
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

    const postMs = (128 * BATCH_QUANTA / this._actualSampleRate) * 1000;
    this._emitLog(
      'info',
      `tester capture batch: rate=${this._actualSampleRate}Hz `
      + `quanta=${BATCH_QUANTA} post=${postMs.toFixed(1)}ms`,
    );
  }

  async _setupInference() {
    // Tester always goes through its own Worker - keeps inference off
    // the main thread (so the chart rAF stays smooth) and gives this
    // session its own isolated backend state independent of the live
    // engine's worker.
    const cutoffs = {};
    if (typeof this._threshold === 'number') {
      cutoffs[this._modelName] = this._threshold;
    } else if (this._engine === 'oww') {
      cutoffs[this._modelName] = 0.5;
    }
    // For VWW with no explicit threshold, omit cutoffs so the worker
    // pulls each model's recommended_threshold from its JSON manifest.
    if (this._engine === 'vww') {
      try {
        const params = await loadVwwModelParams(this._modelName);
        this._reportVwwModelParams(this._modelName, params);
      } catch (_) {
        this._emitLog('warn', `VWW manifest report unavailable for "${this._modelName}"`);
      }
    }
    this._inference = await WorkerProxyBackend.create({
      engine: ['oww', 'vww', 'mww'].includes(this._engine) ? this._engine : 'mww',
      models: [this._modelName],
      cutoffs,
      energyGateEnabled: this._energyGateEnabled,
      sensitivityLabel: this._sensitivityLabel,
      enableTimings: true,
      log: this._instanceLog,
    });
  }

  // ─── Audio processing ───────────────────────────────────────────────

  _onAudioChunk(samples) {
    if (!this._running || !this._inference) return;

    // Resample to 16 kHz if the AudioContext didn't honor our sampleRate hint.
    let s = samples;
    if (this._actualSampleRate !== TARGET_RATE) {
      s = this._resample(samples, this._actualSampleRate, TARGET_RATE);
    }
    this._recordMicHealthChunk(s);

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
      // Capture timestamp for the stale-chunk fast-ingest path (see
      // WorkerProxyBackend.processChunk).
      this._frameQueue.push({ buf: chunk, t: Date.now() });
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
          const chunkIndex = this._processedChunkCount++;
          const audioEndMs = (chunkIndex + 1) * CHUNK_DURATION_MS;
          const t0 = performance.now();
          const result = await this._inference.processChunk(frame.buf, frame.t);
          const dt = performance.now() - t0;
          this._recordPerfSample(dt, result?.timings || null);
          this._recordRmsSample(result?.rms);
          this._updateSpeechOnset(result?.rms, audioEndMs);
          const latencyInfo = this._updateThresholdLatency(result, audioEndMs);
          if (result?.detected) {
            this._detectionSeq++;
            this._lastDetectionAt =
              (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? performance.now()
                : Date.now();
            this._lastDetectionInfo = result;
            this._lastLatencyInfo = latencyInfo;
            this._latencySeq++;
            const model = result.model ?? this._modelName ?? '?';
            const mean = typeof result.score === 'number' ? result.score.toFixed(3) : '?';
            const cutoff = typeof result.cutoff === 'number' ? result.cutoff.toFixed(2) : '?';
            const latencyBits = this._formatLatencyInfo(latencyInfo);
            const runtimeBits = this._formatVwwRuntimeInfo(result, model, result.triggerType);
            // CTC: include the decoded phoneme sequence + confidence
            // metrics in the trigger log so the user can see WHY it
            // fired (which target matched, exact vs ed=1 loose match,
            // and how confident the model was - tunes the gate).
            const ctcEntry = result.ctc?.[model];
            let ctcBits = '';
            if (ctcEntry && Array.isArray(ctcEntry.phonemes)) {
              const ed = ctcEntry.minEditDistance;
              const mc = (typeof ctcEntry.matchedConfidence === 'number')
                ? ` conf=${ctcEntry.matchedConfidence.toFixed(2)}`
                : '';
              const tc = (typeof ctcEntry.totalConfidence === 'number')
                ? ` total_conf=${ctcEntry.totalConfidence.toFixed(2)}`
                : '';
              const gt = (typeof ctcEntry.gateThreshold === 'number'
                          && Number.isFinite(ctcEntry.gateThreshold))
                ? ` gate=${ctcEntry.gateThreshold.toFixed(2)}`
                : '';
              const target = this._formatCtcTargetInfo(ctcEntry);
              ctcBits = ` decoded=[${ctcEntry.phonemes.join(' ')}] ed=${ed}${target}${mc}${tc}${gt}`;
            }
            this._emitLog(
              'trigger',
              `DETECTED "${model}" mean=${mean} cutoff=${cutoff} `
              + `${latencyBits ? `${latencyBits} ` : ''}`
              + `${runtimeBits ? `${runtimeBits} ` : ''}`
              + `rms_now=${(result.rms ?? 0).toFixed(4)} `
              + `window_rms=${(result.windowRms ?? 0).toFixed(4)} `
              + `rms_peak_1s=${this._getRecentRmsPeak(13).toFixed(4)}`
              + ctcBits,
            );
          } else if (result?.ctc) {
            // CTC near-miss diagnostic: when the model decoded something
            // CLOSE to the wake word, emit a 'diag' line so the user can
            // see what it heard and why it didn't fire.  The `reason`
            // field names which gate rejected the decode.  Models with a
            // pretrained phoneme backbone (ok_nabu v121+) honestly decode
            // ALL speech, so the old loose thresholds (>=3 phonemes, any
            // ed up to 8) logged every window of TV audio as a "near
            // miss"; only decodes within one edit of the matcher gate are
            // legitimate near misses.
            for (const [name, info] of Object.entries(result.ctc)) {
              if (!info || !Array.isArray(info.phonemes)) continue;
              // Skip silence/blank decodes - require at least 3 emitted
              // phonemes to be worth logging.
              if (info.phonemes.length < 3) continue;
              const ed = info.minEditDistance;
              const nearMaxEd = ((typeof info.maxEditDistance === 'number')
                ? info.maxEditDistance : 1) + 1;
              if (!Number.isFinite(ed) || ed > nearMaxEd) continue;
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
              const target = this._formatCtcTargetInfo(info);
              // Explicit reason: why didn't this near-miss fire?  Helps
              // the user distinguish "model decoded wrong phonemes" from
              // "model decoded right phonemes but gate rejected it".
              // Order matters - report the FIRST gate that would reject.
              const reasons = [];
              const maxEd = (typeof info.maxEditDistance === 'number')
                ? info.maxEditDistance : 1;
              if (ed > maxEd) reasons.push(`ed>${maxEd}`);
              if (typeof info.matchedConfidence === 'number'
                  && typeof gateThreshold === 'number'
                  && Number.isFinite(gateThreshold)
                  && info.matchedConfidence < gateThreshold) {
                reasons.push(`conf<gate`);
              }
              const runtimeReason = this._getVwwRuntimeRejectReason(result, name, info);
              if (runtimeReason) reasons.push(runtimeReason);
              const reason = reasons.length ? ` reason=${reasons.join('+')}` : ' reason=other';
              const runtimeBits = this._formatVwwRuntimeInfo(result, name, null);
              this._emitLog(
                'diag',
                `CTC near-miss "${name}" ed=${ed}${target}${mc}${tc}${gt}`
                + `${runtimeBits ? ` ${runtimeBits}` : ''}${reason} `
                + `decoded=[${info.phonemes.join(' ')}]`,
              );
            }
          } else if (result?.perModelScores && this._modelName) {
            const score = result.perModelScores[this._modelName];
            const cutoff = typeof result.cutoff === 'number'
              ? result.cutoff
              : (typeof this._threshold === 'number' ? this._threshold : 0.5);
            if (typeof score === 'number' && score > cutoff) {
              const runtimeBits = this._formatVwwRuntimeInfo(result, this._modelName, null);
              const reason = this._getVwwRuntimeRejectReason(result, this._modelName, null)
                || 'reason=other';
              this._emitLog(
                'diag',
                `VWW near-miss "${this._modelName}" score=${score.toFixed(3)} `
                + `cutoff=${cutoff.toFixed(3)}`
                + `${runtimeBits ? ` ${runtimeBits}` : ''} ${reason}`,
              );
            }
          }
        } catch (_) { /* swallow - the tester is best-effort */ }
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
    if (!msg) return;
    const ts = Date.now();
    // Ring of recent lines for diagnostic submissions.
    this._recentLog.push({ ts, cat, msg });
    if (this._recentLog.length > this._recentLogMax) {
      this._recentLog.splice(0, this._recentLog.length - this._recentLogMax);
    }
    // Mirror to browser console so the lines show up in DevTools next
    // to production [VS][wake-word] logs, not only in the tester
    // panel's embedded log pane.  Useful for debugging tester behavior
    // against the live engine without having to switch contexts.
    // Level mapping: warn -> console.warn, error -> console.error,
    // everything else (diag/info/trigger) -> console.log.
    try {
      const formatted = `[VS][tester][${cat}] ${msg}`;
      if (cat === 'warn') console.warn(formatted);
      else if (cat === 'error') console.error(formatted);
      else console.log(formatted);
    } catch (_) { /* ignore */ }
    if (!this._logSubscribers.size) return;
    for (const cb of this._logSubscribers) {
      try { cb(cat, msg, ts); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Append a per-chunk inference latency sample to the ring buffer and
   * emit a summary line every _perfReportEvery chunks.  The summary is
   * useful for comparing engines on identical hardware: switch the engine
   * select, restart the tester, and the log pane prints avg/p50/p95 over
   * the most recent ~16 s of audio (200 chunks).
   */
  _recordPerfSample(ms, timings = null) {
    if (!Number.isFinite(ms)) return;
    const idx = this._perfRingHead;
    this._perfTimes[idx] = ms;
    this._perfTimingRows[idx] = timings && typeof timings === 'object' ? { ...timings } : null;
    this._perfRingHead = (idx + 1) % this._perfRingSize;
    if (this._perfRingFilled < this._perfRingSize) this._perfRingFilled++;
    this._perfChunksSinceReport++;
    if (this._perfChunksSinceReport < this._perfReportEvery) return;
    this._perfChunksSinceReport = 0;
    this._emitPerfSummary();
  }

  /** Public accessor — useful for capturing numbers from devtools. */
  getPerfStats() {
    if (this._perfRingFilled < 5) return null;
    const samples = this._perfTimes.slice(0, this._perfRingFilled).slice().sort((a, b) => a - b);
    const n = samples.length;
    const sum = samples.reduce((s, v) => s + v, 0);
    return {
      engine: this._engine || 'mww',
      model: this._modelName || null,
      count: n,
      avg: sum / n,
      min: samples[0],
      max: samples[n - 1],
      p50: samples[Math.floor(n * 0.50)],
      p95: samples[Math.min(n - 1, Math.floor(n * 0.95))],
      p99: samples[Math.min(n - 1, Math.floor(n * 0.99))],
      stages: this._getPerfStageStats(),
    };
  }

  async _getUserMediaWithDeviceFallback(audioConstraints, requestedDeviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      if (!audioConstraints.deviceId) throw err;
      this._emitLog('warn', `Selected microphone unavailable (${requestedDeviceId}) - falling back to browser default: ${err?.message || err}`);
      const fallbackConstraints = Object.assign({}, audioConstraints);
      delete fallbackConstraints.deviceId;
      return navigator.mediaDevices.getUserMedia({ audio: fallbackConstraints });
    }
  }

  _getPerfStageStats() {
    const sums = {};
    const counts = {};
    let fusedSamples = 0;
    let unfusedSamples = 0;
    for (let i = 0; i < this._perfRingFilled; i++) {
      const row = this._perfTimingRows[i];
      if (!row) continue;
      if (row.fusedFrontend === true) fusedSamples++;
      else if (row.fusedFrontend === false) unfusedSamples++;
      for (const [key, value] of Object.entries(row)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        sums[key] = (sums[key] || 0) + value;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const avg = {};
    for (const key of Object.keys(sums)) avg[key] = sums[key] / counts[key];
    return {
      avg,
      fusedFrontend: fusedSamples > 0 && fusedSamples >= unfusedSamples,
      count: Math.max(fusedSamples, unfusedSamples),
    };
  }

  _emitPerfSummary() {
    const s = this.getPerfStats();
    if (!s) return;
    const fmt = (v) => v.toFixed(1);
    this._emitLog(
      'diag',
      `perf ${s.engine.toUpperCase()} (${s.model}) n=${s.count} chunks: `
      + `avg=${fmt(s.avg)}ms min=${fmt(s.min)}ms p50=${fmt(s.p50)}ms `
      + `p95=${fmt(s.p95)}ms p99=${fmt(s.p99)}ms max=${fmt(s.max)}ms (budget=80ms)`,
    );
    const st = s.stages?.avg;
    if (st && Object.keys(st).length) {
      const frontendLabel = s.stages.fusedFrontend ? 'frontend(fused)' : 'frontend';
      const parts = [];
      if (st.scaleMs !== undefined) parts.push(`scale=${fmt(st.scaleMs)}ms`);
      if (st.prepareMs !== undefined) parts.push(`prep=${fmt(st.prepareMs)}ms`);
      if (st.frontendMs !== undefined) parts.push(`${frontendLabel}=${fmt(st.frontendMs)}ms`);
      if (st.melMs !== undefined) parts.push(`mel=${fmt(st.melMs)}ms`);
      if (st.embeddingMs !== undefined) parts.push(`embed=${fmt(st.embeddingMs)}ms`);
      if (st.classifyMs !== undefined) parts.push(`classify=${fmt(st.classifyMs)}ms`);
      if (st.inferenceTotalMs !== undefined) parts.push(`infer=${fmt(st.inferenceTotalMs)}ms`);
      if (st.modelCount !== undefined) parts.push(`models=${fmt(st.modelCount)}`);
      if (st.backendTotalMs !== undefined) parts.push(`worker=${fmt(st.backendTotalMs)}ms`);
      this._emitLog('diag', `perf stages avg: ${parts.join(' ')}`);
    }
  }

  _resetPerfStats() {
    this._perfRingHead = 0;
    this._perfRingFilled = 0;
    this._perfChunksSinceReport = 0;
    this._perfTimes.length = 0;
    this._perfTimingRows = new Array(this._perfRingSize);
    this._rmsHistory.fill(0);
    this._rmsHistoryHead = 0;
    this._rmsHistoryFilled = 0;
  }

  _resetLatencyStats() {
    this._processedChunkCount = 0;
    this._thresholdTrackers.clear();
    this._pendingLatencyFinals.length = 0;
    this._speechActive = false;
    this._speechStartAudioMs = null;
    this._speechLastActiveAudioMs = null;
    this._lastSpeechStartAudioMs = null;
    this._lastSpeechEndAudioMs = null;
    this._speechQuietChunks = 0;
    this._lastLatencyInfo = null;
    this._latencySeq++;
  }

  _updateSpeechOnset(rms, audioEndMs) {
    if (!Number.isFinite(rms)) return;
    const audioStartMs = Math.max(0, audioEndMs - CHUNK_DURATION_MS);
    if (rms >= SPEECH_ONSET_RMS) {
      if (!this._speechActive) {
        this._speechActive = true;
        this._speechStartAudioMs = audioStartMs;
        this._speechLastActiveAudioMs = audioEndMs;
      }
      this._speechLastActiveAudioMs = audioEndMs;
      this._speechQuietChunks = 0;
      return;
    }
    if (!this._speechActive) return;
    if (rms > SPEECH_RELEASE_RMS) {
      this._speechLastActiveAudioMs = audioEndMs;
      this._speechQuietChunks = 0;
      return;
    }
    if (rms <= SPEECH_RELEASE_RMS) {
      this._speechQuietChunks++;
      if (this._speechQuietChunks >= SPEECH_RELEASE_CHUNKS) {
        this._rememberCompletedSpeech();
        this._finalizeSpeechLatency();
        this._speechActive = false;
        this._speechStartAudioMs = null;
        this._speechLastActiveAudioMs = null;
        this._speechQuietChunks = 0;
      }
    }
  }

  _updateThresholdLatency(result, audioEndMs) {
    if (!result || !this._modelName) return null;
    const scores = result.perModelScores || {};
    const model = result.model || this._modelName;
    const score =
      typeof scores[this._modelName] === 'number'
        ? scores[this._modelName]
        : (typeof result.score === 'number' ? result.score : 0);
    const cutoff =
      typeof result.cutoff === 'number'
        ? result.cutoff
        : (typeof this._threshold === 'number' ? this._threshold : 0.5);
    const key = model || this._modelName;
    let tracker = this._thresholdTrackers.get(key);

    if (score > cutoff) {
      if (!tracker) {
        tracker = {
          firstAboveAudioMs: audioEndMs,
          firstAboveWallMs:
            (typeof performance !== 'undefined' && typeof performance.now === 'function')
              ? performance.now()
              : Date.now(),
          firstScore: score,
          peakScore: score,
          aboveFrames: 0,
        };
        this._thresholdTrackers.set(key, tracker);
      }
      tracker.aboveFrames += 1;
      if (score > tracker.peakScore) tracker.peakScore = score;
    } else {
      this._thresholdTrackers.delete(key);
      tracker = null;
    }

    if (!result.detected) return null;
    if (!tracker) {
      tracker = {
        firstAboveAudioMs: audioEndMs,
        firstAboveWallMs:
          (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now(),
        firstScore: score,
        peakScore: score,
        aboveFrames: 1,
      };
    }

    const activeSpeechStart = this._speechStartAudioMs;
    const recentSpeechStart = this._lastSpeechStartAudioMs;
    const recentSpeechEnd = this._lastSpeechEndAudioMs;
    const hasActiveSpeech = activeSpeechStart !== null;
    const hasRecentSpeech =
      !hasActiveSpeech
      && recentSpeechStart !== null
      && recentSpeechEnd !== null
      && audioEndMs >= recentSpeechEnd
      && (audioEndMs - recentSpeechEnd) <= SPEECH_ASSOCIATION_WINDOW_MS;
    const speechStartAudioMs = hasActiveSpeech
      ? activeSpeechStart
      : (hasRecentSpeech ? recentSpeechStart : null);
    const speechEndAudioMs = hasRecentSpeech ? recentSpeechEnd : null;
    const speechToTriggerMs =
      speechStartAudioMs !== null
        ? Math.max(0, audioEndMs - speechStartAudioMs)
        : null;
    const speechEndToTriggerMs =
      speechEndAudioMs !== null ? audioEndMs - speechEndAudioMs : null;
    const thresholdToTriggerMs = Math.max(0, audioEndMs - tracker.firstAboveAudioMs);
    const info = {
      model: key,
      triggerType: result.triggerType || 'detected',
      audioTimeMs: audioEndMs,
      triggerAudioMs: audioEndMs,
      speechStartAudioMs,
      speechEndAudioMs,
      speechToTriggerMs,
      speechEndToTriggerMs,
      thresholdToTriggerMs,
      aboveFrames: tracker.aboveFrames,
      firstScore: tracker.firstScore,
      triggerScore: score,
      peakScore: Math.max(tracker.peakScore, score),
      cutoff,
    };
    if (this._speechActive) {
      this._pendingLatencyFinals.push(info);
    }
    this._thresholdTrackers.delete(key);
    return info;
  }

  _finalizeSpeechLatency() {
    const speechEndAudioMs = this._speechLastActiveAudioMs;
    if (!Number.isFinite(speechEndAudioMs) || this._pendingLatencyFinals.length === 0) return;
    const pending = this._pendingLatencyFinals.splice(0);
    for (const info of pending) {
      info.speechEndAudioMs = speechEndAudioMs;
      info.speechEndToTriggerMs = info.triggerAudioMs - speechEndAudioMs;
      this._lastLatencyInfo = info;
      this._latencySeq++;
      this._emitLog(
        'diag',
        `latency finalized: ${info.model} ${this._formatLatencyInfo(info)}`,
      );
    }
  }

  _rememberCompletedSpeech() {
    if (this._speechStartAudioMs === null || this._speechLastActiveAudioMs === null) return;
    this._lastSpeechStartAudioMs = this._speechStartAudioMs;
    this._lastSpeechEndAudioMs = this._speechLastActiveAudioMs;
  }

  _formatLatencyInfo(info) {
    if (!info) return '';
    const fmtMs = (v) => Number.isFinite(v) ? `${Math.round(v)}ms` : 'n/a';
    const parts = [
      `latency_signal=${fmtMs(info.speechToTriggerMs)}`,
      `latency_after_end=${fmtMs(info.speechEndToTriggerMs)}`,
      `latency_threshold=${fmtMs(info.thresholdToTriggerMs)}`,
      `above_frames=${info.aboveFrames}`,
      `type=${info.triggerType}`,
    ];
    if (Number.isFinite(info.firstScore)) parts.push(`first=${info.firstScore.toFixed(3)}`);
    if (Number.isFinite(info.peakScore)) parts.push(`peak=${info.peakScore.toFixed(3)}`);
    return parts.join(' ');
  }

  _reportVwwModelParams(modelName, params) {
    if (!params || params.architecture !== 'ctc' || !params.ctc) return;
    const ctc = params.ctc || {};
    const runtime = params.runtime || {};
    const targets = Array.isArray(ctc.wake_word_targets) ? ctc.wake_word_targets : [];
    const targetCount = targets.length;
    const maxEd = Number.isFinite(Number(ctc.max_edit_distance))
      ? Number(ctc.max_edit_distance)
      : 1;
    const trail = Number.isFinite(Number(ctc.wake_word_trail_tolerance))
      ? Number(ctc.wake_word_trail_tolerance)
      : -1;
    const minConf = Number.isFinite(Number(ctc.min_matched_confidence))
      ? Number(ctc.min_matched_confidence).toFixed(2)
      : 'off';
    const targetMinConf = this._targetMinMatchedConfidence(ctc);
    const targetMinConfText = targetMinConf.length
      ? ` target_min_conf=[${targetMinConf.map((v) => (Number.isFinite(v) ? v.toFixed(2) : '-')).join(',')}]`
      : '';
    const targetMaxEd = this._targetMaxEditDistance(ctc);
    const targetMaxEdText = targetMaxEd.length
      ? ` target_max_ed=[${targetMaxEd.map((v) => (Number.isFinite(v) ? String(v) : '-')).join(',')}]`
      : '';
    const baseHits = Number.isFinite(Number(runtime.required_hits)) && Number(runtime.required_hits) > 0
      ? Math.max(1, Math.floor(Number(runtime.required_hits)))
      : null;
    const targetHits = this._targetRequiredHits(runtime);
    const targetHitsText = targetHits.length
      ? ` target_hits=[${targetHits.map((v) => (Number.isFinite(v) ? String(v) : '-')).join(',')}]`
      : '';
    const bypass = Number.isFinite(Number(runtime.high_confidence_bypass))
      ? ` bypass=${Number(runtime.high_confidence_bypass).toFixed(2)}`
      : '';
    const bypassHits = Number.isFinite(Number(runtime.high_confidence_bypass_min_hits))
      ? ` bypass_hits=${Math.max(1, Math.floor(Number(runtime.high_confidence_bypass_min_hits)))}`
      : '';
    this._emitLog(
      'info',
      `VWW CTC manifest "${modelName}": targets=${targetCount} ed<=${maxEd} `
      + `trail=${trail} min_conf=${minConf}`
      + `${targetMaxEdText}${targetMinConfText}${baseHits ? ` hits=${baseHits}` : ''}${targetHitsText}${bypass}${bypassHits}`,
    );

    const anchors = Array.isArray(ctc.wake_word_target_anchors)
      ? ctc.wake_word_target_anchors
      : [];
    const targetGroups = this._targetGroupIds(ctc);
    for (let i = 0; i < targetCount; i++) {
      const hits = Number.isFinite(targetHits[i])
        ? targetHits[i]
        : baseHits;
      const anchorList = Array.isArray(anchors[i]) && anchors[i].length
        ? ` anchors=${anchors[i].join(',')}`
        : '';
      const group = Number.isInteger(targetGroups[i])
        ? ` group=${targetGroups[i] + 1}`
        : '';
      const gate = Number.isFinite(targetMinConf[i])
        ? ` min_conf=${targetMinConf[i].toFixed(2)}`
        : '';
      const ed = Number.isFinite(targetMaxEd[i])
        ? ` ed<=${targetMaxEd[i]}`
        : '';
      this._emitLog(
        'info',
        `CTC target [${i + 1}]${group}${hits ? ` hits=${hits}` : ''}${ed}${gate}${anchorList}: `
        + this._formatCtcTarget(ctc, i),
      );
    }
  }

  _targetMaxEditDistance(ctc) {
    const raw = ctc?.target_max_edit_distance;
    if (!Array.isArray(raw)) return [];
    return raw.map((value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    });
  }

  _targetMinMatchedConfidence(ctc) {
    const raw = ctc?.target_min_matched_confidence;
    if (!Array.isArray(raw)) return [];
    return raw.map((value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    });
  }

  _targetRequiredHits(runtime) {
    const raw = runtime?.target_required_hits;
    if (!Array.isArray(raw)) return [];
    return raw.map((value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : null;
    });
  }

  _targetGroupIds(ctc) {
    const targets = Array.isArray(ctc?.wake_word_targets)
      ? ctc.wake_word_targets
      : [];
    const raw = ctc?.wake_word_target_groups;
    const wordSepId = ctc?.word_sep_id ?? 2;
    const ids = [];
    const labelToId = new Map();
    const idForLabel = (label) => {
      const key = String(label);
      if (!labelToId.has(key)) labelToId.set(key, labelToId.size);
      return labelToId.get(key);
    };
    if (Array.isArray(raw) && raw.length >= targets.length) {
      for (let i = 0; i < targets.length; i++) {
        const value = raw[i];
        ids[i] = value == null ? i : idForLabel(value);
      }
      return ids;
    }
    for (let i = 0; i < targets.length; i++) {
      const normalized = (targets[i] || [])
        .filter((id) => id !== wordSepId)
        .join(',');
      ids[i] = idForLabel(normalized || `target:${i}`);
    }
    return ids;
  }

  _formatCtcTarget(ctc, index) {
    const phonemeTargets = Array.isArray(ctc.wake_word_target_phonemes)
      ? ctc.wake_word_target_phonemes
      : [];
    if (Array.isArray(phonemeTargets[index])) {
      return phonemeTargets[index].map((p) => (p === ' ' ? '_' : String(p))).join(' ');
    }
    const ids = Array.isArray(ctc.wake_word_targets?.[index])
      ? ctc.wake_word_targets[index]
      : [];
    const inventory = Array.isArray(ctc.inventory) ? ctc.inventory : [];
    const wordSepId = ctc.word_sep_id ?? 2;
    return ids.map((id) => {
      if (id === wordSepId) return '_';
      return inventory[id] ?? `?${id}`;
    }).join(' ');
  }

  _formatCtcTargetInfo(ctcInfo) {
    const idx = Number.isInteger(ctcInfo?.matchedTargetIndex)
      ? ctcInfo.matchedTargetIndex
      : -1;
    const groupIdx = Number.isInteger(ctcInfo?.matchedTargetGroupIndex)
      ? ctcInfo.matchedTargetGroupIndex
      : -1;
    const target = idx >= 0 ? ` target=${idx + 1}` : '';
    const group = groupIdx >= 0 ? ` group=${groupIdx + 1}` : '';
    return `${target}${group}`;
  }

  _formatVwwRuntimeInfo(result, model, triggerType = null) {
    const info = result?.runtime?.[model];
    if (!info || info.mode !== 'counter') return '';
    const parts = [];
    if (triggerType) parts.push(`runtime_type=${triggerType}`);
    if (Number.isFinite(info.hits) && Number.isFinite(info.requiredHits)) {
      parts.push(`runtime_hits=${info.hits}/${info.requiredHits}`);
    }
    if (Number.isInteger(info.matchedTargetIndex) && info.matchedTargetIndex >= 0) {
      parts.push(`runtime_target=${info.matchedTargetIndex + 1}`);
    }
    if (Number.isInteger(info.matchedTargetGroupIndex) && info.matchedTargetGroupIndex >= 0) {
      parts.push(`runtime_group=${info.matchedTargetGroupIndex + 1}`);
    }
    if (typeof info.highConfidenceBypass === 'number' && Number.isFinite(info.highConfidenceBypass)) {
      parts.push(`runtime_bypass=${info.highConfidenceBypass.toFixed(2)}`);
    }
    if (
      Number.isFinite(info.highConfidenceBypassMinHits)
      && Number.isFinite(info.hits)
      && info.highConfidence === true
    ) {
      parts.push(`runtime_bypass_hits=${info.hits}/${info.highConfidenceBypassMinHits}`);
    }
    if (info.bypassed === true) parts.push('runtime_bypassed=true');
    if (info.grouped === true) parts.push('runtime_grouped=true');
    if (info.cnnSequenceGate === true) {
      const p = Number(info.cnnPrefixScore);
      const c = Number(info.cnnCompletionScore);
      if (Number.isFinite(p)) parts.push(`cnn_prefix=${p.toFixed(3)}`);
      if (Number.isFinite(c)) parts.push(`cnn_completion=${c.toFixed(3)}`);
      if (info.cnnSequencePassed === false) parts.push('cnn_sequence=blocked');
      else if (info.cnnSequencePassed === true) parts.push('cnn_sequence=passed');
    }
    return parts.join(' ');
  }

  _getVwwRuntimeRejectReason(result, model, ctcInfo) {
    const runtime = result?.runtime?.[model];
    if (!runtime || runtime.mode !== 'counter') return '';
    if (ctcInfo) {
      if (!Number.isFinite(ctcInfo.minEditDistance)) return '';
      const maxEd = typeof ctcInfo.maxEditDistance === 'number' ? ctcInfo.maxEditDistance : 1;
      if (ctcInfo.minEditDistance > maxEd) return '';
      const gate = ctcInfo.gateThreshold;
      if (
        typeof ctcInfo.matchedConfidence === 'number'
        && typeof gate === 'number'
        && Number.isFinite(gate)
        && ctcInfo.matchedConfidence < gate
      ) {
        return '';
      }
    }
    if (
      runtime.highConfidence === true
      && Number.isFinite(runtime.highConfidenceBypassMinHits)
      && Number.isFinite(runtime.hits)
      && runtime.hits < runtime.highConfidenceBypassMinHits
    ) {
      return `runtime_bypass_hits<${runtime.highConfidenceBypassMinHits}`;
    }
    if (runtime.cnnSequenceGate === true && runtime.cnnSequencePassed === false) {
      return 'cnn_sequence';
    }
    if (
      Number.isFinite(runtime.hits)
      && Number.isFinite(runtime.requiredHits)
      && runtime.hits < runtime.requiredHits
    ) {
      return `runtime_hits<${runtime.requiredHits}`;
    }
    return '';
  }

  _startMicHealthProbe() {
    this._stopMicHealthProbe();
    this._micHealth = {
      startedAt: Date.now(),
      chunks: 0,
      peakRms: 0,
      peakAbs: 0,
      reports: 0,
    };
    this._micHealthTimer = setInterval(() => this._reportMicHealth(), 3000);
  }

  _stopMicHealthProbe() {
    if (this._micHealthTimer) {
      clearInterval(this._micHealthTimer);
      this._micHealthTimer = null;
    }
    this._micHealth = null;
  }

  _recordMicHealthChunk(samples) {
    if (!this._micHealth || !samples?.length) return;
    let sumSq = 0;
    let peakAbs = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      const a = Math.abs(v);
      if (a > peakAbs) peakAbs = a;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / samples.length);
    this._micHealth.chunks += 1;
    if (rms > this._micHealth.peakRms) this._micHealth.peakRms = rms;
    if (peakAbs > this._micHealth.peakAbs) this._micHealth.peakAbs = peakAbs;
  }

  _reportMicHealth() {
    const h = this._micHealth;
    if (!h) return;
    h.reports += 1;
    const elapsed = Math.max(1, Date.now() - h.startedAt);
    const chunksPerSecond = h.chunks / (elapsed / 1000);
    const track = this._stream?.getAudioTracks?.()[0];
    const trackBits = track
      ? `track=${track.readyState} enabled=${track.enabled} muted=${track.muted}`
      : 'track=none';
    const msg = `mic health: chunks=${h.chunks} (${chunksPerSecond.toFixed(1)}/s) `
      + `peak_rms=${h.peakRms.toFixed(4)} peak_abs=${h.peakAbs.toFixed(4)} `
      + `${trackBits} ctx=${this._audioContext?.state || 'none'}`;
    this._emitLog('diag', h.chunks === 0 || h.peakRms < 0.001
      ? `${msg} - input appears silent`
      : msg);
  }

  _recordRmsSample(rms) {
    if (!Number.isFinite(rms)) return;
    this._rmsHistory[this._rmsHistoryHead] = Math.max(0, rms);
    this._rmsHistoryHead = (this._rmsHistoryHead + 1) % this._rmsHistory.length;
    if (this._rmsHistoryFilled < this._rmsHistory.length) this._rmsHistoryFilled++;
  }

  _getRecentRmsPeak(maxChunks = this._rmsHistory.length) {
    const n = Math.min(this._rmsHistoryFilled, maxChunks);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const idx = (this._rmsHistoryHead - 1 - i + this._rmsHistory.length) % this._rmsHistory.length;
      const v = this._rmsHistory[idx];
      if (v > peak) peak = v;
    }
    return peak;
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
