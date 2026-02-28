/**
 * VoiceSatelliteSession
 *
 * Singleton that owns the voice pipeline (mic, WebSocket, TTS, timers,
 * notifications) independently of any card instance. Cards register with
 * the session and receive broadcast events via UI/Chat proxies.
 *
 * Implements the same interface that managers expect from a card, so
 * managers continue calling `this._card.X()` without knowing they talk
 * to a session. Zero changes to any manager code.
 */

import { State, DEFAULT_CONFIG } from '../constants.js';
import { Logger } from '../logger.js';
import { AudioManager } from '../audio';
import { AnalyserManager } from '../audio/analyser.js';
import { TtsManager } from '../tts';
import { PipelineManager } from '../pipeline';
import { DoubleTapHandler } from '../shared/double-tap.js';
import { VisibilityManager } from '../shared/visibility.js';
import { TimerManager } from '../timer';
import { AnnouncementManager } from '../announcement';
import { AskQuestionManager } from '../ask-question';
import { StartConversationManager } from '../start-conversation';
import { MediaPlayerManager } from '../media-player';
import { getSelectEntityId, getNumberState } from '../shared/satellite-state.js';
import { DISABLED_VALUE } from '../shared/entity-picker.js';
import { subscribeSatelliteEvents, teardownSatelliteSubscription } from '../shared/satellite-subscription.js';
import { dispatchSatelliteEvent } from '../shared/satellite-notification.js';
import { isEditorPreview } from '../editor/preview.js';
import { UIBroadcastProxy } from './ui-proxy.js';
import { ChatBroadcastProxy } from './chat-proxy.js';
import {
  setState,
  handleStartClick,
  startListening,
  onTTSComplete,
  handlePipelineMessage,
} from './events.js';

// Singleton via window namespace so multiple bundles share state
const SESSION_KEY = '__vsSession';

export class VoiceSatelliteSession {
  /**
   * Get or create the singleton session instance.
   * @returns {VoiceSatelliteSession}
   */
  static getInstance() {
    if (!window[SESSION_KEY]) {
      window[SESSION_KEY] = new VoiceSatelliteSession();
    }
    return window[SESSION_KEY];
  }

  constructor() {
    // Session state
    this._state = State.IDLE;
    this._config = Object.assign({}, DEFAULT_CONFIG);
    this._hass = null;
    this._connection = null;
    this._hasStarted = false;
    this._starting = false;
    this._startAttempted = false;
    this._lastSyncedSatelliteState = null;
    this._imageLingerTimeout = null;
    this._videoPlaying = false;
    this._activeSkin = null;
    this._fullCardSuppressed = false;

    this._logger = new Logger();

    // Session-owned managers (receive `this` as "card" reference)
    this._audio = new AudioManager(this);
    this._analyser = new AnalyserManager(this);
    this._tts = new TtsManager(this);
    this._pipeline = new PipelineManager(this);
    this._doubleTap = new DoubleTapHandler(this);
    this._visibility = new VisibilityManager(this);
    this._timer = new TimerManager(this);
    this._announcement = new AnnouncementManager(this);
    this._askQuestion = new AskQuestionManager(this);
    this._startConversation = new StartConversationManager(this);
    this._mediaPlayer = new MediaPlayerManager(this);

    // Broadcast proxies
    this._uiProxy = new UIBroadcastProxy(this);
    this._chatProxy = new ChatBroadcastProxy(this);

    // Registered card instances
    this._cards = new Set();
    // Cards rejected as editor previews (deferred detection).
    // WeakSet so GC cleans up when the preview instance is destroyed.
    this._rejectedPreviews = new WeakSet();
  }

  // ── Card interface (managers call these) ──────────────────────────

  get logger() { return this._logger; }
  get audio() { return this._audio; }
  get analyser() { return this._analyser; }
  get tts() { return this._tts; }
  get pipeline() { return this._pipeline; }
  get ui() { return this._uiProxy; }
  get chat() { return this._chatProxy; }
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

  get hass() { return this._hass; }

  get connection() {
    if (!this._connection && this._hass?.connection) {
      this._connection = this._hass.connection;
    }
    return this._connection;
  }

  /** Session is always the "owner" — there's no ownership model. */
  get isOwner() { return true; }

  /** True if any registered card wants the reactive bar. */
  get isReactiveBarEnabled() {
    for (const c of this._cards) {
      if (c.isReactiveBarEnabled) return true;
    }
    return false;
  }

  get ttsTarget() {
    return getSelectEntityId(this._hass, this._config.satellite_entity, 'tts_output') || '';
  }

  get announcementDisplayDuration() {
    return getNumberState(this._hass, this._config.satellite_entity, 'announcement_display_duration', 5);
  }

  // ── Card callback methods (managers invoke these) ─────────────────

  setState(newState) { setState(this, newState); }
  onStartClick() { handleStartClick(this); }
  onPipelineMessage(message) { handlePipelineMessage(this, message); }
  onTTSComplete(playbackFailed) { onTTSComplete(this, playbackFailed); }

  // ── Session API (cards call these) ────────────────────────────────

  get isStarted() { return this._hasStarted; }

  /**
   * Register a card with the session. If the session is already running,
   * sync the new card to the current state immediately.
   * @param {HTMLElement} card
   */
  register(card) {
    if (this._cards.has(card)) return;
    if (this._rejectedPreviews.has(card)) return;
    if (isEditorPreview(card)) return;

    // Only one full card should be registered at a time — its UI lives
    // in document.body and persists across navigations. Evict any stale
    // instance that was disconnected during navigation or replaced by
    // the editor.
    if (card.cardType === 'full') {
      for (const c of this._cards) {
        if (c.cardType === 'full' && c !== card) {
          this._cards.delete(c);
          this._logger.log('session', 'Evicted stale full card instance');
          break;
        }
      }
    }

    card.ensureUI();
    this._cards.add(card);
    this._logger.log('session', `Card registered (${this._cards.size} total)`);

    if (this._hasStarted) {
      card.ui.hideStartButton();
      card.ui.updateForState(
        this._state,
        this._pipeline.serviceUnavailable,
        this._tts.isPlaying,
      );

      // If this registration enables the reactive bar and the mic is
      // already running, attach it to the analyser now.  This handles
      // the case where the pipeline started with only a mini card
      // registered (isReactiveBarEnabled was false, so attachMic was
      // skipped) and a full card registers later.
      if (this.isReactiveBarEnabled && this._audio.sourceNode && this._audio.audioContext) {
        this._analyser.attachMic(this._audio.sourceNode, this._audio.audioContext);
      }
    }
    this._syncFullCardSuppression();

    // HA may insert cards before editor wrappers are attached to the DOM,
    // causing isEditorPreview to return false on the first check. Re-check
    // after a frame when the DOM is fully assembled. Blacklist the card so
    // subsequent set-hass() calls don't re-register it in a loop.
    //
    // Guard: only act if the card is still connected to the DOM.  If the
    // user navigated away between registration and this rAF, the card is
    // disconnected but still inside its <hui-card> wrapper (removed as a
    // subtree).  HA's hui-card may expose a `preview` property that could
    // cause isEditorPreview to return a false positive on the detached tree.
    requestAnimationFrame(() => {
      if (card.isConnected && isEditorPreview(card) && this._cards.has(card)) {
        this.unregister(card);
        this._rejectedPreviews.add(card);
      }
    });
  }

  /**
   * Unregister a card from the session.
   * @param {HTMLElement} card
   */
  unregister(card) {
    // Full cards should only be removed by eviction in register(), never
    // through unregister().  Log a trace if this happens so we can
    // diagnose the unexpected caller.
    if (card.cardType === 'full') {
      this._logger.log('session', 'WARNING: full card being unregistered — trace:');
      console.trace('full card unregister');
    }
    this._cards.delete(card);
    this._logger.log('session', `Card unregistered (${this._cards.size} remaining)`);
    this._syncFullCardSuppression();
  }

  /**
   * Update the shared hass reference. Called by cards on `set hass()`.
   * @param {object} hass
   */
  updateHass(hass) {
    if (!hass) return;
    this._hass = hass;
    if (hass.connection) {
      this._connection = hass.connection;
    }

    if (this._hasStarted) {
      this._timer.update();
      this._tts.checkRemotePlayback(hass);
      subscribeSatelliteEvents(this, (event) => dispatchSatelliteEvent(this, event));
    }
  }

  /**
   * Merge session-relevant config keys. Card-specific keys (skin,
   * mini_mode, etc.) stay on the card.
   * @param {object} config
   */
  updateConfig(config) {
    if (!config) return;
    const sessionKeys = [
      'satellite_entity', 'debug', 'browser_satellite_override',
      'echo_cancellation', 'noise_suppression', 'auto_gain_control',
      'voice_isolation', 'reactive_bar', 'reactive_bar_update_interval_ms',
    ];
    const oldEntity = this._config.satellite_entity;
    for (const key of sessionKeys) {
      if (config[key] !== undefined) this._config[key] = config[key];
    }
    this._logger.debug = !!this._config.debug;

    // If entity changed while running, restart
    if (oldEntity && this._config.satellite_entity
        && oldEntity !== this._config.satellite_entity && this._hasStarted) {
      this._logger.log('session', `Entity changed: ${oldEntity} → ${this._config.satellite_entity}`);
      this.teardown();
    }
    this._syncFullCardSuppression();
  }

  /**
   * Start the session pipeline. No-op if already started.
   */
  async start() {
    if (this._hasStarted || this._starting || this._startAttempted) return;
    if (!this._config.satellite_entity || !this._connection) return;
    this._startAttempted = true;
    await startListening(this);
  }

  /**
   * Register a card and start the session in one call.
   * Handles ensureUI (via register), updateHass, updateConfig, and start.
   * @param {HTMLElement} card
   */
  registerAndStart(card) {
    this.register(card);
    this.updateHass(card.hass);
    this.updateConfig(card.config);
    if (card.isConnected) {
      this.start();
    }
  }

  /**
   * Handle an entity picker selection. Updates the card's config,
   * tears down a stale session if needed, then registers and starts.
   * @param {HTMLElement} card
   * @param {string} entityId
   */
  handleEntityPick(card, entityId) {
    if (entityId === DISABLED_VALUE) {
      card._deviceDisabled = true;
      return;
    }
    card._config.satellite_entity = entityId;
    card._isLocalStorageEntity = true;
    if (this.isStarted) {
      this.teardown();
    }
    this.registerAndStart(card);
  }

  /**
   * Tear down the active session: stop pipeline, mic, TTS, timers,
   * subscriptions. Cards remain registered and can restart.
   */
  teardown() {
    this._logger.log('session', 'Tearing down session');
    try { this._pipeline.stop(); } catch (_) {}
    try { this._audio.stopMicrophone(); } catch (_) {}
    try { this._tts.stop(); } catch (_) {}
    try { this._timer.destroy(); } catch (_) {}
    try { teardownSatelliteSubscription(); } catch (_) {}
    try { this._visibility.teardown(); } catch (_) {}
    this._hasStarted = false;
    this._starting = false;
    this._startAttempted = false;
    this._lastSyncedSatelliteState = null;
  }

  // ── Full card suppression ───────────────────────────────────────

  /**
   * Hide the full card's global UI element when any registered mini card
   * has suppress_full_card enabled. Show it otherwise.
   */
  _syncFullCardSuppression() {
    let suppress = false;
    for (const c of this._cards) {
      if (c.cardType === 'mini' && c.config.suppress_full_card) {
        suppress = true;
        break;
      }
    }
    this._fullCardSuppressed = suppress;
    const display = suppress ? 'none' : '';
    const ui = document.getElementById('voice-satellite-ui');
    if (ui) ui.style.display = display;
    // Timer pills live in a separate container outside #voice-satellite-ui
    const timers = document.getElementById('voice-satellite-timers');
    if (timers) timers.style.display = display;
    // Timer alerts are created dynamically in document.body — clean up any visible ones
    if (suppress) {
      for (const el of document.querySelectorAll('.vs-timer-alert')) {
        el.style.display = 'none';
      }
    }
  }
}
