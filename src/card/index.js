/**
 * Voice Satellite Card — Main Card Class
 *
 * Thin orchestrator that owns the managers and wires them together.
 * All real work is delegated to composition-based managers.
 */

import { State, DEFAULT_CONFIG, Timing } from '../constants.js';
import { Logger } from '../logger.js';
import { AudioManager } from '../audio';
import { TtsManager } from '../tts';
import { PipelineManager } from '../pipeline';
import { UIManager } from './ui.js';
import { ChatManager } from './chat.js';
import { DoubleTapHandler } from './double-tap.js';
import { VisibilityManager } from './visibility.js';
import { TimerManager } from '../timer';
import { AnnouncementManager } from '../announcement';
import { AskQuestionManager } from '../ask-question';
import { StartConversationManager } from '../start-conversation';
import { getConfigForm } from '../editor';
import { isEditorPreview, renderPreview } from '../editor/preview.js';
import * as singleton from '../shared/singleton.js';
import { setState, handleStartClick, startListening, onTTSComplete, handlePipelineMessage } from './events.js';
import { syncSatelliteState } from './comms.js';
import { subscribeSatelliteEvents } from '../shared/satellite-subscription.js';
import { dispatchSatelliteEvent } from '../shared/satellite-notification.js';

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
    this._askQuestion = new AskQuestionManager(this);
    this._startConversation = new StartConversationManager(this);
  }

  // --- Public accessors ---

  get logger() { return this._logger; }
  get audio() { return this._audio; }
  get tts() { return this._tts; }
  get pipeline() { return this._pipeline; }
  get ui() { return this._ui; }
  get chat() { return this._chat; }
  get doubleTap() { return this._doubleTap; }
  get visibility() { return this._visibility; }
  get config() { return this._config; }
  get timer() { return this._timer; }
  get announcement() { return this._announcement; }
  get askQuestion() { return this._askQuestion; }
  get startConversation() { return this._startConversation; }
  get currentState() { return this._state; }
  set currentState(val) { this._state = val; }
  get lastSyncedSatelliteState() { return this._lastSyncedSatelliteState; }
  set lastSyncedSatelliteState(val) { this._lastSyncedSatelliteState = val; }
  get isOwner() { return singleton.isOwner(this); }
  get connection() {
    if (!this._connection && this._hass?.connection) {
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

    requestAnimationFrame(() => {
      if (isEditorPreview(this) && this.shadowRoot) {
        renderPreview(this.shadowRoot, this._config);
        return;
      }

      if (!this._config.satellite_entity) return;

      this._ui.ensureGlobalUI();
      this._visibility.setup();

      if (!singleton.isActive() && this._hass?.connection) {
        startListening(this);
      }
    });
  }

  disconnectedCallback() {
    this._disconnectTimeout = setTimeout(() => {
      // Still active instance but truly disconnected — keep running via global UI
    }, Timing.DISCONNECT_GRACE);
  }

  setConfig(config) {
    const hadEntity = !!this._config.satellite_entity;
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._logger.debug = this._config.debug;

    if (this._ui.element) {
      this._ui.applyStyles();
    }

    if (this.shadowRoot && isEditorPreview(this)) {
      renderPreview(this.shadowRoot, this._config);
    }

    // Propagate config to active instance if this is a secondary card
    singleton.propagateConfig(this);

    // If satellite entity was just configured, trigger startup
    if (!hadEntity && this._config.satellite_entity && !this._hasStarted
        && this._hass?.connection && !isEditorPreview(this)) {
      this._connection = this._hass.connection;
      this._ui.ensureGlobalUI();

      if (this._config.start_listening_on_load) {
        this._hasStarted = true;
        startListening(this);
      } else {
        this._hasStarted = true;
        this._ui.showStartButton();
      }
    }
  }

  set hass(hass) {
    this._hass = hass;

    // Preview cards in the editor should never start or subscribe
    if (isEditorPreview(this)) return;

    // Only update subscriptions on the active owner
    if (singleton.isActive() && singleton.isOwner(this)) {
      this._timer.update();
      // Retry satellite subscription if initial attempt in startListening() failed
      subscribeSatelliteEvents(this, (event) => dispatchSatelliteEvent(this, event));
    }

    if (this._hasStarted) return;
    if (!hass?.connection) return;
    if (!this._config.satellite_entity) return;
    if (singleton.isStarting()) return;
    if (singleton.isActive() && !singleton.isOwner(this)) return;

    this._connection = hass.connection;
    this._ui.ensureGlobalUI();

    if (this._config.start_listening_on_load) {
      this._hasStarted = true;
      startListening(this);
    } else {
      this._hasStarted = true;
      this._ui.showStartButton();
    }
  }

  getCardSize() { return 0; }

  static getConfigForm() { return getConfigForm(); }
  static getStubConfig() { return { start_listening_on_load: true }; }

  // --- Delegated methods (public API for managers) ---

  setState(newState) { setState(this, newState); }
  onStartClick() { handleStartClick(this); }
  onPipelineMessage(message) { handlePipelineMessage(this, message); }
  onTTSComplete(playbackFailed) { onTTSComplete(this, playbackFailed); }

  // --- Private ---

  _render() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }

    if (isEditorPreview(this)) {
      renderPreview(this.shadowRoot, this._config);
    } else {
      this.shadowRoot.innerHTML = '<div id="voice-satellite-card" style="display:none;"></div>';
    }
  }
}