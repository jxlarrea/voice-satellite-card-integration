/**
 * TtsManager
 *
 * Handles TTS playback (browser + remote media player), chimes via pre-rendered
 * sound files, and streaming TTS early-start support.
 */

import { playChime as playChimeSound, CHIME_WAKE, CHIME_ERROR, CHIME_DONE, getChimeDuration } from '../audio/chime.js';
import { buildMediaUrl } from '../audio/media-playback.js';
import { playRemote, restoreRemote, stopRemote } from './comms.js';
import { getSelectState } from '../shared/satellite-state.js';
import { supportsNativeSound, playNativeSoundTracked } from '../kiosk/index.js';
import { Timing } from '../constants.js';

/** Safety ceiling so the UI never gets stuck if remote state monitoring fails */
const REMOTE_SAFETY_TIMEOUT = 30_000;

/** Safety ceiling for native (Kiosk Satellite) playback: the app guarantees
 *  exactly one ended event per sound, so this only catches an event lost
 *  crossing the bridge. Generous, because long LLM answers are real audio. */
const NATIVE_SAFETY_TIMEOUT = 120_000;

const CHIME_MAP = {
  wake: CHIME_WAKE,
  error: CHIME_ERROR,
  done: CHIME_DONE,
};

// Arm stop-word listening quickly once playback starts so short assistant
// replies remain interruptible, while still leaving a brief buffer before
// local speaker output settles.
const STOP_WORD_ARM_DELAY_MS = 250;

export class TtsManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    // Single persistent Audio element - reused across all TTS plays.
    // Setting src on an existing element auto-cancels the previous fetch,
    // preventing orphaned HTTP connections from exhausting the browser pool.
    this._audioEl = new Audio();
    this._playing = false;
    this._endTimer = null;
    // Kiosk Satellite native playback handle ({id, started, done, stop})
    // while a delegated TTS play is live; null otherwise. The generation
    // counter guards the async accept round-trip: a play that resolves
    // after a newer play (or a stop) has moved on must not install itself.
    this._nativeSound = null;
    this._nativeGen = 0;
    this._streamingUrl = null;
    this._playbackWatchdog = null;
    this._lastWatchdogTime = 0;
    // Diagnostic timing - captured at play() and the duration event so the
    // 'Playback complete' log can show elapsed-vs-expected in one line.
    this._playStartTs = 0;
    this._serverDuration = 0;

    // Retry fallback - tts-end URL stored for retry on playback failure
    this._pendingTtsEndUrl = null;

    // Remote media player state monitoring
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
    this._remoteInitialState = null;
    this._remoteInitialContentId = null;

    // 'normal_playback' mode: snapshot of prior media to restore after the
    // satellite is done with the remote. Captured at the FIRST remote write
    // of an interaction (wake chime, or TTS if no chime preceded it) and
    // consumed by the deferred restore timer. Null when no interaction is
    // active.
    this._resumeSnapshot = null;
    // Deferred restore timer. Each remote write (chime or TTS) cancels and
    // re-schedules. The last activity in the interaction (typically the
    // done chime) wins, and restore fires after that chime ends.
    this._restoreTimer = null;

    // TTS URL from the current play() call - used to correlate tts-audio-duration events
    this._ttsUrl = null;

    // Stop word activation delay timer
    this._stopWordTimer = null;

  }

  get isPlaying() { return this._playing; }
  get currentAudio() { return this._playing ? this._audioEl : null; }

  get ttsUrl() { return this._ttsUrl; }
  set ttsUrl(url) { this._ttsUrl = url; }

  get streamingUrl() { return this._streamingUrl; }
  set streamingUrl(url) { this._streamingUrl = url; }
  /**
   * @param {string} urlPath - URL or path to TTS audio
   * @param {boolean} [isRetry] - Whether this is a retry attempt
   * @param {string} [mediaId] - media-source:// URI for remote playback (HA resolves/proxies)
   */
  play(urlPath, isRetry, mediaId) {
    const url = buildMediaUrl(urlPath);
    this._playing = true;
    // Halt wake-word inference IMMEDIATELY - before audio loading begins
    // and before pipeline.restart(0) at tts-end spins up a fresh wake-word
    // backend.  Otherwise the new backend processes the speaker-residual
    // mic audio and self-triggers (ok_nabu @ 0.8+ on rms<0.005 audio).
    // Stop-word arming (if enabled) still happens on its 250 ms delay
    // timer below - that's about AEC settling for the stop classifier,
    // independent of suspending wake-word detection.
    if (!isRetry) {
      this._card.wakeWord?.suspendForPlayback();
    }
    // Reset diagnostic timing - the 'Playback complete' log will compare
    // these against the actual end time to detect early stream-close.
    this._playStartTs = performance.now();
    this._serverDuration = 0;

    // Remote media player target - monitor entity state for completion
    const ttsTarget = this._card.ttsTarget;
    if (ttsTarget) {
      this._remoteTarget = ttsTarget;
      this._remoteSawPlaying = false;
      const remoteEntity = this._card.hass?.states?.[ttsTarget];
      this._remoteInitialState = remoteEntity?.state;
      this._remoteInitialContentId = remoteEntity?.attributes?.media_content_id || null;

      // 'normal_playback' mode skips the announce flag and explicitly
      // restores prior content after TTS. Used for speakers (e.g. Google
      // Cast) that ignore announce, leaving the user's music never
      // resumed. Snapshot is only captured when the remote was actively
      // playing user content - if it was idle or already on a TTS URL
      // there's nothing meaningful to restore.
      const useAnnounce = !this._isNormalPlaybackMode();
      this._log.log(
        'tts',
        `Remote start: target=${ttsTarget} useAnnounce=${useAnnounce}`
          + ` initialState=${this._remoteInitialState}`
          + ` initialContentId=${this._remoteInitialContentId}`,
      );
      // Cancel any deferred restore - we're firing more remote activity.
      // A new restore is scheduled by _onComplete (or a subsequent chime).
      this._cancelRestore();
      // In normal_playback mode, snapshot the remote unless a preceding
      // chime already captured one. Only capture if music was actively
      // playing - skip silent/idle/paused states.
      if (!useAnnounce && !this._resumeSnapshot) {
        this._captureRemoteSnapshot();
      }

      playRemote(this._card, mediaId || url, { announce: useAnnounce }).catch(() => {
        this._log.log('tts', 'Remote play service call failed - forcing completion');
        this._onComplete();
      });

      this._enableStopWordDelayed();

      // Safety timeout - if state monitoring never fires, clean up after 2 minutes
      this._endTimer = setTimeout(() => {
        this._endTimer = null;
        this._log.log('tts', 'Remote safety timeout - forcing completion');
        this._onComplete();
      }, REMOTE_SAFETY_TIMEOUT);
      return;
    }

    // Kiosk Satellite host: hand playback to the app - the user's speaker
    // selection, no autoplay gate, and the app's HTTP stack (which trusts
    // a self-signed HA certificate the browser would refuse). Streamed, so
    // speech starts while the server is still synthesizing, same as the
    // browser element. Any refusal falls back to the element below.
    if (supportsNativeSound()) {
      this._playNative(url, isRetry);
      return;
    }
    this._playBrowser(url, isRetry);
  }

  /**
   * Native playback via Kiosk Satellite. Mirrors the browser element's
   * seams exactly: started -> notifyAudioStart + stop-word arming, done ->
   * _onComplete, error -> the one tts-end retry then the failure toast.
   * The app guarantees exactly one ended per sound; the safety timer is
   * the belt for an event lost crossing the bridge.
   *
   * @param {string} url
   * @param {boolean} [isRetry]
   */
  async _playNative(url, isRetry) {
    const gen = ++this._nativeGen;
    const tracked = await playNativeSoundTracked(
      url, this._card.mediaPlayer.volume, { stream: true },
    );
    if (gen !== this._nativeGen || !this._playing) {
      // A newer play or a stop() moved on while the accept round-tripped;
      // nothing owns this sound.
      tracked?.stop();
      return;
    }
    if (!tracked) {
      this._log.log('tts', 'Native playback refused - falling back to browser audio');
      this._playBrowser(url, isRetry);
      return;
    }
    this._nativeSound = tracked;
    let handled = false;

    tracked.started.then(() => {
      if (handled || this._nativeSound !== tracked) return;
      this._log.log('tts', 'Playback started (native)');
      this._pendingTtsEndUrl = null;
      this._card.mediaPlayer.notifyAudioStart('tts');
      if (this._card.isReactiveBarEnabled) {
        // The audio never enters the page; the app measures it and streams
        // levels over. detachAudio (in _onComplete/stop) leaves this mode.
        this._card.analyser.attachExternal();
        tracked.onLevel((level) => this._card.analyser.setExternalLevel(level));
      }
      this._enableStopWordDelayed();
    });

    this._endTimer = setTimeout(() => {
      this._endTimer = null;
      if (handled || this._nativeSound !== tracked) return;
      handled = true;
      this._nativeSound = null;
      this._log.log('tts', 'Native safety timeout - forcing completion');
      tracked.stop();
      this._onComplete();
    }, NATIVE_SAFETY_TIMEOUT);

    tracked.done.then(({ error } = {}) => {
      if (handled || this._nativeSound !== tracked) return;
      handled = true;
      this._nativeSound = null;
      if (error) {
        this._log.error('tts', `Native playback error: ${error}`);
        this._log.error('tts', `URL: ${url}`);
        // Same single retry as the browser path - the TTS proxy token may
        // not have been ready yet.
        if (!isRetry && this._pendingTtsEndUrl) {
          const retryUrl = this._pendingTtsEndUrl;
          this._pendingTtsEndUrl = null;
          this._log.log('tts', `Retrying with tts-end URL: ${retryUrl}`);
          this.play(retryUrl, true);
          return;
        }
        this._card.toast?.show({
          id: 'tts.playback-failed',
          severity: 'warn',
          category: 'Text-to-speech',
          description: 'Audio could not be played on the device.',
          action: { label: 'Open Diagnostics', type: 'diagnostics' },
        });
        this._onComplete(true);
        return;
      }
      const elapsedMs = this._playStartTs ? performance.now() - this._playStartTs : 0;
      const elapsedStr = elapsedMs ? `${(elapsedMs / 1000).toFixed(2)}s` : 'n/a';
      const serverStr = this._serverDuration ? `${this._serverDuration}s` : 'n/a';
      this._log.log('tts', `Playback complete (native) - server=${serverStr} wall=${elapsedStr}`);
      this._onComplete();
    });
  }

  /**
   * Browser Audio element playback: every non-Kiosk host, and the fallback
   * when the app refuses a native play.
   *
   * @param {string} url
   * @param {boolean} [isRetry]
   */
  _playBrowser(url, isRetry) {
    // Browser playback - watchdog checks audio is progressing
    this._lastWatchdogTime = 0;
    this._playbackWatchdog = setInterval(() => {
      if (!this._playing) {
        this._clearWatchdog();
        return;
      }
      const now = this._audioEl.currentTime;
      if (now > this._lastWatchdogTime) {
        this._lastWatchdogTime = now;
        return; // Audio is progressing - all good
      }
      // Audio stalled - force completion
      this._log.log('tts', 'Playback watchdog: audio stalled - forcing completion');
      this._clearWatchdog();
      this._onComplete();
    }, Timing.PLAYBACK_WATCHDOG);

    // Reuse the persistent Audio element. Setting src auto-cancels any
    // previous in-flight fetch, so orphaned connections are impossible.
    const audio = this._audioEl;
    audio.volume = this._card.mediaPlayer.volume;

    // Guard against double error/completion callbacks
    let handled = false;

    audio.onended = () => {
      if (handled) return;
      handled = true;
      // Diagnostic timing - shows whether the Audio element fired 'ended'
      // after playing the full server-measured duration, or short-circuited
      // (streaming response closed early, decoder dropped a chunk, etc.).
      // The most diagnostic value is `delta = el.currentTime - server` -
      // a meaningfully negative number means the element reported `ended`
      // before the file's bytes had actually been played out.  Wall-clock
      // elapsed (from tts.play() through play() promise resolution and
      // playback) is also logged for context but includes browser setup
      // time so it isn't the right comparator on its own.
      const elapsedMs = this._playStartTs ? performance.now() - this._playStartTs : 0;
      const elapsedStr = elapsedMs ? `${(elapsedMs / 1000).toFixed(2)}s` : 'n/a';
      const serverStr = this._serverDuration ? `${this._serverDuration}s` : 'n/a';
      const elCt = Number(this._audioEl?.currentTime);
      const elCtStr = Number.isFinite(elCt) ? `${elCt.toFixed(2)}s` : 'n/a';
      let delta = '';
      if (this._serverDuration && Number.isFinite(elCt)) {
        const diff = elCt - this._serverDuration;
        delta = ` delta=${diff >= 0 ? '+' : ''}${diff.toFixed(2)}s`;
      }
      this._log.log(
        'tts',
        `Playback complete - el.currentTime=${elCtStr} server=${serverStr}${delta} (wall=${elapsedStr})`,
      );
      this._clearWatchdog();
      this._onComplete();
    };

    audio.onerror = (e) => {
      if (handled) return;
      handled = true;
      this._log.error('tts', `Playback error: ${e}`);
      this._log.error('tts', `URL: ${url}`);
      this._clearWatchdog();

      // Retry once - the TTS proxy token may not have been ready yet
      if (!isRetry && this._pendingTtsEndUrl) {
        const retryUrl = this._pendingTtsEndUrl;
        this._pendingTtsEndUrl = null;
        this._log.log('tts', `Retrying with tts-end URL: ${retryUrl}`);
        this.play(retryUrl, true);
        return;
      }

      // Both the initial and the fallback URL failed. Surface it as a
      // toast; the most common cause is a mixed-content TTS URL when
      // HA's internal_url is http and the page is https, which the
      // Diagnostics panel will call out.
      this._card.toast?.show({
        id: 'tts.playback-failed',
        severity: 'warn',
        category: 'Text-to-speech',
        description: 'Audio could not be played. Often caused by mixed-content TTS URLs or autoplay being blocked.',
        action: { label: 'Open Diagnostics', type: 'diagnostics' },
      });

      this._onComplete(true);
    };

    audio.src = url;
    audio.play().then(() => {
      if (handled) return;
      this._log.log('tts', 'Playback started successfully');
      this._pendingTtsEndUrl = null;
      this._card.mediaPlayer.notifyAudioStart('tts');
      if (this._card.isReactiveBarEnabled) {
        this._card.analyser.attachAudio(audio, this._card.audio.audioContext);
      }
      this._enableStopWordDelayed();
    }).catch((e) => {
      // play() promise rejection (autoplay blocked, etc.)
      audio.onerror?.(e);
    });
  }

  stop() {
    // Decide whether to preserve the snapshot BEFORE clearing _remoteTarget.
    // In normal_playback mode with an active snapshot the user's music must
    // still be restored on cancellation (stop word, double-tap, etc.) - if
    // we cleared it and called stopRemote, the speaker would just go silent.
    // A trailing done chime (which every cancellation path fires) will pick
    // up the snapshot and reschedule for after itself.
    const preserveSnapshot = this._resumeSnapshot
      && this._card.ttsTarget
      && this._isNormalPlaybackMode();

    this._playing = false;
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
    this._remoteInitialState = null;
    this._remoteInitialContentId = null;
    this._pendingTtsEndUrl = null;
    this._clearWatchdog();
    this._disableStopWord();
    this._card.wakeWord?.resumeFromPlayback();

    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }

    this._card.analyser.detachAudio();
    this._releaseNativeSound();
    this._releaseAudio();

    if (preserveSnapshot) {
      // Schedule deferred restore. The trailing done chime (within ~ms)
      // cancels and reschedules for after itself. If no chime follows,
      // the safety timer below restores the music and naturally replaces
      // whatever was playing on the remote - no stopRemote needed.
      this._scheduleRestore(1);
    } else {
      this._cancelRestore();
      this._resumeSnapshot = null;
      stopRemote(this._card);
    }

    this._card.mediaPlayer.notifyAudioEnd('tts');
  }

  /**
   * @param {object} eventData - run-start event data containing tts_output
   */
  storeStreamingUrl(eventData) {
    this._streamingUrl = null;
    if (eventData.tts_output?.url && eventData.tts_output?.stream_response) {
      const url = eventData.tts_output.url;
      this._streamingUrl = url.startsWith('http') ? url : window.location.origin + url;
      this._log.log('tts', `Streaming TTS URL stored: ${this._streamingUrl}`);
      // No eager fetch - the persistent Audio element fetches on play().
      // Eager preloading caused connection exhaustion: HA's streaming TTS
      // proxy holds connections open until audio is generated, and cancelled
      // interactions pile up faster than HTTP/1.1 connections can be freed.
    }
  }

  /**
   * Store the tts-end URL as a fallback for retry on playback failure.
   * @param {string|null} url
   */
  storeTtsEndUrl(url) {
    this._pendingTtsEndUrl = url ? buildMediaUrl(url) : null;
  }
  /**
   * @param {'wake' | 'error' | 'done'} type
   */
  playChime(type) {
    const pattern = CHIME_MAP[type] || CHIME_DONE;
    this._log.log('chime', `Playing ${type} chime`);
    this._card.mediaPlayer.notifyAudioStart('chime');

    // 'normal_playback' mode + remote target: capture the snapshot before
    // the chime poisons the remote's media_content_id (so the wake chime
    // doesn't wipe the user's music URL from view). Subsequent chimes in
    // the same interaction reuse the snapshot. Cancel any previously
    // scheduled restore - we're adding more remote activity, so the
    // restore must be re-scheduled for after this chime ends.
    if (this._card.ttsTarget && this._isNormalPlaybackMode()) {
      this._cancelRestore();
      if (!this._resumeSnapshot) {
        this._captureRemoteSnapshot();
      }
    }

    playChimeSound(this._card, pattern, this._log);
    setTimeout(() => {
      this._card.mediaPlayer.notifyAudioEnd('chime');
    }, (pattern.duration || 0.3) * 1000);

    // Only end-of-interaction chimes (done, error) schedule restore.
    // The wake chime is the START of the interaction - scheduling a
    // restore here would fire during STT/intent and briefly resume the
    // user's music before TTS kills it again. _onComplete handles the
    // post-TTS case (and a trailing done chime reschedules to fire
    // after itself).
    const isEndOfInteraction = type === 'done' || type === 'error';
    if (isEndOfInteraction
        && this._resumeSnapshot
        && this._card.ttsTarget
        && this._isNormalPlaybackMode()) {
      this._scheduleRestore(getChimeDuration(pattern));
    }
  }

  /**
   * Capture a snapshot of the remote target's currently-playing media so
   * the deferred restore can put it back when the satellite is done.
   * Idempotent within an interaction - re-calls while a snapshot already
   * exists are no-ops. Used by both TTS playback and the notification path
   * (announce, ask_question, start_conversation) so any first remote write
   * in normal_playback mode captures before clobbering the speaker's state.
   */
  ensureRemoteSnapshot() {
    if (this._resumeSnapshot) return;
    if (!this._card.ttsTarget) return;
    if (!this._isNormalPlaybackMode()) return;
    this._captureRemoteSnapshot();
  }

  /**
   * Schedule the deferred restore if there's a captured snapshot waiting.
   * Used by notification managers (announce) to close the loop when no
   * done chime will fire (wake_sound switch off). A subsequent chime/TTS
   * will cancel and reschedule; the safety timer here just guarantees the
   * music doesn't stay dead when no other trigger lands.
   * @param {number} seconds - delay before restore fires
   */
  scheduleRemoteRestoreIfNeeded(seconds) {
    if (!this._resumeSnapshot) return;
    if (!this._card.ttsTarget) return;
    this._scheduleRestore(seconds);
  }

  /** True if remote TTS output mode is 'normal_playback'. */
  _isNormalPlaybackMode() {
    const mode = getSelectState(
      this._card.hass,
      this._card.config?.satellite_entity,
      'tts_output_mode_remote',
      'announcement',
    );
    return mode === 'normal_playback';
  }

  /**
   * Snapshot the remote target's current media so it can be restored
   * after the satellite is done. No-op if the remote isn't actively
   * playing user content.
   */
  _captureRemoteSnapshot() {
    const target = this._card.ttsTarget;
    if (!target) return;
    const remote = this._card.hass?.states?.[target];
    if (!remote || remote.state !== 'playing' || !remote.attributes?.media_content_id) {
      return;
    }
    const attrs = remote.attributes;
    const reportedAt = attrs.media_position_updated_at
      ? Date.parse(attrs.media_position_updated_at)
      : null;
    const elapsed = reportedAt && Number.isFinite(reportedAt)
      ? Math.max(0, (Date.now() - reportedAt) / 1000)
      : 0;
    const position = (Number(attrs.media_position) || 0) + elapsed;
    this._resumeSnapshot = {
      id: attrs.media_content_id,
      type: attrs.media_content_type || 'music',
      position,
      duration: Number(attrs.media_duration) || null,
    };
    this._log.log(
      'tts',
      `Captured resume snapshot: id=${this._resumeSnapshot.id} pos=${position.toFixed(1)}s`,
    );
  }

  /**
   * Schedule a deferred restore. Cancels any prior timer first so the
   * most recent remote activity defines when restore actually fires.
   * @param {number} afterSeconds - seconds from now to fire restore
   */
  _scheduleRestore(afterSeconds) {
    this._cancelRestore();
    const delayMs = Math.max(0, afterSeconds + 0.5) * 1000;
    this._restoreTimer = setTimeout(() => {
      this._restoreTimer = null;
      if (!this._resumeSnapshot || !this._card.ttsTarget) return;
      const snap = this._resumeSnapshot;
      this._resumeSnapshot = null;
      const atEnd = snap.duration && snap.position + 2 >= snap.duration;
      if (atEnd) {
        this._log.log('tts', `Skipping restore - at/near end (pos=${snap.position.toFixed(1)}s dur=${snap.duration}s)`);
        return;
      }
      restoreRemote(this._card, snap);
    }, delayMs);
  }

  _cancelRestore() {
    if (this._restoreTimer) {
      clearTimeout(this._restoreTimer);
      this._restoreTimer = null;
    }
  }

  /**
   * Set a duration-based completion timer for remote TTS playback.
   * Called when the integration sends a tts-audio-duration event after
   * measuring the audio length server-side via mutagen.
   * @param {number} duration - Audio duration in seconds
   * @param {string} [ttsUrl] - TTS proxy URL to correlate with current playback
   */
  setAudioDuration(duration, ttsUrl) {
    // Log unconditionally - including for browser playback where the
    // duration is informational only.  Useful for diagnosing TTS-to-STT
    // bleed issues: comparing the server-measured duration against
    // audio.onended timing tells us whether the Audio element is firing
    // 'ended' before the bytes have actually finished decoding/playing.
    // Include audio-element perspective when we have it so the values
    // are directly comparable in a single log line.
    const elDuration = Number(this._audioEl?.duration);
    const elCurrentTime = Number(this._audioEl?.currentTime);
    const elDurationStr = Number.isFinite(elDuration) ? `${elDuration.toFixed(2)}s` : 'n/a';
    const elCurrentStr = Number.isFinite(elCurrentTime) ? `${elCurrentTime.toFixed(2)}s` : 'n/a';

    if (!duration) {
      this._log.log(
        'tts',
        `Audio duration unavailable (server measurement failed) - el.duration=${elDurationStr} el.currentTime=${elCurrentStr}`,
      );
      return;
    }

    // Stash for the 'Playback complete' log line so elapsed-vs-expected
    // can be compared in a single output.
    if (this._playing) this._serverDuration = duration;

    const baseLog = `server=${duration}s el.duration=${elDurationStr} el.currentTime=${elCurrentStr}`;

    if (!this._playing) {
      this._log.log('tts', `Audio duration received but not playing (informational): ${baseLog}`);
      return;
    }
    if (!this._remoteTarget) {
      this._log.log(
        'tts',
        `Audio duration received (browser playback - informational only): ${baseLog}`,
      );
      return;
    }

    // Ignore stale duration events from a different TTS output
    if (ttsUrl && this._ttsUrl && ttsUrl !== this._ttsUrl) {
      this._log.log('tts', `Ignoring stale duration (url mismatch): ${baseLog}`);
      return;
    }

    this._log.log('tts', `Audio duration applied - setting completion timer: ${baseLog}`);

    // Replace the 30s safety timeout with one based on server-measured
    // duration plus a 2s buffer. The buffer covers playback-start latency
    // on the remote (network fetch + buffering), which can be noticeable
    // on long TTS responses.
    if (this._endTimer) {
      clearTimeout(this._endTimer);
    }
    this._endTimer = setTimeout(() => {
      this._endTimer = null;
      this._log.log('tts', 'Duration-based timer fired - completing');
      this._onComplete();
    }, (duration + 2) * 1000);
  }

  /**
   * Called from card's set hass() - monitors remote media player entity state
   * to detect when TTS playback finishes.
   * @param {object} hass
   */
  checkRemotePlayback(hass) {
    if (!this._playing || !this._remoteTarget) return;

    // Once the server-measured duration is known, the duration-based
    // timer in setAudioDuration() is the source of truth for completion.
    // Entity-state polling is unreliable on speakers that have other
    // media active: announce-mode may resume the user's content with the
    // same media_content_id (firing path 2 prematurely), or briefly blip
    // through 'paused'/'idle' (firing path 1 prematurely). The duration
    // timer is unaffected by either.
    if (this._serverDuration) return;

    const entity = hass.states?.[this._remoteTarget];
    if (!entity) return;

    const state = entity.state;
    const contentId = entity.attributes?.media_content_id || null;
    const isActive = state === 'playing' || state === 'buffering';

    // ── Detect our content started playing ──
    if (!this._remoteSawPlaying) {
      if (!isActive) return;

      // Player was already active when we started - only mark as saw-playing
      // when media_content_id changes (confirms our content loaded).
      // This avoids false-flagging pre-existing music as our TTS.
      const wasAlreadyActive = this._remoteInitialState === 'playing'
                            || this._remoteInitialState === 'buffering';
      if (wasAlreadyActive && contentId === this._remoteInitialContentId) return;

      this._remoteSawPlaying = true;
      return;
    }

    // ── Detect our content finished ──
    // Path 1: state left playing/buffering (player went idle/paused)
    if (!isActive) {
      this._log.log('tts', `Remote player stopped (state: ${state}) - completing`);
      this._onComplete();
      return;
    }

    // Path 2: player was already active and media_content_id reverted to the
    // original (announce finished, previous media resumed)
    if (this._remoteInitialContentId && contentId === this._remoteInitialContentId) {
      this._log.log('tts', 'Remote player resumed original content - completing');
      this._onComplete();
    }
  }
  /** Reset the persistent Audio element, closing any open HTTP connection. */
  _releaseAudio() {
    const a = this._audioEl;
    a.onended = null;
    a.onerror = null;
    a.pause();
    a.removeAttribute('src');
    a.load();
  }

  /** Stop and disown any live native (Kiosk Satellite) sound. Nulling the
   *  handle first is what neutralizes its pending done/started callbacks -
   *  they all guard on the handle still being current. */
  _releaseNativeSound() {
    const ns = this._nativeSound;
    if (!ns) return;
    this._nativeSound = null;
    ns.stop();
  }

  _clearWatchdog() {
    if (this._playbackWatchdog) {
      clearInterval(this._playbackWatchdog);
      this._playbackWatchdog = null;
    }
  }

  _enableStopWordDelayed() {
    if (this._stopWordTimer) clearTimeout(this._stopWordTimer);
    this._stopWordTimer = setTimeout(() => {
      this._stopWordTimer = null;
      const wakeWord = this._card.wakeWord;
      if (wakeWord && this._playing) {
        wakeWord.enableStopModel(true);
      }
    }, STOP_WORD_ARM_DELAY_MS);
  }

  _disableStopWord() {
    if (this._stopWordTimer) {
      clearTimeout(this._stopWordTimer);
      this._stopWordTimer = null;
    }
    this._card.wakeWord?.disableStopModel();
  }

  /**
   * @param {boolean} [playbackFailed]
   */
  _onComplete(playbackFailed) {
    this._log.log('tts', `Complete - cleaning up UI${playbackFailed ? ' (playback failed)' : ''}`);
    this._disableStopWord();
    // Resume wake-word inference now that the speaker is silent.  Order
    // matters: _disableStopWord runs first so if stop-only mode was on,
    // disableStopModel restores the wake keywords; resumeFromPlayback
    // then sees stop-only is off and clears the suspend cleanly.
    this._card.wakeWord?.resumeFromPlayback();
    this._card.analyser.detachAudio();
    this._releaseNativeSound();
    this._releaseAudio();

    // Schedule a deferred restore for the captured snapshot. A done chime
    // typically fires within a few ms of _onComplete via onTTSComplete,
    // and that chime call will cancel + reschedule for after itself, so
    // restore lands cleanly at the very end of the interaction. The 1s
    // delay here is a safety floor for the rare case no chime follows.
    // Skipped on playback failure (the user didn't actually hear TTS, no
    // point displacing whatever's currently playing on the remote).
    if (!playbackFailed && this._resumeSnapshot && this._remoteTarget) {
      this._scheduleRestore(1);
    } else if (playbackFailed) {
      this._cancelRestore();
      this._resumeSnapshot = null;
    }

    this._playing = false;
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
    this._remoteInitialState = null;
    this._remoteInitialContentId = null;
    this._pendingTtsEndUrl = null;

    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }

    this._card.mediaPlayer.notifyAudioEnd('tts');
    this._card.onTTSComplete(playbackFailed);
  }
}
