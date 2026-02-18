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

    this._playing = false;
    this._currentAudio = null;
    this._clearTimeout = null;
    this._barWasVisible = false;
    this._queued = null;
    this._unsubscribe = null;
    this._subscribed = false;
  }

  /**
   * Called from set hass() - ensures subscription is active.
   * Announcement detection is handled exclusively by the state_changed
   * subscription to avoid duplicate triggers.
   */
  update() {
    var config = this._card.config;
    if (!config.satellite_entity) return;

    // Only the active singleton instance should subscribe
    if (window._voiceSatelliteInstance && window._voiceSatelliteInstance !== this._card) return;

    // Set up persistent subscription (once)
    if (!this._subscribed) {
      var connection = this._card.connection;
      if (connection) {
        this._subscribe(connection, config.satellite_entity);
      }
    }
  }

  destroy() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._reconnectListener && this._card.connection) {
      this._card.connection.removeEventListener('ready', this._reconnectListener);
      this._reconnectListener = null;
    }
    this._subscribed = false;
  }

  // --- Subscription (survives idle/screensaver periods) ---

  _subscribe(connection, entityId) {
    this._subscribed = true;
    this._entityId = entityId;
    var self = this;

    this._doSubscribe(connection, entityId);

    // Re-subscribe when HA reconnects (e.g. after restart)
    if (!this._reconnectListener) {
      this._reconnectListener = function () {
        // Only re-subscribe if this card is still the active instance
        if (window._voiceSatelliteInstance && window._voiceSatelliteInstance !== self._card) return;

        self._log.log('announce', 'Connection reconnected — re-subscribing');
        if (self._unsubscribe) {
          try { self._unsubscribe(); } catch (e) {}
          self._unsubscribe = null;
        }
        var conn = self._card.connection;
        if (conn) {
          self._doSubscribe(conn, self._entityId);
        }
      };
      connection.addEventListener('ready', this._reconnectListener);
    }
  }

  _doSubscribe(connection, entityId) {
    var self = this;

    connection.subscribeEvents(function (event) {
      var data = event.data;
      if (!data || !data.new_state) return;
      if (data.entity_id !== entityId) return;

      var attrs = data.new_state.attributes || {};
      self._processAnnouncement(attrs);
    }, 'state_changed').then(function (unsub) {
      self._unsubscribe = unsub;
      self._log.log('announce', 'Subscribed to state changes for ' + entityId);

      // Immediate check for any pending announcement at subscription time
      var hass = self._card.hass;
      if (hass && hass.states && hass.states[entityId]) {
        var attrs = hass.states[entityId].attributes || {};
        self._processAnnouncement(attrs);
      }
    }).catch(function (err) {
      self._log.error('announce', 'Failed to subscribe: ' + err);
      self._subscribed = false;
    });
  }

  _processAnnouncement(attrs) {
    if (!attrs.announcement) return;

    var ann = attrs.announcement;
    if (!ann.id) return;

    // Window-level dedup — guarantees single processing regardless
    // of how many card/manager instances exist
    window._vsLastAnnounceId = window._vsLastAnnounceId || 0;
    if (ann.id <= window._vsLastAnnounceId) return;
    window._vsLastAnnounceId = ann.id;

    // New announcement detected
    if (this._playing) {
      this._log.log('announce', 'Announcement #' + ann.id + ' ignored - already playing');
      return;
    }

    // Queue if pipeline is active (not idle/listening)
    var cardState = this._card.currentState;
    var pipelineBusy = cardState === 'WAKE_WORD_DETECTED' ||
      cardState === 'STT' || cardState === 'INTENT' || cardState === 'TTS';
    if (pipelineBusy || this._card.tts.isPlaying) {
      if (!this._queued || this._queued.id !== ann.id) {
        this._queued = ann;
        this._log.log('announce', 'Announcement #' + ann.id + ' queued - pipeline busy (' + cardState + ')');
      }
      return;
    }

    this._queued = null;
    this._log.log('announce', 'New announcement #' + ann.id +
      ': message="' + (ann.message || '') +
      '" media="' + (ann.media_id || '') + '"' +
      (ann.start_conversation ? ' [start_conversation]' : ''));

    this._playAnnouncement(ann);
  }

  /**
   * Called when the pipeline returns to idle — checks for queued announcements.
   */
  playQueued() {
    if (!this._queued) return;
    var ann = this._queued;
    this._queued = null;

    if (ann.id <= (window._vsLastAnnounceId || 0)) return;
    if (this._playing) return;

    window._vsLastAnnounceId = ann.id;
    this._log.log('announce', 'Playing queued announcement #' + ann.id);
    this._playAnnouncement(ann);
  }

  _playAnnouncement(ann) {
    var self = this;
    this._playing = true;

    // Show blur overlay
    this._card.ui.showBlurOverlay('announcement');

    // Wake up screen (e.g., turn off Fully Kiosk screensaver)
    this._card.turnOffWakeWordSwitch();

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

    // ACK to the integration so async_announce/async_start_conversation unblocks
    this._sendAck(ann.id);

    // Check announcement type flags
    var startConversation = ann.start_conversation || false;
    var askQuestion = ann.ask_question || false;

    // Auto-clear the bubble and blur after a delay
    var self = this;
    var clearDelay = (this._card.config.announcement_display_duration || 5) * 1000;

    if (askQuestion) {
      // For ask_question: keep the question bubble visible, enter STT-only
      // mode, capture text and send back to integration. Both the question
      // bubble and the user's answer bubble will be cleared together.
      this._log.log('announce', 'Ask question requested — entering STT-only mode');

      // Don't clear the announcement bubble — keep it visible during STT
      // so the user can see the question while answering.
      this._card.ui.showBlurOverlay('pipeline');

      var pipeline = this._card.pipeline;
      if (pipeline) {
        var announceId = ann.id;
        // Play wake chime to signal the user should speak
        var isRemote = this._card.config.tts_target && this._card.config.tts_target !== 'browser';
        if (!isRemote) {
          this._card.tts.playChime('wake');
        }
        pipeline.restartContinue(null, {
          end_stage: 'stt',
          onSttEnd: function (text) {
            self._log.log('announce', 'Ask question STT result: "' + text + '"');

            // Start cleanup timer immediately — don't wait for WS round-trip
            var cleaned = false;
            var matchedResult = null;
            var cleanup = function () {
              if (cleaned) return;
              cleaned = true;
              if (matchedResult !== null && !matchedResult) {
                self._card.ui.clearErrorBar();
              }
              self._clearAnnouncement();
              self._card.chat.clear();
              self._card.ui.hideBlurOverlay('pipeline');
              pipeline.restart(0);
            };
            setTimeout(cleanup, 2000);

            // Send answer and handle feedback when result arrives
            self._sendQuestionAnswer(announceId, text).then(function (result) {
              var matched = result && result.matched;
              matchedResult = matched;
              var isRemote = self._card.config.tts_target && self._card.config.tts_target !== 'browser';
              if (!isRemote) {
                self._card.tts.playChime(matched ? 'done' : 'error');
              }

              if (!matched) {
                self._card.ui.showErrorBar();
                var bar = self._card.ui._globalUI
                  ? self._card.ui._globalUI.querySelector('.vs-rainbow-bar')
                  : null;
                if (bar) {
                  bar.classList.add('error-flash');
                  bar.addEventListener('animationend', function handler() {
                    bar.classList.remove('error-flash');
                    bar.removeEventListener('animationend', handler);
                  });
                }
              }
            });
          },
        });
      }
    } else if (startConversation) {
      // For start_conversation: clear announcement UI, then enter listening mode
      this._log.log('announce', 'Start conversation requested — entering STT mode');
      this._clearAnnouncement();

      // Show pipeline blur overlay and restart in STT mode (skip wake word)
      this._card.ui.showBlurOverlay('pipeline');
      var pipeline = this._card.pipeline;
      if (pipeline) {
        pipeline.restartContinue(null);
      }
    } else {
      this._clearTimeout = setTimeout(function () {
        self._clearAnnouncement();
      }, clearDelay);
    }
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

  _sendQuestionAnswer(announceId, sentence) {
    var connection = this._card.connection;
    var config = this._card.config;
    if (!connection || !config.satellite_entity) {
      this._log.error('announce', 'Cannot send question answer — no connection or entity');
      return Promise.resolve(null);
    }

    var self = this;
    return connection.sendMessagePromise({
      type: 'voice_satellite/question_answered',
      entity_id: config.satellite_entity,
      announce_id: announceId,
      sentence: sentence || '',
    }).then(function (result) {
      var matched = result && result.matched;
      var matchId = result && result.id;
      self._log.log('announce', 'Question answer sent for #' + announceId + ': "' + sentence + '" — matched: ' + matched + (matchId ? ' (id: ' + matchId + ')' : ''));
      return result;
    }).catch(function (err) {
      self._log.error('announce', 'Question answer failed: ' + (err.message || JSON.stringify(err)));
      return null;
    });
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