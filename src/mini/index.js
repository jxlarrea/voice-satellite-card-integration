/**
 * Voice Satellite Mini Card
 *
 * Normal Lovelace card (non-fullscreen) that reuses the existing voice
 * pipeline/audio/TTS/integration communication stack with a local text UI.
 */

import { State, DEFAULT_CONFIG, Timing } from '../constants.js';
import { Logger } from '../logger.js';
import { AudioManager } from '../audio';
import { AnalyserManager } from '../audio/analyser.js';
import { TtsManager } from '../tts';
import { PipelineManager } from '../pipeline';
import { ChatManager } from '../card/chat.js';
import { DoubleTapHandler } from '../card/double-tap.js';
import { VisibilityManager } from '../card/visibility.js';
import { TimerManager } from '../timer';
import { AnnouncementManager } from '../announcement';
import { AskQuestionManager } from '../ask-question';
import { StartConversationManager } from '../start-conversation';
import { MediaPlayerManager } from '../media-player';
import { isEditorPreview } from '../editor/preview.js';
import { renderMiniPreview } from '../mini-editor/preview.js';
import { getMiniConfigForm } from '../mini-editor/index.js';
import { getMiniGridRows } from './constants.js';
import * as singleton from '../shared/singleton.js';
import {
  setState,
  handleStartClick,
  startListening,
  onTTSComplete,
  handlePipelineMessage,
} from '../card/events.js';
import { getSelectEntityId, getNumberState } from '../shared/satellite-state.js';
import { subscribeSatelliteEvents, teardownSatelliteSubscription } from '../shared/satellite-subscription.js';
import { dispatchSatelliteEvent } from '../shared/satellite-notification.js';
import {
  getStoredEntity,
  clearStoredEntity,
  resolveEntity,
  showPicker,
  DISABLED_VALUE,
} from '../card/entity-picker.js';
import { MiniUIManager } from './ui.js';

const NOOP_MANAGER_STATE = {
  playing: false,
  clearTimeoutId: null,
  currentAnnounceId: null,
};

export class VoiceSatelliteMiniCard extends HTMLElement {
  constructor() {
    super();

    this._state = State.IDLE;
    this._lastSyncedSatelliteState = null;
    this._config = Object.assign({}, DEFAULT_CONFIG, {
      mini_mode: 'compact',
      skin: 'default',
    });
    this._configuredMiniMode = null;
    this._hass = null;
    this._connection = null;
    this._hasStarted = false;
    this._disconnectTimeout = null;
    this._pickerTeardown = null;
    this._isLocalStorageEntity = false;
    this._deviceDisabled = false;
    this._renderMode = 'live';
    this._ownerMirrorCleanup = null;
    this._ownerMirrorOwner = null;

    this._logger = new Logger();

    this._audio = new AudioManager(this);
    this._analyser = new AnalyserManager(this);
    this._tts = new TtsManager(this);
    this._pipeline = new PipelineManager(this);
    this._ui = new MiniUIManager(this);
    this._chat = new ChatManager(this);
    this._doubleTap = new DoubleTapHandler(this);
    this._visibility = new VisibilityManager(this);
    this._timer = new TimerManager(this);
    this._announcement = new AnnouncementManager(this);
    this._askQuestion = new AskQuestionManager(this);
    this._startConversation = new StartConversationManager(this);
    this._mediaPlayer = new MediaPlayerManager(this);

    Object.assign(this._announcement, NOOP_MANAGER_STATE);
    Object.assign(this._askQuestion, NOOP_MANAGER_STATE);
    Object.assign(this._startConversation, NOOP_MANAGER_STATE);
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
    if (!this._connection && this._hass?.connection) this._connection = this._hass.connection;
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
    return false;
  }

  connectedCallback() {
    if (this._disconnectTimeout) {
      clearTimeout(this._disconnectTimeout);
      this._disconnectTimeout = null;
    }
    this._render();

    requestAnimationFrame(() => {
      if (this._syncRenderMode()) {
        return;
      }
      if (isEditorPreview(this)) {
        return;
      }
      if (this._deviceDisabled) return;

      if (!this._config.satellite_entity) {
        if (this._config.browser_satellite_override && this._hass?.entities) {
          const resolved = resolveEntity(this._hass);
          if (resolved === DISABLED_VALUE) {
            this._deviceDisabled = true;
            return;
          }
          if (resolved) {
            this._config.satellite_entity = resolved;
            this._isLocalStorageEntity = true;
          } else {
            return;
          }
        } else {
          return;
        }
      }

      this._ui.ensureLocalUI();
      this._visibility.setup();
      if (!this._hasStarted && !singleton.isActive() && this._hass?.connection) {
        // Defer one more frame before auto-starting. In HA card editor flows,
        // duplicate preview cards can be connected before the preview/edit
        // wrappers are fully attached, so editor detection may be false on the
        // first callback. A second pass avoids starting the pipeline on the
        // preview clone.
        requestAnimationFrame(() => {
          if (!this.isConnected) return;
          if (this._hasStarted || singleton.isActive() || !this._hass?.connection) return;
          if (this._syncRenderMode()) return;
          if (isEditorPreview(this)) return;
          this._hasStarted = true;
          startListening(this);
        });
      } else if (this._hasStarted && singleton.isOwner(this)) {
        // The live owner card was reattached (e.g. editor open/close). Do not
        // force it back to IDLE; just repaint the local UI from the current
        // runtime state.
        this._ui.hideStartButton();
        this._ui.updateForState(this._state, this._pipeline?.serviceUnavailable, this._tts?.isPlaying);
      } else if (singleton.isActive() && !singleton.isOwner(this)) {
        this._ensureOwnerMirrorObserver();
        this._mirrorOwnerUI();
      } else {
        this._clearOwnerMirrorObserver();
        this.setState(State.IDLE);
        this._ui.showStartButton();
      }
    });
  }

  disconnectedCallback() {
    if (this._pickerTeardown) {
      this._pickerTeardown();
      this._pickerTeardown = null;
    }
    this._clearOwnerMirrorObserver();
    this._disconnectTimeout = setTimeout(() => {
      // Mirror full-card behavior: editing/reconfiguring dashboards can detach
      // and reattach the same card instance (or a replacement) transiently.
      // Tearing down here causes unnecessary pipeline restarts when the editor
      // closes. Keep the active session alive across disconnects.
      if (this.isConnected) return;
    }, Timing.DISCONNECT_GRACE);
  }

  setConfig(config) {
    this._configuredMiniMode = config?.mini_mode ?? null;
    const hadEntity = !!this._config.satellite_entity;
    this._config = Object.assign({}, DEFAULT_CONFIG, { mini_mode: 'compact' }, config);
    this._logger.debug = this._config.debug;

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
        this._config.satellite_entity = '';
        this._isLocalStorageEntity = false;
        this._deviceDisabled = false;
      }
    } else {
      clearStoredEntity();
      this._isLocalStorageEntity = false;
      this._deviceDisabled = false;
    }

    if (this.shadowRoot) {
      if (this._syncRenderMode()) {
        // preview rendered; no live UI updates
      } else {
        this._ui.applyStyles();
        this._ui.updateForState(this._state, this._pipeline?.serviceUnavailable, this._tts?.isPlaying);
      }
    }

    singleton.propagateConfig(this);

    if (!hadEntity && this._config.satellite_entity && !this._hasStarted && this._hass?.connection && !isEditorPreview(this)) {
      this._connection = this._hass.connection;
      this._ui.ensureLocalUI();
      if (this.isConnected) {
        this._hasStarted = true;
        startListening(this);
      } else {
        this.setState(State.IDLE);
        this._ui.showStartButton();
      }
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._syncRenderMode()) return;
    if (isEditorPreview(this)) return;

    if (singleton.isActive() && singleton.isOwner(this)) {
      this._timer.update();
      this._tts.checkRemotePlayback(hass);
      subscribeSatelliteEvents(this, (event) => dispatchSatelliteEvent(this, event));
    }

    if (this._hasStarted || this._deviceDisabled || !hass?.connection) return;

    if (!this._config.satellite_entity) {
      if (this._config.browser_satellite_override) {
        const resolved = resolveEntity(hass);
        if (resolved === DISABLED_VALUE) {
          this._deviceDisabled = true;
          return;
        }
        if (resolved) {
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
    if (singleton.isActive() && !singleton.isOwner(this)) {
      this._ui.ensureLocalUI();
      this._ensureOwnerMirrorObserver();
      this._mirrorOwnerUI();
      return;
    }
    this._clearOwnerMirrorObserver();

    this._connection = hass.connection;
    this._ui.ensureLocalUI();
    // card-mod can create a duplicate instance that receives set hass()
    // but is never attached to the DOM. Defer auto-start to connectedCallback
    // so the visible instance owns the gesture fallback UI.
    if (this.isConnected) {
      this._hasStarted = true;
      startListening(this);
    } else {
      this.setState(State.IDLE);
      this._ui.showStartButton();
    }
  }

  getCardSize() {
    return getMiniGridRows(this._configuredMiniMode || 'tall').default;
  }

  getGridOptions() {
    // HA can query grid options before setConfig() runs; avoid inheriting the
    // constructor's compact default (fixed 1 row) in that transient state.
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

      if (singleton.isActive() && !singleton.isOwner(this)) {
        const stale = window.__vsSingleton?.instance;
        if (stale) {
          try {
            stale.pipeline.stop();
            stale.audio.stopMicrophone();
            stale.tts.stop();
            stale.timer.destroy();
          } catch (_) {}
        }
        teardownSatelliteSubscription();
        singleton.release();
      }

      const currentHass = this._hass || hass;
      this._connection = currentHass.connection;
      this._ui.ensureLocalUI();
      if (this.isConnected) {
        this._hasStarted = true;
        startListening(this);
      } else {
        this.setState(State.IDLE);
        this._ui.showStartButton();
      }
    });
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this._syncRenderMode();
  }

  _mirrorOwnerUI() {
    const owner = window.__vsSingleton?.instance;
    if (!owner || owner === this) return;
    this._ui.hideStartButton();
    this._ui.updateForState(
      owner.currentState || this._state,
      !!owner.pipeline?.serviceUnavailable,
      !!owner.tts?.isPlaying,
    );

    // HA can replace the visible card element after saving config in the
    // editor while the original singleton owner keeps the active pipeline.
    // In that case, this visible non-owner card should mirror the owner's mini
    // transcript/timer DOM so STT/TTS text continues to appear without a
    // forced pipeline restart.
    const ownerRoot = owner.shadowRoot;
    const localRoot = this.shadowRoot;
    if (!ownerRoot || !localRoot) return;

    const ownerLine = ownerRoot.querySelector('.vs-mini-line');
    const localLine = localRoot.querySelector('.vs-mini-line');
    if (ownerLine && localLine && !this._sameMiniContent(ownerLine, localLine)) {
      this._replaceChildrenFrom(ownerLine, localLine);
      localLine.scrollLeft = ownerLine.scrollLeft;
    }

    const ownerTranscript = ownerRoot.querySelector('.vs-mini-transcript');
    const localTranscript = localRoot.querySelector('.vs-mini-transcript');
    if (ownerTranscript && localTranscript && !this._sameMiniContent(ownerTranscript, localTranscript)) {
      this._replaceChildrenFrom(ownerTranscript, localTranscript);
      localTranscript.scrollTop = ownerTranscript.scrollTop;
    }

    const ownerTimers = ownerRoot.querySelector('.vs-mini-timers');
    const localTimers = localRoot.querySelector('.vs-mini-timers');
    if (ownerTimers && localTimers && !this._sameMiniContent(ownerTimers, localTimers)) {
      this._replaceChildrenFrom(ownerTimers, localTimers);
    }
  }

  _replaceChildrenFrom(sourceEl, targetEl) {
    targetEl.replaceChildren(...Array.from(sourceEl.childNodes, (node) => node.cloneNode(true)));
  }

  _sameMiniContent(a, b) {
    if (a.childNodes.length !== b.childNodes.length) return false;
    for (let i = 0; i < a.childNodes.length; i++) {
      const an = a.childNodes[i];
      const bn = b.childNodes[i];
      if (an.nodeType !== bn.nodeType) return false;
      if (an.nodeType === Node.TEXT_NODE) {
        if (an.textContent !== bn.textContent) return false;
        continue;
      }
      if (!(an instanceof Element) || !(bn instanceof Element)) return false;
      if (an.tagName !== bn.tagName) return false;
      if (an.className !== bn.className) return false;
      if (an.textContent !== bn.textContent) return false;
    }
    return true;
  }

  _ensureOwnerMirrorObserver() {
    const owner = window.__vsSingleton?.instance;
    if (!owner || owner === this) return;
    if (this._ownerMirrorCleanup && this._ownerMirrorOwner === owner) return;

    this._clearOwnerMirrorObserver();

    const ownerRoot = owner.shadowRoot;
    if (!ownerRoot) return;
    const isTall = this._config.mini_mode === 'tall';
    const targets = [
      ownerRoot.querySelector('.vs-mini-root'),
      isTall ? ownerRoot.querySelector('.vs-mini-transcript') : ownerRoot.querySelector('.vs-mini-line'),
      ownerRoot.querySelector('.vs-mini-timers'),
    ].filter(Boolean);
    if (!targets.length) return;

    let rafId = 0;
    const scheduleMirror = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!this.isConnected || singleton.isOwner(this)) return;
        if (!singleton.isActive()) return;
        this._mirrorOwnerUI();
      });
    };

    const observer = new MutationObserver(scheduleMirror);
    for (const target of targets) {
      observer.observe(target, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }

    this._ownerMirrorOwner = owner;
    this._ownerMirrorCleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }

  _clearOwnerMirrorObserver() {
    if (this._ownerMirrorCleanup) {
      this._ownerMirrorCleanup();
      this._ownerMirrorCleanup = null;
    }
    this._ownerMirrorOwner = null;
  }

  _syncRenderMode() {
    if (!this.shadowRoot) return false;
    const preview = this._shouldRenderStaticPreview();
    if (preview) {
      renderMiniPreview(this.shadowRoot, this._config);
      this._renderMode = 'preview';
      return true;
    }

    // If this instance was previously rendered as an editor preview, rebuild
    // the live mini UI now that it is back in the dashboard.
    if (this._renderMode === 'preview' || !this.shadowRoot.querySelector('.vs-mini-root')) {
      this._ui.ensureLocalUI();
      // The local mini DOM may have been rebuilt/replaced (HA editor save/cancel
      // flows). Invalidate mirror caches and repaint immediately if this is a
      // visible non-owner replacement for an active singleton owner.
      if (singleton.isActive() && !singleton.isOwner(this)) {
        this._ensureOwnerMirrorObserver();
        this._mirrorOwnerUI();
      }
    }
    this._renderMode = 'live';
    return false;
  }

  _shouldRenderStaticPreview() {
    if (!this._isMiniEditorPreview()) return false;
    // Never replace the active/started instance with the fake preview. The
    // editor preview should be a separate non-started, non-owner instance.
    if (this._hasStarted) return false;
    if (window.__vsSingleton?.instance === this) return false;
    return true;
  }

  _isMiniEditorPreview() {
    // `isEditorPreview()` includes broad dialog-level detection that can match
    // non-preview cards while the edit dialog is open. For the mini card we
    // only want the static preview in the actual dedicated preview container.
    // Do not key off generic `preview` attrs on HUI wrappers: those can appear
    // transiently during editor open/close and cause a visible preview flash.
    if (!isEditorPreview(this)) return false;
    let node = this;
    for (let i = 0; i < 20 && node; i++) {
      const tag = node.tagName;
      if (node.classList?.contains?.('element-preview')) return true;
      if (tag === 'HUI-CARD-PREVIEW') return true;
      node = node.parentElement || (node.getRootNode && node.getRootNode()).host;
    }
    return false;
  }

  _teardownActiveSession() {
    try { this.pipeline.stop(); } catch (_) {}
    try { this.audio.stopMicrophone(); } catch (_) {}
    try { this.tts.stop(); } catch (_) {}
    try { this.timer.destroy(); } catch (_) {}
    try { teardownSatelliteSubscription(); } catch (_) {}
    try { this.visibility.teardown(); } catch (_) {}
    singleton.release();
    this._hasStarted = false;
  }
}
