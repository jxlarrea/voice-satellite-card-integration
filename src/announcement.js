/**
 * Voice Satellite Card — AnnouncementManager
 *
 * Watches the satellite entity's state for announcement attributes.
 * When an announcement arrives:
 *   1. Show blur overlay (reason: 'announcement')
 *   2. Play pre-announcement chime (if provided, or default chime)
 *   3. Play announcement TTS audio
 *   4. Show message as a chat bubble
 *   5. ACK completion via WebSocket so the integration unblocks
 *   6. Auto-clear after configurable duration
 */

export class AnnouncementManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._lastAnnounceId = 0;
    this._playing = false;
    this._currentAudio = null;
    this._clearTimeout = null;
    this._barWasVisible = false;
  }

  /**
   * Called from set hass() — checks entity state for new announcements.
   */
  update() {
    var hass = this._card.hass;
    var config = this._card.config;
    if (!hass || !config.satellite_entity) return;

    var state = hass.states[config.satellite_entity];
    if (!state || !state.attributes || !state.attributes.announcement) return;

    var ann = state.attributes.announcement;
    if (!ann.id || ann.id <= this._lastAnnounceId) return;

    // New announcement detected
    if (this._playing) {
      this._log.log('announce', 'Announcement #' + ann.id + ' ignored — already playing');
      return;
    }
    this._lastAnnounceId = ann.id;
    this._log.log('announce', 'New announcement #' + ann.id +
      ': message="' + (ann.message || '') +
      '" media="' + (ann.media_id || '') + '"');

    this._playAnnouncement(ann);
  }

  _playAnnouncement(ann) {
    var self = this;
    this._playing = true;

    // Show blur overlay
    this._card.ui.showBlurOverlay('announcement');

    // Show activity bar in speaking mode (save current state to restore later)
    if (this._card.ui._globalUI) {
      var barEl = this._card.ui._globalUI.querySelector('.vs-rainbow-bar');
      if (barEl) {
        this._barWasVisible = barEl.classList.contains('visible');
        barEl.classList.add('visible', 'speaking');
      }
    }

    // Step 1: Play pre-announcement chime
    var hasPreAnnounce = ann.preannounce_media_id && ann.preannounce_media_id !== '';

    if (hasPreAnnounce) {
      // Play custom pre-announcement media
      this._log.log('announce', 'Playing pre-announcement media: ' + ann.preannounce_media_id);
      this._playMedia(ann.preannounce_media_id, function () {
        self._playMainAnnouncement(ann);
      });
    } else {
      // Play default chime (announcement-style: two-tone attention)
      this._playAnnouncementChime(function () {
        self._playMainAnnouncement(ann);
      });
    }
  }

  _playMainAnnouncement(ann) {
    var self = this;
    var mediaUrl = ann.media_id || '';

    // Show the message as a chat bubble
    if (ann.message) {
      this._showAnnouncementBubble(ann.message);
    }

    if (mediaUrl) {
      this._log.log('announce', 'Playing announcement media: ' + mediaUrl);
      this._playMedia(mediaUrl, function () {
        self._onAnnouncementComplete(ann);
      });
    } else {
      // No media — just show message briefly then complete
      this._log.log('announce', 'No media — completing after message display');
      setTimeout(function () {
        self._onAnnouncementComplete(ann);
      }, 3000);
    }
  }

  _onAnnouncementComplete(ann) {
    this._playing = false;
    this._currentAudio = null;

    this._log.log('announce', 'Announcement #' + ann.id + ' playback complete');

    // ACK to the integration so async_announce unblocks
    this._sendAck(ann.id);

    // Auto-clear the bubble and blur after a delay
    var self = this;
    var clearDelay = (this._card.config.announcement_display_duration || 5) * 1000;
    this._clearTimeout = setTimeout(function () {
      self._clearAnnouncement();
    }, clearDelay);
  }

  _clearAnnouncement() {
    if (this._clearTimeout) {
      clearTimeout(this._clearTimeout);
      this._clearTimeout = null;
    }

    // Clear the announcement bubble
    var ui = this._card.ui.element;
    if (ui) {
      var container = ui.querySelector('.vs-chat-container');
      var announcements = container ? container.querySelectorAll('.vs-chat-msg.announcement') : [];
      for (var i = 0; i < announcements.length; i++) {
        announcements[i].remove();
      }
      // If no other messages, hide the container
      if (container && !container.firstChild) {
        container.classList.remove('visible');
      }
    }

    // Remove blur overlay
    this._card.ui.hideBlurOverlay('announcement');

    // Restore activity bar to previous state
    if (this._card.ui._globalUI) {
      var barEl = this._card.ui._globalUI.querySelector('.vs-rainbow-bar');
      if (barEl) {
        barEl.classList.remove('speaking');
        if (!this._barWasVisible) {
          barEl.classList.remove('visible');
        }
      }
    }
  }

  _showAnnouncementBubble(message) {
    var ui = this._card.ui.element;
    if (!ui) return;
    var cfg = this._card.config;
    var container = ui.querySelector('.vs-chat-container');
    container.classList.add('visible');

    var msg = document.createElement('div');
    msg.className = 'vs-chat-msg announcement';
    msg.textContent = message;

    // Use response styling (same as assistant bubbles)
    msg.style.fontSize = cfg.response_font_size + 'px';
    msg.style.fontFamily = cfg.response_font_family;
    msg.style.color = cfg.response_font_color;
    msg.style.fontWeight = cfg.response_font_bold ? 'bold' : 'normal';
    msg.style.fontStyle = cfg.response_font_italic ? 'italic' : 'normal';
    msg.style.background = cfg.response_background;
    msg.style.border = '3px solid ' + cfg.response_border_color;
    msg.style.padding = cfg.response_padding + 'px';
    msg.style.borderRadius = cfg.response_rounded ? '12px' : '0';

    container.appendChild(msg);
  }

  _playAnnouncementChime(onDone) {
    try {
      var existingCtx = this._card.audio ? this._card.audio.audioContext : null;
      var ctx;
      var ownCtx = false;

      if (existingCtx && existingCtx.state !== 'closed') {
        ctx = existingCtx;
        if (ctx.state === 'suspended') ctx.resume();
      } else {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        ownCtx = true;
      }

      var volume = (this._card.config.chime_volume / 100) * 0.5;

      // Announcement chime: attention-getting two-tone ding-dong
      var notes = [
        { freq: 784, start: 0, end: 0.15 },
        { freq: 587, start: 0.18, end: 0.4 },
      ];

      for (var i = 0; i < notes.length; i++) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(notes[i].freq, ctx.currentTime + notes[i].start);
        gain.gain.setValueAtTime(0, ctx.currentTime + notes[i].start);
        gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + notes[i].start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + notes[i].end);
        osc.start(ctx.currentTime + notes[i].start);
        osc.stop(ctx.currentTime + notes[i].end);
      }

      // Wait for chime to finish, then proceed
      var chimeDuration = 500; // ms
      setTimeout(function () {
        if (ownCtx) ctx.close();
        if (onDone) onDone();
      }, chimeDuration);

      this._log.log('announce', 'Announcement chime played');
    } catch (e) {
      this._log.error('announce', 'Chime error: ' + e);
      if (onDone) onDone();
    }
  }

  _playMedia(urlPath, onDone) {
    var self = this;
    var config = this._card.config;

    // Build full URL
    var url = urlPath;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      if (!url.startsWith('/')) url = '/' + url;
      url = window.location.origin + url;
    }

    var audio = new Audio();
    audio.volume = config.tts_volume / 100;

    audio.onended = function () {
      self._log.log('announce', 'Media playback complete');
      self._currentAudio = null;
      if (onDone) onDone();
    };

    audio.onerror = function (e) {
      self._log.error('announce', 'Media playback error: ' + e);
      self._currentAudio = null;
      if (onDone) onDone();
    };

    audio.src = url;
    audio.play().then(function () {
      self._log.log('announce', 'Media playback started');
    }).catch(function (e) {
      self._log.error('announce', 'Media play() failed: ' + e);
      if (onDone) onDone();
    });

    this._currentAudio = audio;
  }

  _sendAck(announceId) {
    var connection = this._card.connection;
    var config = this._card.config;
    if (!connection || !config.satellite_entity) {
      this._log.error('announce', 'Cannot ACK — no connection or entity');
      return;
    }

    var self = this;
    connection.sendMessagePromise({
      type: 'voice_satellite/announce_finished',
      entity_id: config.satellite_entity,
      announce_id: announceId,
    }).then(function () {
      self._log.log('announce', 'ACK sent for announcement #' + announceId);
    }).catch(function (err) {
      self._log.error('announce', 'ACK failed: ' + (err.message || JSON.stringify(err)));
    });
  }
}