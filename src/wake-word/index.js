/**
 * WakeWordManager
 *
 * Orchestrates on-device wake word detection using microWakeWord
 * and a custom in-browser model runner. Processes 16kHz audio through
 * a micro_frontend feature extractor and runs a wake word model with sliding
 * window detection.
 */

import { State, BlurReason } from '../constants.js';
import { getSwitchState, getSelectState } from '../shared/satellite-state.js';
import { CHIME_WAKE } from '../audio/chime.js';
import { loadTFLite, loadMicroModels, loadMicroModel, getMicroModelParams, releaseUnusedMicroModels, getWasmHeapSize, forceResetWasm } from './micro-models.js';
import { MicroWakeWordInference } from './micro-inference.js';
import { clearNotificationUI } from '../shared/satellite-notification.js';
import { sendAck } from '../shared/notification-comms.js';

const CHUNK_SIZE = 1280; // 80ms @ 16kHz
const MAX_POOL = 20;    // cap recycled frame pool (20 * 5KB = 100KB max)

// Window between local wake word detection and the wake chime firing.
// We keep the chime pending for this long so HA has a chance to send
// duplicate_wake_up_detected first — if it does, we cancel the chime
// and the losing tablet stays silent. Local HA round trip is typically
// 25-100ms; 250ms gives a comfortable margin without making the chime
// feel laggy on the winning tablet (the user was waiting for the chime
// to finish anyway, so 250ms of "silence then chime" feels equivalent
// to "chime then silence").
const WAKE_DEDUPE_WINDOW_MS = 250;

// ─── Detection thresholds ────────────────────────────────────────────
// microWakeWord models output confidence scores (0–1 via uint8/255).
// Detection uses sliding window mean > cutoff. The base cutoff comes from
// the model's companion JSON manifest (or hardcoded fallback in micro-models.js).
// Sensitivity scales the detection margin (1 - baseCutoff):
//   effective = 1 - (1 - baseCutoff) * factor
//   Slightly sensitive = smaller margin (harder to trigger)
//   Moderately sensitive = base cutoff as-is
//   Very sensitive = larger margin (easier to trigger)
const SENSITIVITY_MARGIN_FACTORS = {
  'Slightly sensitive': 0.5,
  'Moderately sensitive': 1.0,
  'Very sensitive': 2.0,
};
// The stop model has a much lower base cutoff (~0.5) than wake words (~0.95),
// so the wake-word factors produce extreme swings (clamps to 0.1 on Very, jumps
// to 0.75 on Slightly). Use gentler factors for stop to keep variation symmetric
// and meaningful around its base cutoff.
const STOP_SENSITIVITY_FACTORS = {
  'Slightly sensitive': 0.8,
  'Moderately sensitive': 1.0,
  'Very sensitive': 1.2,
};
const DEFAULT_CUTOFF = 0.90;

// ─── Runtime compatibility monitoring ────────────────────────────────
// The manager still exposes periodic runtime-reset hooks through the same
// flow as before, but the custom JS runner reports zero heap here. These
// checks stay inert unless a lower-level runtime is introduced again.
const WASM_HEAP_THRESHOLD = 48 * 1024 * 1024; // reset when heap exceeds 48 MB (~1.5x initial 32 MB)
const WASM_CHECK_MS = 15_000;                  // check heap every 15 seconds

// Wake word phrases matching microWakeWord conventions.
// DATA_LAST_WAKE_UP in HA core uses these exact strings for dedup.
const WAKE_WORD_PHRASES = {
  ok_nabu: 'Okay Nabu',
  hey_jarvis: 'Hey Jarvis',
  alexa: 'Alexa',
  hey_mycroft: 'Hey Mycroft',
  hey_home_assistant: 'Hey Home Assistant',
  hey_luna: 'Hey Luna',
  okay_computer: 'Okay Computer',
};

export class WakeWordManager {
  constructor(session) {
    this._session = session;
    this._log = session.logger;

    this._inference = null;
    this._active = false;
    this._sampleBuf = new Float32Array(CHUNK_SIZE * 2);
    this._sampleBufLen = 0;
    this._framePool = []; // recycled Float32Array buffers to avoid allocation
    this._loadedModelsKey = null; // sorted model names string for change detection
    this._processing = false;
    this._frameQueue = [];

    // Runtime compatibility token (cached)
    this._tfweb = null;

    // Stop word state
    this._stopOnlyMode = false;
    this._stopMicroConfig = null;
    this._suspendedKeywords = null;

    // Settings change tracking
    this._cachedEnabled = undefined;
    this._cachedModel = undefined;
    this._cachedThreshold = undefined;
    this._cachedStopWord = undefined;
    this._switching = false;

    // Cross-tablet wake word dedupe state. When the local micro_frontend
    // detects a wake word, we mute the mic and schedule the wake chime
    // for WAKE_DEDUPE_WINDOW_MS later instead of playing it immediately,
    // so the pipeline error handler has time to cancel it on a
    // duplicate_wake_up_detected from HA.
    this._pendingChimeHandle = null;
    this._pendingUnmuteHandle = null;

    // Runtime reset tracking
    this._lastWasmCheck = 0;
    this._resetting = false;

  }

  /** True when actively listening for wake words. */
  get active() { return this._active; }

  /** True when running stop-only inference (during TTS/notification playback). */
  get stopOnlyMode() { return this._stopOnlyMode; }

  /**
   * Check if on-device wake word detection is enabled.
   * @returns {boolean}
   */
  isEnabled() {
    const mode = getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_detection',
      'Home Assistant',
    );
    return mode === 'On Device';
  }

  /**
   * Get the primary wake word model name.
   * @returns {string}
   */
  getModelName() {
    return getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_model',
      'ok_nabu',
    );
  }

  /**
   * Get the active model names. Always a single-element array now —
   * the dual wake word feature was removed because the second model
   * never reliably detected (the shared micro_frontend produces one
   * stream of features that can only be quantized for one model).
   * @returns {string[]}
   */
  getActiveModels() {
    return [this.getModelName()];
  }

  /**
   * Get the wake word phrase for pipeline dedup (matches microWakeWord format).
   * @param {string} modelName - model name to look up
   * @returns {string}
   */
  getWakeWordPhrase(modelName) {
    return WAKE_WORD_PHRASES[modelName]
      || modelName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Get the sensitivity label from the HA select entity.
   * @returns {string}
   */
  _getSensitivityLabel() {
    return getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_sensitivity',
      'Moderately sensitive',
    );
  }

  /**
   * Check if the noise gate switch is enabled.
   * @returns {boolean}
   */
  _isNoiseGateEnabled() {
    return getSwitchState(
      this._session.hass,
      this._session.config.satellite_entity,
      'noise_gate',
    ) === true;
  }

  /**
   * Check if stop word interruption is enabled.
   * @returns {boolean}
   */
  isStopWordEnabled() {
    return getSwitchState(
      this._session.hass,
      this._session.config.satellite_entity,
      'stop_word',
    ) === true;
  }

  /**
   * Get the detection threshold for a specific model. The base cutoff
   * comes from the model's JSON manifest (or hardcoded fallback) and is
   * scaled by the Slightly/Moderately/Very sensitive setting.
   *
   * @param {string} modelName
   * @returns {number}
   */
  getThresholdForModel(modelName) {
    const label = this._getSensitivityLabel();
    const params = getMicroModelParams(modelName);
    const baseCutoff = params.cutoff ?? DEFAULT_CUTOFF;
    const table = modelName === 'stop' ? STOP_SENSITIVITY_FACTORS : SENSITIVITY_MARGIN_FACTORS;
    const factor = table[label] ?? 1.0;
    const effective = 1 - (1 - baseCutoff) * factor;
    return Math.max(0.1, Math.min(effective, 0.99));
  }

  /**
   * Get the detection threshold for the primary model.
   * @returns {number}
   */
  getThreshold() {
    return this.getThresholdForModel(this.getModelName());
  }

  /**
   * Build keywordConfigs array for the inference engine.
   * @param {Record<string, object>} runners - name → runner map
   * @returns {{runner: object, name: string, cutoff: number, slidingWindow: number, stepSize: number}[]}
   */
  _buildKeywordConfigs(runners) {
    return Object.entries(runners).map(([name, runner]) => {
      const params = getMicroModelParams(name);
      const effectiveCutoff = this.getThresholdForModel(name);
      const label = this._getSensitivityLabel();
      this._log.log('wake-word',
        `${name}: baseCutoff=${params.cutoff} effective=${effectiveCutoff.toFixed(3)} (${label}, margin ×${SENSITIVITY_MARGIN_FACTORS[label]}) slidingWindow=${params.slidingWindow} stepSize=${params.stepSize} (${params._source || 'hardcoded'})`
      );
      return {
        runner,
        name,
        cutoff: effectiveCutoff,
        slidingWindow: params.slidingWindow,
        stepSize: params.stepSize,
        inputScale: params.inputScale,
        inputZeroPoint: params.inputZeroPoint,
      };
    });
  }

  // ─── Start / Stop ───────────────────────────────────────────────────

  /**
   * Start wake word detection. Initializes the model runtime on first call.
   */
  async start() {
    if (this._active || this._resetting) return;

    const activeModels = this.getActiveModels();
    const modelsKey = activeModels.slice().sort().join(',');
    this._log.log('wake-word', `Starting on-device detection (models: ${activeModels.join(', ')})`);

    try {
      if (!this._tfweb) {
        this._log.log('wake-word', 'Initializing wake-word runtime...');
        this._tfweb = await loadTFLite();
        const backend = this._tfweb?.backend ? ` (${this._tfweb.backend})` : '';
        this._log.log('wake-word', `Wake-word runtime ready${backend}`);
      }

      if (!this._inference || this._loadedModelsKey !== modelsKey) {
        // Only treat "tfweb exists but inference is gone" as stale state
        // if we had previously completed a model load in this manager.
        // On a normal cold start _tfweb is created first and _inference
        // is still null, so resetting here would churn the TFLite loader
        // and increase startup pressure for no benefit.
        if (this._tfweb && !this._inference && this._loadedModelsKey !== null) {
          await this._recreateTfliteRuntime('stale runtime before model reload');
        }
        // Release models no longer needed before loading new ones.
        await releaseUnusedMicroModels(activeModels);
        this._log.log('wake-word', 'Loading wake word models...');
        const runners = await loadMicroModels(
          this._tfweb,
          activeModels,
          (name) => this._log.log('wake-word', `Loading model: ${name}`),
        );

        const keywordConfigs = this._buildKeywordConfigs(runners);
        this._inference = await MicroWakeWordInference.create(
          keywordConfigs, this._log, this._getSensitivityLabel(), this._isNoiseGateEnabled(),
        );
        this._loadedModelsKey = modelsKey;

        const configSummary = keywordConfigs.map((k) => `${k.name}(c=${k.cutoff},sw=${k.slidingWindow})`).join(', ');
        this._log.log('wake-word', `Wake word models loaded: ${configSummary}`);
      } else {
        this._inference.updateThresholds(
          activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) })),
        );
        this._inference.updateEnergyThresholds(this._getSensitivityLabel());
        this._inference.reset();
      }

      this._sampleBufLen = 0;
      this._frameQueue.length = 0;
      this._processing = false;
      this._active = true;
      this._session.setState(State.LISTENING);
      this._log.log('wake-word', 'On-device wake word detection active');

    } catch (e) {
      if (String(e?.message || e).includes('Out of memory')
          || String(e?.message || e).includes('Cannot allocate Wasm memory')) {
        this._log.error('wake-word', 'Wake-word runtime OOM â€” forcing full runtime reset');
        try {
          await this._recreateTfliteRuntime('OOM recovery');
        } catch (_) { /* ignore secondary failure */ }
      }
      this._log.error('wake-word', `Failed to start: ${e.message || e}`);
      throw e;
    }
  }

  /**
   * Stop wake word detection.
   */
  stop() {
    if (!this._active && !this._stopOnlyMode) return;
    this._active = false;
    this._stopOnlyMode = false;
    this._suspendedKeywords = null;
    this._sampleBufLen = 0;
    this._frameQueue.length = 0;
    this._framePool.length = 0;
    this._log.log('wake-word', 'Stopped');
  }

  _destroyInference(reason = 'cleanup') {
    if (!this._inference) return;
    try {
      this._inference.destroy();
      this._log.log('wake-word', `${reason}: micro-frontend destroyed`);
    } catch (e) {
      this._log.log('wake-word', `${reason}: inference.destroy failed: ${e.message || e}`);
    }
    this._inference = null;
  }

  async _recreateTfliteRuntime(reason = 'runtime reset') {
    this._log.log('wake-word', `${reason}: resetting wake-word runtime`);
    await forceResetWasm();
    this._tfweb = await loadTFLite();
  }

  /**
   * Full teardown: stop detection and free the wake-word runtime this
   * manager owns. Called from
   * `session.teardown()` on page unload so V8 can reclaim linear
   * memory and compiled native code before the next page mounts.
   * Synchronous so it runs to completion inside a `pagehide` handler.
   */
  release() {
    this._log.log('wake-word', 'release() — freeing wake-word runtime');
    const heapBefore = getWasmHeapSize();
    try { this.stop(); } catch (e) { this._log.log('wake-word', `release: stop failed: ${e.message || e}`); }
    this._destroyInference('release');
    this._loadedModelsKey = null;
    this._stopMicroConfig = null;
    try {
      forceResetWasm();
      this._log.log('wake-word', `release: wake-word runtime reset (heap was ${(heapBefore / (1024 * 1024)).toFixed(1)} MB)`);
    } catch (e) {
      this._log.log('wake-word', `release: forceResetWasm failed: ${e.message || e}`);
    }
  }

  // ─── Audio feed + detection ─────────────────────────────────────────

  /**
   * Feed audio samples from the AudioWorklet.
   * Accumulates to CHUNK_SIZE (1280) then queues for serial inference.
   * @param {Float32Array} chunk - raw audio samples from worklet
   */
  feedAudio(chunk) {
    if ((!this._active && !this._stopOnlyMode) || !this._inference) return;

    // Grow pre-allocated buffer if needed (rare — only if chunk is unusually large)
    const needed = this._sampleBufLen + chunk.length;
    if (needed > this._sampleBuf.length) {
      const newBuf = new Float32Array(needed * 2);
      newBuf.set(this._sampleBuf.subarray(0, this._sampleBufLen));
      this._sampleBuf = newBuf;
    }

    // Append into pre-allocated buffer (no allocation)
    this._sampleBuf.set(chunk, this._sampleBufLen);
    this._sampleBufLen += chunk.length;

    // Queue complete chunks for serial processing.
    // Cap queue depth — if inference can't keep up, drop oldest frames rather
    // than letting memory grow unbounded.  50 frames ≈ 4s of audio at 80ms each.
    const MAX_QUEUE = 50;
    while (this._sampleBufLen >= CHUNK_SIZE) {
      if (this._frameQueue.length >= MAX_QUEUE) {
        const dropped = this._frameQueue.shift();
        if (this._framePool.length < MAX_POOL) this._framePool.push(dropped);
      }
      const buf = this._framePool.pop() || new Float32Array(CHUNK_SIZE);
      buf.set(this._sampleBuf.subarray(0, CHUNK_SIZE));
      this._frameQueue.push(buf);
      this._sampleBuf.copyWithin(0, CHUNK_SIZE, this._sampleBufLen);
      this._sampleBufLen -= CHUNK_SIZE;
    }

    this._drainQueue();
  }

  /**
   * Process queued frames one at a time (serialized).
   * Prevents concurrent inference from corrupting shared state.
   */
  async _drainQueue() {
    if (this._processing) return;
    this._processing = true;

    try {
      while (this._frameQueue.length > 0 && (this._active || this._stopOnlyMode)) {
        const frame = this._frameQueue.shift();
        const result = await this._inference.processChunk(frame);
        if (this._framePool.length < MAX_POOL) this._framePool.push(frame);
        if (result.detected) {
          this._log.log('wake-word', `Detected: ${result.model} (score: ${result.score.toFixed(3)})`);
          this._frameQueue.length = 0;
          if (result.model === 'stop') {
            await this._onStopDetection();
          } else {
            await this._onDetection(result.model);
          }
          return;
        }
      }

      // Periodic runtime compatibility check -- kept for the shared reset flow
      if (this._active && !this._resetting) {
        const now = Date.now();
        if (now - this._lastWasmCheck > WASM_CHECK_MS) {
          this._lastWasmCheck = now;
          const heapSize = getWasmHeapSize();
          if (heapSize > WASM_HEAP_THRESHOLD) {
            this._log.log('wake-word',
              `Runtime heap ${(heapSize / (1024 * 1024)).toFixed(1)} MB exceeds ${WASM_HEAP_THRESHOLD / (1024 * 1024)} MB -- resetting runtime`);
            await this._resetWasmRuntime();
          }
        }
      }
    } catch (e) {
      this._log.error('wake-word', `Inference error: ${e.message || e}`);
    } finally {
      this._processing = false;
    }
  }

  /**
   * Handle wake word detection — mirrors pipeline handleWakeWordEnd behavior.
   * @param {string} modelName - the model that triggered detection
   */
  async _onDetection(modelName) {
    // Stop listening for more wake words
    this._active = false;

    const session = this._session;
    const _m = performance.memory;
    const _ms = _m ? `heap ${(_m.usedJSHeapSize/1048576).toFixed(1)}/${(_m.totalJSHeapSize/1048576).toFixed(1)}MB` : '';
    // console.log(`[wf-diag] _onDetection(${modelName}) ${_ms}`);

    // If the tab is paused (screen off / background), unpause so pipeline
    // events aren't dropped. The wake word worklet keeps running while
    // paused, but handlePipelineMessage blocks all events when isPaused.
    if (session.visibility.isPaused) {
      this._log.log('wake-word', 'Unpausing — detection while tab paused');

      // Signal visibility manager that we own the resume — prevents the
      // visibilitychange → _resume() path from racing with us (both would
      // resume AudioContext + restart pipeline concurrently).
      session.visibility._wakeWordResuming = true;

      await session.audio.resume();
      session.visibility._isPaused = false;

      // Yield to the browser so it can paint the first frame after the
      // screen wakes up. Without this, the AudioContext resume + TFLite
      // sleep-buffer replay + pipeline start all block the main thread
      // back-to-back and the UI appears frozen.
      await new Promise((r) => requestAnimationFrame(r));
    }

    // If muted, silently ignore the detection and resume listening
    if (getSwitchState(session.hass, session.config.satellite_entity, 'mute') === true) {
      this._log.log('wake-word', 'Muted — ignoring wake word detection');
      this._active = true;
      return;
    }

    // Interrupt media player
    session.mediaPlayer.interrupt();

    // Stop TTS if playing
    if (session.tts.isPlaying) {
      session.tts.stop();
      session.pipeline.pendingRunEnd = false;
    }

    // Clear previous interaction state
    if (session.pipeline.intentErrorBarTimeout) {
      clearTimeout(session.pipeline.intentErrorBarTimeout);
      session.pipeline.intentErrorBarTimeout = null;
    }
    if (session._imageLingerTimeout) {
      clearTimeout(session._imageLingerTimeout);
      session._imageLingerTimeout = null;
    }

    session.chat.clear();
    session.pipeline.shouldContinue = false;
    session.pipeline.continueConversationId = null;

    // console.log('[wf-diag] _onDetection -- setState + showBlurOverlay');
    session.setState(State.WAKE_WORD_DETECTED);
    session.ui.showBlurOverlay(BlurReason.PIPELINE);

    const wakeSound = getSwitchState(
      session.hass, session.config.satellite_entity, 'wake_sound',
    ) !== false;

    // ── Cross-tablet dedupe handling ─────────────────────────────────
    // If multiple satellites can hear the user, more than one of them
    // will trigger a local wake word detection. HA's pipeline picks the
    // first one as authoritative and replies to the others with
    // `duplicate_wake_up_detected`. To prevent the losing tablets from
    // chiming and then immediately cleaning up, we:
    //
    //   1. mute the mic so the chime won't bleed into STT;
    //   2. start the pipeline immediately so HA can dedupe ASAP;
    //   3. schedule the wake chime for WAKE_DEDUPE_WINDOW_MS later;
    //   4. on duplicate_wake_up_detected the pipeline error handler
    //      calls cancelPendingChime() before any audio fires.
    //
    // The mic stays muted until either the chime finishes (winning
    // tablet) or the dedupe handler cancels everything (losing tablet),
    // so the speaker→mic feedback that previously required playing the
    // chime BEFORE starting the pipeline is no longer a concern.

    this._setMicTracksMuted(true);

    // Kick off the pipeline immediately. We do NOT await — the chime
    // and STT timing are independent of pipeline.start's resolution,
    // and we need HA to receive the wake_word_detected event right
    // away so it can decide if this tablet won the dedupe race.
    session.pipeline
      .start({
        start_stage: 'stt',
        wake_word_phrase: this.getWakeWordPhrase(modelName),
        defer_audio_start: true,
      })
      .catch((e) => {
        this._log.error('wake-word', `Pipeline start failed after detection: ${e.message || e}`);
        // If the pipeline failed to start, we don't want to play the
        // chime or leave the mic muted forever.
        this._cancelPendingChimeInternal();
        this._setMicTracksMuted(false);
        session.pipeline.restart(session.pipeline.calculateRetryDelay());
      });

    this._log.log(
      'wake-word',
      wakeSound
        ? `STT audio deferred until wake chime completes (${WAKE_DEDUPE_WINDOW_MS}ms dedupe window)`
        : `STT audio deferred for ${WAKE_DEDUPE_WINDOW_MS}ms dedupe window`,
    );

    // Schedule the wake chime (or just an unmute if wake sound is off).
    if (wakeSound) {
      this._pendingChimeHandle = setTimeout(() => {
        this._pendingChimeHandle = null;
        const audio = session.audio;
        session.ui.stopReactive();
        // Even though the mic tracks stay muted through the deferred chime,
        // the pipeline is already running in STT mode for cross-tablet dedupe.
        // Pause upstream audio transmission too so the server-side VAD never
        // sees the wake chime window as part of the user's utterance.
        audio.stopSending();
        // Mic is still muted at this point so the chime won't bleed
        // into the STT recording. Unmute after the chime + a small
        // settle window — same total duration the old in-line code used.
        session.tts.playChime('wake');
        const unmuteAfter = (CHIME_WAKE.duration * 1000) + 50;
        this._pendingUnmuteHandle = setTimeout(() => {
          this._pendingUnmuteHandle = null;
          this._setMicTracksMuted(false);
          // Discard any buffered silence/audio captured during the dedupe
          // window + chime, then resume streaming into the active pipeline.
          audio.audioBuffer = [];
          if (session.pipeline.binaryHandlerId) {
            audio.startSending(() => session.pipeline.binaryHandlerId);
          }
          if ([State.WAKE_WORD_DETECTED, State.STT].includes(session.currentState)) {
            session.ui.startReactive();
          }
        }, unmuteAfter);
      }, WAKE_DEDUPE_WINDOW_MS);
    } else {
      // No wake chime configured. Still defer the unmute by the dedupe
      // window so we have a chance to cancel silently if a duplicate
      // arrives, then unmute so STT records.
      this._pendingUnmuteHandle = setTimeout(() => {
        this._pendingUnmuteHandle = null;
        this._setMicTracksMuted(false);
        const audio = session.audio;
        audio.audioBuffer = [];
        if (session.pipeline.binaryHandlerId) {
          audio.startSending(() => session.pipeline.binaryHandlerId);
        }
      }, WAKE_DEDUPE_WINDOW_MS);
    }
  }

  /**
   * Mute or unmute the mic stream's tracks. Used by the deferred
   * wake chime path so the chime audio (played through the speakers)
   * doesn't get captured by the mic and shipped off to STT. While
   * muted the audio worklet still runs but receives silence from the
   * disabled tracks.
   */
  _setMicTracksMuted(muted) {
    const stream = this._session?.audio?._mediaStream;
    if (!stream) return;
    stream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }

  /**
   * Cancel any timers scheduled by _onDetection without touching the
   * mic mute state. Internal helper — callers usually want
   * cancelPendingChime() which also handles the unmute.
   */
  _cancelPendingChimeInternal() {
    if (this._pendingChimeHandle) {
      clearTimeout(this._pendingChimeHandle);
      this._pendingChimeHandle = null;
    }
    if (this._pendingUnmuteHandle) {
      clearTimeout(this._pendingUnmuteHandle);
      this._pendingUnmuteHandle = null;
    }
  }

  /**
   * Cancel a pending wake chime if one is scheduled (i.e. we're inside
   * the dedupe window after a local detection but the chime hasn't
   * fired yet). Returns true if something was cancelled — the caller
   * (the pipeline error handler) uses this to short-circuit the normal
   * "expected error" cleanup so the losing tablet stays completely
   * silent.
   *
   * If the chime has already played (we're past the dedupe window),
   * returns false and the normal cleanup runs.
   */
  cancelPendingChime() {
    const wasPending = this._pendingChimeHandle !== null
      || this._pendingUnmuteHandle !== null;
    this._cancelPendingChimeInternal();
    if (wasPending) {
      this._setMicTracksMuted(false);
    }
    return wasPending;
  }

  // ─── Stop model management ──────────────────────────────────────────

  /**
   * Enable the stop keyword model for interruptible states.
   * @param {boolean} stopOnly - true for stop-only mode (TTS/notifications),
   *   false to add stop alongside regular wake words (timer alerts)
   */
  async enableStopModel(stopOnly = false) {
    if (!this.isStopWordEnabled()) {
      this._log.log('stop-word', 'Not enabled in satellite settings');
      return;
    }

    if (!this._inference) {
      this._log.log('stop-word', 'Cannot enable — inference not initialized');
      return;
    }

    try {
      if (!this._tfweb) return;

      if (!this._stopMicroConfig) {
        this._log.log('stop-word', 'Loading stop model...');
        const runner = await loadMicroModel(this._tfweb, 'stop');
        const params = getMicroModelParams('stop');
        const effectiveCutoff = this.getThresholdForModel('stop');
        this._log.log(
          'stop-word',
          `stop: baseCutoff=${params.cutoff} effective=${effectiveCutoff.toFixed(3)} (${this._getSensitivityLabel()}, margin ×${STOP_SENSITIVITY_FACTORS[this._getSensitivityLabel()]}) slidingWindow=${params.slidingWindow} stepSize=${params.stepSize} (${params._source || 'hardcoded'})`,
        );
        this._stopMicroConfig = {
          runner,
          name: 'stop',
          cutoff: effectiveCutoff,
          slidingWindow: params.slidingWindow,
          stepSize: params.stepSize,
          inputScale: params.inputScale,
          inputZeroPoint: params.inputZeroPoint,
        };
        this._log.log(
          'stop-word',
          `Stop model loaded: stop(c=${this._stopMicroConfig.cutoff},sw=${this._stopMicroConfig.slidingWindow})`,
        );
      } else {
        this._log.log('stop-word', 'Stop model already loaded (cached)');
      }

      this._inference.addKeyword(this._stopMicroConfig);

      if (stopOnly) {
        this._suspendedKeywords = this._inference._keywords
          .filter((k) => k.name !== 'stop')
          .map((k) => ({
            runner: k.runner,
            name: k.name,
            cutoff: k.cutoff,
            slidingWindow: k.slidingWindow,
            stepSize: k.stepSize,
            inputScale: k.inputScale,
            inputZeroPoint: k.inputZeroPoint,
          }));
        for (const kw of this._suspendedKeywords) {
          this._inference.removeKeyword(kw.name);
        }
        this._stopOnlyMode = true;
        this._inference.reset();
        this._sampleBufLen = 0;
        this._frameQueue.length = 0;
        this._processing = false;
        this._log.log('stop-word', 'Enabled (stop-only mode)');
      } else {
        this._log.log('stop-word', 'Enabled (alongside wake words)');
      }

      this._log.log('stop-word', `Inference active${stopOnly ? ' (stop-only)' : ' (shared)'}`);
    } catch (e) {
      this._log.error('stop-word', `Failed to enable: ${e.message || e}`);
    }
  }

  /**
   * Disable the stop keyword model and restore regular keywords if suspended.
   */
  disableStopModel({ log = true } = {}) {
    if (!this._inference) return;

    this._inference.removeKeyword('stop');

    if (this._stopOnlyMode) {
      this._stopOnlyMode = false;
      if (this._suspendedKeywords) {
        for (const kw of this._suspendedKeywords) {
          this._inference.addKeyword(kw);
        }
        if (log) {
          const restored = this._suspendedKeywords.map((kw) => kw.name).join(', ');
          this._log.log('stop-word', `Restored wake keywords: ${restored}`);
        }
        this._suspendedKeywords = null;
      }
      // Stop-only mode has been consuming TTS/notification audio with a
      // different keyword set. Reset the inference engine before returning
      // to normal wake-word listening so stale stop-model/TTS state doesn't
      // carry into the restored wake-word detectors.
      this._inference.reset();
      this._active = true;
      this._sampleBufLen = 0;
      this._frameQueue.length = 0;
      this._processing = false;
      if (log) this._log.log('stop-word', 'Disabled (stop-only mode off)');
    } else if (log) {
      this._log.log('stop-word', 'Disabled');
    }
  }

  /**
   * Handle stop word detection — cancel the current interruptible state.
   * Priority chain matches DoubleTapHandler._cancel().
   */
  async _onStopDetection() {
    const session = this._session;
    this._log.log('stop-word', 'Stop detected');

    // Disable stop model first
    this.disableStopModel();

    // 1. Timer alert — highest priority
    if (session.timer.alertActive) {
      this._log.log('stop-word', 'Dismissing timer alert');
      session.timer.dismissAlert();
      return;
    }

    // 2. Notification playing (announcement / ask-question / start-conversation)
    const isNotification = session.announcement.playing
      || session.askQuestion.playing
      || session.startConversation.playing
      || session.announcement.clearTimeoutId
      || session.startConversation.clearTimeoutId;

    if (isNotification) {
      this._log.log('stop-word', 'Dismissing notification');
      for (const mgr of [session.announcement, session.askQuestion, session.startConversation]) {
        if (!mgr.playing && !mgr.clearTimeoutId) continue;
        if (mgr.currentAnnounceId) {
          sendAck(session, mgr.currentAnnounceId, 'stop-word');
        }
        if (mgr.currentAudio) {
          mgr.currentAudio.onended = null;
          mgr.currentAudio.onerror = null;
          mgr.currentAudio.pause();
          mgr.currentAudio.src = '';
          mgr.currentAudio = null;
        }
        mgr.playing = false;
        mgr.currentAnnounceId = null;
        mgr.queued = null;
        clearNotificationUI(mgr);
      }
      session.askQuestion.cancel();
      session.chat.clear();
      session.ui.clearNotificationStatusOverride();

      if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false) {
        session.tts.playChime('done');
      }
      session.pipeline.restart(0);
      return;
    }

    // 3. TTS / active interaction
    this._log.log('stop-word', 'Cancelling interaction');

    if (session._imageLingerTimeout) {
      clearTimeout(session._imageLingerTimeout);
      session._imageLingerTimeout = null;
    }

    session.tts.stop();

    session.askQuestion.cancel();
    session.pipeline.clearContinueState();
    session.setState(State.IDLE);
    session.chat.clear();
    session.ui.hideBlurOverlay(BlurReason.PIPELINE);
    session.ui.updateForState(State.IDLE, session.pipeline.serviceUnavailable, false);

    if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false) {
      session.tts.playChime('done');
    }
    session.pipeline.restart(0);
  }

  // ─── Restart / settings ─────────────────────────────────────────────

  /**
   * Restart wake word detection (e.g. after pipeline completes).
   */
  async restart() {
    if (!this.isEnabled() || this._resetting) return;

    // If models changed while paused, do a full start
    const activeModels = this.getActiveModels();
    const modelsKey = activeModels.slice().sort().join(',');
    if (!this._inference || this._loadedModelsKey !== modelsKey) {
      this._log.log('wake-word', 'Restarting with model reload');
      await this.start();
      return;
    }

    this._log.log('wake-word', 'Restarting detection');
    this._sampleBufLen = 0;
    this._frameQueue.length = 0;
    this._processing = false;
    this._inference.updateThresholds(
      activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) })),
    );
    this._inference.updateEnergyThresholds(this._getSensitivityLabel());
    this._inference.reset();
    this._active = true;
  }

  /**
   * Reset the wake-word runtime and recreate the inference engine.
   * Takes ~1-2s during which detection pauses.
   */
  async _resetWasmRuntime() {
    this._resetting = true;
    this._active = false;

    try {
      const heapBefore = getWasmHeapSize();

      this._destroyInference('reset');
      this._loadedModelsKey = null;
      this._stopMicroConfig = null;

      await forceResetWasm();

      // Reload runtime token and rebuild models from scratch.
      this._tfweb = await loadTFLite();

      const activeModels = this.getActiveModels();
      const runners = await loadMicroModels(this._tfweb, activeModels);

      const keywordConfigs = this._buildKeywordConfigs(runners);
      this._inference = await MicroWakeWordInference.create(
        keywordConfigs,
        this._log,
        this._getSensitivityLabel(),
        this._isNoiseGateEnabled(),
      );
      this._loadedModelsKey = activeModels.slice().sort().join(',');

      this._sampleBufLen = 0;
      this._frameQueue.length = 0;
      this._active = true;

      const heapAfter = getWasmHeapSize();
      this._log.log('wake-word',
        `Runtime reset complete: ${(heapBefore / (1024 * 1024)).toFixed(1)} MB -> ${(heapAfter / (1024 * 1024)).toFixed(1)} MB`);
    } catch (e) {
      this._log.error('wake-word', `Runtime reset failed: ${e.message || e}`);
    } finally {
      this._resetting = false;
      if (!this._active && !this._inference) {
        this._log.log('wake-word', 'Attempting recovery after failed runtime reset');
        try { await this.start(); } catch (_) {}
      }
    }
  }

  /**
   * Check for wake word setting changes and react.
   * Called from session.updateHass() on every HA state change.
   */
  checkSettingsChanged() {
    if (!this._session._hasStarted || this._switching) return;

    const enabled = this.isEnabled();
    const model = this.getModelName();
    const threshold = this.getThreshold();
    const noiseGate = this._isNoiseGateEnabled();
    const stopWord = this.isStopWordEnabled();

    // Initialize cache on first call
    if (this._cachedEnabled === undefined) {
      this._cachedEnabled = enabled;
      this._cachedModel = model;
      this._cachedThreshold = threshold;
      this._cachedNoiseGate = noiseGate;
      this._cachedStopWord = stopWord;
      return;
    }

    const enabledChanged = enabled !== this._cachedEnabled;
    const modelChanged = model !== this._cachedModel;
    const thresholdChanged = threshold !== this._cachedThreshold;
    const noiseGateChanged = noiseGate !== this._cachedNoiseGate;
    const stopWordChanged = stopWord !== this._cachedStopWord;

    if (!enabledChanged && !modelChanged && !thresholdChanged && !noiseGateChanged && !stopWordChanged) return;

    // Always update caches
    this._cachedThreshold = threshold;
    this._cachedNoiseGate = noiseGate;
    this._cachedStopWord = stopWord;

    // Live threshold / noise gate update (no restart needed)
    if ((thresholdChanged || noiseGateChanged) && !modelChanged && this._active && this._inference) {
      if (thresholdChanged) {
        const activeModels = this.getActiveModels();
        this._inference.updateThresholds(
          activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) })),
        );
        this._inference.updateEnergyThresholds(this._getSensitivityLabel());
      }
      if (noiseGateChanged) {
        this._inference.setEnergyGateEnabled(noiseGate);
      }
      this._log.log('wake-word', `Settings updated${noiseGateChanged ? ` (noise gate: ${noiseGate ? 'on' : 'off'})` : ''}`);
    }

    if (stopWordChanged) {
      this._log.log('stop-word', `Setting changed: ${stopWord ? 'enabled' : 'disabled'}`);
    }

    if (stopWordChanged && !stopWord) {
      this.disableStopModel({ log: false });
      this._log.log('stop-word', 'Disabled in satellite settings');
    }

    // Mode or model change requires switching
    if (enabledChanged || modelChanged) {
      this._applyModeOrModelChange(enabled, model, enabledChanged);
    }
  }

  /**
   * Apply a detection mode or model change.
   */
  async _applyModeOrModelChange(enabled, model, enabledChanged) {
    const session = this._session;

    // Only switch while waiting for wake word, not mid-interaction.
    if (![State.LISTENING, State.IDLE, State.PAUSED].includes(session.currentState)) {
      this._log.log('wake-word', 'Settings changed during interaction — will apply on next cycle');
      return;
    }

    this._switching = true;
    try {
      if (enabledChanged) {
        if (enabled) {
          this._log.log('wake-word', 'Mode → On Device');
          session.pipeline.stop();
          if (session.currentState !== State.PAUSED) {
            await this.start();
          }
        } else {
          this._log.log('wake-word', 'Mode → Home Assistant — releasing models');
          this.stop();
          this._destroyInference('mode-switch');
          this._loadedModelsKey = null;
          this._stopMicroConfig = null;
          await forceResetWasm();
          this._tfweb = null;
          if (session.currentState !== State.PAUSED) {
            session.setState(State.CONNECTING);
            await session.pipeline.start();
          }
        }
      } else if (this._active || session.currentState === State.PAUSED) {
        // Model changed while actively listening (or paused)
        this._log.log('wake-word', `Model → ${model}`);
        this.stop();
        if (session.currentState !== State.PAUSED) {
          await this.start();
        }
      }

      // Update cache after successful apply
      this._cachedEnabled = enabled;
      this._cachedModel = model;
    } catch (e) {
      this._log.error('wake-word', `Settings change failed: ${e.message || e}`);
      this._cachedEnabled = enabled;
      this._cachedModel = model;
      session.pipeline.restart(session.pipeline.calculateRetryDelay());
    } finally {
      this._switching = false;
    }
  }

  /**
   * Release all resources.
   */
  async teardown() {
    this.stop();
    if (this._stopMicroConfig) {
      this._log.log('stop-word', 'Stop model unloaded');
      this._stopMicroConfig = null;
    }
    this._destroyInference('teardown');
    this._loadedModelsKey = null;
    try {
      await forceResetWasm();
      this._tfweb = null;
    } catch (_) { /* ignore */ }
  }
}
