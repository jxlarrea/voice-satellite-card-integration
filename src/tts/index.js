/**
 * Voice Satellite Card — TtsManager
 *
 * Handles TTS playback (browser + remote media player), chimes via Web Audio API,
 * and streaming TTS early-start support.
 */

import { playChime as playChimeSound, CHIME_WAKE, CHIME_ERROR, CHIME_DONE } from '../audio/chime.js';
import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';
import { playRemote, stopRemote } from './comms.js';
import { Timing } from '../constants.js';

const REMOTE_COMPLETION_DELAY = 2000;

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
  }

  get isPlaying() { return this._playing; }

  get streamingUrl() { return this._streamingUrl; }
  set streamingUrl(url) { this._streamingUrl = url; }

  // --- TTS Playback ---

  /**
   * @param {string} urlPath - URL or path to TTS audio
   */
  play(urlPath) {
    const { config } = this._card;
    const url = buildMediaUrl(urlPath);
    this._playing = true;

    // Remote media player target
    if (config.tts_target && config.tts_target !== 'browser') {
      playRemote(this._card, url);
      this._endTimer = setTimeout(() => {
        this._endTimer = null;
        this._onComplete();
      }, REMOTE_COMPLETION_DELAY);
      return;
    }

    // Browser playback
    this._playbackWatchdog = setTimeout(() => {
      this._playbackWatchdog = null;
      if (this._playing && this._currentAudio) {
        this._log.log('tts', 'Playback watchdog fired — forcing completion');
        this._onComplete();
      }
    }, Timing.PLAYBACK_WATCHDOG);

    this._currentAudio = playMediaUrl(url, config.tts_volume / 100, {
      onEnd: () => {
        this._log.log('tts', 'Playback complete');
        this._clearWatchdog();
        this._onComplete();
      },
      onError: (e) => {
        this._log.error('tts', `Playback error: ${e}`);
        this._log.error('tts', `URL: ${url}`);
        this._clearWatchdog();
        this._onComplete(true);
      },
      onStart: () => {
        this._log.log('tts', 'Playback started successfully');
      },
    });
  }

  stop() {
    this._playing = false;
    this._clearWatchdog();

    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }

    if (this._currentAudio) {
      this._currentAudio.onended = null;
      this._currentAudio.onerror = null;
      this._currentAudio.pause();
      this._currentAudio.src = '';
      this._currentAudio = null;
    }

    stopRemote(this._card);
  }

  resetStreamingUrl() {
    this._streamingUrl = null;
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

  // --- Chimes ---

  /**
   * @param {'wake' | 'error' | 'done'} type
   */
  playChime(type) {
    const pattern = CHIME_MAP[type] || CHIME_DONE;
    playChimeSound(this._card, pattern, this._log);
  }

  // --- Private ---

  _clearWatchdog() {
    if (this._playbackWatchdog) {
      clearTimeout(this._playbackWatchdog);
      this._playbackWatchdog = null;
    }
  }

  /**
   * @param {boolean} [playbackFailed]
   */
  _onComplete(playbackFailed) {
    this._log.log('tts', `Complete — cleaning up UI${playbackFailed ? ' (playback failed)' : ''}`);
    this._currentAudio = null;
    this._playing = false;

    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }

    this._card.onTTSComplete(playbackFailed);
  }
}
