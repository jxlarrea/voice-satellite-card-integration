/**
 * TtsManager
 *
 * Handles TTS playback (browser + remote media player), chimes via Web Audio API,
 * and streaming TTS early-start support.
 */

import { playChime as playChimeSound, CHIME_WAKE, CHIME_ERROR, CHIME_DONE } from '../audio/chime.js';
import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';
import { playRemote, stopRemote } from './comms.js';
import { Timing } from '../constants.js';

/** Safety ceiling so the UI never gets stuck if remote state monitoring fails */
const REMOTE_SAFETY_TIMEOUT = 120_000;

const CHIME_MAP = {
  wake: CHIME_WAKE,
  error: CHIME_ERROR,
  done: CHIME_DONE,
};

export class TtsManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._currentAudio = null;
    this._playing = false;
    this._endTimer = null;
    this._streamingUrl = null;
    this._playbackWatchdog = null;

    // Retry fallback - tts-end URL stored for retry on playback failure
    this._pendingTtsEndUrl = null;

    // Remote media player state monitoring
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
  }

  get isPlaying() { return this._playing; }

  get streamingUrl() { return this._streamingUrl; }
  set streamingUrl(url) { this._streamingUrl = url; }
  /**
   * @param {string} urlPath - URL or path to TTS audio
   * @param {boolean} [isRetry] - Whether this is a retry attempt
   */
  play(urlPath, isRetry) {
    const url = buildMediaUrl(urlPath);
    this._playing = true;

    // Remote media player target - monitor entity state for completion
    const ttsTarget = this._card.ttsTarget;
    if (ttsTarget) {
      this._remoteTarget = ttsTarget;
      this._remoteSawPlaying = false;
      playRemote(this._card, url);

      // Safety timeout - if state monitoring never fires, clean up after 2 minutes
      this._endTimer = setTimeout(() => {
        this._endTimer = null;
        this._log.log('tts', 'Remote safety timeout - forcing completion');
        this._onComplete();
      }, REMOTE_SAFETY_TIMEOUT);
      return;
    }

    // Browser playback - watchdog checks audio is progressing
    this._lastWatchdogTime = 0;
    this._playbackWatchdog = setInterval(() => {
      if (!this._playing || !this._currentAudio) {
        this._clearWatchdog();
        return;
      }
      const now = this._currentAudio.currentTime;
      if (now > this._lastWatchdogTime) {
        this._lastWatchdogTime = now;
        return; // Audio is progressing - all good
      }
      // Audio stalled - force completion
      this._log.log('tts', 'Playback watchdog: audio stalled - forcing completion');
      this._clearWatchdog();
      this._onComplete();
    }, Timing.PLAYBACK_WATCHDOG);

    this._currentAudio = playMediaUrl(url, this._card.mediaPlayer.volume, {
      onEnd: () => {
        this._log.log('tts', 'Playback complete');
        this._clearWatchdog();
        this._onComplete();
      },
      onError: (e) => {
        this._log.error('tts', `Playback error: ${e}`);
        this._log.error('tts', `URL: ${url}`);
        this._clearWatchdog();

        // Retry once - the TTS proxy token may not have been ready yet
        if (!isRetry && this._pendingTtsEndUrl) {
          const retryUrl = this._pendingTtsEndUrl;
          this._pendingTtsEndUrl = null;
          this._currentAudio = null;
          this._log.log('tts', `Retrying with tts-end URL: ${retryUrl}`);
          this.play(retryUrl, true);
          return;
        }

        this._onComplete(true);
      },
      onStart: () => {
        this._log.log('tts', 'Playback started successfully');
        this._pendingTtsEndUrl = null;
        this._card.mediaPlayer.notifyAudioStart('tts');
        if (this._card.isReactiveBarEnabled && this._currentAudio) {
          this._card.analyser.attachAudio(this._currentAudio, this._card.audio.audioContext);
        }
      },
    });
  }

  stop() {
    this._playing = false;
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
    this._pendingTtsEndUrl = null;
    this._clearWatchdog();

    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }

    this._card.analyser.detachAudio();
    if (this._currentAudio) {
      this._currentAudio.onended = null;
      this._currentAudio.onerror = null;
      this._currentAudio.pause();
      this._currentAudio.src = '';
      this._currentAudio = null;
    }

    stopRemote(this._card);
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
      this._log.log('tts', `Streaming TTS URL available: ${this._streamingUrl}`);
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
    this._card.mediaPlayer.notifyAudioStart('chime');
    playChimeSound(this._card, pattern, this._log);
    setTimeout(() => {
      this._card.mediaPlayer.notifyAudioEnd('chime');
    }, (pattern.duration || 0.3) * 1000);
  }

  /**
   * Called from card's set hass() - monitors remote media player entity state
   * to detect when TTS playback finishes.
   * @param {object} hass
   */
  checkRemotePlayback(hass) {
    if (!this._playing || !this._remoteTarget) return;

    const entity = hass.states?.[this._remoteTarget];
    if (!entity) return;

    const state = entity.state;

    if (state === 'playing' || state === 'buffering') {
      this._remoteSawPlaying = true;
      return;
    }

    // Only complete once we've confirmed it was playing first,
    // to avoid false triggers during the brief delay before playback starts
    if (this._remoteSawPlaying) {
      this._log.log('tts', `Remote player stopped (state: ${state}) - completing`);
      this._onComplete();
    }
  }
  _clearWatchdog() {
    if (this._playbackWatchdog) {
      clearInterval(this._playbackWatchdog);
      this._playbackWatchdog = null;
    }
  }

  /**
   * @param {boolean} [playbackFailed]
   */
  _onComplete(playbackFailed) {
    this._log.log('tts', `Complete - cleaning up UI${playbackFailed ? ' (playback failed)' : ''}`);
    this._card.analyser.detachAudio();
    this._currentAudio = null;
    this._playing = false;
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
    this._pendingTtsEndUrl = null;

    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }

    this._card.mediaPlayer.notifyAudioEnd('tts');
    this._card.onTTSComplete(playbackFailed);
  }
}
