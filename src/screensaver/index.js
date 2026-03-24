/**
 * ScreensaverManager
 *
 * Built-in screensaver that overlays a solid color after an idle
 * timeout.  Replaces FK's heavy VideoView-based screensaver with a
 * lightweight CSS overlay that keeps the mic alive.
 *
 * Reads configuration from the satellite entity attributes:
 *   - screensaver_enabled  (boolean)  - switch on/off
 *   - screensaver_timer    (number)   - idle seconds before activation
 *
 * On Fully Kiosk Browser, dims the hardware backlight to 0 and
 * restores the original brightness on dismiss.
 *
 * The overlay fades in/out with a 200ms transition.  It is dismissed
 * when:
 *   - A voice interaction starts (wake word, announcement, etc.)
 *   - The user taps/clicks the overlay
 */

import { INTERACTING_STATES, State } from '../constants.js';
import { getSatelliteAttr } from '../shared/satellite-state.js';

const OVERLAY_ID = 'voice-satellite-screensaver';
const FADE_MS = 200;

export class ScreensaverManager {
  constructor(session) {
    this._session = session;
    this._log = session.logger;

    this._overlay = null;
    this._idleTimer = null;
    this._active = false;
    this._enabled = false;
    this._timerSeconds = 60;
    this._activityHandler = null;
    this._savedBrightness = null;
    this._fkMotionBound = false;
    this._unloadHandler = null;
  }

  /**
   * Read screensaver settings from entity attributes and start the
   * idle timer if enabled.  Called from session.updateHass().
   */
  checkSettings() {
    const hass = this._session.hass;
    const entityId = this._session.config.satellite_entity;
    if (!hass || !entityId) return;

    const enabled = getSatelliteAttr(hass, entityId, 'screensaver_enabled');
    const timer = getSatelliteAttr(hass, entityId, 'screensaver_timer');

    const newEnabled = enabled === true;
    const newTimer = (typeof timer === 'number' && timer >= 30) ? timer : 60;

    // Skip if nothing changed
    if (newEnabled === this._enabled && newTimer === this._timerSeconds) {
      return;
    }

    const wasEnabled = this._enabled;
    const oldTimer = this._timerSeconds;
    this._enabled = newEnabled;
    this._timerSeconds = newTimer;

    this._log.log('screensaver', `Settings changed: enabled=${newEnabled}, timer=${newTimer}s`);

    if (this._enabled && !wasEnabled) {
      this._log.log('screensaver', `Enabled (timer=${this._timerSeconds}s)`);
      this._setupActivityListeners();
      this._setupUnloadHandler();
      this._bindFkMotion();
      this._resetIdleTimer();
    } else if (!this._enabled && wasEnabled) {
      this._log.log('screensaver', 'Disabled');
      this._dismiss();
      this._clearIdleTimer();
      this._removeActivityListeners();
      this._removeUnloadHandler();
      this._unbindFkMotion();
    } else if (this._enabled && newTimer !== oldTimer) {
      // Timer value changed while enabled -- reset with new value
      this._resetIdleTimer();
    }
  }

  /**
   * Dismiss the screensaver if active.  Called from session event
   * handlers when a voice interaction begins.
   */
  dismiss() {
    if (!this._active) return;
    this._dismiss();
    this._resetIdleTimer();
  }

  /**
   * Notify the manager that a user interaction or voice event occurred.
   * Resets the idle timer.
   */
  notifyActivity() {
    this._lastInteractionTime = Date.now();
    if (this._active) {
      this._dismiss();
    }
    if (this._enabled) {
      this._resetIdleTimer();
    }
  }

  /**
   * Full teardown -- remove overlay, timers, and listeners.
   */
  teardown() {
    this._dismiss();
    this._clearIdleTimer();
    this._removeActivityListeners();
    this._removeUnloadHandler();
    this._unbindFkMotion();
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    this._enabled = false;
  }

  // ── Private ─────────────────────────────────────────────────────

  _resetIdleTimer() {
    this._clearIdleTimer();
    if (!this._enabled) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this._activate();
    }, this._timerSeconds * 1000);
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _activate() {
    if (this._active) return;
    if (!this._enabled) return;

    // Don't activate during a voice interaction, TTS playback, notification, or tab hidden
    if (
      this._session.currentState === State.PAUSED ||
      INTERACTING_STATES.includes(this._session.currentState) ||
      this._session.tts?.isPlaying ||
      this._session.announcement?.playing ||
      this._session.askQuestion?.playing ||
      this._session.startConversation?.playing
    ) {
      this._log.log('screensaver', 'Skipping activation -- interaction in progress');
      this._resetIdleTimer();
      return;
    }

    this._log.log('screensaver', 'Activating');
    this._active = true;
    this._ensureOverlay();
    this._overlay.style.backgroundColor = '#000000';

    // Dim hardware backlight via Fully Kiosk Browser API
    this._dimScreen();

    // Force reflow so the transition plays from opacity 0
    void this._overlay.offsetHeight;
    this._overlay.classList.add('vs-screensaver-visible');
    this._syncState(true);
  }

  _dismiss() {
    if (!this._active) return;
    this._log.log('screensaver', 'Dismissing');
    this._active = false;

    // Restore hardware backlight before fading overlay
    this._restoreScreen();

    if (this._overlay) {
      this._overlay.classList.remove('vs-screensaver-visible');
    }
    this._syncState(false);
  }

  _bindFkMotion() {
    if (this._fkMotionBound || !window.fully) return;
    // FK's bind() takes a string event name and a string global function name
    window.__vsOnFkMotion = () => {
      if (!this._active) return;
      this._log.log('screensaver', 'FK motion detected -- dismissing');
      this.notifyActivity();
    };
    try {
      window.fully.bind('onMotion', '__vsOnFkMotion()');
      this._fkMotionBound = true;
      this._log.log('screensaver', 'FK motion detection bound');
    } catch (e) {
      this._log.log('screensaver', `Failed to bind FK motion: ${e.message || e}`);
    }
  }

  _unbindFkMotion() {
    if (!this._fkMotionBound) return;
    try {
      window.fully.bind('onMotion', '');
    } catch (e) { /* ignore */ }
    delete window.__vsOnFkMotion;
    this._fkMotionBound = false;
  }

  _setupUnloadHandler() {
    if (this._unloadHandler) return;
    this._unloadHandler = () => {
      // Restore brightness synchronously on page unload so it's not stuck at 0
      if (this._savedBrightness !== null && window.fully) {
        try { window.fully.setScreenBrightness(this._savedBrightness); } catch (_) {}
      }
    };
    window.addEventListener('beforeunload', this._unloadHandler);
  }

  _removeUnloadHandler() {
    if (!this._unloadHandler) return;
    window.removeEventListener('beforeunload', this._unloadHandler);
    this._unloadHandler = null;
  }

  _dimScreen() {
    if (!window.fully) return;
    try {
      this._savedBrightness = window.fully.getScreenBrightness();
      window.fully.setScreenBrightness(0);
      this._log.log('screensaver', `Screen dimmed (saved: ${this._savedBrightness})`);
    } catch (e) {
      this._log.log('screensaver', `Failed to dim screen: ${e.message || e}`);
    }
  }

  _restoreScreen() {
    if (!window.fully || this._savedBrightness === null) return;
    try {
      window.fully.setScreenBrightness(this._savedBrightness);
      this._log.log('screensaver', `Screen brightness restored to ${this._savedBrightness}`);
      this._savedBrightness = null;
    } catch (e) {
      this._log.log('screensaver', `Failed to restore brightness: ${e.message || e}`);
    }
  }

  _syncState(active) {
    const conn = this._session.connection;
    const entityId = this._session.config.satellite_entity;
    if (!conn || !entityId) return;
    conn.sendMessagePromise({
      type: 'voice_satellite/screensaver_state',
      entity_id: entityId,
      active,
    }).catch(() => { /* fire-and-forget */ });
  }

  _ensureOverlay() {
    if (this._overlay) return;

    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    // Inject the style rules once (class-based so we can transition)
    if (!document.getElementById('vs-screensaver-style')) {
      const style = document.createElement('style');
      style.id = 'vs-screensaver-style';
      style.textContent = [
        `#${OVERLAY_ID} {`,
        '  position: fixed;',
        '  inset: 0;',
        '  z-index: 999999;',
        '  opacity: 0;',
        `  transition: opacity ${FADE_MS}ms ease;`,
        '  pointer-events: none;',
        '}',
        `#${OVERLAY_ID}.vs-screensaver-visible {`,
        '  opacity: 1;',
        '  pointer-events: auto;',
        '}',
      ].join('\n');
      document.head.appendChild(style);
    }

    el.addEventListener('click', () => {
      this._log.log('screensaver', 'Tap detected -- dismissing');
      this.notifyActivity();
    });

    document.body.appendChild(el);
    this._overlay = el;
    this._log.log('screensaver', 'Overlay element created');
  }

  _setupActivityListeners() {
    if (this._activityHandler) return;
    this._activityHandler = () => {
      this._lastInteractionTime = Date.now();
      if (this._active) {
        this._dismiss();
      }
      if (this._enabled) {
        this._resetIdleTimer();
      }
    };
    for (const evt of ['pointerdown', 'keydown']) {
      document.addEventListener(evt, this._activityHandler, { passive: true });
    }
    this._log.log('screensaver', 'Activity listeners registered');
  }

  _removeActivityListeners() {
    if (!this._activityHandler) return;
    for (const evt of ['pointerdown', 'keydown']) {
      document.removeEventListener(evt, this._activityHandler);
    }
    this._activityHandler = null;
  }
}
