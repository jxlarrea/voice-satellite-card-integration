/**
 * Main Card Class
 *
 * Thin orchestrator that owns the managers and wires them together.
 * All real work is delegated to composition-based managers.
 */

import { State, DEFAULT_CONFIG, Timing } from '../constants.js';
import { getSkin } from '../skins/index.js';
import { Logger } from '../logger.js';
import { AudioManager } from '../audio';
import { AnalyserManager } from '../audio/analyser.js';
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
import { MediaPlayerManager } from '../media-player';
import { getConfigForm } from '../editor';
import { isEditorPreview, renderPreview } from '../editor/preview.js';
import * as singleton from '../shared/singleton.js';
import { setState, handleStartClick, startListening, onTTSComplete, handlePipelineMessage } from './events.js';
import { syncSatelliteState } from './comms.js';
import { getSelectEntityId, getNumberState } from '../shared/satellite-state.js';
import { subscribeSatelliteEvents, teardownSatelliteSubscription } from '../shared/satellite-subscription.js';
import { dispatchSatelliteEvent } from '../shared/satellite-notification.js';
import { getStoredEntity, clearStoredEntity, resolveEntity, showPicker, DISABLED_VALUE, isDeviceDisabled } from './entity-picker.js';

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
    this._pickerTeardown = null;
    this._isLocalStorageEntity = false;
    this._imageLingerTimeout = null;
    this._videoPlaying = false;
    this._activeSkin = null;
    this._deviceDisabled = false;

    // Logger (shared by all managers)
    this._logger = new Logger();

    // Composition - managers
    this._audio = new AudioManager(this);
    this._analyser = new AnalyserManager(this);
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
    this._mediaPlayer = new MediaPlayerManager(this);
  }
  get logger() { return this._logger; }
  get audio() { return this._audio; }
  get analyser() { return this._analyser; }
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
  get mediaPlayer() { return this._mediaPlayer; }
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
  get ttsTarget() {
    return getSelectEntityId(this._hass, this._config.satellite_entity, 'tts_output') || '';
  }
  get announcementDisplayDuration() {
    return getNumberState(this._hass, this._config.satellite_entity, 'announcement_display_duration', 5);
  }
  get isReactiveBarEnabled() {
    return !!this._activeSkin?.reactiveBar && this._config.reactive_bar !== false;
  }
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

      if (this._deviceDisabled) return;

      if (!this._config.satellite_entity) {
        if (this._config.browser_satellite_override && this._hass?.entities) {
          const resolved = resolveEntity(this._hass);
          if (resolved === DISABLED_VALUE) {
            this._deviceDisabled = true;
            return;
          } else if (resolved) {
            this._config.satellite_entity = resolved;
            this._isLocalStorageEntity = true;
          } else {
            return; // picker shows from set hass()
          }
        } else {
          return;
        }
      }

      this._ui.ensureGlobalUI();
      this._visibility.setup();

      if (!singleton.isActive() && this._hass?.connection) {
        startListening(this);
      }
    });
  }

  disconnectedCallback() {
    if (this._pickerTeardown) {
      this._pickerTeardown();
      this._pickerTeardown = null;
    }
    this._disconnectTimeout = setTimeout(() => {
      // Still active instance but truly disconnected - keep running via global UI
    }, Timing.DISCONNECT_GRACE);
  }

  setConfig(config) {
    const hadEntity = !!this._config.satellite_entity;

    const skin = getSkin(config.skin || 'default');
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._activeSkin = skin;
    this._logger.debug = this._config.debug;

    // When browser_satellite_override is on, localStorage takes full control
    if (this._config.browser_satellite_override) {
      const stored = getStoredEntity();
      if (stored === DISABLED_VALUE) {
        this._config.satellite_entity = '';
        this._isLocalStorageEntity = false;
        this._deviceDisabled = true;
      } else if (stored) {
        this._config.satellite_entity = stored;
        this._isLocalStorageEntity = true;
        this._deviceDisabled = false;
      } else {
        // No localStorage yet - clear entity so startup path shows picker
        this._config.satellite_entity = '';
        this._isLocalStorageEntity = false;
        this._deviceDisabled = false;
      }
    } else {
      clearStoredEntity();
      this._isLocalStorageEntity = false;
      this._deviceDisabled = false;
    }

    if (this._ui.element) {
      this._ui.applyStyles();

      // If reactive bar was just enabled and mic is already running, attach analyser
      const reactive = this.isReactiveBarEnabled;
      if (reactive && this._audio.sourceNode && this._audio.audioContext) {
        this._analyser.attachMic(this._audio.sourceNode, this._audio.audioContext);
      } else if (!reactive) {
        if (this._audio.sourceNode) this._analyser.detachMic(this._audio.sourceNode);
        this._analyser.stop();
      }

      // Re-evaluate reactive bar state after config change
      this._ui.updateForState(this._state, this._pipeline?.serviceUnavailable, this._tts?.isPlaying);
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

      this._hasStarted = true;
      startListening(this);
    }
  }

  set hass(hass) {
    this._hass = hass;

    // Preview cards in the editor should never start or subscribe
    if (isEditorPreview(this)) return;

    // Only update subscriptions on the active owner
    if (singleton.isActive() && singleton.isOwner(this)) {
      this._timer.update();
      this._tts.checkRemotePlayback(hass);
      // Retry satellite subscription if initial attempt in startListening() failed
      subscribeSatelliteEvents(this, (event) => dispatchSatelliteEvent(this, event));
    }

    if (this._hasStarted) return;
    if (this._deviceDisabled) return;
    if (!hass?.connection) return;

    if (!this._config.satellite_entity) {
      if (this._config.browser_satellite_override) {
        const resolved = resolveEntity(hass);
        if (resolved === DISABLED_VALUE) {
          this._deviceDisabled = true;
          return;
        } else if (resolved) {
          this._config.satellite_entity = resolved;
          this._isLocalStorageEntity = true;
        } else if (hass.entities && Object.keys(hass.entities).length > 0 && !this._pickerTeardown) {
          this._showEntityPicker(hass);
          return;
        } else {
          return;
        }
      } else {
        return;
      }
    }

    if (singleton.isStarting()) return;
    if (singleton.isActive() && !singleton.isOwner(this)) return;

    this._connection = hass.connection;
    this._ui.ensureGlobalUI();

    this._hasStarted = true;
    startListening(this);
  }

  getCardSize() { return 0; }

  static getConfigForm() { return getConfigForm(); }
  static getStubConfig() { return { skin: 'default', text_scale: 100 }; }
  setState(newState) { setState(this, newState); }
  onStartClick() { handleStartClick(this); }
  onPipelineMessage(message) { handlePipelineMessage(this, message); }
  onTTSComplete(playbackFailed) { onTTSComplete(this, playbackFailed); }
  _showEntityPicker(hass) {
    this._pickerTeardown = showPicker(hass, (entityId) => {
      this._pickerTeardown = null;

      if (entityId === DISABLED_VALUE) {
        this._deviceDisabled = true;
        return;
      }

      this._config.satellite_entity = entityId;
      this._isLocalStorageEntity = true;

      // Displace stale singleton owner (previous instance HA destroyed)
      if (singleton.isActive() && !singleton.isOwner(this)) {
        const stale = window.__vsSingleton?.instance;
        if (stale) {
          try {
            stale.pipeline.stop();
            stale.audio.stopMicrophone();
            stale.tts.stop();
            stale.timer.destroy();
          } catch (_) { /* zombie instance */ }
        }
        teardownSatelliteSubscription();
        singleton.release();
      }

      const currentHass = this._hass || hass;
      this._connection = currentHass.connection;
      this._ui.ensureGlobalUI();
      this._hasStarted = true;
      startListening(this);
    });
  }

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
