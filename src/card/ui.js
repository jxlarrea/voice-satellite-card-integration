/**
 * Voice Satellite Card — UIManager
 *
 * Single owner of ALL DOM manipulation in the card.
 * Manages: global overlay, rainbow bar, blur overlay, start button,
 * chat bubbles, timer pills/alerts, notification bubbles,
 * and error flash animations.
 */

import STYLES from '../styles.css';
import { seamlessGradient, Timing } from '../constants.js';
import { applyBubbleStyle as _applyBubbleStyleFn } from '../shared/style-utils.js';
import { formatTime } from '../shared/format.js';

export class UIManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._globalUI = null;
    this._pendingStartButtonReason = undefined;
    this._blurReasons = {};

    // Timer DOM state
    this._timerContainer = null;
    this._timerAlertEl = null;
  }

  get element() {
    return this._globalUI;
  }

  // ─── Global UI Lifecycle ──────────────────────────────────────────

  ensureGlobalUI() {
    const existing = document.getElementById('voice-satellite-ui');

    if (existing) {
      this._globalUI = existing;
      this._flushPendingStartButton();
      return;
    }

    const ui = document.createElement('div');
    ui.id = 'voice-satellite-ui';
    ui.innerHTML =
      '<div class="vs-blur-overlay"></div>' +
      '<button class="vs-start-btn">' +
      '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>' +
      '</button>' +
      '<div class="vs-chat-container"></div>' +
      '<div class="vs-rainbow-bar"></div>';

    document.body.appendChild(ui);
    this._globalUI = ui;

    this._injectGlobalStyles();
    this.applyStyles();

    ui.querySelector('.vs-start-btn').addEventListener('click', () => {
      this._card.onStartClick();
    });

    const btn = ui.querySelector('.vs-start-btn');
    btn.classList.add('visible');
    btn.title = 'Tap to start voice assistant';

    this._flushPendingStartButton();
  }

  // ─── Global Styles ────────────────────────────────────────────────

  applyStyles() {
    if (!this._globalUI) return;
    const cfg = this._card.config;

    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.style.height = `${cfg.bar_height}px`;
    bar.style[cfg.bar_position === 'top' ? 'top' : 'bottom'] = '0';
    bar.style[cfg.bar_position === 'top' ? 'bottom' : 'top'] = 'auto';
    bar.style.background = seamlessGradient(cfg.bar_gradient);
    bar.style.backgroundSize = '200% 100%';

    const blur = this._globalUI.querySelector('.vs-blur-overlay');
    if (cfg.background_blur) {
      blur.style.backdropFilter = `blur(${cfg.background_blur_intensity}px)`;
      blur.style.webkitBackdropFilter = `blur(${cfg.background_blur_intensity}px)`;
    } else {
      blur.style.backdropFilter = 'none';
      blur.style.webkitBackdropFilter = 'none';
    }

    const bubbleGap = 12;
    const barH = cfg.bar_height || 6;
    const chat = this._globalUI.querySelector('.vs-chat-container');
    if (cfg.bar_position === 'bottom') {
      chat.style.bottom = `${barH + bubbleGap}px`;
      chat.style.top = 'auto';
    } else {
      chat.style.bottom = `${bubbleGap}px`;
      chat.style.top = 'auto';
    }

    // Bubble layout style
    const isChatStyle = cfg.bubble_style === 'chat';
    chat.style.alignItems = isChatStyle ? 'flex-start' : 'center';
    chat.style.width = `${cfg.bubble_container_width || 80}%`;
    chat.style.maxWidth = `${cfg.bubble_container_width || 80}%`;

    // Apply alignment class for chat-style bubbles
    chat.setAttribute('data-bubble-style', cfg.bubble_style || 'centered');
  }

  /**
   * Apply bubble styling to an element based on config prefix.
   * @param {HTMLElement} el
   * @param {string} prefix - Config key prefix (e.g. 'timer', 'transcription', 'response')
   */
  applyBubbleStyle(el, prefix) {
    _applyBubbleStyleFn(el, this._card.config, prefix);
  }

  // ─── State-Driven Bar Updates ─────────────────────────────────────

  updateForState(state, serviceUnavailable, ttsPlaying) {
    if (!this._globalUI) return;

    // Don't touch the bar while a notification is playing — it manages its own bar state
    const notifPlaying = this._card.announcement.playing
      || this._card.askQuestion.playing
      || this._card.startConversation.playing;
    if (notifPlaying) return;

    const states = {
      IDLE: { barVisible: false },
      CONNECTING: { barVisible: false },
      LISTENING: { barVisible: false },
      PAUSED: { barVisible: false },
      WAKE_WORD_DETECTED: { barVisible: true, animation: 'listening' },
      STT: { barVisible: true, animation: 'listening' },
      INTENT: { barVisible: true, animation: 'processing' },
      TTS: { barVisible: true, animation: 'speaking' },
      ERROR: { barVisible: false },
    };

    const config = states[state];
    if (!config) return;
    if (serviceUnavailable && !config.barVisible) return;
    if (ttsPlaying && !config.barVisible) return;

    const bar = this._globalUI.querySelector('.vs-rainbow-bar');

    if (config.barVisible) {
      if (bar.classList.contains('error-mode')) this.clearErrorBar();
      bar.classList.add('visible');
      bar.classList.remove('connecting', 'listening', 'processing', 'speaking');
      if (config.animation) bar.classList.add(config.animation);
    } else {
      if (bar.classList.contains('error-mode')) this.clearErrorBar();
      bar.classList.remove('visible', 'connecting', 'listening', 'processing', 'speaking');
    }
  }

  // ─── Start Button ─────────────────────────────────────────────────

  showStartButton(reason) {
    if (!this._globalUI) {
      this._pendingStartButtonReason = reason;
      return;
    }
    const btn = this._globalUI.querySelector('.vs-start-btn');
    btn.classList.add('visible');

    const titles = {
      'not-allowed': 'Tap to enable microphone',
      'not-found': 'No microphone found',
      'not-readable': 'Microphone unavailable - tap to retry',
    };
    btn.title = titles[reason] || 'Tap to start voice assistant';
  }

  hideStartButton() {
    this._globalUI?.querySelector('.vs-start-btn')?.classList.remove('visible');
  }

  // ─── Blur Overlay (reference-counted) ─────────────────────────────

  showBlurOverlay(reason) {
    if (!this._globalUI || !this._card.config.background_blur) return;
    this._blurReasons[reason || 'default'] = true;
    this._globalUI.querySelector('.vs-blur-overlay').classList.add('visible');
  }

  hideBlurOverlay(reason) {
    if (!this._globalUI) return;
    delete this._blurReasons[reason || 'default'];

    if (Object.keys(this._blurReasons).length === 0) {
      this._globalUI.querySelector('.vs-blur-overlay').classList.remove('visible');
    }
  }

  // ─── Rainbow Bar ──────────────────────────────────────────────────

  showErrorBar() {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('connecting', 'listening', 'processing', 'speaking');
    bar.classList.add('visible', 'error-mode');
    bar.style.background = 'linear-gradient(90deg, #ff4444, #ff6666, #cc2222, #ff4444, #ff6666, #cc2222, #ff4444)';
    bar.style.backgroundSize = '200% 100%';
  }

  clearErrorBar() {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('error-mode');
    bar.style.background = seamlessGradient(this._card.config.bar_gradient);
    bar.style.backgroundSize = '200% 100%';
  }

  hideBar() {
    this._globalUI?.querySelector('.vs-rainbow-bar')?.classList.remove('visible');
  }


  /**
   * Show the bar in speaking mode, returning whether it was already visible.
   * @returns {boolean} Whether bar was previously visible
   */
  showBarSpeaking() {
    if (!this._globalUI) return false;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    if (!bar) return false;
    const wasVisible = bar.classList.contains('visible');
    bar.classList.add('visible', 'speaking');
    return wasVisible;
  }

  /**
   * Restore bar after notification playback.
   * @param {boolean} wasVisible - Whether bar was visible before notification
   */
  restoreBar(wasVisible) {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    if (!bar) return;
    bar.classList.remove('speaking');
    if (!wasVisible) {
      bar.classList.remove('visible');
    }
  }

  // ─── Chat Bubbles ─────────────────────────────────────────────────

  /**
   * Add a chat message bubble.
   * @param {string} text
   * @param {'user'|'assistant'|'announcement'} type
   * @returns {HTMLElement|null} The created element
   */
  addChatMessage(text, type) {
    if (!this._globalUI) return null;
    const container = this._globalUI.querySelector('.vs-chat-container');
    container.classList.add('visible');

    const msg = document.createElement('div');
    msg.className = `vs-chat-msg ${type}`;
    msg.textContent = text;

    const styleMap = { user: 'transcription', assistant: 'response', announcement: 'response' };
    this.applyBubbleStyle(msg, styleMap[type] || 'response');

    // Announcements are non-interactive — always centered
    if (type === 'announcement') {
      msg.style.alignSelf = 'center';
      msg.style.textAlign = 'center';
    }

    container.appendChild(msg);
    return msg;
  }

  /**
   * Update text content of an existing chat element.
   * @param {HTMLElement} el
   * @param {string} text
   */
  updateChatText(el, text) {
    if (el) el.textContent = text;
  }

  /**
   * Update inner HTML of an existing chat element (for streaming fade).
   * @param {HTMLElement} el
   * @param {string} html
   */
  updateChatHtml(el, html) {
    if (el) el.innerHTML = html;
  }

  /**
   * Clear all chat messages.
   */
  clearChat() {
    if (!this._globalUI) return;
    const container = this._globalUI.querySelector('.vs-chat-container');
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    container.classList.remove('visible');
  }

  /**
   * Toggle announcement-mode centering on the chat container.
   * @param {boolean} on
   */
  setAnnouncementMode(on) {
    if (!this._globalUI) return;
    const container = this._globalUI.querySelector('.vs-chat-container');
    if (!container) return;
    container.classList.toggle('announcement-mode', on);
  }

  /**
   * Clear only announcement bubbles.
   */
  clearAnnouncementBubbles() {
    if (!this._globalUI) return;
    const container = this._globalUI.querySelector('.vs-chat-container');
    const announcements = container?.querySelectorAll('.vs-chat-msg.announcement') || [];
    for (const el of announcements) el.remove();
    if (container && !container.firstChild) {
      container.classList.remove('visible');
    }
  }

  // ─── Timer Pills ──────────────────────────────────────────────────

  /**
   * Ensure the timer pill container exists in the DOM.
   */
  ensureTimerContainer() {
    if (this._timerContainer && document.body.contains(this._timerContainer)) return;

    const container = document.createElement('div');
    container.id = 'voice-satellite-timers';
    container.className = 'vs-timer-container';
    document.body.appendChild(container);
    this._timerContainer = container;
    this.applyTimerPosition();
  }

  /**
   * Position the timer container based on config.
   */
  applyTimerPosition() {
    if (!this._timerContainer) return;
    const cfg = this._card.config;
    const barH = cfg.bar_height || 16;
    const gap = 12;
    const pos = cfg.timer_position || 'top-right';

    this._timerContainer.style.top = 'auto';
    this._timerContainer.style.bottom = 'auto';
    this._timerContainer.style.left = 'auto';
    this._timerContainer.style.right = 'auto';

    if (pos.startsWith('top')) {
      const offset = cfg.bar_position === 'top' ? barH + gap : gap;
      this._timerContainer.style.top = `${offset}px`;
    } else {
      const offset = cfg.bar_position === 'bottom' ? barH + gap : gap;
      this._timerContainer.style.bottom = `${offset}px`;
    }

    if (pos.includes('left')) {
      this._timerContainer.style.left = `${gap}px`;
    } else {
      this._timerContainer.style.right = `${gap}px`;
    }
  }

  /**
   * Remove the timer container from the DOM.
   */
  removeTimerContainer() {
    this._timerContainer?.parentNode?.removeChild(this._timerContainer);
    this._timerContainer = null;
  }

  /**
   * Create a timer pill element.
   * @param {object} timer - Timer data { id, secondsLeft, totalSeconds }
   * @param {Function} onDoubleTap - Callback for double-tap cancel
   * @returns {HTMLElement}
   */
  createTimerPill(timer, onDoubleTap) {
    const pct = timer.totalSeconds > 0
      ? Math.max(0, (timer.secondsLeft / timer.totalSeconds) * 100)
      : 0;

    const pill = document.createElement('div');
    pill.className = 'vs-timer-pill';
    pill.setAttribute('data-timer-id', timer.id);
    this.applyBubbleStyle(pill, 'timer');

    const progressColor = this._card.config.timer_border_color || 'rgba(100, 200, 150, 0.5)';

    pill.innerHTML =
      `<div class="vs-timer-progress" style="width:${pct}%;background:${progressColor};opacity:0.3"></div>` +
      '<div class="vs-timer-content">' +
        '<span class="vs-timer-icon">⏱</span>' +
        `<span class="vs-timer-time">${formatTime(timer.secondsLeft)}</span>` +
      '</div>';

    if (onDoubleTap) {
      _attachDoubleTap(pill, onDoubleTap);
    }

    return pill;
  }

  /**
   * Sync timer pills to match the current timer list.
   * @param {Array} timers - Array of { id, secondsLeft, totalSeconds, el }
   * @param {Function} onDoubleTap - Factory: (timerId) => callback
   */
  syncTimerPills(timers, onDoubleTap) {
    this.ensureTimerContainer();

    // Remove pills for timers that no longer exist
    const existing = this._timerContainer.querySelectorAll('.vs-timer-pill');
    for (const pill of existing) {
      const pillId = pill.getAttribute('data-timer-id');
      if (!timers.some((t) => t.id === pillId)) {
        pill.parentNode.removeChild(pill);
      }
    }

    // Create pills for new timers
    for (const t of timers) {
      if (!t.el || !this._timerContainer.contains(t.el)) {
        t.el = this.createTimerPill(t, onDoubleTap(t.id));
        this._timerContainer.appendChild(t.el);
      }
    }
  }

  /**
   * Update a timer pill's display in-place.
   * @param {HTMLElement} el - Pill element
   * @param {number} secondsLeft
   * @param {number} totalSeconds
   */
  updateTimerPill(el, secondsLeft, totalSeconds) {
    if (!el) return;
    const timeEl = el.querySelector('.vs-timer-time');
    if (timeEl) timeEl.textContent = formatTime(secondsLeft);

    const progressEl = el.querySelector('.vs-timer-progress');
    if (progressEl) {
      const pct = totalSeconds > 0 ? Math.max(0, (secondsLeft / totalSeconds) * 100) : 0;
      progressEl.style.width = `${pct}%`;
    }
  }

  /**
   * Animate a timer pill as expired and remove it.
   * @param {string} timerId
   * @param {number} animationMs
   */
  expireTimerPill(timerId, animationMs) {
    if (!this._timerContainer) return;
    const pill = this._timerContainer.querySelector(`.vs-timer-pill[data-timer-id="${timerId}"]`);
    if (pill) {
      pill.classList.add('vs-timer-expired');
      setTimeout(() => pill.parentNode?.removeChild(pill), animationMs);
    }
  }

  // ─── Timer Alert ──────────────────────────────────────────────────

  /**
   * Show the full-screen timer finished alert.
   * @param {Function} onDoubleTap - Callback to dismiss
   */
  showTimerAlert(onDoubleTap) {
    this._timerAlertEl = document.createElement('div');
    this._timerAlertEl.className = 'vs-timer-alert';
    this.applyBubbleStyle(this._timerAlertEl, 'timer');

    this._timerAlertEl.innerHTML =
      '<span class="vs-timer-icon">⏱</span>' +
      '<span class="vs-timer-time">00:00:00</span>';

    document.body.appendChild(this._timerAlertEl);

    if (onDoubleTap) {
      _attachDoubleTap(this._timerAlertEl, onDoubleTap);
    }
  }

  /**
   * Remove all timer alert elements from the DOM.
   */
  clearTimerAlert() {
    for (const el of document.querySelectorAll('.vs-timer-alert')) {
      el.parentNode?.removeChild(el);
    }
    this._timerAlertEl = null;
  }

  // ─── Private ──────────────────────────────────────────────────────

  _injectGlobalStyles() {
    if (document.getElementById('voice-satellite-styles')) return;
    const style = document.createElement('style');
    style.id = 'voice-satellite-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  _flushPendingStartButton() {
    if (this._pendingStartButtonReason !== undefined) {
      this.showStartButton(this._pendingStartButtonReason);
      this._pendingStartButtonReason = undefined;
    }
  }
}

// ─── Module-level helpers (no DOM, pure logic) ────────────────────

function _attachDoubleTap(el, callback) {
  let lastTap = 0;
  const handler = (e) => {
    const now = Date.now();
    if (now - lastTap < Timing.DOUBLE_TAP_THRESHOLD && now - lastTap > 0) {
      e.preventDefault();
      e.stopPropagation();
      callback();
    }
    lastTap = now;
  };
  el.addEventListener('touchstart', handler, { passive: false });
  el.addEventListener('click', handler);
}