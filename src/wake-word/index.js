/**
 * WakeWordManager
 *
 * Orchestrates on-device wake word detection using openWakeWord
 * ONNX models via onnxruntime-web. Taps into the existing
 * AudioWorklet stream, runs inference, and triggers the pipeline
 * with start_stage: "stt" on detection.
 *
 * Supports dual wake words — two keyword models can run
 * concurrently on the same shared mel/embedding/VAD pipeline.
 */

import { State, BlurReason } from '../constants.js';
import { getSwitchState, getSelectState } from '../shared/satellite-state.js';
import { CHIME_WAKE } from '../audio/chime.js';
import { loadOrt, loadModels, releaseModels, releaseUnusedKeywords, getKeywordWindowSize } from './models.js';
import { WakeWordInference } from './inference.js';

const CHUNK_SIZE = 1280; // 80ms @ 16kHz
const NO_WAKE_WORD = 'No wake word';

// Per-model sensitivity thresholds tuned for browser-side inference.
// Browser pipeline produces lower raw scores than HA Voice PE firmware,
// so thresholds are calibrated lower to match observed detection ranges.
// Values are floating-point probability cutoffs (higher = less sensitive).
const MODEL_THRESHOLDS = {
  ok_nabu:     { 'Slightly sensitive': 0.65, 'Moderately sensitive': 0.50, 'Very sensitive': 0.35 },
  hey_jarvis:  { 'Slightly sensitive': 0.70, 'Moderately sensitive': 0.55, 'Very sensitive': 0.40 },
  hey_mycroft: { 'Slightly sensitive': 0.70, 'Moderately sensitive': 0.55, 'Very sensitive': 0.40 },
  alexa:       { 'Slightly sensitive': 0.70, 'Moderately sensitive': 0.55, 'Very sensitive': 0.40 },
  hey_rhasspy: { 'Slightly sensitive': 0.70, 'Moderately sensitive': 0.55, 'Very sensitive': 0.40 },
};
const DEFAULT_THRESHOLDS = { 'Slightly sensitive': 0.70, 'Moderately sensitive': 0.55, 'Very sensitive': 0.40 };

// Wake word phrases matching openWakeWord / microWakeWord conventions.
// DATA_LAST_WAKE_UP in HA core uses these exact strings for dedup.
const WAKE_WORD_PHRASES = {
  ok_nabu: 'Okay Nabu',
  hey_jarvis: 'Hey Jarvis',
  alexa: 'Alexa',
  hey_mycroft: 'Hey Mycroft',
  hey_rhasspy: 'Hey Rhasspy',
};

export class WakeWordManager {
  constructor(session) {
    this._session = session;
    this._log = session.logger;

    this._inference = null;
    this._ort = null;
    this._active = false;
    this._sampleBuffer = new Float32Array(0);
    this._loadedModelsKey = null; // sorted model names string for change detection
    this._processing = false;
    this._frameQueue = [];

    // Settings change tracking
    this._cachedEnabled = undefined;
    this._cachedModel = undefined;
    this._cachedModel2 = undefined;
    this._cachedThreshold = undefined;
    this._switching = false;
  }

  /** True when actively listening for wake words. */
  get active() { return this._active; }

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
   * Get the wake word phrase for pipeline dedup (matches openWakeWord/microWakeWord format).
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
   * Get the detection threshold for the primary model (legacy compat).
   * @returns {number}
   */
  getThreshold() {
    return this.getThresholdForModel(this.getModelName());
  }

  /**
   * Build keywordConfigs array for the inference engine.
   * @param {Record<string, object>} keywordSessions - name → ONNX session map
   * @returns {{session: object, windowSize: number, threshold: number, name: string}[]}
   */
  _buildKeywordConfigs(keywordSessions) {
    return Object.entries(keywordSessions).map(([name, session]) => ({
      session,
      windowSize: getKeywordWindowSize(session),
      threshold: this.getThresholdForModel(name),
      name,
    }));
  }

  /**
   * Start wake word detection. Loads models on first call.
   */
  async start() {
    if (this._active) return;

    const activeModels = this.getActiveModels();
    const modelsKey = activeModels.slice().sort().join(',');
    this._log.log('wake-word', `Starting on-device detection (models: ${activeModels.join(', ')})`);

    try {
      // Load ONNX Runtime (cached)
      if (!this._ort) {
        this._log.log('wake-word', 'Loading ONNX Runtime...');
        this._ort = await loadOrt();
        this._log.log('wake-word', 'ONNX Runtime loaded');
      }

      // Load models (cached per-name, unless active set changed)
      if (!this._inference || this._loadedModelsKey !== modelsKey) {
        this._log.log('wake-word', 'Loading wake word models...');
        const { common, keywords } = await loadModels(this._ort, activeModels, (name) => {
          this._log.log('wake-word', `Loading model: ${name}`);
        });

        // Release keyword sessions no longer in use
        await releaseUnusedKeywords(activeModels);

        const keywordConfigs = this._buildKeywordConfigs(keywords);
        this._inference = new WakeWordInference(this._ort, common, keywordConfigs);
        this._loadedModelsKey = modelsKey;

        const configSummary = keywordConfigs.map((k) => `${k.name}(w=${k.windowSize},t=${k.threshold})`).join(', ');
        this._log.log('wake-word', `Models loaded: ${configSummary}`);
      } else {
        // Same models, just reset state and update thresholds
        this._inference.updateThresholds(
          activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) })),
        );
        this._inference.reset();
      }

      this._sampleBuffer = new Float32Array(0);
      this._frameQueue.length = 0;
      this._processing = false;
      this._active = true;
      this._session.setState(State.LISTENING);
      this._log.log('wake-word', 'On-device wake word detection active');
    } catch (e) {
      this._log.error('wake-word', `Failed to start: ${e.message || e}`);
      throw e;
    }
  }

  /**
   * Stop wake word detection.
   */
  stop() {
    if (!this._active) return;
    this._active = false;
    this._sampleBuffer = new Float32Array(0);
    this._frameQueue.length = 0;
    this._log.log('wake-word', 'Stopped');
  }

  /**
   * Feed audio samples from the AudioWorklet.
   * Accumulates to CHUNK_SIZE (1280) then queues for serial inference.
   * @param {Float32Array} chunk - raw audio samples from worklet
   */
  feedAudio(chunk) {
    if (!this._active || !this._inference) return;

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
      while (this._frameQueue.length > 0 && this._active) {
        const frame = this._frameQueue.shift();
        const result = await this._inference.processChunk(frame);
        if (result.detected) {
          this._log.log('wake-word', `Wake word detected: ${result.model} (score: ${result.score.toFixed(3)}, vad: ${result.vadScore.toFixed(3)})`);
          this._frameQueue.length = 0;
          await this._onDetection(result.model);
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

  /**
   * Restart wake word detection (e.g. after pipeline completes).
   */
  async restart() {
    if (!this.isEnabled()) return;

    // If models changed while paused, do a full start to reload them
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

    // Always update threshold cache (applies immediately)
    this._cachedThreshold = threshold;

    // Live threshold update (no restart needed)
    if (thresholdChanged && !modelChanged && this._active && this._inference) {
      const activeModels = this.getActiveModels();
      this._inference.updateThresholds(
        activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) })),
      );
      this._log.log('wake-word', `Thresholds updated`);
    }

    // Mode or model change requires switching
    // Cache for enabled/model/model2 updated inside _applyModeOrModelChange
    // AFTER the change is actually applied (not when deferred due to state)
    if (enabledChanged || modelChanged) {
      this._applyModeOrModelChange(enabled, model, model2, enabledChanged);
    }
  }

  /**
   * Apply a detection mode or model change. Switches between
   * on-device and HA pipeline, or reloads models.
   */
  async _applyModeOrModelChange(enabled, model, model2, enabledChanged) {
    const session = this._session;

    // Only switch while waiting for wake word, not mid-interaction.
    // PAUSED is allowed — change is applied and takes effect on resume.
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
      // Update cache even on error to avoid infinite retry loop
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
    this._inference = null;
    this._loadedModelsKey = null;
    try {
      await releaseModels();
    } catch (_) { /* ignore */ }
  }
}
