/**
 * Main Card Class
 *
 * Thin rendering shell that registers with VoiceSatelliteSession.
 * Owns only its UIManager and ChatManager; all pipeline, audio, TTS,
 * and notification managers live on the session singleton.
 */

import { State, DEFAULT_CONFIG } from '../constants.js';
import { getSkin, loadSkin } from '../skins/index.js';
import { Logger } from '../logger.js';
import { UIManager } from './ui.js';
import { ChatManager } from '../shared/chat.js';
import { getConfigForm } from '../editor';
import { isEditorPreview, renderPreview } from '../editor/preview.js';
import { VoiceSatelliteSession } from '../session';
import {
  applyBrowserOverride,
  resolveEntity,
  showPicker,
  DISABLED_VALUE,
} from '../shared/entity-picker.js';

export class VoiceSatelliteCard extends HTMLElement {
  constructor() {
    super();

    // Card-local state
    this._config = Object.assign({}, DEFAULT_CONFIG);
    this._hass = null;
    this._disconnectTimeout = null;
    this._pickerTeardown = null;
    this._isLocalStorageEntity = false;
    this._activeSkin = null;
    this._deviceDisabled = false;
    this._editorCheckDone = false;

    this._logger = new Logger();

    // Card-local managers (rendering only)
    this._ui = new UIManager(this);
    this._chat = new ChatManager(this);
  }

  // ── Session access ────────────────────────────────────────────────

  get _session() { return VoiceSatelliteSession.getInstance(); }

  // ── Card-local getters ────────────────────────────────────────────

  get logger() { return this._session?.logger ?? this._logger; }
  get ui() { return this._ui; }
  get chat() { return this._chat; }
  get config() { return this._config; }
  get hass() { return this._hass; }

  // ── Session-delegating getters ────────────────────────────────────

  get audio() { return this._session?.audio; }
  get analyser() { return this._session?.analyser; }
  get tts() { return this._session?.tts; }
  get pipeline() { return this._session?.pipeline; }
  get doubleTap() { return this._session?.doubleTap; }
  get visibility() { return this._session?.visibility; }
  get timer() { return this._session?.timer; }
  get announcement() { return this._session?.announcement; }
  get askQuestion() { return this._session?.askQuestion; }
  get startConversation() { return this._session?.startConversation; }
  get mediaPlayer() { return this._session?.mediaPlayer; }
  get connection() { return this._session?.connection; }

  // ── State (delegated to session) ──────────────────────────────────

  get currentState() { return this._session?.currentState ?? State.IDLE; }
  set currentState(val) { if (this._session) this._session.currentState = val; }

  get lastSyncedSatelliteState() { return this._session?.lastSyncedSatelliteState; }
  set lastSyncedSatelliteState(val) { if (this._session) this._session.lastSyncedSatelliteState = val; }

  get isOwner() { return true; }
  get cardType() { return 'full'; }

  // ── Bridge properties (UIManager reads/writes these on "card") ────

  get _imageLingerTimeout() { return this._session?._imageLingerTimeout; }
  set _imageLingerTimeout(v) { if (this._session) this._session._imageLingerTimeout = v; }

  get _videoPlaying() { return this._session?._videoPlaying; }
  set _videoPlaying(v) { if (this._session) this._session._videoPlaying = v; }

  // ── Skin / reactive bar ───────────────────────────────────────────

  get isReactiveBarEnabled() {
    return !!this._activeSkin?.reactiveBar && this._config.reactive_bar !== false;
  }

  ensureUI() { this._ui.ensureGlobalUI(); }

  // ── Lifecycle ─────────────────────────────────────────────────────

  connectedCallback() {
    if (this._disconnectTimeout) {
      clearTimeout(this._disconnectTimeout);
      this._disconnectTimeout = null;
    }
    this._editorCheckDone = false;
    this._render();

    requestAnimationFrame(() => {
      if (isEditorPreview(this) && this.shadowRoot) {
        renderPreview(this.shadowRoot, this._config);
        return; // _editorCheckDone stays false — no registration paths will fire
      }

      this._editorCheckDone = true;
      this._session._rejectedPreviews.delete(this);

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

      this._session.registerAndStart(this);
    });
  }

  disconnectedCallback() {
    if (this._pickerTeardown) {
      this._pickerTeardown();
      this._pickerTeardown = null;
    }
    // Full card's global UI persists in document.body across dashboard
    // navigations — do NOT unregister on disconnect. Stale instances are
    // evicted by the session when a new full card registers.
  }

  setConfig(config) {
    const hadEntity = !!this._config.satellite_entity;

    const skinId = config.skin || 'default';
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._activeSkin = getSkin(skinId);
    loadSkin(skinId).then((skin) => {
      if (this._activeSkin !== skin) {
        this._activeSkin = skin;
        if (this._ui.element) this._ui.applyStyles();
      }
    });
    this._logger.debug = this._config.debug;

    // When browser_satellite_override is on, localStorage takes full control
    const override = applyBrowserOverride(this._config);
    this._isLocalStorageEntity = override.isLocalStorageEntity;
    this._deviceDisabled = override.deviceDisabled;

    if (this._ui.element) {
      this._ui.applyStyles();

      // Re-evaluate reactive bar after config change
      const reactive = this.isReactiveBarEnabled;
      const audio = this._session?.audio;
      const analyser = this._session?.analyser;
      if (reactive && audio?.sourceNode && audio?.audioContext) {
        analyser?.attachMic(audio.sourceNode, audio.audioContext);
      } else if (!reactive && analyser) {
        if (audio?.sourceNode) analyser.detachMic(audio.sourceNode);
        analyser.stop();
      }

      this._ui.updateForState(
        this.currentState,
        this.pipeline?.serviceUnavailable,
        this.tts?.isPlaying,
      );
    }

    if (this.shadowRoot && isEditorPreview(this)) {
      renderPreview(this.shadowRoot, this._config);
    }

    // Forward session-relevant config
    this._session.updateConfig(this._config);

    // If satellite entity was just configured, trigger startup
    if (!hadEntity && this._config.satellite_entity && !this._session.isStarted
        && this._hass?.connection && !isEditorPreview(this)) {
      this._session.registerAndStart(this);
    }
  }

  set hass(hass) {
    this._hass = hass;

    // Preview cards in the editor should never start or subscribe.
    // isEditorPreview is unreliable synchronously (DOM ancestors not attached
    // yet), so also gate on the rAF-confirmed _editorCheckDone flag.
    if (isEditorPreview(this)) return;
    if (!this._editorCheckDone) return;

    // Forward hass to session (handles timer updates, TTS checks, subscriptions)
    this._session.updateHass(hass);

    // Session already running — register once (no-op if already registered)
    if (this._session.isStarted) {
      if (this._config.satellite_entity && !this._session._cards.has(this)) {
        this._session.register(this);
      }
      return;
    }

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

    this._session.registerAndStart(this);
  }

  getCardSize() { return 0; }

  static getConfigForm() { return getConfigForm(); }
  static getStubConfig() { return { skin: 'default', text_scale: 100 }; }

  // ── Event callbacks (delegated to session) ────────────────────────

  setState(newState) { this._session.setState(newState); }
  onStartClick() { this._session.onStartClick(); }
  onPipelineMessage(message) { this._session.onPipelineMessage(message); }
  onTTSComplete(playbackFailed) { this._session.onTTSComplete(playbackFailed); }

  // ── Entity picker ─────────────────────────────────────────────────

  _showEntityPicker(hass) {
    this._pickerTeardown = showPicker(hass, (entityId) => {
      this._pickerTeardown = null;
      this._session.handleEntityPick(this, entityId);
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
