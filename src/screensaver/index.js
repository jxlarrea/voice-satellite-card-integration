/**
 * ScreensaverManager
 *
 * Built-in screensaver that overlays the display after an idle timeout.
 * Supports three display types:
 *   - 'black'   — solid black overlay (original behavior, dims FK backlight)
 *   - 'media'   — images/videos/cameras from a media-source URI (single
 *                 file, folder for cycling, or a camera feed from HA's
 *                 media library)
 *   - 'website' — arbitrary URL in an <iframe>, useful for kiosk-style
 *                 apps like immich-kiosk
 *
 * Also runs an external-screensaver keep-alive loop: while a voice
 * interaction is active, periodically turns off a user-selected switch
 * (typically Fully Kiosk's built-in screensaver) so it can't cover the
 * voice UI mid-conversation.
 *
 * All configuration comes from the session config (sidebar panel):
 *   - screensaver_enabled, screensaver_timer_s
 *   - screensaver_type
 *   - screensaver_media_id, screensaver_media_interval_s, screensaver_media_shuffle
 *   - screensaver_suppress_external
 */

import { INTERACTING_STATES, State } from '../constants.js';

const OVERLAY_ID = 'voice-satellite-screensaver';
const FADE_MS = 200;
const MEDIA_FADE_MS = 600;
const KEEPALIVE_INTERVAL_MS = 5000;

/**
 * Detect a camera entity selected via the media browser.
 * HA uses `media-source://camera/camera.xxx` for cameras; extract the
 * `camera.xxx` entity_id so we can stream via camera_proxy_stream
 * (MJPEG) rather than the HLS URL that resolve_media tends to return.
 */
function getCameraEntityFromMediaId(id) {
  if (!id) return null;
  const m = /^media-source:\/\/camera\/(camera\.[a-z0-9_]+)/i.exec(id);
  return m ? m[1] : null;
}

export class ScreensaverManager {
  constructor(session) {
    this._session = session;
    this._log = session.logger;

    this._overlay = null;
    this._contentEl = null;
    this._idleTimer = null;
    this._active = false;
    this._enabled = false;
    this._timerSeconds = 60;
    this._type = 'black';
    this._dimPercent = null;
    this._fkMotionDismiss = false;
    this._mediaId = '';
    this._mediaIntervalSeconds = 10;
    this._mediaShuffle = false;
    this._websiteUrl = '';
    this._suppressExternal = '';
    this._activityHandler = null;
    this._savedBrightness = null;
    this._fkMotionBound = false;
    this._unloadHandler = null;

    // Media playback state
    this._playlist = [];
    this._playlistIdx = 0;
    this._mediaCycleTimer = null;

    // External screensaver keep-alive
    this._keepaliveTimer = null;
  }

  /**
   * Read screensaver settings from the session config and start the
   * idle timer if enabled.  Called from session.updateHass() and
   * session.updateConfig().
   */
  checkSettings() {
    const cfg = this._session.config || {};

    const newEnabled = cfg.screensaver_enabled === true;
    const newTimer = Math.max(10, parseInt(cfg.screensaver_timer_s, 10) || 60);
    // Dim percent is a "null = no dimming" tri-state: null/undefined/
    // empty-string means leave the backlight alone, numbers 0–100 pick
    // an explicit brightness level.
    let newDimPercent = null;
    if (cfg.screensaver_dim_percent !== null
        && cfg.screensaver_dim_percent !== undefined
        && cfg.screensaver_dim_percent !== '') {
      const rawDim = Number(cfg.screensaver_dim_percent);
      if (Number.isFinite(rawDim)) {
        newDimPercent = Math.min(100, Math.max(0, rawDim));
      }
    }
    const newFkMotionDismiss = cfg.screensaver_fk_motion_dismiss === true;
    const newType = ['black', 'media', 'website'].includes(cfg.screensaver_type)
      ? cfg.screensaver_type : 'black';
    const newMediaId = cfg.screensaver_media_id || '';
    const newMediaInterval = Math.max(2, parseInt(cfg.screensaver_media_interval_s, 10) || 10);
    const newMediaShuffle = cfg.screensaver_media_shuffle === true;
    const newWebsiteUrl = (cfg.screensaver_website_url || '').trim();
    const newSuppressExternal = cfg.screensaver_suppress_external || '';

    const settingsChanged =
      newEnabled !== this._enabled ||
      newTimer !== this._timerSeconds ||
      newDimPercent !== this._dimPercent ||
      newFkMotionDismiss !== this._fkMotionDismiss ||
      newType !== this._type ||
      newMediaId !== this._mediaId ||
      newMediaInterval !== this._mediaIntervalSeconds ||
      newMediaShuffle !== this._mediaShuffle ||
      newWebsiteUrl !== this._websiteUrl;

    this._suppressExternal = newSuppressExternal;

    if (!settingsChanged) return;

    const wasEnabled = this._enabled;
    const wasActive = this._active;
    this._enabled = newEnabled;
    this._timerSeconds = newTimer;
    this._dimPercent = newDimPercent;
    this._fkMotionDismiss = newFkMotionDismiss;
    this._type = newType;
    this._mediaId = newMediaId;
    this._mediaIntervalSeconds = newMediaInterval;
    this._mediaShuffle = newMediaShuffle;
    this._websiteUrl = newWebsiteUrl;

    this._log.log('screensaver', `Settings: enabled=${newEnabled}, timer=${newTimer}s, type=${newType}`);

    if (this._enabled && !wasEnabled) {
      this._setupActivityListeners();
      this._setupUnloadHandler();
      this._resetIdleTimer();
    } else if (!this._enabled && wasEnabled) {
      this._dismiss();
      this._clearIdleTimer();
      this._removeActivityListeners();
      this._removeUnloadHandler();
    } else if (this._enabled) {
      // Re-render with new type/media if currently active
      if (wasActive) {
        this._dismiss();
        this._resetIdleTimer();
      } else {
        this._resetIdleTimer();
      }
    }

    // Reconcile FK motion binding — covers enable/disable transitions
    // AND live toggling of the fk_motion_dismiss setting while enabled.
    if (this._enabled && this._fkMotionDismiss) {
      this._bindFkMotion();
    } else {
      this._unbindFkMotion();
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
   * Start the external screensaver keep-alive loop.  Called when a
   * voice interaction begins (pipeline state becomes non-idle).
   */
  startExternalKeepalive() {
    if (!this._suppressExternal) return;
    if (this._keepaliveTimer) return;
    this._turnOffExternal();
    this._keepaliveTimer = setInterval(
      () => this._turnOffExternal(),
      KEEPALIVE_INTERVAL_MS,
    );
  }

  /**
   * Stop the external screensaver keep-alive loop.  We intentionally
   * do NOT turn the switch back on here — Fully Kiosk (or whichever
   * integration owns the switch) should re-activate on its own
   * schedule so the user sees the dashboard first and only re-enters
   * the screensaver after FK's normal idle timeout.
   */
  stopExternalKeepalive() {
    if (!this._keepaliveTimer) return;
    clearInterval(this._keepaliveTimer);
    this._keepaliveTimer = null;
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
    this.stopExternalKeepalive();
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
      this._contentEl = null;
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

    // Don't activate if the voice engine isn't running — the screensaver
    // is a companion to the satellite, not something that should take
    // over the screen while the engine is stopped.
    if (!this._session.isStarted) {
      this._log.log('screensaver', 'Skipping activation -- engine not started');
      return;
    }

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

    this._log.log('screensaver', `Activating (type=${this._type})`);
    this._active = true;
    this._ensureOverlay();

    // Dim the hardware backlight (Fully Kiosk only) before rendering
    // content — applies to all screensaver types, using the user's
    // configured brightness.  0% = fully dim (black overlay default),
    // 100% = keep current brightness.
    this._dimScreen();

    if (this._type === 'black') {
      this._renderBlack();
    } else if (this._type === 'media') {
      this._renderMedia();
    } else if (this._type === 'website') {
      this._renderWebsite();
    }

    // Force reflow so the transition plays from opacity 0
    void this._overlay.offsetHeight;
    this._overlay.classList.add('vs-screensaver-visible');
    this._syncState(true);
  }

  _dismiss() {
    if (!this._active) return;
    this._log.log('screensaver', 'Dismissing');
    this._active = false;

    // Restore hardware backlight to whatever it was before we dimmed it
    this._restoreScreen();

    // Stop media cycling
    this._stopMediaCycle();

    if (this._overlay) {
      this._overlay.classList.remove('vs-screensaver-visible');
      // Clear content after fade completes so next activation gets fresh DOM
      setTimeout(() => {
        if (!this._active && this._contentEl) {
          this._contentEl.innerHTML = '';
        }
      }, FADE_MS + 50);
    }
    this._syncState(false);
  }

  // ── Render modes ─────────────────────────────────────────────────

  _renderBlack() {
    this._overlay.style.backgroundColor = '#000000';
    if (this._contentEl) this._contentEl.innerHTML = '';
  }

  _renderWebsite() {
    this._overlay.style.backgroundColor = '#000000';
    if (!this._contentEl) return;
    this._contentEl.innerHTML = '';

    if (!this._websiteUrl) {
      this._log.log('screensaver', 'Website mode but no URL configured — falling back to black');
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.src = this._websiteUrl;
    iframe.referrerPolicy = 'no-referrer';
    iframe.allow = 'autoplay; fullscreen';
    iframe.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'border:0',
      'background:#000',
      // Let taps fall through to the overlay so the standard
      // click-to-dismiss gesture works even though the iframe's
      // (usually cross-origin) content would otherwise swallow them.
      'pointer-events:none',
      'opacity:0',
      `transition:opacity ${MEDIA_FADE_MS}ms ease`,
    ].join(';');
    iframe.addEventListener('load', () => this._fadeInAndSweep(iframe), { once: true });
    iframe.addEventListener('error', () => {
      this._log.log('screensaver', `Website iframe failed to load: ${this._websiteUrl}`);
    }, { once: true });
    this._contentEl.appendChild(iframe);
  }

  async _renderMedia() {
    this._overlay.style.backgroundColor = '#000000';
    if (!this._contentEl) return;
    this._contentEl.innerHTML = '';

    if (!this._mediaId) {
      this._log.log('screensaver', 'Media mode but no media selected — falling back to black');
      return;
    }

    try {
      this._playlist = await this._resolvePlaylist(this._mediaId);
      if (this._playlist.length === 0) {
        this._log.log('screensaver', 'Playlist empty — falling back to black');
        return;
      }
      if (this._mediaShuffle) this._shuffle(this._playlist);
      this._playlistIdx = 0;
      this._playCurrentItem();
    } catch (e) {
      this._log.log('screensaver', `Failed to resolve media: ${e.message || e}`);
    }
  }

  async _resolvePlaylist(mediaId) {
    const conn = this._session.connection;
    if (!conn) return [];

    // Try to browse first — if it has children, treat as folder
    try {
      const browse = await conn.sendMessagePromise({
        type: 'media_source/browse_media',
        media_content_id: mediaId,
      });
      const children = (browse && browse.children) || [];
      if (children.length > 0) {
        const items = [];
        for (const child of children) {
          if (child.can_play && !child.can_expand) {
            items.push(child.media_content_id);
          }
        }
        return items;
      }
    } catch (_) {
      // Not browseable — fall through to treat as single item
    }
    return [mediaId];
  }

  async _playCurrentItem() {
    if (!this._active || !this._contentEl) return;
    if (this._playlist.length === 0) return;

    const conn = this._session.connection;
    if (!conn) return;

    const itemId = this._playlist[this._playlistIdx];
    let url = '';
    let mime = '';

    // Camera entities selected via the media browser come back as
    // media-source://camera/camera.xxx.  Resolving them tends to yield
    // HLS playlists, which Chrome/Firefox can't play in <video>.
    // Instead, use the MJPEG proxy stream which is universal and
    // works inside <img>.
    const cameraEid = getCameraEntityFromMediaId(itemId);
    if (cameraEid) {
      try {
        const res = await conn.sendMessagePromise({
          type: 'auth/sign_path',
          path: `/api/camera_proxy_stream/${cameraEid}`,
          expires: 3600,
        });
        const signedPath = res?.path || '';
        if (signedPath) {
          const base = this._session.hass?.hassUrl ? this._session.hass.hassUrl() : '';
          url = base.replace(/\/$/, '') + signedPath;
          mime = 'multipart/x-mixed-replace';
        }
      } catch (e) {
        this._log.log('screensaver', `Failed to sign camera ${cameraEid}: ${e.message || e}`);
      }
    } else {
      try {
        const res = await conn.sendMessagePromise({
          type: 'media_source/resolve_media',
          media_content_id: itemId,
        });
        url = res?.url || '';
        mime = res?.mime_type || '';
      } catch (e) {
        this._log.log('screensaver', `Resolve failed for ${itemId}: ${e.message || e}`);
        this._advancePlaylist();
        return;
      }

      // HA returns relative URLs — resolve against the HA base URL
      if (url && url.startsWith('/')) {
        const base = this._session.hass?.hassUrl ? this._session.hass.hassUrl() : '';
        url = base.replace(/\/$/, '') + url;
      }
    }

    if (!url) {
      this._advancePlaylist();
      return;
    }

    const isVideo = /^video\//.test(mime) || /\.(mp4|webm|ogg|mov)($|\?)/i.test(url);
    const baseStyles = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'object-fit:contain',
      'background:#000',
      'opacity:0',
      `transition:opacity ${MEDIA_FADE_MS}ms ease`,
    ].join(';');

    if (isVideo) {
      const v = document.createElement('video');
      v.src = url;
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.loop = this._playlist.length === 1;
      v.style.cssText = baseStyles;
      v.addEventListener('loadeddata', () => this._fadeInAndSweep(v), { once: true });
      v.addEventListener('error', () => {
        v.remove();
        if (this._playlist.length > 1) this._advancePlaylist();
      }, { once: true });
      if (this._playlist.length > 1) {
        v.addEventListener('ended', () => this._advancePlaylist(), { once: true });
      }
      this._contentEl.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = baseStyles;
      img.addEventListener('load', () => this._fadeInAndSweep(img), { once: true });
      img.addEventListener('error', () => {
        img.remove();
        if (this._playlist.length > 1) this._advancePlaylist();
      }, { once: true });
      this._contentEl.appendChild(img);

      // Cycle on interval for images (videos cycle on 'ended')
      if (this._playlist.length > 1) {
        this._scheduleNextMediaCycle();
      }
    }
  }

  /**
   * Cross-fade: fade a newly-loaded media element to full opacity,
   * then remove any older siblings once the transition completes.
   * The previous item stays visible under the new one during the fade,
   * so cycling images is smooth instead of flashing black between them.
   */
  _fadeInAndSweep(el) {
    if (!this._contentEl) return;
    // Force a reflow so the browser picks up opacity:0 before we change it
    void el.offsetHeight;
    el.style.opacity = '1';
    setTimeout(() => {
      if (!this._contentEl) return;
      for (const child of Array.from(this._contentEl.children)) {
        if (child !== el) child.remove();
      }
    }, MEDIA_FADE_MS + 50);
  }

  _advancePlaylist() {
    if (!this._active) return;
    if (this._playlist.length === 0) return;
    this._playlistIdx = (this._playlistIdx + 1) % this._playlist.length;
    this._playCurrentItem();
  }

  _scheduleNextMediaCycle() {
    this._stopMediaCycle();
    this._mediaCycleTimer = setTimeout(
      () => this._advancePlaylist(),
      this._mediaIntervalSeconds * 1000,
    );
  }

  _stopMediaCycle() {
    if (this._mediaCycleTimer) {
      clearTimeout(this._mediaCycleTimer);
      this._mediaCycleTimer = null;
    }
  }

  // ── External screensaver keep-alive ─────────────────────────────

  _turnOffExternal() {
    const hass = this._session.hass;
    if (!hass || !this._suppressExternal) return;
    try {
      hass.callService('homeassistant', 'turn_off', {
        entity_id: this._suppressExternal,
      });
    } catch (_) { /* best-effort */ }
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  // ── FK motion / backlight ───────────────────────────────────────

  _bindFkMotion() {
    if (this._fkMotionBound || !window.fully) return;
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
    // Only Fully Kiosk exposes a hardware-backlight API.  Other
    // browsers just ignore the dim setting.  Null (no value stored)
    // and 100% (max) both mean "leave the current brightness alone"
    // so we don't clobber the user's existing FK brightness.
    if (!window.fully) return;
    if (this._dimPercent === null || this._dimPercent >= 100) return;
    try {
      this._savedBrightness = window.fully.getScreenBrightness();
      const target = Math.round(this._dimPercent * 2.55);
      window.fully.setScreenBrightness(target);
      this._log.log(
        'screensaver',
        `Screen dimmed to ${target}/255 (saved: ${this._savedBrightness})`,
      );
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
        '  overflow: hidden;',
        '}',
        `#${OVERLAY_ID}.vs-screensaver-visible {`,
        '  opacity: 1;',
        '  pointer-events: auto;',
        '}',
        `#${OVERLAY_ID} .vs-screensaver-content {`,
        '  position: absolute;',
        '  inset: 0;',
        '}',
      ].join('\n');
      document.head.appendChild(style);
    }

    const content = document.createElement('div');
    content.className = 'vs-screensaver-content';
    el.appendChild(content);

    el.addEventListener('click', () => {
      this._log.log('screensaver', 'Tap detected -- dismissing');
      this.notifyActivity();
    });

    document.body.appendChild(el);
    this._overlay = el;
    this._contentEl = content;
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
