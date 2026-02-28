/**
 * Voice Satellite Mini Card
 *
 * Thin rendering shell that registers with VoiceSatelliteSession.
 * Owns only its MiniUIManager and ChatManager; all pipeline, audio, TTS,
 * and notification managers live on the session singleton.
 */

import { State, DEFAULT_CONFIG, Timing } from '../constants.js';
import { Logger } from '../logger.js';
import { ChatManager } from '../shared/chat.js';
import { isEditorPreview } from '../editor/preview.js';
import { renderMiniPreview, teardownMiniPreview } from '../mini-editor/preview.js';
import { getMiniConfigForm } from '../mini-editor/index.js';
import { getMiniGridRows } from './constants.js';
import { VoiceSatelliteSession } from '../session';
import {
  applyBrowserOverride,
  resolveEntity,
  showPicker,
  DISABLED_VALUE,
} from '../shared/entity-picker.js';
import { MiniUIManager } from './ui.js';

export class VoiceSatelliteMiniCard extends HTMLElement {
  constructor() {
    super();

    this._config = Object.assign({}, DEFAULT_CONFIG, {
      mini_mode: 'compact',
      skin: 'default',
    });
    this._configuredMiniMode = null;
    this._hass = null;
    this._disconnectTimeout = null;
    this._pickerTeardown = null;
    this._isLocalStorageEntity = false;
    this._deviceDisabled = false;
    this._editorCheckDone = false;
    this._renderMode = 'live';

    this._logger = new Logger();

    // Card-local managers (rendering only)
    this._ui = new MiniUIManager(this);
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
  get cardType() { return 'mini'; }

  // ── Bridge properties (UIManager reads/writes these on "card") ────

  get _imageLingerTimeout() { return this._session?._imageLingerTimeout; }
  set _imageLingerTimeout(v) { if (this._session) this._session._imageLingerTimeout = v; }

  get _videoPlaying() { return this._session?._videoPlaying; }
  set _videoPlaying(v) { if (this._session) this._session._videoPlaying = v; }

  get isReactiveBarEnabled() { return false; }

  ensureUI() { this._ui.ensureLocalUI(); }

  // ── Lifecycle ─────────────────────────────────────────────────────

  connectedCallback() {
    if (this._disconnectTimeout) {
      clearTimeout(this._disconnectTimeout);
      this._disconnectTimeout = null;
    }
    this._editorCheckDone = false;
    this._render();

    requestAnimationFrame(() => {
      if (this._syncRenderMode()) return;
      if (isEditorPreview(this)) return;

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
            return;
          }
        } else {
          return;
        }
      }

      this._session.register(this);
      this._session.updateHass(this._hass);
      this._session.updateConfig(this._config);

      if (!this._session.isStarted) {
        // Defer one more frame before auto-starting. In HA card editor
        // flows, duplicate preview cards can be connected before the
        // preview/edit wrappers are fully attached, so editor detection
        // may be false on the first callback.
        requestAnimationFrame(() => {
          if (!this.isConnected) return;
          if (this._session.isStarted || !this._hass?.connection) return;
          if (this._syncRenderMode()) return;
          if (isEditorPreview(this)) return;
          this._session.start();
        });
      }
    });
  }

  disconnectedCallback() {
    if (this._pickerTeardown) {
      this._pickerTeardown();
      this._pickerTeardown = null;
    }
    if (this.shadowRoot) teardownMiniPreview(this.shadowRoot);
    this._disconnectTimeout = setTimeout(() => {
      if (!this.isConnected) {
        this._session.unregister(this);
      }
    }, Timing.DISCONNECT_GRACE);
  }

  setConfig(config) {
    this._configuredMiniMode = config?.mini_mode ?? null;
    const hadEntity = !!this._config.satellite_entity;
    this._config = Object.assign({}, DEFAULT_CONFIG, { mini_mode: 'compact' }, config);
    this._logger.debug = this._config.debug;

    const override = applyBrowserOverride(this._config);
    this._isLocalStorageEntity = override.isLocalStorageEntity;
    this._deviceDisabled = override.deviceDisabled;

    if (this.shadowRoot) {
      if (this._syncRenderMode()) {
        // preview rendered; no live UI updates
      } else {
        this._ui.applyStyles();
        this._ui.updateForState(
          this.currentState,
          this.pipeline?.serviceUnavailable,
          this.tts?.isPlaying,
        );
      }
    }

    // Forward session-relevant config
    this._session.updateConfig(this._config);

    if (!hadEntity && this._config.satellite_entity && !this._session.isStarted
        && this._hass?.connection && !isEditorPreview(this)) {
      this._session.registerAndStart(this);
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._syncRenderMode()) return;
    if (isEditorPreview(this)) return;
    if (!this._editorCheckDone) return;

    // Forward hass to session
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

  getCardSize() {
    return getMiniGridRows(this._configuredMiniMode || 'tall').default;
  }

  getGridOptions() {
    const rows = getMiniGridRows(this._configuredMiniMode || 'tall');
    if (isEditorPreview(this) && this._configuredMiniMode !== 'compact') {
      return {
        rows: rows.default,
        min_rows: 1,
        max_rows: 12,
        columns: 12,
      };
    }
    return {
      rows: rows.default,
      min_rows: rows.min,
      max_rows: rows.max,
      columns: 12,
    };
  }

  static getConfigForm() { return getMiniConfigForm(); }
  static getStubConfig() { return { mini_mode: 'compact', text_scale: 100 }; }

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

  // ── Render / preview ──────────────────────────────────────────────

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this._syncRenderMode();
  }

  _syncRenderMode() {
    if (!this.shadowRoot) return false;
    if (this._shouldRenderStaticPreview()) {
      renderMiniPreview(this.shadowRoot, this._config);
      this._renderMode = 'preview';
      return true;
    }

    if (this._renderMode === 'preview' || !this.shadowRoot.querySelector('.vs-mini-root')) {
      this._ui.ensureLocalUI();
    }
    this._renderMode = 'live';
    return false;
  }

  _shouldRenderStaticPreview() {
    return isEditorPreview(this);
  }
}
