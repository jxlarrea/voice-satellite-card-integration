/**
 * ScreensaverManager
 *
 * Built-in screensaver that overlays the display after an idle timeout.
 * Supports four display types:
 *   - 'black'   — solid black overlay (original behavior, dims FK backlight)
 *   - 'media'   — images/videos/cameras from a media-source URI (single
 *                 file, folder for cycling, or a camera feed from HA's
 *                 media library; cameras stream over WebRTC when the
 *                 entity has a provider, MJPEG otherwise)
 *   - 'website' — arbitrary URL in an <iframe>, useful for kiosk-style
 *                 apps like immich-kiosk
 *   - 'clock'   — large digital time + date on a black background
 *
 * Also runs an external-screensaver keep-alive loop: while a voice
 * interaction is active, periodically turns off a user-selected switch
 * (typically Fully Kiosk's built-in screensaver) so it can't cover the
 * voice UI mid-conversation.
 *
 * All configuration comes from the session config (sidebar panel),
 * except enable/disable, where the integration's Screensaver switch
 * entity wins when it exists (so automations can toggle it):
 *   - screensaver_enabled, screensaver_timer_s
 *   - screensaver_type
 *   - screensaver_media_id, screensaver_media_interval_s, screensaver_media_shuffle
 *   - screensaver_website_url
 *   - screensaver_suppress_external
 */

import { INTERACTING_STATES, State } from '../constants.js';
import { getSwitchState } from '../shared/satellite-state.js';
import { cameraSupportsWebrtc, attachCameraWebrtc } from '../shared/camera-webrtc.js';
import * as kiosk from '../kiosk/index.js';

const OVERLAY_ID = 'voice-satellite-screensaver';
const FADE_MS = 200;
const MEDIA_FADE_MS = 600;
const KEEPALIVE_INTERVAL_MS = 5000;
const PIXEL_SHIFT_INTERVAL_MS = 60000;

// Caps for recursive playlist resolution ("Include subfolders").  Each
// folder is one websocket round-trip at activation time, so a huge SMB
// library must not stall the screensaver or hammer the server.
const PLAYLIST_MAX_ITEMS = 12000;
const PLAYLIST_MAX_FOLDERS = 200;
const PLAYLIST_MAX_DEPTH = 5;
const PLAYLIST_BROWSE_CONCURRENCY = 4;

/**
 * Detect a camera entity selected via the media browser.
 * HA uses `media-source://camera/camera.xxx` for cameras; extract the
 * `camera.xxx` entity_id so we can stream via WebRTC (sub-second
 * latency, negotiated over the HA websocket) or, when the camera has
 * no WebRTC provider, via camera_proxy_stream (MJPEG) - rather than
 * the HLS URL that resolve_media tends to return, which Chrome and
 * Firefox can't play in <video>.
 */
function getCameraEntityFromMediaId(id) {
  if (!id) return null;
  const m = /^media-source:\/\/camera\/(camera\.[a-z0-9_]+)/i.exec(id);
  return m ? m[1] : null;
}

/** Shared styles for media elements (image/video/camera) in the overlay.
 *  Longhand offsets instead of `inset` - old WebViews (< Chromium 87,
 *  e.g. Android 9 kiosk tablets) drop the shorthand, collapsing the
 *  overlay to an invisible zero-size box (#94). */
const MEDIA_BASE_STYLES = [
  'position:absolute',
  'top:0;left:0;right:0;bottom:0',
  'width:100%',
  'height:100%',
  'object-fit:contain',
  'background:#000',
  'opacity:0',
  `transition:opacity ${MEDIA_FADE_MS}ms ease`,
].join(';');

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
    this._mediaRecursive = false;
    this._websiteUrl = '';
    this._clock24h = false;
    this._clockSeconds = false;
    this._clockShowDate = true;
    this._clockScale = 100;
    this._clockColor = '250,250,250';
    this._clockTimer = null;
    this._clockTimeEl = null;
    this._clockDateEl = null;
    this._suppressExternal = '';
    this._pixelShift = false;
    this._pixelShiftTimer = null;
    this._activityHandler = null;
    this._savedBrightness = null;
    this._fkMotionBound = false;
    this._unloadHandler = null;

    // Media playback state
    this._playlist = [];
    this._playlistIdx = 0;
    this._mediaCycleTimer = null;

    // WebRTC camera state (media type with a camera selected). Cameras
    // whose WebRTC negotiation failed fall back to MJPEG and are
    // remembered so we don't retry every cycle.
    this._cameraWebrtc = null;
    this._webrtcFailedCams = new Set();

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

    // Enable/disable: the integration's Screensaver switch entity is
    // authoritative when present, so automations and the HA UI can
    // toggle the screensaver.  The panel config value is the fallback
    // for older integration versions without the switch.
    const switchOn = getSwitchState(this._session.hass, cfg.satellite_entity, 'screensaver');
    let newEnabled = switchOn !== undefined ? switchOn : cfg.screensaver_enabled === true;

    // Kiosk Satellite precedence: when the kiosk app runs its own
    // screensaver and asks ours to stand down, enabled is forced off no
    // matter what the switch or config says.  The answer is queried once
    // (async) and cached; re-run the settings check when it lands true so
    // an already-armed screensaver disarms.
    if (!this._ksSuppressQueried) {
      this._ksSuppressQueried = true;
      kiosk.confirmScreensaverSuppressed().then((suppressed) => {
        if (suppressed) this.checkSettings();
      });
    }
    if (newEnabled && kiosk.screensaverSuppressed()) newEnabled = false;
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
    const newType = ['black', 'media', 'website', 'clock'].includes(cfg.screensaver_type)
      ? cfg.screensaver_type : 'black';
    const newMediaId = cfg.screensaver_media_id || '';
    const newMediaInterval = Math.max(2, parseInt(cfg.screensaver_media_interval_s, 10) || 10);
    const newMediaShuffle = cfg.screensaver_media_shuffle === true;
    const newMediaRecursive = cfg.screensaver_media_recursive === true;
    const newWebsiteUrl = (cfg.screensaver_website_url || '').trim();
    const newClock24h = cfg.screensaver_clock_24h === true;
    const newClockSeconds = cfg.screensaver_clock_seconds === true;
    // Defaults to on: only an explicit `false` hides the date.
    const newClockShowDate = cfg.screensaver_clock_show_date !== false;
    // Percentage scale for the clock/date size.  The base size is in
    // viewport units, which browsers/webviews report differently
    // (zoom, chrome, kiosk viewport settings), so this per-browser
    // knob lets users equalize the apparent size across tablets.
    const newClockScale = Math.min(300, Math.max(50, parseInt(cfg.screensaver_clock_scale, 10) || 100));
    // Clock text color, an [r,g,b] array from the HA color picker.
    // Normalized to an "r,g,b" string so the change comparison below
    // stays a plain !== (a fresh array every read would never match).
    let newClockColor = '250,250,250';
    if (Array.isArray(cfg.screensaver_clock_color) && cfg.screensaver_clock_color.length === 3) {
      const rgb = cfg.screensaver_clock_color.map((c) => {
        const n = Math.round(Number(c));
        return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : null;
      });
      if (!rgb.includes(null)) newClockColor = rgb.join(',');
    }
    const newPixelShift = cfg.screensaver_pixel_shift === true;
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
      newMediaRecursive !== this._mediaRecursive ||
      newWebsiteUrl !== this._websiteUrl ||
      newClock24h !== this._clock24h ||
      newClockSeconds !== this._clockSeconds ||
      newClockShowDate !== this._clockShowDate ||
      newClockScale !== this._clockScale ||
      newClockColor !== this._clockColor ||
      newPixelShift !== this._pixelShift;

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
    this._mediaRecursive = newMediaRecursive;
    this._websiteUrl = newWebsiteUrl;
    this._clock24h = newClock24h;
    this._clockSeconds = newClockSeconds;
    this._clockShowDate = newClockShowDate;
    this._clockScale = newClockScale;
    this._clockColor = newClockColor;
    this._pixelShift = newPixelShift;

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
    this._stopCameraWebrtc();
    this._stopClock();
    this._stopPixelShift();
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

    // Dim the hardware backlight (kiosk browsers only) before rendering
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
    } else if (this._type === 'clock') {
      this._renderClock();
    }

    // Force reflow so the transition plays from opacity 0
    void this._overlay.offsetHeight;
    this._overlay.classList.add('vs-screensaver-visible');
    this._startPixelShift();
    this._syncState(true);
  }

  _dismiss() {
    if (!this._active) return;
    this._log.log('screensaver', 'Dismissing');
    this._active = false;

    // Restore hardware backlight to whatever it was before we dimmed it
    this._restoreScreen();

    // Stop media cycling, any WebRTC camera stream, the clock tick,
    // and the OLED pixel-shift drift
    this._stopMediaCycle();
    this._stopCameraWebrtc();
    this._stopClock();
    this._stopPixelShift();

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
      'top:0;left:0;right:0;bottom:0',
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

  _renderClock() {
    this._overlay.style.backgroundColor = '#000000';
    if (!this._contentEl) return;
    this._contentEl.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'position:absolute',
      'top:0;left:0;right:0;bottom:0',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'text-align:center',
      'user-select:none',
      "font-family:'Google Sans', var(--ha-font-family, Roboto, system-ui, sans-serif)",
      // Tabular figures keep the digits from shifting as the time ticks.
      'font-variant-numeric:tabular-nums',
      "font-feature-settings:'tnum' 1",
      'opacity:0',
      `transition:opacity ${MEDIA_FADE_MS}ms ease`,
    ].join(';');

    const scale = this._clockScale / 100;
    // Date line: same hue as the time, darkened.  0.65 matches the
    // old rgba(255,255,255,0.65)-on-black look for the default color.
    const dateColor = this._clockColor
      .split(',')
      .map((c) => Math.round(Number(c) * 0.65))
      .join(',');
    // px fallbacks for engines without min() in calc() (< Chromium 79):
    // the earlier valid px declaration survives when the calc() one is
    // dropped, while modern engines override it with the calc() value.
    // Only degradation on old engines: the size doesn't track viewport
    // rotation until the next activation re-renders.
    const timeFallbackPx = Math.round(
      Math.min(window.innerWidth * 0.20, window.innerHeight * 0.30) * scale,
    );
    const dateFallbackPx = Math.round(
      Math.min(window.innerWidth * 0.05, window.innerHeight * 0.07) * scale,
    );
    const timeEl = document.createElement('div');
    timeEl.style.cssText = [
      `color:rgb(${this._clockColor})`,
      'font-weight:300',
      'letter-spacing:0.02em',
      'line-height:1',
      `font-size:${timeFallbackPx}px`,
      `font-size:calc(min(20vw, 30vh) * ${scale})`,
    ].join(';');
    wrap.appendChild(timeEl);
    this._clockTimeEl = timeEl;

    if (this._clockShowDate) {
      const dateEl = document.createElement('div');
      dateEl.style.cssText = [
        `color:rgb(${dateColor})`,
        'font-weight:400',
        // Replaces the wrapper's flex gap (< Chromium 84 support).
        'margin-top:0.35rem',
        `font-size:${dateFallbackPx}px`,
        `font-size:calc(min(5vw, 7vh) * ${scale})`,
      ].join(';');
      wrap.appendChild(dateEl);
      this._clockDateEl = dateEl;
    }

    this._contentEl.appendChild(wrap);
    this._updateClock();
    this._startClock();
    this._fadeInAndSweep(wrap);
  }

  /** Render the current time/date into the clock elements. */
  _updateClock() {
    if (!this._clockTimeEl) return;
    const now = new Date();
    // Use the device/browser locale so the time and date render in the
    // viewer's own language and regional format. Passing undefined to
    // toLocale* falls back to the runtime default locale (the device's).
    const lang = (typeof navigator !== 'undefined' && navigator.language) || undefined;
    const timeOpts = {
      // Leading-zero hours read better in 24h ("09:05"); 12h drops it ("9:05").
      hour: this._clock24h ? '2-digit' : 'numeric',
      minute: '2-digit',
      hour12: !this._clock24h,
    };
    if (this._clockSeconds) timeOpts.second = '2-digit';
    this._clockTimeEl.textContent = now.toLocaleTimeString(lang, timeOpts);
    if (this._clockDateEl) {
      this._clockDateEl.textContent = now.toLocaleDateString(lang, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    }
  }

  /** Tick the clock, re-aligning to each second boundary so it stays accurate. */
  _startClock() {
    this._stopClock(false);
    const tick = () => {
      this._updateClock();
      this._clockTimer = setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    this._clockTimer = setTimeout(tick, 1000 - (Date.now() % 1000));
  }

  _stopClock(clearRefs = true) {
    if (this._clockTimer) {
      clearTimeout(this._clockTimer);
      this._clockTimer = null;
    }
    if (clearRefs) {
      this._clockTimeEl = null;
      this._clockDateEl = null;
    }
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
      this._webrtcFailedCams.clear();
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

    const browse = (id) => conn.sendMessagePromise({
      type: 'media_source/browse_media',
      media_content_id: id,
    });

    // Try to browse first — if it has children, treat as folder
    try {
      const root = await browse(mediaId);
      const children = (root && root.children) || [];
      if (children.length > 0) {
        const items = [];
        let queue = []; // folders to browse at the next depth level
        const collect = (kids) => {
          for (const child of kids) {
            if (child.can_play && !child.can_expand) {
              if (items.length < PLAYLIST_MAX_ITEMS) items.push(child.media_content_id);
            } else if (this._mediaRecursive && child.can_expand) {
              queue.push(child.media_content_id);
            }
          }
        };
        collect(children);

        // Breadth-first descent into subfolders, a few browses in
        // flight at a time, bounded by the PLAYLIST_* caps.
        let browsed = 0;
        let depth = 1;
        while (queue.length > 0 && depth <= PLAYLIST_MAX_DEPTH
               && browsed < PLAYLIST_MAX_FOLDERS && items.length < PLAYLIST_MAX_ITEMS) {
          const level = queue;
          queue = [];
          while (level.length > 0
                 && browsed < PLAYLIST_MAX_FOLDERS && items.length < PLAYLIST_MAX_ITEMS) {
            const batch = level.splice(0, PLAYLIST_BROWSE_CONCURRENCY);
            browsed += batch.length;
            const results = await Promise.all(
              batch.map((id) => browse(id).catch(() => null)),
            );
            for (const res of results) {
              collect((res && res.children) || []);
            }
          }
          depth += 1;
        }

        if (this._mediaRecursive) {
          const capped = queue.length > 0 || items.length >= PLAYLIST_MAX_ITEMS;
          this._log.log(
            'screensaver',
            `Recursive playlist: ${items.length} item(s) from ${browsed + 1} folder(s)`
            + (capped ? ' (capped - library exceeds playlist limits)' : ''),
          );
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

    // Close any WebRTC camera stream from the previous playlist item
    // before rendering the next one (the old <video> keeps its last
    // frame for the cross-fade).
    this._stopCameraWebrtc();

    const itemId = this._playlist[this._playlistIdx];
    let url = '';
    let mime = '';

    // Camera entities selected via the media browser come back as
    // media-source://camera/camera.xxx.  Try WebRTC first (sub-second
    // latency via HA signaling); cameras without a WebRTC provider (or
    // with a failed negotiation) use the MJPEG proxy stream, which is
    // universal and works inside <img>.
    const cameraEid = getCameraEntityFromMediaId(itemId);
    if (cameraEid) {
      if (await this._tryCameraWebrtc(cameraEid)) return;
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
    const baseStyles = MEDIA_BASE_STYLES;

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
   * Play a camera playlist item over WebRTC (HA signaling, shared
   * client in src/shared/camera-webrtc.js).  Returns true when the
   * WebRTC path is handling the item; false to fall through to the
   * MJPEG proxy path.  A camera whose negotiation fails mid-stream is
   * remembered in _webrtcFailedCams and re-rendered via MJPEG.
   */
  async _tryCameraWebrtc(cameraEid) {
    const conn = this._session.connection;
    if (!conn || this._webrtcFailedCams.has(cameraEid)) return false;

    let supported = false;
    try {
      supported = await cameraSupportsWebrtc(conn, cameraEid);
    } catch (e) {
      this._log.log('screensaver', `Camera capability check failed: ${e?.message || e}`);
      return false;
    }
    if (!supported) {
      this._log.log('screensaver', `Camera ${cameraEid} has no WebRTC support - using MJPEG`);
      return false;
    }
    // Dismissed while awaiting the capability check - claim the item as
    // handled so the caller doesn't render a stale MJPEG stream.
    if (!this._active || !this._contentEl) return true;

    this._log.log('screensaver', `Camera ${cameraEid} via WebRTC`);
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = MEDIA_BASE_STYLES;
    video.addEventListener('loadeddata', () => this._fadeInAndSweep(video), { once: true });

    const idx = this._playlistIdx;
    this._cameraWebrtc = attachCameraWebrtc({
      conn,
      entityId: cameraEid,
      video,
      log: (m) => this._log.log('screensaver', m),
      onError: (e) => {
        this._log.log(
          'screensaver',
          `Camera WebRTC failed for ${cameraEid}: ${e?.message || e} - falling back to MJPEG`,
        );
        this._stopCameraWebrtc();
        this._webrtcFailedCams.add(cameraEid);
        // Re-render the same item through the MJPEG path if it's still
        // the one on screen.
        if (this._active && this._playlistIdx === idx) this._playCurrentItem();
      },
    });
    this._contentEl.appendChild(video);

    if (this._playlist.length > 1) {
      this._scheduleNextMediaCycle();
    }
    return true;
  }

  _stopCameraWebrtc() {
    if (this._cameraWebrtc) {
      this._cameraWebrtc.close();
      this._cameraWebrtc = null;
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

  /**
   * OLED burn-in protection: once a minute, drift the content div to a
   * new random offset near center.  The black overlay backdrop fills
   * the exposed edges, so this works for every type as one unit (clock
   * plus date, media, website iframe).  No-op for the black type -
   * those pixels are already off.
   */
  _startPixelShift() {
    this._stopPixelShift();
    if (!this._pixelShift || this._type === 'black') return;
    if (!this._contentEl) return;
    this._contentEl.style.transition = 'transform 2s ease';
    this._pixelShiftTimer = setInterval(() => {
      if (!this._active || !this._contentEl) return;
      const maxX = Math.min(24, Math.round(window.innerWidth * 0.015));
      const maxY = Math.min(24, Math.round(window.innerHeight * 0.015));
      const x = Math.round((Math.random() * 2 - 1) * maxX);
      const y = Math.round((Math.random() * 2 - 1) * maxY);
      this._contentEl.style.transform = `translate(${x}px, ${y}px)`;
    }, PIXEL_SHIFT_INTERVAL_MS);
  }

  _stopPixelShift() {
    if (this._pixelShiftTimer) {
      clearInterval(this._pixelShiftTimer);
      this._pixelShiftTimer = null;
    }
    if (this._contentEl) {
      this._contentEl.style.transform = '';
      this._contentEl.style.transition = '';
    }
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
    // Motion detection is Fully-Kiosk-only; Kiosker exposes no motion
    // event, so this is a no-op there.
    if (this._fkMotionBound || !kiosk.supportsMotion()) return;
    // Motion counts as activity in both states: it dismisses an active
    // screensaver AND defers activation while someone is moving in
    // front of the camera - otherwise the idle timer expires mid-motion
    // and the screensaver flashes for a second before the next motion
    // event dismisses it again (#93).
    window.__vsOnFkMotion = () => {
      this._log.log(
        'screensaver',
        this._active
          ? 'FK motion detected -- dismissing'
          : 'FK motion detected -- resetting idle timer',
      );
      this.notifyActivity();
    };
    if (kiosk.bindMotion('__vsOnFkMotion')) {
      this._fkMotionBound = true;
      this._log.log('screensaver', 'FK motion detection bound');
    } else {
      delete window.__vsOnFkMotion;
      this._log.log('screensaver', 'Failed to bind FK motion');
    }
  }

  _unbindFkMotion() {
    if (!this._fkMotionBound) return;
    kiosk.unbindMotion();
    delete window.__vsOnFkMotion;
    this._fkMotionBound = false;
  }

  _setupUnloadHandler() {
    if (this._unloadHandler) return;
    this._unloadHandler = () => {
      if (this._savedBrightness !== null) {
        kiosk.setBrightness(this._savedBrightness);
      }
    };
    window.addEventListener('beforeunload', this._unloadHandler);
  }

  _removeUnloadHandler() {
    if (!this._unloadHandler) return;
    window.removeEventListener('beforeunload', this._unloadHandler);
    this._unloadHandler = null;
  }

  async _dimScreen() {
    // Only kiosk browsers expose a hardware-backlight API (Fully Kiosk on
    // Android, Kiosker Pro on iOS).  Other browsers just ignore the dim
    // setting.  Null (no value stored) and 100% (max) both mean "leave
    // the current brightness alone" so we don't clobber the user's
    // existing brightness.  Brightness is normalised to 0..1 here.
    if (!kiosk.isAvailable()) return;
    if (this._dimPercent === null || this._dimPercent >= 100) return;
    try {
      const saved = await kiosk.getBrightness();
      // Guard against a stale write: the screensaver may have been
      // dismissed (and brightness already restored) while we awaited the
      // async read on Kiosker.
      if (!this._active) return;
      this._savedBrightness = saved;
      const target = Math.min(1, Math.max(0, this._dimPercent / 100));
      kiosk.setBrightness(target);
      this._log.log(
        'screensaver',
        `Screen dimmed to ${Math.round(target * 100)}% (saved: ${
          saved === null ? 'n/a' : `${Math.round(saved * 100)}%`})`,
      );
    } catch (e) {
      this._log.log('screensaver', `Failed to dim screen: ${e.message || e}`);
    }
  }

  _restoreScreen() {
    if (this._savedBrightness === null) return;
    try {
      kiosk.setBrightness(this._savedBrightness);
      this._log.log(
        'screensaver',
        `Screen brightness restored to ${Math.round(this._savedBrightness * 100)}%`,
      );
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
        // The overlay lives in document.body, outside the skin CSS scope
        // that defines our shipped fonts, so register Google Sans here at
        // the document level for the digital-clock screensaver to use.
        "@font-face {",
        "  font-family: 'Google Sans';",
        '  font-style: normal;',
        '  font-weight: 400 700;',
        '  font-display: swap;',
        "  src: url('/voice_satellite/fonts/google-sans-latin-ext.woff2') format('woff2');",
        '  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;',
        '}',
        "@font-face {",
        "  font-family: 'Google Sans';",
        '  font-style: normal;',
        '  font-weight: 400 700;',
        '  font-display: swap;',
        "  src: url('/voice_satellite/fonts/google-sans-latin.woff2') format('woff2');",
        '  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;',
        '}',
        `#${OVERLAY_ID} {`,
        '  position: fixed;',
        // Longhand offsets: `inset` needs Chromium 87+, and old kiosk
        // WebViews otherwise collapse the overlay to a 0x0 box (#94).
        '  top: 0; left: 0; right: 0; bottom: 0;',
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
        '  top: 0; left: 0; right: 0; bottom: 0;',
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
