/**
 * WakeWordManager
 *
 * Orchestrates on-device wake word detection using microWakeWord
 * (TFLite via WASM). Processes 16kHz audio through a micro_frontend
 * feature extractor and runs TFLite keyword models with sliding
 * window detection.
 *
 * Supports dual wake words — two keyword models can run
 * concurrently on the shared pipeline.
 */

import { State, BlurReason } from '../constants.js';
import { getSwitchState, getSelectState } from '../shared/satellite-state.js';
import { CHIME_WAKE } from '../audio/chime.js';
import { loadTFLite, loadMicroModels, loadMicroModel, getMicroModelParams, releaseUnusedMicroModels, releaseMicroModels } from './micro-models.js';
import { MicroWakeWordInference } from './micro-inference.js';
import { clearNotificationUI } from '../shared/satellite-notification.js';
import { sendAck } from '../shared/notification-comms.js';

const CHUNK_SIZE = 1280; // 80ms @ 16kHz
const NO_WAKE_WORD = 'No wake word';

// ─── Detection thresholds ────────────────────────────────────────────
// microWakeWord models output confidence scores (0–1 via uint8/255).
// Detection uses sliding window mean > cutoff. Browser audio (WebRTC
// AGC/NS) produces different feature profiles than ESP32, so these
// cutoffs are lower than the model manifests' native values.
const MODEL_THRESHOLDS = {
  ok_nabu:     { 'Slightly sensitive': 0.65, 'Moderately sensitive': 0.50, 'Very sensitive': 0.35 },
  hey_jarvis:  { 'Slightly sensitive': 0.55, 'Moderately sensitive': 0.40, 'Very sensitive': 0.30 },
  hey_mycroft: { 'Slightly sensitive': 0.55, 'Moderately sensitive': 0.40, 'Very sensitive': 0.30 },
  alexa:       { 'Slightly sensitive': 0.55, 'Moderately sensitive': 0.40, 'Very sensitive': 0.30 },
  stop:        { 'Slightly sensitive': 0.50, 'Moderately sensitive': 0.40, 'Very sensitive': 0.30 },
};
const DEFAULT_THRESHOLDS = { 'Slightly sensitive': 0.60, 'Moderately sensitive': 0.45, 'Very sensitive': 0.30 };

// Wake word phrases matching microWakeWord conventions.
// DATA_LAST_WAKE_UP in HA core uses these exact strings for dedup.
const WAKE_WORD_PHRASES = {
  ok_nabu: 'Okay Nabu',
  hey_jarvis: 'Hey Jarvis',
  alexa: 'Alexa',
  hey_mycroft: 'Hey Mycroft',
};

export class WakeWordManager {
  constructor(session) {
    this._session = session;
    this._log = session.logger;

    this._inference = null;
    this._active = false;
    this._sampleBuffer = new Float32Array(0);
    this._loadedModelsKey = null; // sorted model names string for change detection
    this._processing = false;
    this._frameQueue = [];

    // TFLite WASM client (cached)
    this._tfweb = null;

    // Stop word state
    this._stopOnlyMode = false;
    this._stopMicroConfig = null;
    this._suspendedKeywords = null;

    // Settings change tracking
    this._cachedEnabled = undefined;
    this._cachedModel = undefined;
    this._cachedModel2 = undefined;
    this._cachedThreshold = undefined;
    this._switching = false;
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
   * Get the second wake word model name (or NO_WAKE_WORD if disabled).
   * @returns {string}
   */
  getModelName2() {
    return getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_model_2',
      NO_WAKE_WORD,
    );
  }

  /**
   * Get deduplicated list of active model names.
   * @returns {string[]}
   */
  getActiveModels() {
    const models = [this.getModelName()];
    const model2 = this.getModelName2();
    if (model2 && model2 !== NO_WAKE_WORD && !models.includes(model2)) {
      models.push(model2);
    }
    return models;
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
   * Get the detection threshold for a specific model based on sensitivity setting.
   * @param {string} modelName
   * @returns {number}
   */
  getThresholdForModel(modelName) {
    const label = this._getSensitivityLabel();
    const modelMap = MODEL_THRESHOLDS[modelName] || DEFAULT_THRESHOLDS;
    return modelMap[label] ?? DEFAULT_THRESHOLDS['Moderately sensitive'];
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
   * @param {Record<string, object>} runners - name → TFLiteWebModelRunner map
   * @returns {{runner: object, name: string, cutoff: number, slidingWindow: number, stepSize: number}[]}
   */
  _buildKeywordConfigs(runners) {
    return Object.entries(runners).map(([name, runner]) => {
      const params = getMicroModelParams(name);
      this._log.log('wake-word',
        `${name}: cutoff=${params.cutoff} slidingWindow=${params.slidingWindow} stepSize=${params.stepSize} (${params._source || 'hardcoded'})`
      );
      return {
        runner,
        name,
        cutoff: this.getThresholdForModel(name),
        slidingWindow: params.slidingWindow,
        stepSize: params.stepSize,
      };
    });
  }

  // ─── Start / Stop ───────────────────────────────────────────────────

  /**
   * Start wake word detection. Loads the TFLite runtime on first call.
   */
  async start() {
    if (this._active) return;

    const activeModels = this.getActiveModels();
    const modelsKey = activeModels.slice().sort().join(',');
    this._log.log('wake-word', `Starting on-device detection (models: ${activeModels.join(', ')})`);

    try {
      if (!this._tfweb) {
        this._log.log('wake-word', 'Loading TFLite WASM runtime...');
        this._tfweb = await loadTFLite();
        this._log.log('wake-word', 'TFLite runtime loaded');
      }

      if (!this._inference || this._loadedModelsKey !== modelsKey) {
        this._log.log('wake-word', 'Loading TFLite wake word models...');
        const runners = await loadMicroModels(this._tfweb, activeModels, (name) => {
          this._log.log('wake-word', `Loading model: ${name}`);
        });
        await releaseUnusedMicroModels(activeModels);

        const keywordConfigs = this._buildKeywordConfigs(runners);
        this._inference = new MicroWakeWordInference(keywordConfigs, this._log, this._getSensitivityLabel());
        this._loadedModelsKey = modelsKey;

        const configSummary = keywordConfigs.map((k) => `${k.name}(c=${k.cutoff},sw=${k.slidingWindow})`).join(', ');
        this._log.log('wake-word', `TFLite models loaded: ${configSummary}`);
      } else {
        this._inference.updateThresholds(
          activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) })),
        );
        this._inference.updateEnergyThresholds(this._getSensitivityLabel());
        this._inference.reset();
      }

      this._sampleBuffer = new Float32Array(0);
      this._frameQueue.length = 0;
      this._processing = false;
      this._active = true;
      this._session.setState(State.LISTENING);
      this._log.log('wake-word', 'On-device wake word detection active');

      // Pre-load stop model in the background
      this._preloadStopModel();
    } catch (e) {
      this._log.error('wake-word', `Failed to start: ${e.message || e}`);
      throw e;
    }
  }

  /**
   * Pre-load the stop model (non-blocking).
   */
  _preloadStopModel() {
    if (this._stopMicroConfig) return;
    if (!this._tfweb) return;
    loadMicroModel(this._tfweb, 'stop').then((runner) => {
      const params = getMicroModelParams('stop');
      this._stopMicroConfig = {
        runner,
        name: 'stop',
        cutoff: this.getThresholdForModel('stop'),
        slidingWindow: params.slidingWindow,
        stepSize: params.stepSize,
      };
      this._log.log('stop-word', `Stop model pre-loaded (c=${this._stopMicroConfig.cutoff})`);
    }).catch((e) => {
      this._log.log('stop-word', `Pre-load skipped — ${e.message || e}`);
    });
  }

  /**
   * Stop wake word detection.
   */
  stop() {
    if (!this._active && !this._stopOnlyMode) return;
    this._active = false;
    this._stopOnlyMode = false;
    this._suspendedKeywords = null;
    this._sampleBuffer = new Float32Array(0);
    this._frameQueue.length = 0;
    this._log.log('wake-word', 'Stopped');
  }

  // ─── Audio feed + detection ─────────────────────────────────────────

  /**
   * Feed audio samples from the AudioWorklet.
   * Accumulates to CHUNK_SIZE (1280) then queues for serial inference.
   * @param {Float32Array} chunk - raw audio samples from worklet
   */
  feedAudio(chunk) {
    if ((!this._active && !this._stopOnlyMode) || !this._inference) return;

    // Accumulate samples
    const combined = new Float32Array(this._sampleBuffer.length + chunk.length);
    combined.set(this._sampleBuffer);
    combined.set(chunk, this._sampleBuffer.length);
    this._sampleBuffer = combined;

    // Queue complete chunks for serial processing
    while (this._sampleBuffer.length >= CHUNK_SIZE) {
      this._frameQueue.push(this._sampleBuffer.slice(0, CHUNK_SIZE));
      this._sampleBuffer = this._sampleBuffer.slice(CHUNK_SIZE);
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

    // If the tab is paused (screen off / background), unpause so pipeline
    // events aren't dropped. The wake word worklet keeps running while
    // paused, but handlePipelineMessage blocks all events when isPaused.
    if (session.visibility.isPaused) {
      this._log.log('wake-word', 'Unpausing — detection while tab paused');
      await session.audio.resume();
      session.visibility._isPaused = false;
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

    session.setState(State.WAKE_WORD_DETECTED);
    session.ui.showBlurOverlay(BlurReason.PIPELINE);

    // Play wake chime if enabled
    const wakeSound = getSwitchState(
      session.hass, session.config.satellite_entity, 'wake_sound',
    ) !== false;

    if (wakeSound) {
      session.audio.stopSending();
      session.tts.playChime('wake');
      const resumeDelay = (CHIME_WAKE.duration * 1000) + 50;

      await new Promise((resolve) => setTimeout(resolve, resumeDelay));
      // Discard audio captured during chime
      session.audio.audioBuffer = [];
    }

    // Start pipeline with STT stage (skip server-side wake word)
    try {
      await session.pipeline.start({ start_stage: 'stt', wake_word_phrase: this.getWakeWordPhrase(modelName) });
    } catch (e) {
      this._log.error('wake-word', `Pipeline start failed after detection: ${e.message || e}`);
      session.pipeline.restart(session.pipeline.calculateRetryDelay());
    }
  }

  // ─── Stop model management ──────────────────────────────────────────

  /**
   * Enable the stop keyword model for interruptible states.
   * @param {boolean} stopOnly - true for stop-only mode (TTS/notifications),
   *   false to add stop alongside regular wake words (timer alerts)
   */
  async enableStopModel(stopOnly = false) {
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
        this._stopMicroConfig = {
          runner,
          name: 'stop',
          cutoff: this.getThresholdForModel('stop'),
          slidingWindow: params.slidingWindow,
          stepSize: params.stepSize,
        };
        this._log.log('stop-word', `Stop model loaded (c=${this._stopMicroConfig.cutoff})`);
      } else {
        this._log.log('stop-word', 'Stop model already loaded (cached)');
      }

      this._inference.addKeyword(this._stopMicroConfig);

      if (stopOnly) {
        this._suspendedKeywords = this._inference._keywords.filter((k) => k.name !== 'stop');
        for (const kw of this._suspendedKeywords) {
          this._inference.removeKeyword(kw.name);
        }
        this._stopOnlyMode = true;
        this._inference.reset();
        this._sampleBuffer = new Float32Array(0);
        this._frameQueue.length = 0;
        this._processing = false;
        this._log.log('stop-word', 'Enabled (stop-only mode)');
      } else {
        this._log.log('stop-word', 'Enabled (alongside wake words)');
      }
    } catch (e) {
      this._log.error('stop-word', `Failed to enable: ${e.message || e}`);
    }
  }

  /**
   * Disable the stop keyword model and restore regular keywords if suspended.
   */
  disableStopModel() {
    if (!this._inference) return;

    this._inference.removeKeyword('stop');

    if (this._stopOnlyMode) {
      this._stopOnlyMode = false;
      if (this._suspendedKeywords) {
        for (const kw of this._suspendedKeywords) {
          this._inference.addKeyword(kw);
        }
        this._suspendedKeywords = null;
      }
      this._sampleBuffer = new Float32Array(0);
      this._frameQueue.length = 0;
      this._processing = false;
      this._log.log('stop-word', 'Disabled (stop-only mode off)');
    } else {
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
          mgr.currentAudio.pause();
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

      const isRemote = !!session.ttsTarget;
      if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
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

    if (session.tts.isPlaying) {
      session.tts.stop();
    }

    session.askQuestion.cancel();
    session.pipeline.clearContinueState();
    session.setState(State.IDLE);
    session.chat.clear();
    session.ui.hideBlurOverlay(BlurReason.PIPELINE);
    session.ui.updateForState(State.IDLE, session.pipeline.serviceUnavailable, false);

    const isRemote = !!session.ttsTarget;
    if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
      session.tts.playChime('done');
    }
    session.pipeline.restart(0);
  }

  // ─── Restart / settings ─────────────────────────────────────────────

  /**
   * Restart wake word detection (e.g. after pipeline completes).
   */
  async restart() {
    if (!this.isEnabled()) return;

    // If models changed while paused, do a full start
    const activeModels = this.getActiveModels();
    const modelsKey = activeModels.slice().sort().join(',');
    if (!this._inference || this._loadedModelsKey !== modelsKey) {
      this._log.log('wake-word', 'Restarting with model reload');
      await this.start();
      return;
    }

    this._log.log('wake-word', 'Restarting detection');
    this._sampleBuffer = new Float32Array(0);
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
   * Check for wake word setting changes and react.
   * Called from session.updateHass() on every HA state change.
   */
  checkSettingsChanged() {
    if (!this._session._hasStarted || this._switching) return;

    const enabled = this.isEnabled();
    const model = this.getModelName();
    const model2 = this.getModelName2();
    const threshold = this.getThreshold();

    // Initialize cache on first call
    if (this._cachedEnabled === undefined) {
      this._cachedEnabled = enabled;
      this._cachedModel = model;
      this._cachedModel2 = model2;
      this._cachedThreshold = threshold;
      return;
    }

    const enabledChanged = enabled !== this._cachedEnabled;
    const modelChanged = model !== this._cachedModel || model2 !== this._cachedModel2;
    const thresholdChanged = threshold !== this._cachedThreshold;

    if (!enabledChanged && !modelChanged && !thresholdChanged) return;

    // Always update threshold cache
    this._cachedThreshold = threshold;

    // Live threshold update (no restart needed)
    if (thresholdChanged && !modelChanged && this._active && this._inference) {
      const activeModels = this.getActiveModels();
      this._inference.updateThresholds(
        activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) })),
      );
      this._inference.updateEnergyThresholds(this._getSensitivityLabel());
      this._log.log('wake-word', 'Thresholds updated');
    }

    // Mode or model change requires switching
    if (enabledChanged || modelChanged) {
      this._applyModeOrModelChange(enabled, model, model2, enabledChanged);
    }
  }

  /**
   * Apply a detection mode or model change.
   */
  async _applyModeOrModelChange(enabled, model, model2, enabledChanged) {
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
          this._log.log('wake-word', 'Mode → Home Assistant');
          this.stop();
          if (session.currentState !== State.PAUSED) {
            session.setState(State.CONNECTING);
            await session.pipeline.start();
          }
        }
      } else if (this._active || session.currentState === State.PAUSED) {
        // Model changed while actively listening (or paused)
        this._log.log('wake-word', `Models → ${this.getActiveModels().join(', ')}`);
        this.stop();
        if (session.currentState !== State.PAUSED) {
          await this.start();
        }
      }

      // Update cache after successful apply
      this._cachedEnabled = enabled;
      this._cachedModel = model;
      this._cachedModel2 = model2;
    } catch (e) {
      this._log.error('wake-word', `Settings change failed: ${e.message || e}`);
      this._cachedEnabled = enabled;
      this._cachedModel = model;
      this._cachedModel2 = model2;
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
    this._inference = null;
    this._loadedModelsKey = null;
    try {
      await releaseMicroModels();
    } catch (_) { /* ignore */ }
  }
}
