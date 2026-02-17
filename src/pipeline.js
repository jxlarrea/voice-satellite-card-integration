/**
 * Voice Satellite Card — PipelineManager
 *
 * Manages the HA Assist pipeline lifecycle: starting, stopping, restarting,
 * idle timeouts, error recovery with linear backoff, and continue conversation.
 */

import { State } from './constants.js';

export class PipelineManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._unsubscribe = null;
    this._binaryHandlerId = null;
    this._retryCount = 0;
    this._serviceUnavailable = false;
    this._restartTimeout = null;
    this._isRestarting = false;
    this._idleTimeoutId = null;
    this._pendingRunEnd = false;
    this._recoveryTimeout = null;
    this._suppressTTS = false;
    this._intentErrorBarTimeout = null;
    this._continueConversationId = null;
    this._shouldContinue = false;
    this._continueMode = false;
    this._isStreaming = false;
  }

  get binaryHandlerId() {
    return this._binaryHandlerId;
  }

  get isRestarting() {
    return this._isRestarting;
  }

  get serviceUnavailable() {
    return this._serviceUnavailable;
  }

  get shouldContinue() {
    return this._shouldContinue;
  }

  get continueConversationId() {
    return this._continueConversationId;
  }

  get isStreaming() {
    return this._isStreaming;
  }

  // --- Start / Stop / Restart ---

  async _resolveDeviceId() {
    var config = this._card.config;
    if (!config.satellite_entity) return null;

    var connection = this._card.connection;
    if (!connection) return null;

    try {
      var entity = await connection.sendMessagePromise({
        type: 'config/entity_registry/get',
        entity_id: config.satellite_entity,
      });
      if (entity && entity.device_id) {
        this._log.log('pipeline', 'Resolved device_id: ' + entity.device_id + ' from ' + config.satellite_entity);
        return entity.device_id;
      }
    } catch (e) {
      this._log.error('pipeline', 'Failed to resolve device_id from ' + config.satellite_entity + ': ' + e);
    }
    return null;
  }

  async start(options) {
    var self = this;
    var opts = options || {};
    var connection = this._card.connection;

    if (!connection) {
      throw new Error('No Home Assistant connection available');
    }

    // Listen for HA reconnection (e.g. after restart) to reset retries
    if (!this._reconnectListener) {
      this._reconnectListener = function () {
        self._log.log('pipeline', 'Connection reconnected — resetting retry state');
        self._retryCount = 0;

        // Cancel any pending retry and restart immediately
        if (self._restartTimeout) {
          clearTimeout(self._restartTimeout);
          self._restartTimeout = null;
        }
        if (self._isRestarting) {
          self._isRestarting = false;
        }

        // Clear error state
        self._serviceUnavailable = false;
        self._card.ui.clearErrorBar();

        // Small delay to let HA fully initialize after reconnect
        setTimeout(function () {
          self.restart(0);
        }, 2000);
      };
      connection.addEventListener('ready', this._reconnectListener);
    }

    var pipelines = await connection.sendMessagePromise({
      type: 'assist_pipeline/pipeline/list',
    });

    this._log.log('pipeline', 'Available: ' + pipelines.pipelines.map(function (p) {
      return p.name + ' (' + p.id + ')' + (p.preferred ? ' [preferred]' : '');
    }).join(', '));

    var config = this._card.config;
    var pipelineId = config.pipeline_id;
    if (!pipelineId) {
      var preferred = pipelines.pipelines.find(function (p) { return p.preferred; });
      pipelineId = preferred ? preferred.id : pipelines.pipelines[0].id;
    }

    this._log.log('pipeline', 'Starting pipeline: ' + pipelineId);

    var startStage = opts.start_stage || 'wake_word';
    var runConfig = {
      type: 'assist_pipeline/run',
      start_stage: startStage,
      end_stage: 'tts',
      input: {
        sample_rate: 16000,
        timeout: startStage === 'wake_word' ? 0 : undefined,
      },
      pipeline: pipelineId,
      timeout: config.pipeline_timeout,
    };

    if (opts.conversation_id) {
      runConfig.conversation_id = opts.conversation_id;
    }

    // Resolve device_id from satellite entity for timer support
    var deviceId = await this._resolveDeviceId();
    if (deviceId) {
      runConfig.device_id = deviceId;
    }

    if (runConfig.input.timeout === undefined) {
      delete runConfig.input.timeout;
    }

    this._log.log('pipeline', 'Run config: ' + JSON.stringify(runConfig));

    this._unsubscribe = await connection.subscribeMessage(
      function (message) {
        self._card.onPipelineMessage(message);
      },
      runConfig
    );

    this._log.log('pipeline', 'Subscribed, waiting for run-start...');

    // Start sending audio
    var audio = this._card.audio;
    audio.startSending(function () { return self._binaryHandlerId; });

    this._isStreaming = true;
    this._startIdleTimeout();
  }

  async stop() {
    this._card.audio.stopSending();
    this._binaryHandlerId = null;
    this._isStreaming = false;

    if (this._unsubscribe) {
      try {
        await this._unsubscribe();
      } catch (e) {
        // Ignore unsubscribe errors
      }
      this._unsubscribe = null;
    }

    this._clearIdleTimeout();
  }

  restart(delay) {
    var self = this;

    if (this._isRestarting) {
      this._log.log('pipeline', 'Restart already in progress — skipping');
      return;
    }
    this._isRestarting = true;

    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }

    this._clearIdleTimeout();

    var stopPromise = this.stop();
    stopPromise.then(function () {
      self._restartTimeout = setTimeout(function () {
        self._restartTimeout = null;
        self._isRestarting = false;
        self.start().catch(function (e) {
          var msg = (e && e.message) ? e.message : JSON.stringify(e);
          self._log.error('pipeline', 'Restart failed: ' + msg);
          if (!self._serviceUnavailable) {
            self._card.ui.showErrorBar();
            self._serviceUnavailable = true;
          }
          self.restart(self._calculateRetryDelay());
        });
      }, delay || 0);
    });
  }

  restartContinue(conversationId) {
    var self = this;

    if (this._isRestarting) {
      this._log.log('pipeline', 'Restart already in progress — skipping continue');
      return;
    }
    this._isRestarting = true;
    this._clearIdleTimeout();

    var stopPromise = this.stop();
    stopPromise.then(function () {
      self._isRestarting = false;
      self._continueMode = true;
      self.start({
        start_stage: 'stt',
        conversation_id: conversationId,
      }).catch(function (e) {
        self._log.error('pipeline', 'Continue conversation failed: ' + ((e && e.message) ? e.message : JSON.stringify(e)));
        self._card.chat.clear();
        self._card.ui.hideBlurOverlay('pipeline');
        self.restart(0);
      });
    });
  }

  // --- Event Data Processing ---

  handleRunStart(eventData) {
    this._binaryHandlerId = eventData.runner_data.stt_binary_handler_id;
    this._resetIdleTimeout();

    // Store streaming TTS URL
    this._card.tts.storeStreamingUrl(eventData);

    if (this._continueMode) {
      this._continueMode = false;
      this._card.setState(State.STT);
      this._log.log('pipeline', 'Running (continue conversation) — binary handler ID: ' + this._binaryHandlerId);
      this._log.log('pipeline', 'Listening for speech...');
      return;
    }

    this._card.setState(State.LISTENING);
    this._log.log('pipeline', 'Running — binary handler ID: ' + this._binaryHandlerId);
    this._log.log('pipeline', 'Listening for wake word...');
  }

  handleWakeWordStart() {
    if (this._serviceUnavailable) {
      var self = this;
      if (this._recoveryTimeout) clearTimeout(this._recoveryTimeout);
      this._recoveryTimeout = setTimeout(function () {
        if (self._serviceUnavailable) {
          self._log.log('recovery', 'Wake word service recovered');
          self._serviceUnavailable = false;
          self._retryCount = 0;
          self._card.ui.clearErrorBar();
          self._card.ui.hideBar();
        }
      }, 2000);
    }
  }

  handleWakeWordEnd(eventData) {
    var wakeOutput = eventData.wake_word_output;
    if (!wakeOutput || Object.keys(wakeOutput).length === 0) {
      this._log.error('error', 'Wake word service unavailable (empty wake_word_output)');

      if (this._recoveryTimeout) {
        clearTimeout(this._recoveryTimeout);
        this._recoveryTimeout = null;
      }

      this._binaryHandlerId = null;
      this._card.ui.showErrorBar();
      this._serviceUnavailable = true;
      this.restart(this._calculateRetryDelay());
      return;
    }

    // Valid wake word — service healthy
    if (this._recoveryTimeout) {
      clearTimeout(this._recoveryTimeout);
      this._recoveryTimeout = null;
    }
    this._serviceUnavailable = false;
    this._retryCount = 0;
    this._card.ui.clearErrorBar();

    var tts = this._card.tts;
    if (tts.isPlaying) {
      tts.stop();
      this._pendingRunEnd = false;
    }
    if (this._intentErrorBarTimeout) {
      clearTimeout(this._intentErrorBarTimeout);
      this._intentErrorBarTimeout = null;
    }

    this._card.chat.clear();
    this._shouldContinue = false;
    this._continueConversationId = null;

    this._card.setState(State.WAKE_WORD_DETECTED);
    this._resetIdleTimeout();

    if (this._card.config.chime_on_wake_word) {
      tts.playChime('wake');
    }
    this._card.turnOffWakeWordSwitch();
    this._card.ui.showBlurOverlay('pipeline');
  }

  handleSttEnd(eventData) {
    var text = eventData.stt_output ? eventData.stt_output.text : '';
    if (text) {
      this._card.chat.showTranscription(text);
    }
  }

  handleIntentProgress(eventData) {
    var tts = this._card.tts;

    if (eventData.tts_start_streaming && tts.streamingUrl && !tts.isPlaying) {
      this._log.log('tts', 'Streaming TTS started — playing early');
      this._card.setState(State.TTS);
      tts.play(tts.streamingUrl);
      tts.streamingUrl = null;
    }

    if (!eventData.chat_log_delta) return;
    var chunk = eventData.chat_log_delta.content;
    if (typeof chunk !== 'string') return;

    var chat = this._card.chat;
    chat.streamedResponse = (chat.streamedResponse || '') + chunk;
    chat.updateResponse(chat.streamedResponse);
  }

  handleIntentEnd(eventData) {
    var responseType = null;
    try {
      responseType = eventData.intent_output.response.response_type;
    } catch (e) { /* ignore */ }

    if (responseType === 'error') {
      var errorText = this._extractResponseText(eventData) || 'An error occurred';
      this._log.error('error', 'Intent error: ' + errorText);

      this._card.ui.showErrorBar();
      if (this._card.config.chime_on_wake_word) {
        this._card.tts.playChime('error');
      }

      this._suppressTTS = true;

      var self = this;
      if (this._intentErrorBarTimeout) clearTimeout(this._intentErrorBarTimeout);
      this._intentErrorBarTimeout = setTimeout(function () {
        self._intentErrorBarTimeout = null;
        self._card.ui.clearErrorBar();
        self._card.ui.hideBar();
      }, 3000);

      this._card.chat.streamedResponse = '';
      return;
    }

    var responseText = this._extractResponseText(eventData);
    if (responseText) {
      this._card.chat.showResponse(responseText);
    }

    this._shouldContinue = false;
    this._continueConversationId = null;
    if (this._card.config.continue_conversation) {
      try {
        if (eventData.intent_output.continue_conversation === true) {
          this._shouldContinue = true;
          this._continueConversationId = eventData.intent_output.conversation_id || null;
          this._log.log('pipeline', 'Continue conversation requested — id: ' + this._continueConversationId);
        }
      } catch (e) { /* ignore */ }
    }

    this._card.chat.streamedResponse = '';
    this._card.chat.streamEl = null;
  }

  handleTtsEnd(eventData) {
    if (this._suppressTTS) {
      this._suppressTTS = false;
      this._log.log('tts', 'TTS suppressed (intent error)');
      this.restart(0);
      return;
    }

    var tts = this._card.tts;
    if (tts.isPlaying) {
      this._log.log('tts', 'Streaming TTS already playing — skipping duplicate playback');
      this.restart(0);
      return;
    }

    var url = eventData.tts_output ? (eventData.tts_output.url || eventData.tts_output.url_path) : null;
    if (url) {
      tts.play(url);
    }

    this.restart(0);
  }

  handleRunEnd() {
    this._log.log('pipeline', 'Run ended');
    this._binaryHandlerId = null;

    if (this._isRestarting) {
      this._log.log('pipeline', 'Restart already in progress — skipping run-end restart');
      return;
    }

    if (this._serviceUnavailable) {
      this._log.log('ui', 'Error recovery handling restart');
      this._card.ui.hideBlurOverlay('pipeline');
      return;
    }

    if (this._card.tts.isPlaying) {
      this._log.log('ui', 'TTS playing — deferring cleanup');
      this._pendingRunEnd = true;
      return;
    }

    this._finishRunEnd();
  }

  handleError(errorData) {
    var errorCode = errorData.code || '';
    var errorMessage = errorData.message || '';

    this._log.log('error', errorCode + ' — ' + errorMessage);

    var EXPECTED_ERRORS = ['timeout', 'wake-word-timeout', 'stt-no-text-recognized', 'duplicate_wake_up_detected'];

    if (EXPECTED_ERRORS.indexOf(errorCode) !== -1) {
      this._log.log('pipeline', 'Expected error: ' + errorCode + ' — restarting');

      var interactingStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
      if (interactingStates.indexOf(this._card.currentState) !== -1) {
        this._log.log('ui', 'Cleaning up interaction UI after expected error');
        this._card.setState(State.IDLE);
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay('pipeline');
        this._shouldContinue = false;
        this._continueConversationId = null;
        var isRemote = this._card.config.tts_target && this._card.config.tts_target !== 'browser';
        if (this._card.config.chime_on_request_sent && !isRemote) {
          this._card.tts.playChime('done');
        }
      }

      this.restart(0);
      return;
    }

    this._log.error('error', 'Unexpected: ' + errorCode + ' — ' + errorMessage);

    var interactingStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
    var wasInteracting = interactingStates.indexOf(this._card.currentState) !== -1;

    this._binaryHandlerId = null;

    if (wasInteracting && this._card.config.chime_on_wake_word) {
      this._card.tts.playChime('error');
    }
    this._card.ui.showErrorBar();
    this._serviceUnavailable = true;
    this._card.chat.clear();
    this._card.ui.hideBlurOverlay('pipeline');

    this.restart(this._calculateRetryDelay());
  }

  finishPendingRunEnd() {
    if (this._pendingRunEnd) {
      this._finishRunEnd();
    }
  }

  clearContinueState() {
    this._shouldContinue = false;
    this._continueConversationId = null;
  }

  resetForResume() {
    this._isRestarting = false;
    this._continueMode = false;
    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }
  }

  // --- Private ---

  _finishRunEnd() {
    this._pendingRunEnd = false;
    this._card.chat.clear();
    this._card.ui.hideBlurOverlay('pipeline');
    this._card.setState(State.IDLE);

    if (this._serviceUnavailable) {
      this._log.log('ui', 'Retry already scheduled — skipping restart');
      return;
    }

    this.restart(0);
  }

  _calculateRetryDelay() {
    this._retryCount++;
    var delay = Math.min(5000 * this._retryCount, 30000);
    this._log.log('pipeline', 'Retry in ' + delay + 'ms (attempt #' + this._retryCount + ')');
    return delay;
  }

  _startIdleTimeout() {
    var self = this;
    this._clearIdleTimeout();

    if (this._card.config.pipeline_idle_timeout <= 0) return;

    this._idleTimeoutId = setTimeout(function () {
      var activeStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
      if (activeStates.indexOf(self._card.currentState) !== -1) {
        self._log.log('pipeline', 'Idle timeout fired but interaction in progress — deferring');
        self._resetIdleTimeout();
        return;
      }
      if (self._card.tts.isPlaying) {
        self._log.log('pipeline', 'Idle timeout fired but TTS playing — deferring');
        self._resetIdleTimeout();
        return;
      }

      self._log.log('pipeline', 'Idle timeout — restarting');
      self.restart(0);
    }, this._card.config.pipeline_idle_timeout * 1000);
  }

  _clearIdleTimeout() {
    if (this._idleTimeoutId) {
      clearTimeout(this._idleTimeoutId);
      this._idleTimeoutId = null;
    }
  }

  _resetIdleTimeout() {
    this._startIdleTimeout();
  }

  _extractResponseText(eventData) {
    try {
      var text = eventData.intent_output.response.speech.plain.speech;
      if (text) return text;
    } catch (e) { /* ignore */ }

    try { if (eventData.intent_output.response.speech.speech) return eventData.intent_output.response.speech.speech; } catch (e) { /* ignore */ }
    try { if (eventData.intent_output.response.plain) return eventData.intent_output.response.plain; } catch (e) { /* ignore */ }
    try { if (typeof eventData.intent_output.response === 'string') return eventData.intent_output.response; } catch (e) { /* ignore */ }

    this._log.log('error', 'Could not extract response text');
    return null;
  }
}