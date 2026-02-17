/**
 * Voice Satellite Card — TimerManager
 *
 * Watches the satellite entity's active_timers attribute and renders
 * countdown pill overlays.
 *
 * Timer lifecycle:
 * 1. HA state_changed → active_timers gets new entry → pill appears
 * 2. Local 1s tick counts down → pill updates in-place
 * 3. HA state_changed → active_timers entry removed + last_timer_event
 *    - "finished" → show alert (blur + chime + 0:00 display)
 *    - "cancelled" → silently remove pill
 * 4. Alert dismissed by double-tap or auto-dismiss timeout
 */

export class TimerManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._timers = [];
    this._tickInterval = null;
    this._container = null;
    this._unsubscribe = null;
    this._subscribed = false;

    // Track timer IDs so we can detect removals
    this._knownTimerIds = [];

    // Alert state
    this._alertActive = false;
    this._alertEl = null;
  }

  // --- Public API ---

  update() {
    if (this._subscribed) return;

    var config = this._card.config;
    if (!config.satellite_entity) return;

    var connection = this._card.connection;
    if (!connection) return;

    this._subscribe(connection, config.satellite_entity);
  }

  get isAlertActive() {
    return this._alertActive;
  }

  dismissAlert() {
    this._clearAlert();
  }

  destroy() {
    this._stopTick();
    this._removeContainer();
    this._clearAlert();
    this._timers = [];
    this._knownTimerIds = [];
    window._vsLastTimerJson = '';
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

  // --- Subscription ---

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

        self._log.log('timer', 'Connection reconnected — re-subscribing');
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
      self._processStateChange(attrs);
    }, 'state_changed').then(function (unsub) {
      self._unsubscribe = unsub;
      self._log.log('timer', 'Subscribed to state changes for ' + entityId);
    }).catch(function (err) {
      self._log.error('timer', 'Failed to subscribe: ' + err);
      self._subscribed = false;
    });

    // Immediate check
    var hass = self._card.hass;
    if (hass && hass.states && hass.states[entityId]) {
      var attrs = hass.states[entityId].attributes || {};
      self._processStateChange(attrs);
    }
  }

  // --- State Change Processing ---

  _processStateChange(attrs) {
    var rawTimers = attrs.active_timers;
    var lastEvent = attrs.last_timer_event;

    if (!rawTimers || !Array.isArray(rawTimers)) {
      rawTimers = [];
    }

    var rawJson = JSON.stringify(rawTimers);
    window._vsLastTimerJson = window._vsLastTimerJson || '';
    if (rawJson === window._vsLastTimerJson) return;

    this._log.log('timer', 'State changed: timers=' + rawJson + ' last_event=' + lastEvent);
    window._vsLastTimerJson = rawJson;

    // Detect which timers were removed
    var newIds = [];
    for (var i = 0; i < rawTimers.length; i++) {
      newIds.push(rawTimers[i].id);
    }

    var removedIds = [];
    for (var i = 0; i < this._knownTimerIds.length; i++) {
      if (newIds.indexOf(this._knownTimerIds[i]) === -1) {
        removedIds.push(this._knownTimerIds[i]);
      }
    }

    // If timers were removed and the last event was "finished", show alert
    if (removedIds.length > 0 && lastEvent === 'finished') {
      this._log.log('timer', 'Timer(s) finished: ' + removedIds.join(', '));
      if (!this._alertActive) {
        this._showAlert();
      }
    }

    // Remove pills for removed timers
    for (var i = 0; i < removedIds.length; i++) {
      this._removePill(removedIds[i]);
    }

    window._vsLastTimerJson = rawJson;
    this._knownTimerIds = newIds;

    // Sync remaining/new timers
    this._syncTimers(rawTimers);
  }

  _syncTimers(rawTimers) {
    if (rawTimers.length === 0) {
      this._timers = [];
      this._stopTick();
      this._removeContainer();
      return;
    }

    var now = Date.now();
    var newTimers = [];
    for (var i = 0; i < rawTimers.length; i++) {
      var raw = rawTimers[i];
      var existing = null;
      for (var j = 0; j < this._timers.length; j++) {
        if (this._timers[j].id === raw.id) {
          existing = this._timers[j];
          break;
        }
      }

      // Use server-side started_at (epoch seconds) to compute correct start
      var serverStartedAt = raw.started_at
        ? raw.started_at * 1000  // convert seconds to ms
        : now;

      if (existing) {
        if (existing.totalSeconds !== raw.total_seconds) {
          existing.totalSeconds = raw.total_seconds;
          existing.startedAt = serverStartedAt;
          var elapsed = Math.floor((now - serverStartedAt) / 1000);
          existing.secondsLeft = Math.max(0, raw.total_seconds - elapsed);
          existing.startHours = raw.start_hours || 0;
          existing.startMinutes = raw.start_minutes || 0;
          existing.startSeconds = raw.start_seconds || 0;
        }
        newTimers.push(existing);
      } else {
        var elapsed = Math.floor((now - serverStartedAt) / 1000);
        newTimers.push({
          id: raw.id,
          name: raw.name || '',
          totalSeconds: raw.total_seconds,
          secondsLeft: Math.max(0, raw.total_seconds - elapsed),
          startedAt: serverStartedAt,
          startHours: raw.start_hours || 0,
          startMinutes: raw.start_minutes || 0,
          startSeconds: raw.start_seconds || 0,
          el: null,
        });
      }
    }

    this._timers = newTimers;
    this._startTick();
    this._syncDOM();
  }

  // --- Tick ---

  _startTick() {
    if (this._tickInterval) return;
    var self = this;
    this._tickInterval = setInterval(function () {
      self._tick();
    }, 1000);
  }

  _stopTick() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  _tick() {
    var now = Date.now();

    for (var i = 0; i < this._timers.length; i++) {
      var t = this._timers[i];
      var elapsed = Math.floor((now - t.startedAt) / 1000);
      var left = t.totalSeconds - elapsed;
      if (left < 0) left = 0;

      t.secondsLeft = left;

      // Update DOM in-place
      if (t.el) {
        var timeEl = t.el.querySelector('.vs-timer-time');
        if (timeEl) timeEl.textContent = this._formatTime(left);

        var progressEl = t.el.querySelector('.vs-timer-progress');
        if (progressEl) {
          var pct = t.totalSeconds > 0
            ? Math.max(0, (left / t.totalSeconds) * 100)
            : 0;
          progressEl.style.width = pct + '%';
        }
      }
    }
  }

  // --- Alert (Timer Finished) ---

  _showAlert() {
    // Guard: if alert is already showing, don't create another one
    if (this._alertActive) {
      this._log.log('timer', 'Alert already active, skipping duplicate');
      return;
    }

    this._alertActive = true;
    var self = this;
    var cfg = this._card.config;

    this._log.log('timer', 'Showing finished alert');

    // Show blur overlay
    this._card.ui.showBlurOverlay('timer');

    // Wake up screen (e.g., turn off Fully Kiosk screensaver)
    this._card.turnOffWakeWordSwitch();

    // Create centered alert element
    this._alertEl = document.createElement('div');
    this._alertEl.className = 'vs-timer-alert';
    this._applyPillStyle(this._alertEl);

    this._alertEl.innerHTML =
      '<span class="vs-timer-icon">⏱</span>' +
      '<span class="vs-timer-time">00:00:00</span>';

    document.body.appendChild(this._alertEl);

    // Double-tap alert element to dismiss
    var alertLastTap = 0;
    function alertTapHandler(e) {
      var now = Date.now();
      if (now - alertLastTap < 400 && now - alertLastTap > 0) {
        e.preventDefault();
        e.stopPropagation();
        self._clearAlert();
      }
      alertLastTap = now;
    }
    this._alertEl.addEventListener('touchstart', alertTapHandler, { passive: false });
    this._alertEl.addEventListener('click', alertTapHandler);

    // Play chime immediately then loop every 3 seconds
    this._playAlertChime();
    // Use window-level globals so any card instance can clear them
    if (window.__vsTimerChimeInterval) clearInterval(window.__vsTimerChimeInterval);
    window.__vsTimerChimeInterval = setInterval(function () {
      self._playAlertChime();
    }, 3000);

    // Auto-dismiss after configured duration (0 = never)
    var duration = cfg.timer_finished_duration;
    if (duration > 0) {
      if (window.__vsTimerDismissTimeout) clearTimeout(window.__vsTimerDismissTimeout);
      window.__vsTimerDismissTimeout = setTimeout(function () {
        self._clearAlert();
      }, duration * 1000);
    }
  }

  _clearAlert() {
    if (!this._alertActive) return;
    this._alertActive = false;

    // Stop chime loop (window-level global)
    if (window.__vsTimerChimeInterval) {
      clearInterval(window.__vsTimerChimeInterval);
      window.__vsTimerChimeInterval = null;
    }

    // Cancel auto-dismiss (window-level global)
    if (window.__vsTimerDismissTimeout) {
      clearTimeout(window.__vsTimerDismissTimeout);
      window.__vsTimerDismissTimeout = null;
    }

    // Remove ALL alert elements from DOM
    var alerts = document.querySelectorAll('.vs-timer-alert');
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].parentNode) {
        alerts[i].parentNode.removeChild(alerts[i]);
      }
    }
    this._alertEl = null;

    // Clean up timer pills/container
    this._stopTick();
    this._removeContainer();
    this._timers = [];

    this._card.ui.hideBlurOverlay('timer');
    this._log.log('timer', 'Alert dismissed');
  }

  _playAlertChime() {
    try {
      // Reuse the card's existing AudioContext (already unlocked by user gesture)
      var existingCtx = this._card.audio ? this._card.audio.audioContext : null;
      var ctx;
      var ownCtx = false;

      if (existingCtx && existingCtx.state !== 'closed') {
        ctx = existingCtx;
        // Resume if suspended
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
      } else {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        ownCtx = true;
      }

      var volume = (this._card.config.chime_volume / 100) * 0.5;

      // Alert pattern: high-low-high
      var notes = [
        { freq: 880, start: 0, end: 0.15 },
        { freq: 660, start: 0.18, end: 0.33 },
        { freq: 880, start: 0.36, end: 0.55 },
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

      // Only close if we created our own context
      if (ownCtx) {
        setTimeout(function () { ctx.close(); }, 1000);
      }

      this._log.log('timer', 'Alert chime played (ctx.state=' + ctx.state + ')');
    } catch (e) {
      this._log.error('timer', 'Alert chime error: ' + e);
    }
  }

  // --- Cancel Timer (double-tap pill) ---

  cancelTimer(timerId) {
    this._log.log('timer', 'Cancelling timer: ' + timerId);

    // Find the timer to get its details for the cancel command
    var timer = null;
    for (var i = 0; i < this._timers.length; i++) {
      if (this._timers[i].id === timerId) {
        timer = this._timers[i];
        break;
      }
    }

    // Send cancel via conversation.process service
    var connection = this._card.connection;
    var hass = this._card.hass;
    var config = this._card.config;
    if (hass && config.satellite_entity) {
      var self = this;

      // Build cancel text — use timer name if available
      var cancelText = 'cancel the timer';
      if (timer && timer.name) {
        cancelText = 'cancel the ' + timer.name;
      }

      hass.callService('conversation', 'process', {
        text: cancelText,
        agent_id: 'conversation.home_assistant',
      }).then(function (result) {
        self._log.log('timer', 'Cancel service called successfully');
      }).catch(function (err) {
        self._log.error('timer', 'Cancel service failed: ' + (err.message || JSON.stringify(err)));
      });
    }

    // Remove pill with animation immediately for responsive UI
    this._removePill(timerId);

    // Remove from tracked timers
    for (var i = this._timers.length - 1; i >= 0; i--) {
      if (this._timers[i].id === timerId) {
        this._timers.splice(i, 1);
        break;
      }
    }

    // Remove from known IDs so we don't trigger alert on next state change
    for (var i = this._knownTimerIds.length - 1; i >= 0; i--) {
      if (this._knownTimerIds[i] === timerId) {
        this._knownTimerIds.splice(i, 1);
        break;
      }
    }

    // Update raw JSON cache to match
    window._vsLastTimerJson = '';

    if (this._timers.length === 0) {
      this._stopTick();
      var self = this;
      setTimeout(function () {
        if (self._timers.length === 0) {
          self._removeContainer();
        }
      }, 500);
    }
  }

  // --- DOM Management ---

  _ensureContainer() {
    if (this._container && document.body.contains(this._container)) return;

    var container = document.createElement('div');
    container.id = 'voice-satellite-timers';
    container.className = 'vs-timer-container';
    document.body.appendChild(container);
    this._container = container;
    this._applyPosition();
  }

  _applyPosition() {
    if (!this._container) return;
    var cfg = this._card.config;
    var barH = cfg.bar_height || 16;
    var gap = 12;
    var pos = cfg.timer_position || 'bottom-right';

    // Reset
    this._container.style.top = 'auto';
    this._container.style.bottom = 'auto';
    this._container.style.left = 'auto';
    this._container.style.right = 'auto';

    // Vertical — offset for activity bar if on same edge
    if (pos.indexOf('top') === 0) {
      var topOffset = (cfg.bar_position === 'top') ? (barH + gap) : gap;
      this._container.style.top = topOffset + 'px';
    } else {
      var bottomOffset = (cfg.bar_position === 'bottom') ? (barH + gap) : gap;
      this._container.style.bottom = bottomOffset + 'px';
    }

    // Horizontal
    if (pos.indexOf('left') !== -1) {
      this._container.style.left = gap + 'px';
    } else {
      this._container.style.right = gap + 'px';
    }
  }

  _removeContainer() {
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._container = null;
  }

  _removePill(timerId) {
    if (!this._container) return;
    var pills = this._container.querySelectorAll('.vs-timer-pill');
    for (var i = 0; i < pills.length; i++) {
      if (pills[i].getAttribute('data-timer-id') === timerId) {
        pills[i].classList.add('vs-timer-expired');
        (function (el) {
          setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
          }, 400);
        })(pills[i]);
        break;
      }
    }

    // Clear el reference on the timer object
    for (var j = 0; j < this._timers.length; j++) {
      if (this._timers[j].id === timerId) {
        this._timers[j].el = null;
        break;
      }
    }
  }

  _syncDOM() {
    this._ensureContainer();

    // Remove pills for timers that no longer exist
    var existing = this._container.querySelectorAll('.vs-timer-pill');
    for (var i = 0; i < existing.length; i++) {
      var pillId = existing[i].getAttribute('data-timer-id');
      var found = false;
      for (var k = 0; k < this._timers.length; k++) {
        if (this._timers[k].id === pillId) {
          found = true;
          break;
        }
      }
      if (!found) {
        existing[i].parentNode.removeChild(existing[i]);
      }
    }

    // Create pills for new timers
    for (var i = 0; i < this._timers.length; i++) {
      var t = this._timers[i];
      if (!t.el || !this._container.contains(t.el)) {
        t.el = this._createPill(t);
        this._container.appendChild(t.el);
      }
    }
  }

  _applyPillStyle(el) {
    var cfg = this._card.config;
    el.style.fontSize = cfg.timer_font_size + 'px';
    el.style.fontFamily = cfg.timer_font_family;
    el.style.color = cfg.timer_font_color;
    el.style.fontWeight = cfg.timer_font_bold ? 'bold' : 'normal';
    el.style.fontStyle = cfg.timer_font_italic ? 'italic' : 'normal';
    el.style.background = cfg.timer_background;
    el.style.border = '3px solid ' + cfg.timer_border_color;
    el.style.padding = cfg.timer_padding + 'px';
    el.style.borderRadius = cfg.timer_rounded ? '12px' : '0';
  }

  _createPill(timer) {
    var pct = timer.totalSeconds > 0
      ? Math.max(0, (timer.secondsLeft / timer.totalSeconds) * 100)
      : 0;

    var pill = document.createElement('div');
    pill.className = 'vs-timer-pill';
    pill.setAttribute('data-timer-id', timer.id);
    this._applyPillStyle(pill);

    var progressColor = this._card.config.timer_border_color || 'rgba(100, 200, 150, 0.5)';

    pill.innerHTML =
      '<div class="vs-timer-progress" style="width:' + pct + '%;background:' + progressColor + ';opacity:0.3"></div>' +
      '<div class="vs-timer-content">' +
        '<span class="vs-timer-icon">⏱</span>' +
        '<span class="vs-timer-time">' + this._formatTime(timer.secondsLeft) + '</span>' +
      '</div>';

    // Double-tap to cancel
    var self = this;
    var lastTap = 0;
    pill.addEventListener('touchstart', handleTap, { passive: false });
    pill.addEventListener('click', handleTap);

    function handleTap(e) {
      var now = Date.now();
      if (now - lastTap < 400 && now - lastTap > 0) {
        e.preventDefault();
        e.stopPropagation();
        self.cancelTimer(timer.id);
      }
      lastTap = now;
    }

    return pill;
  }

  _formatTime(seconds) {
    if (seconds < 0) seconds = 0;

    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;

    return (h < 10 ? '0' : '') + h + ':' +
           (m < 10 ? '0' : '') + m + ':' +
           (s < 10 ? '0' : '') + s;
  }
}