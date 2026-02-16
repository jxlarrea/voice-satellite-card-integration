/**
 * Voice Satellite Card — TtsManager
 *
 * Handles TTS playback (browser + remote media player), chimes via Web Audio API,
 * and streaming TTS early-start support.
 */

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

  get isPlaying() {
    return this._playing;
  }

  get streamingUrl() {
    return this._streamingUrl;
  }

  set streamingUrl(url) {
    this._streamingUrl = url;
  }

  // --- TTS Playback ---

  play(urlPath) {
    var self = this;
    var config = this._card.config;
    var url = this._buildUrl(urlPath);
    this._playing = true;

    // Remote media player target
    if (config.tts_target && config.tts_target !== 'browser') {
      this._playRemote(url);
      return;
    }

    // Browser playback (default)
    var audio = new Audio();
    audio.volume = config.tts_volume / 100;

    // Watchdog: if playback hasn't completed after 30s, force completion.
    // Covers Companion App WebView where events may never fire.
    this._playbackWatchdog = setTimeout(function () {
      self._playbackWatchdog = null;
      if (self._playing && self._currentAudio === audio) {
        self._log.log('tts', 'Playback watchdog fired — forcing completion');
        self._onComplete();
      }
    }, 30000);

    audio.onended = function () {
      self._log.log('tts', 'Playback complete');
      self._clearWatchdog();
      self._onComplete();
    };

    audio.onerror = function (e) {
      self._log.error('tts', 'Playback error: ' + e);
      self._log.error('tts', 'URL: ' + url);
      self._clearWatchdog();
      self._onComplete();
    };

    audio.src = url;
    audio.play().then(function () {
      self._log.log('tts', 'Playback started successfully');
    }).catch(function (e) {
      self._log.error('tts', 'play() failed: ' + e);
      self._clearWatchdog();
      self._onComplete(true);
    });

    this._currentAudio = audio;
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

    var config = this._card.config;
    if (config.tts_target && config.tts_target !== 'browser' && this._card.hass) {
      var self = this;
      this._card.hass.callService('media_player', 'media_stop', {
        entity_id: config.tts_target,
      }).catch(function (e) {
        self._log.error('tts', 'Remote stop failed: ' + e);
      });
    }
  }

  resetStreamingUrl() {
    this._streamingUrl = null;
  }

  storeStreamingUrl(eventData) {
    this._streamingUrl = null;
    if (eventData.tts_output && eventData.tts_output.url && eventData.tts_output.stream_response) {
      var url = eventData.tts_output.url;
      this._streamingUrl = url.startsWith('http') ? url : window.location.origin + url;
      this._log.log('tts', 'Streaming TTS URL available: ' + this._streamingUrl);
    }
  }

  // --- Chimes ---

  playChime(type) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      var volume = (this._card.config.chime_volume / 100) * 0.5;

      if (type === 'wake') {
        osc.type = 'sine';
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.frequency.setValueAtTime(523, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.16);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'error') {
        osc.type = 'square';
        gain.gain.setValueAtTime(volume * 0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.setValueAtTime(200, ctx.currentTime + 0.08);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else {
        // done chime
        osc.type = 'sine';
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.frequency.setValueAtTime(784, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }

      setTimeout(function () { ctx.close(); }, 500);
    } catch (e) {
      this._log.error('tts', 'Chime error: ' + e);
    }
  }

  // --- Private ---

  _clearWatchdog() {
    if (this._playbackWatchdog) {
      clearTimeout(this._playbackWatchdog);
      this._playbackWatchdog = null;
    }
  }

  _playRemote(url) {
    var self = this;
    var entityId = this._card.config.tts_target;

    this._log.log('tts', 'Playing on remote: ' + entityId + ' URL: ' + url);

    this._card.hass.callService('media_player', 'play_media', {
      entity_id: entityId,
      media_content_id: url,
      media_content_type: 'music',
    }).catch(function (e) {
      self._log.error('tts', 'Remote play failed: ' + e);
    });

    this._endTimer = setTimeout(function () {
      self._endTimer = null;
      self._onComplete();
    }, 2000);
  }

  _onComplete(playbackFailed) {
    this._log.log('tts', 'Complete — cleaning up UI' + (playbackFailed ? ' (playback failed)' : ''));
    this._currentAudio = null;
    this._playing = false;

    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }

    this._card.onTTSComplete(playbackFailed);
  }

  _buildUrl(urlPath) {
    if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
      return urlPath;
    }
    var baseUrl = window.location.origin;
    if (!urlPath.startsWith('/')) {
      urlPath = '/' + urlPath;
    }
    return baseUrl + urlPath;
  }
}