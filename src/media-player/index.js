/**
 * MediaPlayerManager
 *
 * Handles media_player commands pushed from the integration via the
 * satellite event subscription.  Plays audio in the browser, reports
 * state back via a WS command so the HA entity stays in sync.
 *
 * Camera entities play over WebRTC (negotiated via camera/webrtc/offer
 * on the HA websocket, sub-second latency) with automatic fallback to
 * the resolved HLS / MJPEG URL for cameras without a WebRTC provider.
 *
 * Also acts as the unified audio-state reporter: TTS, chimes, and
 * notification playback call notifyAudioStart/End so the HA
 * media_player entity reflects *all* audio output (matching Voice PE).
 */

import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';
import { attachDoubleTap } from '../shared/double-tap.js';
import { cameraSupportsWebrtc, attachCameraWebrtc } from '../shared/camera-webrtc.js';
import { Timing } from '../constants.js';
import * as kiosk from '../kiosk/index.js';

let hlsLoaderPromise = null;

function loadHlsLight() {
  const existing = globalThis.Hls;
  if (existing) return Promise.resolve(existing);
  if (hlsLoaderPromise) return hlsLoaderPromise;

  hlsLoaderPromise = new Promise((resolve, reject) => {
    const src = `/voice_satellite/vendor/hls.light.min.js?v=${__VERSION__}`;
    const existingScript = document.querySelector(`script[data-vs-hls="${__VERSION__}"]`);
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(globalThis.Hls), { once: true });
      existingScript.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.vsHls = __VERSION__;
    script.onload = () => {
      if (globalThis.Hls) resolve(globalThis.Hls);
      else reject(new Error('hls.js loaded but window.Hls was not defined'));
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });

  return hlsLoaderPromise;
}

export class MediaPlayerManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._audio = null;
    this._videoOverlay = null;
    this._isLive = false;
    this._playing = false;
    this._paused = false;
    this._volume = 1.0;
    this._muted = false;
    this._mediaId = null;
    this._volumeSynced = false;
    // Set when interrupt() pauses for a voice interaction or notification.
    // resumeAfterInterrupt() consumes it. Cleared on user-initiated stop/play
    // so a manual stop is never silently undone later.
    this._interruptedForResume = false;

    // Unified audio-state tracking (TTS, chimes, notifications)
    this._activeSources = new Set();
    this._idleDebounce = null;

    // Keeps the in-app screensaver from re-activating mid-playback.
    // Started when a video/image overlay is shown, stopped on cleanup.
    this._screensaverKeepaliveTimer = null;

    // WebRTC camera playback state
    this._webrtcHandle = null;
    this._cameraFallbackTried = false;

    // True while the current playback shows a fullscreen overlay
    // (video / camera / image). Gates whether the stop word is armed:
    // visual playback uses stop-only mode, audio-only keeps the wake word.
    this._currentIsVisual = false;
  }

  get isPlaying() { return this._playing; }

  /**
   * Effective volume with perceptual curve (volume²).
   * Syncs from the HA entity on first access after page load.
   */
  get volume() {
    this._syncInitialVolume();
    return this._muted ? 0 : this._volume * this._volume;
  }
  /**
   * Notify that an audio source has started playing.
   * @param {string} source - e.g. 'tts', 'chime', 'notification'
   */
  notifyAudioStart(source) {
    if (this._idleDebounce) {
      clearTimeout(this._idleDebounce);
      this._idleDebounce = null;
    }
    this._activeSources.add(source);
    this._reportState('playing');
  }

  /**
   * Notify that an audio source has stopped playing.
   * Reports idle (debounced) when no audio remains active.
   * @param {string} source
   */
  notifyAudioEnd(source) {
    this._activeSources.delete(source);
    if (this._activeSources.size === 0 && !this._playing && !this._paused) {
      if (this._idleDebounce) clearTimeout(this._idleDebounce);
      this._idleDebounce = setTimeout(() => {
        this._idleDebounce = null;
        if (this._activeSources.size === 0 && !this._playing && !this._paused) {
          this._reportState('idle');
        }
      }, Timing.IDLE_DEBOUNCE);
    }
  }
  /**
   * Handle a command from the integration (via satellite subscription).
   * @param {object} data - {command, ...fields}
   */
  handleCommand(data) {
    const { command } = data;
    this._log.log('media-player', `Command: ${command}`);

    switch (command) {
      case 'play':
        this._play(data);
        break;
      case 'pause':
        this._pause();
        break;
      case 'resume':
        this._resume();
        break;
      case 'stop':
        this._stop();
        break;
      case 'volume_set':
        this._setVolume(data.volume);
        break;
      case 'volume_mute':
        this._setMute(data.mute);
        break;
      default:
        this._log.log('media-player', `Unknown command: ${command}`);
    }
  }

  /**
   * Interrupt own playback (e.g. wake word barge-in, notification).
   * Pauses the audio element rather than tearing it down so the
   * subsequent resumeAfterInterrupt() can pick up from the same
   * position. Reports 'paused' (not 'idle') so HA keeps
   * media_content_id and user automations can distinguish a
   * voice-interaction duck from a real stop.
   * Does NOT affect external audio sources - they manage themselves.
   */
  interrupt() {
    if (!this._audio || !this._playing) return;
    this._log.log('media-player', 'Interrupted (paused for resume)');
    this._audio.pause();
    if (this._videoOverlay) this._videoOverlay.style.display = 'none';
    this._playing = false;
    this._paused = true;
    this._interruptedForResume = true;
    // Hand stop-word ownership over to the wake/TTS/notification flow that
    // is about to take control. resumeAfterInterrupt() re-arms when we
    // come back to plain media playback.
    this._disarmStopWord();
    this._reportState('paused');
  }

  /**
   * Resume playback that was paused by interrupt().  No-op unless
   * we were the ones who paused. Called at the end of every path
   * that returns the satellite to true idle (TTS-complete cleanup,
   * pipeline errors that go back to IDLE, notification end).
   */
  resumeAfterInterrupt() {
    if (!this._interruptedForResume) return;
    this._interruptedForResume = false;
    if (!this._audio || !this._paused) return;
    this._log.log('media-player', 'Resuming after interrupt');
    if (this._videoOverlay) this._videoOverlay.style.display = 'flex';
    this._playing = true;
    this._paused = false;
    this._audio.play().then(() => {
      if (this._isLive) this._seekToLive();
      this._reportState('playing');
      this._armStopWord();
    }).catch((e) => {
      this._log.error('media-player', `Resume failed: ${e}`);
      this._cleanup();
      if (this._activeSources.size === 0) {
        this._reportState('idle');
      }
    });
  }

  /**
   * Jump an HLS stream to the current live edge. hls.js exposes a
   * `liveSyncPosition` for streams it knows are live; for native HLS
   * (Safari fallback), the seekable range's end is the closest equivalent.
   */
  _seekToLive() {
    const v = this._audio;
    if (!v) return;
    if (this._hls && typeof this._hls.liveSyncPosition === 'number') {
      const target = this._hls.liveSyncPosition;
      this._log.log('media-player', `HLS seek to liveSyncPosition=${target.toFixed(2)}`);
      v.currentTime = target;
      return;
    }
    if (v.seekable && v.seekable.length > 0) {
      const target = v.seekable.end(v.seekable.length - 1);
      this._log.log('media-player', `HLS seek to seekable end=${target.toFixed(2)}`);
      v.currentTime = target;
    }
  }
  /**
   * Public stop entry point so the wake-word "stop" handler can stop
   * media playback the same way HA's media_stop service would.
   */
  stop() {
    this._stop();
  }

  /**
   * Re-arm the stop keyword if we should currently be listening for it.
   * Called from paths that disable the stop model for their own reasons
   * (timer dismiss, _onStopDetection top) so media keeps a stop-listener
   * even after one of those paths cleared it.
   */
  refreshStopWord() {
    if (this._playing) this._armStopWord();
  }

  /**
   * Arm the stop keyword for the current playback - but ONLY for visual
   * media (video / camera / image), which puts a fullscreen overlay on
   * screen that "stop" is the natural way to dismiss.
   *
   * Arming stop puts the engine in stop-only mode, which pauses wake-word
   * inference (slower tablets can't run wake + stop simultaneously). For
   * audio-only playback (e.g. Music Assistant) that's the wrong trade:
   * there's nothing on screen to dismiss, and the user is more likely to
   * want to wake the assistant (to pause/adjust by voice) than to say
   * "stop". So for audio-only we leave the wake word running and do not
   * arm stop - never both at once, but the right one for the context.
   */
  _armStopWord() {
    if (!this._currentIsVisual) {
      this._log.log(
        'media-player',
        'Audio-only playback - keeping wake word active, NOT arming stop word',
      );
      return;
    }
    this._log.log(
      'media-player',
      'Visual playback - arming stop word (wake-word inference pauses)',
    );
    this._card.wakeWord?.enableStopModel(false);
  }

  /**
   * Disarm the stop keyword. Idempotent.
   *
   * Safe to call even when TTS / a notification has set stop-only mode:
   * disableStopModel restores any suspended wake words. We only call
   * this from paths that own the current stop-word state (play start /
   * end, our own interrupt() / resumeAfterInterrupt()).
   */
  _disarmStopWord() {
    this._card.wakeWord?.disableStopModel();
  }

  /** Apply perceptual curve to raw volume (0-1). */
  _curved(raw) {
    return raw * raw;
  }

  /** Effective volume after mute + curve. */
  _effectiveVolume() {
    return this._muted ? 0 : this._curved(this._volume);
  }

  /**
   * Sync volume and mute state from the HA entity on first access.
   * Runs once per page load so the card picks up the entity's current state.
   */
  _syncInitialVolume() {
    if (this._volumeSynced) return;
    const entityId = this._getEntityId();
    if (!entityId) return;
    const state = this._card.hass?.states?.[entityId];
    if (!state) return;

    const vol = state.attributes?.volume_level;
    if (vol !== undefined && vol !== null) {
      this._volume = vol;
      this._log.log('media-player', `Synced initial volume from entity: ${vol}`);
    }
    const muted = state.attributes?.is_volume_muted;
    if (muted !== undefined) {
      this._muted = muted;
    }
    this._volumeSynced = true;
  }

  async _play(data) {
    // Stop any current playback
    this._cleanup();
    this._interruptedForResume = false;

    const { media_id, media_type, volume, announce, proxy_url } = data;
    this._log.log(
      'media-player',
      `_play received: media_id=${media_id} media_type=${media_type} volume=${volume} announce=${announce}`,
    );

    if (volume !== undefined && volume !== null) {
      this._volume = volume;
    }

    this._mediaId = media_id;

    const mt = typeof media_type === 'string' ? media_type.toLowerCase() : '';
    // Camera entities arrive unresolved (media_id = camera.xxx) so we can
    // negotiate WebRTC over the authenticated HA websocket. Falls back to
    // the resolved HLS / MJPEG URL inside _attachWebrtc when the camera
    // has no WebRTC provider.
    const isCamera = mt === 'camera'
      && typeof media_id === 'string' && media_id.startsWith('camera.');
    const isHls = mt === 'application/vnd.apple.mpegurl'
      || mt === 'application/x-mpegurl'
      || (typeof media_id === 'string' && media_id.toLowerCase().split('?')[0].endsWith('.m3u8'));
    // Cameras without HLS support fall through to image/jpeg or
    // multipart/x-mixed-replace served via /api/camera_proxy_stream as
    // continuous MJPEG. Render those in <img>; <video> won't accept them.
    const isImage = mt.startsWith('image/') || mt.startsWith('multipart/x-mixed-replace');
    const isVideo = mt.startsWith('video/') || mt === 'video' || isHls;
    // Visual playback (overlay on screen) arms the stop word; audio-only
    // keeps the wake word running instead. See _armStopWord().
    this._currentIsVisual = isCamera || isVideo || isImage;
    this._log.log(
      'media-player',
      `Detection: isCamera=${isCamera} isVideo=${isVideo} isHls=${isHls} isImage=${isImage} visual=${this._currentIsVisual} (mime="${mt}")`,
    );

    // Sign relative URLs - HA media endpoints require authentication.
    // HLS stream URLs from HA's stream integration are already path-token
    // signed by `_async_stream_endpoint_url`, so signing them again would
    // either be redundant or rewrite the path. Use them directly.
    // The integration offers proxy_url for HTTP-only sources (e.g. Music
    // Assistant). It's only needed to dodge mixed-content blocking, which
    // only happens when THIS page is HTTPS - so decide here, where we
    // know our own scheme. On an all-HTTP setup we play the direct URL
    // and skip the needless relay through HA.
    const pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:';
    const useProxy = !!proxy_url && pageIsHttps;

    let url;
    if (isCamera) {
      url = null; // no URL - WebRTC negotiates over the WS connection
      this._log.log('media-player', `URL path: camera entity (WebRTC). entity=${media_id}`);
    } else if (useProxy) {
      // Same-origin proxy path - resolve against our HTTPS origin, no signing.
      url = buildMediaUrl(proxy_url);
      this._log.log('media-player', `URL path: same-origin media proxy (mixed-content avoidance). url=${url}`);
    } else if (media_id.startsWith('http://') || media_id.startsWith('https://')) {
      url = media_id;
      this._log.log('media-player', `URL path: absolute (no signing). url=${url}`);
    } else if (isHls) {
      url = buildMediaUrl(media_id);
      this._log.log('media-player', `URL path: HLS direct (skip signing). url=${url}`);
    } else {
      const conn = this._card.connection;
      if (conn) {
        try {
          const result = await conn.sendMessagePromise({
            type: 'auth/sign_path',
            path: media_id,
            expires: Timing.AUTH_SIGN_EXPIRES,
          });
          url = buildMediaUrl(result.path);
          this._log.log('media-player', `URL path: signed. url=${url}`);
        } catch (e) {
          this._log.error('media-player', `Failed to sign URL: ${e}`);
          url = buildMediaUrl(media_id);
          this._log.log('media-player', `URL path: sign failed, falling back. url=${url}`);
        }
      } else {
        url = buildMediaUrl(media_id);
        this._log.log('media-player', `URL path: no connection, raw build. url=${url}`);
      }
    }

    this._playing = true;
    this._paused = false;

    const callbacks = {
      onEnd: () => {
        this._log.log('media-player', 'Playback complete');
        this._removeVideoOverlay();
        this._playing = false;
        this._paused = false;
        this._audio = null;
        this._disarmStopWord();
        if (this._activeSources.size === 0) {
          this._reportState('idle');
        }
      },
      onError: (e) => {
        this._log.error('media-player', `Playback error: ${e}`);
        this._removeVideoOverlay();
        this._playing = false;
        this._paused = false;
        this._audio = null;
        this._disarmStopWord();
        if (this._activeSources.size === 0) {
          this._reportState('idle');
        }
      },
      onStart: () => {
        this._log.log('media-player', `Playing: ${media_id}`);
        this._reportState('playing');
        this._armStopWord();
      },
    };

    // HLS camera streams buffer ahead, so resume after a wake-word
    // interrupt should jump to the live edge - otherwise the user watches
    // tens of seconds of stale footage. MJPEG doesn't buffer (each
    // reconnect shows the live frame) and WebRTC resumes at the live edge
    // by nature, so neither needs this.
    this._isLive = isHls;

    const dispatch = isCamera
      ? 'webrtc camera overlay'
      : (isImage ? 'image overlay' : (isVideo ? 'video overlay' : 'audio element'));
    this._log.log(
      'media-player',
      `Dispatch: ${dispatch} (effectiveVolume=${this._effectiveVolume().toFixed(3)})`,
    );
    if (isCamera) {
      this._cameraFallbackTried = false;
      this._audio = this._playVideo(null, this._effectiveVolume(), callbacks, { webrtcEntity: media_id });
    } else if (isImage) {
      this._audio = this._playImage(url, callbacks);
    } else if (isVideo) {
      this._audio = this._playVideo(url, this._effectiveVolume(), callbacks, { isHls });
    } else {
      this._audio = playMediaUrl(url, this._effectiveVolume(), callbacks);
    }

    // Visual overlays must dismiss the screensaver and prevent it from
    // re-activating mid-playback - audio-only playback doesn't need this
    // since it doesn't put anything on screen.
    if (isCamera || isVideo || isImage) {
      this._card.screensaver?.dismiss();
      this._startScreensaverKeepalive();
    }
  }

  /**
   * Keep the in-app screensaver (and Fully Kiosk's native one) from
   * re-activating during a long video or camera stream. The 4s ping
   * sits a safe margin under the minimum allowed in-app screensaver
   * timer (10s, clamped in the screensaver manager) so the idle timer
   * never expires; the same callback also calls FK's stopScreensaver
   * via the JS Interface when running inside Fully Kiosk, so the
   * external screensaver gets dismissed within 4s of activation
   * regardless of whether the user has the screensaver_suppress_external
   * switch configured. Both are no-ops when not applicable.
   */
  _startScreensaverKeepalive() {
    this._stopScreensaverKeepalive();
    this._log.log('media-player', 'Screensaver keepalive started (4s ping)');
    // Fire once immediately so FK's screensaver doesn't get up to 4s of
    // visibility before the first interval tick.
    this._screensaverKeepalivePing();
    this._screensaverKeepaliveTimer = setInterval(
      () => this._screensaverKeepalivePing(),
      4000,
    );
  }

  _screensaverKeepalivePing() {
    this._card.screensaver?.notifyActivity();
    // Suppress the kiosk browser's own screensaver (FK one-shot stop /
    // Kiosker pause) so it can't cover the media overlay.
    kiosk.stopScreensaver('media');
  }

  _stopScreensaverKeepalive() {
    if (this._screensaverKeepaliveTimer) {
      this._log.log('media-player', 'Screensaver keepalive stopped');
      clearInterval(this._screensaverKeepaliveTimer);
      this._screensaverKeepaliveTimer = null;
      // Re-enable the kiosk screensaver if we paused it (Kiosker only;
      // no-op on Fully Kiosk, which resumes on its own idle schedule).
      kiosk.releaseScreensaver('media');
    }
  }

  /**
   * Render a fullscreen video overlay and start playback.
   * Double-tap dismisses (mirroring the rest of the card's cancel UX).
   * Returns the <video> element so the existing pause/resume/volume
   * paths in this manager work unchanged (HTMLVideoElement shares the
   * Audio API surface they touch).
   *
   * For HLS streams, hls.js is dynamically imported and attached so
   * Chromium-based browsers (which lack native HLS) can play camera
   * feeds. Safari/iOS use native HLS via direct src.
   *
   * For camera entities (webrtcEntity set), the stream is negotiated
   * over the HA websocket via camera/webrtc/offer and attached as a
   * MediaStream - url is unused.
   */
  _playVideo(url, volume, { onEnd, onError, onStart }, { isHls = false, webrtcEntity = null } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'vs-video-overlay';
    overlay.style.cssText = [
      'position: fixed;',
      'inset: 0;',
      'background: #000;',
      'z-index: 99999;',
      'display: flex;',
      'align-items: center;',
      'justify-content: center;',
    ].join(' ');

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = 'max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain;';
    video.volume = volume;

    video.onended = () => onEnd();
    video.onerror = (e) => onError(e);

    // Double-tap on the overlay (but not the video controls) stops playback.
    // Listening on the overlay container lets the native controls bar still
    // receive single taps for play/pause/seek/etc.
    attachDoubleTap(overlay, () => this._stop());

    overlay.appendChild(video);
    document.body.appendChild(overlay);
    this._videoOverlay = overlay;

    this._log.log(
      'media-player',
      `Video overlay created. claims_native_hls=${!!video.canPlayType('application/vnd.apple.mpegurl')}`,
    );

    if (webrtcEntity) {
      this._log.log('media-player', `Routing camera via WebRTC. entity=${webrtcEntity}`);
      this._attachWebrtc(video, webrtcEntity, onStart, onError);
    } else if (isHls) {
      // Prefer hls.js for HLS — Chromium browsers (including Fully Kiosk
      // on Android) often claim native HLS support via canPlayType but
      // fail at runtime with NotSupportedError. hls.js handles this
      // reliably on any browser with MSE. Safari falls through to native
      // inside _attachHls when MSE isn't available.
      this._log.log('media-player', `Routing HLS via hls.js. url=${url}`);
      this._attachHls(video, url, onStart, onError);
    } else {
      this._log.log('media-player', `Routing video via native <video>. url=${url}`);
      video.src = url;
      video.play().then(() => {
        onStart?.();
      }).catch((e) => {
        onError(e);
      });
    }

    return video;
  }

  /**
   * Render a fullscreen image overlay for MJPEG / snapshot cameras.
   * Browsers display multipart/x-mixed-replace responses natively as a
   * continuously updating <img>; <video> won't accept them.
   *
   * Returns a small shim object that mimics the HTMLMediaElement API the
   * rest of this manager touches (pause/play/volume/src/onerror) so the
   * existing pause / resume / cleanup paths keep working uniformly.
   * pause() actually clears the img src to release the connection so
   * wake-word interrupts don't keep the stream open in the background.
   */
  _playImage(url, { onEnd: _onEnd, onError, onStart }) {
    const overlay = document.createElement('div');
    overlay.className = 'vs-video-overlay';
    overlay.style.cssText = [
      'position: fixed;',
      'inset: 0;',
      'background: #000;',
      'z-index: 99999;',
      'display: flex;',
      'align-items: center;',
      'justify-content: center;',
    ].join(' ');

    const img = document.createElement('img');
    img.style.cssText = 'max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain;';
    img.alt = '';

    img.onload = () => {
      onStart?.();
    };
    img.onerror = (e) => {
      onError(e);
    };

    attachDoubleTap(overlay, () => this._stop());

    overlay.appendChild(img);
    document.body.appendChild(overlay);
    this._videoOverlay = overlay;

    img.src = url;

    let savedUrl = url;
    let isPaused = false;
    return {
      pause() {
        if (!isPaused && img.src) {
          savedUrl = img.src;
          img.src = '';
          isPaused = true;
        }
      },
      play() {
        if (isPaused) {
          img.src = savedUrl;
          isPaused = false;
        }
        return Promise.resolve();
      },
      get volume() { return 0; },
      set volume(_v) { /* no audio for MJPEG */ },
      get src() { return img.src; },
      set src(v) { savedUrl = v; img.src = v; },
      set onerror(fn) { img.onerror = fn; },
      set onended(_fn) { /* MJPEG never ends */ },
    };
  }

  async _attachHls(video, url, onStart, onError) {
    const t0 = performance.now();
    try {
      const Hls = await loadHlsLight();

      // If a second _play() call ran _cleanup() before HLS attach starts,
      // abandon silently so we don't leak a parallel hls.js instance
      // attached to a discarded <video>.
      if (this._audio !== video) {
        this._log.log(
          'media-player',
          'hls.js attach skipped: superseded by a newer _play',
        );
        return;
      }

      const supported = Hls.isSupported();
      this._log.log(
        'media-player',
        `hls.js loaded in ${(performance.now() - t0).toFixed(0)}ms (version=${Hls.version}, supported=${supported})`,
      );

      if (!supported) {
        // No MSE - the only path left is native HLS (Safari).
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          this._log.log('media-player', `MSE unavailable, using native HLS. url=${url}`);
          video.src = url;
          video.play().then(() => onStart?.()).catch(onError);
        } else {
          const err = new Error('Browser supports neither MSE nor native HLS');
          this._log.error('media-player', err.message);
          onError(err);
        }
        return;
      }

      // Live-latency tuning. HA's stream integration emits 2s segments and
      // by default tells the player to start ~3s behind live - on top of
      // hls.js's own default 3-segment buffer, that's typically 6-10s of
      // lag. The settings below pull playback closer to the live edge:
      //
      //   - lowLatencyMode: enable LL-HLS support when HA serves it (HA
      //     yaml: `stream: { ll_hls: true, part_duration: 0.5 }`). No-op
      //     on regular HLS streams.
      //   - liveSyncDuration: target lag from live in seconds. 2 is a
      //     conservative floor for non-LL-HLS over LAN.
      //   - liveMaxLatencyDuration: if we fall more than this far behind,
      //     hls.js seeks forward to catch up rather than playing through.
      //   - backBufferLength: only keep a few seconds of past content in
      //     the buffer (default is unbounded), reduces memory pressure on
      //     long camera streams.
      //   - maxLiveSyncPlaybackRate: when behind live, speed up to 1.5x
      //     to catch up smoothly. LL-HLS only; ignored otherwise.
      const hls = new Hls({
        lowLatencyMode: true,
        liveSyncDuration: 2,
        liveMaxLatencyDuration: 5,
        backBufferLength: 4,
        maxLiveSyncPlaybackRate: 1.5,
      });
      this._hls = hls;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        const level = data.fatal ? 'error' : 'log';
        this._log[level](
          'media-player',
          `HLS ${data.fatal ? 'fatal' : 'non-fatal'} error: type=${data.type} details=${data.details}`,
        );
        if (data.fatal) onError(data);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        this._log.log(
          'media-player',
          `HLS manifest parsed: levels=${data.levels?.length ?? '?'} configuredLowLatency=${hls.config.lowLatencyMode}`,
        );
        video.play().then(() => onStart?.()).catch(onError);
      });

      // Confirm whether the server is actually serving LL-HLS parts (the
      // `lowLatencyMode` config is just our request - the level details
      // tell us what HA is delivering). Log once on first level load.
      let levelLoadedLogged = false;
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
        if (levelLoadedLogged) return;
        levelLoadedLogged = true;
        const d = data?.details;
        const partCount = d?.partList?.length ?? 0;
        const llHlsActive = partCount > 0;
        this._log.log(
          'media-player',
          `HLS level loaded: live=${!!d?.live} ll-hls-active=${llHlsActive}`
            + ` partCount=${partCount} partTarget=${d?.partTarget ?? 'n/a'}s`
            + ` targetduration=${d?.targetduration ?? '?'}s`
            + ` totalduration=${d?.totalduration?.toFixed(2) ?? '?'}s`,
        );
      });
      this._log.log('media-player', `hls.loadSource: ${url}`);
      hls.loadSource(url);
      hls.attachMedia(video);
    } catch (e) {
      this._log.error('media-player', `Failed to load hls.js: ${e}`);
      onError(e);
    }
  }

  _destroyHls() {
    if (this._hls) {
      this._log.log('media-player', 'Destroying hls.js instance');
      try { this._hls.destroy(); } catch (_e) { /* best effort */ }
      this._hls = null;
    }
  }

  /**
   * Negotiate a WebRTC stream for a camera entity over the HA websocket
   * (shared client in src/shared/camera-webrtc.js) and attach it to the
   * <video>.  Cameras without a WebRTC provider (or failed negotiations
   * before first frame) fall back to the classic resolved HLS / MJPEG
   * URL via _fallbackCameraStream.
   */
  async _attachWebrtc(video, entityId, onStart, onError) {
    const conn = this._card.connection;
    if (!conn) {
      onError(new Error('No HA connection for WebRTC'));
      return;
    }

    // Fired for both negotiation errors and error events from HA. Falls
    // back to HLS/MJPEG once if the stream never started; reports a real
    // playback error otherwise.
    let started = false;
    const fail = (err) => {
      if (this._audio !== video) return; // superseded by a newer _play
      if (!started && !this._cameraFallbackTried) {
        this._cameraFallbackTried = true;
        this._log.log(
          'media-player',
          `WebRTC failed (${err?.message || err}) - falling back to HLS/MJPEG`,
        );
        this._fallbackCameraStream(entityId);
      } else {
        onError(err);
      }
    };

    // Show an instant snapshot while waiting for the first decodable
    // keyframe. WebRTC relays the camera stream without transcoding, so
    // a new viewer can't render until the camera's next IDR frame -
    // UniFi Protect emits one every ~4s, leaving a black screen without
    // this. The poster clears automatically when the stream renders.
    conn.sendMessagePromise({
      type: 'auth/sign_path',
      path: `/api/camera_proxy/${entityId}`,
      expires: Timing.AUTH_SIGN_EXPIRES,
    }).then((res) => {
      if (this._audio === video && res?.path && !video.srcObject) {
        video.poster = buildMediaUrl(res.path);
      }
    }).catch(() => { /* no snapshot - black screen until first frame */ });

    // Capability check - cameras without a WebRTC provider go straight
    // to the classic resolved-URL path.
    try {
      const supported = await cameraSupportsWebrtc(conn, entityId);
      if (this._audio !== video) return;
      if (!supported) {
        this._log.log('media-player', `Camera ${entityId} has no WebRTC support`);
        fail(new Error('WebRTC not supported by camera'));
        return;
      }
    } catch (e) {
      fail(e);
      return;
    }

    video.addEventListener('loadeddata', () => {
      if (this._audio !== video) return;
      video.play().then(() => {
        started = true;
        this._log.log('media-player', `WebRTC stream playing. entity=${entityId}`);
        onStart?.();
      }).catch((e) => fail(e));
    }, { once: true });

    this._webrtcHandle = attachCameraWebrtc({
      conn,
      entityId,
      video,
      log: (m) => this._log.log('media-player', m),
      onError: fail,
    });
  }

  /**
   * Classic camera playback path: resolve the camera media source to its
   * HLS or MJPEG URL (same thing the integration used to push before the
   * WebRTC path existed) and re-dispatch through _play.
   */
  async _fallbackCameraStream(entityId) {
    const conn = this._card.connection;
    if (!conn) return;
    try {
      const res = await conn.sendMessagePromise({
        type: 'media_source/resolve_media',
        media_content_id: `media-source://camera/${entityId}`,
      });
      this._log.log(
        'media-player',
        `Camera fallback resolved: url=${res?.url} mime=${res?.mime_type}`,
      );
      this._play({ media_id: res.url, media_type: res.mime_type });
    } catch (e) {
      this._log.error('media-player', `Camera fallback resolve failed: ${e?.message || JSON.stringify(e)}`);
      this._cleanup();
      if (this._activeSources.size === 0) {
        this._reportState('idle');
      }
    }
  }

  _destroyWebrtc() {
    if (this._webrtcHandle) {
      this._log.log('media-player', 'Closing WebRTC session');
      this._webrtcHandle.close();
      this._webrtcHandle = null;
    }
  }

  _removeVideoOverlay() {
    this._destroyHls();
    this._destroyWebrtc();
    this._stopScreensaverKeepalive();
    if (this._videoOverlay) {
      this._videoOverlay.remove();
      this._videoOverlay = null;
    }
  }

  _pause() {
    if (!this._audio || !this._playing) {
      this._log.log('media-player', `_pause no-op (audio=${!!this._audio} playing=${this._playing})`);
      this._reportState('idle');
      return;
    }
    this._log.log('media-player', `_pause (mediaId=${this._mediaId})`);
    this._audio.pause();
    this._playing = false;
    this._paused = true;
    this._interruptedForResume = false;
    this._disarmStopWord();
    this._reportState('paused');
  }

  _resume() {
    if (!this._audio || !this._paused) {
      this._log.log('media-player', `_resume no-op (audio=${!!this._audio} paused=${this._paused})`);
      this._reportState('idle');
      return;
    }
    this._log.log('media-player', `_resume (mediaId=${this._mediaId})`);
    this._interruptedForResume = false;
    this._audio.play().then(() => {
      this._armStopWord();
    }).catch((e) => {
      this._log.error('media-player', `Resume failed: ${e}`);
      this._cleanup();
      this._reportState('idle');
    });
    this._playing = true;
    this._paused = false;
    this._reportState('playing');
  }

  _stop() {
    this._log.log('media-player', `_stop (mediaId=${this._mediaId})`);
    this._interruptedForResume = false;
    if (!this._audio) return;
    this._cleanup();
    if (this._activeSources.size === 0) {
      this._reportState('idle');
    }
  }

  _setVolume(volume) {
    this._volume = volume;
    const effective = this._effectiveVolume();
    this._log.log(
      'media-player',
      `_setVolume raw=${volume} effective=${effective.toFixed(3)} muted=${this._muted}`,
    );
    if (this._audio) {
      this._audio.volume = effective;
    }
    this._applyVolumeToExternalAudio(effective);
    const state = this._playing || this._activeSources.size > 0
      ? 'playing'
      : this._paused ? 'paused' : 'idle';
    this._reportState(state);
  }

  _setMute(mute) {
    this._muted = mute;
    const effective = this._effectiveVolume();
    this._log.log('media-player', `_setMute=${mute} effectiveVolume=${effective.toFixed(3)}`);
    if (this._audio) {
      this._audio.volume = effective;
    }
    this._applyVolumeToExternalAudio(effective);
  }

  /** Apply volume to any active TTS or notification Audio elements. */
  _applyVolumeToExternalAudio(vol) {
    const ttsAudio = this._card.tts?.currentAudio;
    if (ttsAudio) ttsAudio.volume = vol;

    // Notification managers share the same currentAudio pattern
    for (const mgr of [this._card.announcement, this._card.askQuestion, this._card.startConversation]) {
      if (mgr?.currentAudio) mgr.currentAudio.volume = vol;
    }
  }

  _cleanup() {
    this._log.log(
      'media-player',
      `_cleanup (audio=${!!this._audio} hls=${!!this._hls} overlay=${!!this._videoOverlay} mediaId=${this._mediaId})`,
    );
    if (this._idleDebounce) {
      clearTimeout(this._idleDebounce);
      this._idleDebounce = null;
    }
    // Tear down hls.js BEFORE clearing the video element's src - hls owns
    // the MSE buffers and calling destroy() detaches them cleanly. Doing
    // it the other way around can throw or leak buffers. Same ordering
    // for the WebRTC peer connection, which owns the MediaStream.
    this._destroyHls();
    this._destroyWebrtc();
    if (this._audio) {
      this._audio.onended = null;
      this._audio.onerror = null;
      this._audio.pause();
      if (this._audio.srcObject) this._audio.srcObject = null;
      this._audio.src = '';
      this._audio = null;
    }
    if (this._videoOverlay) {
      this._videoOverlay.remove();
      this._videoOverlay = null;
    }
    this._stopScreensaverKeepalive();
    this._isLive = false;
    this._playing = false;
    this._paused = false;
    this._currentIsVisual = false;
    this._disarmStopWord();
  }

  /**
   * Find the media_player entity ID for this satellite device.
   * Uses the same device lookup pattern as getSwitchState.
   */
  _getEntityId() {
    const hass = this._card.hass;
    const satelliteId = this._card.config.satellite_entity;
    if (!hass?.entities || !satelliteId) return null;

    const satellite = hass.entities[satelliteId];
    if (!satellite?.device_id) return null;

    for (const [eid, entry] of Object.entries(hass.entities)) {
      if (entry.device_id === satellite.device_id &&
          entry.platform === 'voice_satellite' &&
          eid.startsWith('media_player.')) {
        return eid;
      }
    }
    return null;
  }

  /**
   * Report playback state back to the integration via WS.
   */
  _reportState(state) {
    this._syncInitialVolume();
    const entityId = this._getEntityId();
    if (!entityId) {
      this._log.log('media-player', 'No media_player entity found - skipping state report');
      return;
    }

    const conn = this._card.connection;
    if (!conn) return;

    const msg = {
      type: 'voice_satellite/media_player_event',
      entity_id: entityId,
      state,
    };

    if (this._volumeSynced && this._volume !== undefined) {
      msg.volume = this._volume;
    }
    if (this._mediaId && state !== 'idle') {
      msg.media_id = this._mediaId;
    }

    conn.sendMessagePromise(msg).catch((err) => {
      this._log.error('media-player', `Failed to report state: ${JSON.stringify(err)}`);
    });
  }
}
