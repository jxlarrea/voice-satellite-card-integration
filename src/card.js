/**
 * Voice Satellite Card — Main Card Class
 *
 * Thin orchestrator that owns the managers and wires them together.
 * All real work is delegated to composition-based managers.
 */

import { State, DEFAULT_CONFIG } from './constants.js';
import { Logger } from './logger.js';
import { AudioManager } from './audio.js';
import { TtsManager } from './tts.js';
import { PipelineManager } from './pipeline.js';
import { UIManager } from './ui.js';
import { ChatManager } from './chat.js';
import { DoubleTapHandler } from './double-tap.js';
import { VisibilityManager } from './visibility.js';
import { TimerManager } from './timer.js';
import { AnnouncementManager } from './announcement.js';
import { getConfigForm } from './editor.js';
import { isEditorPreview, renderPreview } from './preview.js';

export class VoiceSatelliteCard extends HTMLElement {
  constructor() {
    super();

    // Core state
    this._state = State.IDLE;
    this._lastSyncedSatelliteState = null;
    this._config = Object.assign({}, DEFAULT_CONFIG);
    this._hass = null;
    this._connection = null;
    this._hasStarted = false;
    this._disconnectTimeout = null;

    // Logger (shared by all managers)
    this._logger = new Logger();

    // Composition — managers
    this._audio = new AudioManager(this);
    this._tts = new TtsManager(this);
    this._pipeline = new PipelineManager(this);
    this._ui = new UIManager(this);
    this._chat = new ChatManager(this);
    this._doubleTap = new DoubleTapHandler(this);
    this._visibility = new VisibilityManager(this);
    this._timer = new TimerManager(this);
    this._announcement = new AnnouncementManager(this);
  }

  // --- Public accessors for managers ---

  get logger() { return this._logger; }
  get audio() { return this._audio; }
  get tts() { return this._tts; }
  get pipeline() { return this._pipeline; }
  get ui() { return this._ui; }
  get chat() { return this._chat; }
  get config() { return this._config; }
  get timer() { return this._timer; }
  get announcement() { return this._announcement; }
  get currentState() { return this._state; }
  get connection() {
    if (!this._connection && this._hass && this._hass.connection) {
      this._connection = this._hass.connection;
    }
    return this._connection;
  }
  get hass() { return this._hass; }

  // --- HTMLElement Lifecycle ---

  connectedCallback() {
    if (this._disconnectTimeout) {
      clearTimeout(this._disconnectTimeout);
      this._disconnectTimeout = null;
    }
    this._render();

    // Defer preview check — card may not be in final DOM tree yet
    var self = this;
    requestAnimationFrame(function () {
      if (isEditorPreview(self) && self.shadowRoot) {
        renderPreview(self.shadowRoot, self._config);
        return; // Don't start pipeline in preview mode
      }
      self._ui.ensureGlobalUI();
      self._visibility.setup();

      if (!window._voiceSatelliteActive && self._hass && self._hass.connection) {
        self._startListening();
      }
    });
  }

  disconnectedCallback() {
    var self = this;
    this._disconnectTimeout = setTimeout(function () {
      if (window._voiceSatelliteInstance === self) {
        // Still active instance but truly disconnected — keep running via global UI
      }
    }, 100);
  }

  setConfig(config) {
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._logger.debug = this._config.debug;

    if (this._ui.element) {
      this._ui.applyStyles();
    }

    // Re-render preview if in editor
    if (this.shadowRoot && isEditorPreview(this)) {
      renderPreview(this.shadowRoot, this._config);
    }

    // Propagate config to active instance if this is a secondary card
    if (window._voiceSatelliteInstance && window._voiceSatelliteInstance !== this) {
      window._voiceSatelliteInstance._config = this._config;
      window._voiceSatelliteInstance._logger.debug = this._config.debug;
      if (window._voiceSatelliteInstance._ui.element) {
        window._voiceSatelliteInstance._ui.applyStyles();
      }
    }
  }

  set hass(hass) {
    this._hass = hass;

    // Only update timer and announcements on the active card instance
    if (!window._voiceSatelliteInstance || window._voiceSatelliteInstance === this) {
      this._timer.update();
      this._announcement.update();
    }

    if (this._hasStarted) return;
    if (!hass || !hass.connection) return;
    if (window._voiceSatelliteStarting) return;
    if (window._voiceSatelliteActive && window._voiceSatelliteInstance !== this) return;

    this._connection = hass.connection;

    // Ensure global UI exists before start or show button
    this._ui.ensureGlobalUI();

    if (this._config.start_listening_on_load) {
      this._hasStarted = true;
      this._startListening();
    } else {
      this._hasStarted = true;
      this._ui.showStartButton();
    }
  }

  getCardSize() {
    return 0;
  }

  static getConfigForm() {
    return getConfigForm();
  }

  static getStubConfig() {
    return { start_listening_on_load: true };
  }

  // --- State Management ---

  setState(newState) {
    var oldState = this._state;
    this._state = newState;
    this._logger.log('state', oldState + ' → ' + newState);
    this._ui.updateForState(newState, this._pipeline.serviceUnavailable, this._tts.isPlaying);

    if (newState === State.WAKE_WORD_DETECTED) {
      this.updateInteractionState('ACTIVE');
    }

    // Sync pipeline state to integration entity
    // Don't sync back to idle/listening while TTS is still playing (barge-in restart)
    if (this._tts.isPlaying && (newState === State.LISTENING || newState === State.IDLE)) return;
    this._syncSatelliteState(newState);
  }

  _syncSatelliteState(state) {
    var entityId = this._config.satellite_entity;
    if (!entityId || !this._hass || !this._hass.connection) return;

    // Skip if same state as last sync
    if (state === this._lastSyncedSatelliteState) return;
    this._lastSyncedSatelliteState = state;

    this._hass.connection.sendMessagePromise({
      type: 'voice_satellite/update_state',
      entity_id: entityId,
      state: state,
    }).catch(function () {});
  }

  updateInteractionState(interactionState) {
    var entityId = this._config.state_entity;
    if (!entityId || !this._hass) return;

    var self = this;
    this._logger.log('state_entity', entityId + ' → ' + interactionState);
    this._hass.callService('input_text', 'set_value', {
      entity_id: entityId,
      value: interactionState,
    }).catch(function (e) {
      self._logger.error('state_entity', 'Failed to update ' + entityId + ': ' + e);
    });
  }

  // --- Callbacks from managers ---

  onStartClick() {
    this._handleStartClick();
  }

  onPipelineMessage(message) {
    this._handlePipelineMessage(message);
  }

  onTTSComplete(playbackFailed) {
    // If a NEW interaction has started (wake word detected again during TTS),
    // don't clean up — let the new interaction handle its own lifecycle.
    // Note: State.TTS itself is NOT a new interaction — it means we're completing normally.
    var newInteraction = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT];
    if (newInteraction.indexOf(this._state) !== -1) {
      this._logger.log('tts', 'New interaction in progress — skipping cleanup');
      return;
    }

    // Continue conversation (only if TTS actually played successfully)
    if (!playbackFailed && this._pipeline.shouldContinue && this._pipeline.continueConversationId) {
      this._logger.log('pipeline', 'Continuing conversation — skipping wake word');
      var conversationId = this._pipeline.continueConversationId;
      this._pipeline.clearContinueState();
      this._chat.streamEl = null;

      // Keep blur, bar, and chat visible
      this._pipeline.restartContinue(conversationId);
      return;
    }

    // Normal completion
    var isRemote = this._config.tts_target && this._config.tts_target !== 'browser';
    if (this._config.chime_on_request_sent && !isRemote) {
      this._tts.playChime('done');
    }

    this._chat.clear();
    this._ui.hideBlurOverlay('pipeline');
    this._ui.updateForState(this._state, this._pipeline.serviceUnavailable, false);
    this.updateInteractionState('IDLE');
    this._syncSatelliteState('IDLE');

    // Play any queued announcements now that the pipeline is idle
    this._announcement.playQueued();
  }

  turnOffWakeWordSwitch() {
    if (!this._config.wake_word_switch || !this._hass) return;
    var self = this;

    var entityId = this._config.wake_word_switch;
    if (!entityId.includes('.')) {
      this._logger.log('switch', 'Invalid entity: ' + entityId);
      return;
    }

    this._logger.log('switch', 'Turning off: ' + entityId);

    this._hass.callService('homeassistant', 'turn_off', {
      entity_id: entityId,
    }).catch(function (err) {
      self._logger.error('switch', 'Failed to turn off: ' + err);
    });
  }

  // --- Private ---

  _render() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }

    // Detect if we're inside the card editor preview
    var isPreview = isEditorPreview(this);

    if (isPreview) {
      renderPreview(this.shadowRoot, this._config);
    } else {
      this.shadowRoot.innerHTML = '<div id="voice-satellite-card" style="display:none;"></div>';
    }
  }

  async _startListening() {
    if (window._voiceSatelliteActive && window._voiceSatelliteInstance !== this) {
      this._logger.log('lifecycle', 'Another instance is active, skipping');
      return;
    }
    if (window._voiceSatelliteStarting) {
      this._logger.log('lifecycle', 'Pipeline already starting globally, skipping');
      return;
    }

    window._voiceSatelliteStarting = true;

    try {
      this.setState(State.CONNECTING);
      await this._audio.startMicrophone();
      await this._pipeline.start();

      window._voiceSatelliteActive = true;
      window._voiceSatelliteInstance = this;
      this._ui.hideStartButton();

      // Setup double-tap after first successful start
      this._doubleTap.setup();
    } catch (e) {
      var msg = (e && e.message) ? e.message : JSON.stringify(e);
      this._logger.error('pipeline', 'Failed to start: ' + msg);

      var reason = 'error';
      if (e.name === 'NotAllowedError') {
        reason = 'not-allowed';
        this._logger.log('mic', 'Access denied — browser requires user gesture');
      } else if (e.name === 'NotFoundError') {
        reason = 'not-found';
        this._logger.error('mic', 'No microphone found');
      } else if (e.name === 'NotReadableError' || e.name === 'AbortError') {
        reason = 'not-readable';
        this._logger.error('mic', 'Microphone in use or not readable');
      }

      // For mic errors, show the start button (needs user gesture)
      // For pipeline errors, retry automatically
      if (reason !== 'error') {
        this._ui.showStartButton(reason);
        this.setState(State.IDLE);
      } else {
        this.setState(State.IDLE);
        this._pipeline.restart(this._pipeline._calculateRetryDelay());
      }
    } finally {
      window._voiceSatelliteStarting = false;
    }
  }

  async _handleStartClick() {
    await this._audio.ensureAudioContextForGesture();
    await this._startListening();
  }

  _handlePipelineMessage(message) {
    if (this._visibility.isPaused) {
      this._logger.log('event', 'Ignoring event while paused: ' + message.type);
      return;
    }

    if (this._pipeline.isRestarting) {
      this._logger.log('event', 'Ignoring event while restarting: ' + message.type);
      return;
    }

    var eventType = message.type;
    var eventData = message.data || {};

    if (this._config.debug) {
      var timestamp = message.timestamp ? message.timestamp.split('T')[1].split('.')[0] : '';
      this._logger.log('event', timestamp + ' ' + eventType + ' ' + JSON.stringify(eventData).substring(0, 500));
    }

    switch (eventType) {
      case 'run-start':
        this._pipeline.handleRunStart(eventData);
        break;
      case 'wake_word-start':
        this._pipeline.handleWakeWordStart();
        break;
      case 'wake_word-end':
        this._pipeline.handleWakeWordEnd(eventData);
        break;
      case 'stt-start':
        this.setState(State.STT);
        break;
      case 'stt-vad-start':
        this._logger.log('event', 'VAD: speech started');
        break;
      case 'stt-vad-end':
        this._logger.log('event', 'VAD: speech ended');
        break;
      case 'stt-end':
        this._pipeline.handleSttEnd(eventData);
        break;
      case 'intent-start':
        this.setState(State.INTENT);
        break;
      case 'intent-progress':
        if (this._config.streaming_response) {
          this._pipeline.handleIntentProgress(eventData);
        }
        break;
      case 'intent-end':
        this._pipeline.handleIntentEnd(eventData);
        break;
      case 'tts-start':
        this.setState(State.TTS);
        break;
      case 'tts-end':
        this._pipeline.handleTtsEnd(eventData);
        break;
      case 'run-end':
        this._pipeline.handleRunEnd();
        break;
      case 'error':
        this._pipeline.handleError(eventData);
        break;
    }
  }
}