/**
 * Voice Satellite Card — UIManager
 *
 * Single owner of ALL DOM manipulation in the card.
 * Manages: global overlay, rainbow bar, blur overlay, start button,
 * chat bubbles, timer pills/alerts, notification bubbles,
 * and error flash animations.
 */

import { Timing } from '../constants.js';
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
      this.applyStyles();
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
      '<div class="vs-image-panel"><div class="vs-panel-scroll"></div></div>' +
      '<div class="vs-lightbox"><img class="vs-lightbox-img" /><iframe class="vs-lightbox-iframe" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>' +
      '<div class="vs-rainbow-bar"></div>';

    document.body.appendChild(ui);
    this._globalUI = ui;

    this._injectSkinCSS();
    this._applyCustomCSS();
    this._applyTextScale();
    this._applyBackgroundOpacity();

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
    this._injectSkinCSS();
    this._applyCustomCSS();
    this._applyTextScale();
    this._applyBackgroundOpacity();
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
      WAKE_WORD_DETECTED: { barVisible: true, animation: 'listening', useReactive: true },
      STT: { barVisible: true, animation: 'listening', useReactive: true },
      INTENT: { barVisible: true, animation: 'processing' },
      TTS: { barVisible: true, animation: 'speaking', useReactive: true },
      ERROR: { barVisible: false },
    };

    const config = states[state];
    if (!config) return;
    if (serviceUnavailable && !config.barVisible) return;
    if (ttsPlaying && !config.barVisible) return;

    const bar = this._globalUI.querySelector('.vs-rainbow-bar');

    const reactive = this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false;

    if (config.barVisible) {
      if (bar.classList.contains('error-mode')) this.clearErrorBar();
      bar.classList.add('visible');
      bar.classList.remove('connecting', 'listening', 'processing', 'speaking', 'reactive');
      if (config.animation) {
        bar.classList.add(config.animation);
      }
      if (reactive && config.useReactive) {
        bar.classList.add('reactive');
        this._globalUI.classList.add('reactive-mode');
        this._card.analyser.reconnectMic();
        this._card.analyser.start(bar);
      } else {
        bar.classList.remove('reactive');
        this._globalUI.classList.remove('reactive-mode');
      }
    } else {
      if (bar.classList.contains('error-mode')) this.clearErrorBar();
      bar.classList.remove('visible', 'connecting', 'listening', 'processing', 'speaking', 'reactive');
      this._globalUI.classList.remove('reactive-mode');
      if (reactive) this._card.analyser.stop();
    }
  }

  /**
   * Stop only the reactive bar (analyser + class) without hiding the bar.
   */
  stopReactive() {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('reactive');
    this._card.analyser.stop();
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
    if (!this._globalUI) return;
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
  }

  clearErrorBar() {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('error-mode');
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
    const reactive = this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false;
    bar.classList.add('visible', 'speaking');
    if (reactive) {
      bar.classList.add('reactive');
      this._globalUI.classList.add('reactive-mode');
      this._card.analyser.start(bar);
    }
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
    bar.classList.remove('speaking', 'reactive');
    this._globalUI.classList.remove('reactive-mode');
    if (this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false) this._card.analyser.stop();
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
   * Show the image panel with a 2-column grid of images.
   * @param {Array<{image_url: string, thumbnail_url?: string, title?: string}>} results
   * @param {boolean} [autoDisplay=false] - If true, auto-open lightbox with first image
   * @param {boolean} [featured=false] - If true, use narrower panel (featured image from web/wiki search)
   */
  showImagePanel(results, autoDisplay, featured) {
    if (!this._globalUI) return;
    const panel = this._globalUI.querySelector('.vs-image-panel');
    const scroll = panel.querySelector('.vs-panel-scroll');

    const items = results;
    const single = items.length === 1;

    const grid = document.createElement('div');
    grid.className = single ? 'vs-image-grid single' : 'vs-image-grid';

    let loaded = 0;
    for (const result of items) {
      const img = document.createElement('img');
      img.className = 'vs-panel-img';
      img.src = result.thumbnail_url || result.image_url;
      img.alt = result.title || '';
      img.loading = 'eager';
      img.onerror = () => {
        img.remove();
        if (!grid.hasChildNodes()) {
          panel.classList.remove('visible');
          this._globalUI.classList.remove('has-images');
        }
      };
      const fullSrc = result.image_url;
      img.addEventListener('click', () => this.showLightbox(fullSrc));
      img.style.cursor = 'pointer';
      grid.appendChild(img);
      loaded++;
    }

    if (loaded === 0) return;

    // Cancel linger timeout on first scroll — user is browsing
    if (!scroll._vsScrollHandler) {
      scroll._vsScrollHandler = () => {
        if (this._card._imageLingerTimeout) {
          clearTimeout(this._card._imageLingerTimeout);
          this._card._imageLingerTimeout = null;
        }
      };
      scroll.addEventListener('scroll', scroll._vsScrollHandler, { passive: true });
    }

    scroll.appendChild(grid);
    panel.classList.toggle('featured', !!featured);
    panel.classList.add('visible');
    this._globalUI.classList.toggle('has-featured', !!featured);
    if (!featured) this._globalUI.classList.add('has-images');

    // Auto-display: open lightbox with first image immediately
    if (autoDisplay && items.length > 0) {
      this.showLightbox(items[0].image_url);
    }
  }

  showVideoPanel(results, autoPlay) {
    if (!this._globalUI) return;
    const panel = this._globalUI.querySelector('.vs-image-panel');
    const scroll = panel.querySelector('.vs-panel-scroll');

    const grid = document.createElement('div');
    grid.className = 'vs-video-grid';

    let loaded = 0;
    for (const result of results) {
      const card = document.createElement('div');
      card.className = 'vs-video-card';

      // Thumbnail wrapper with duration badge
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'vs-video-thumb-wrap';

      const thumb = document.createElement('img');
      thumb.className = 'vs-video-thumb';
      thumb.src = result.thumbnail_url || '';
      thumb.alt = result.title || '';
      thumb.loading = 'eager';
      thumb.onerror = () => card.remove();
      thumbWrap.appendChild(thumb);

      if (result.duration) {
        const badge = document.createElement('span');
        badge.className = 'vs-video-duration';
        badge.textContent = this._parseDuration(result.duration);
        thumbWrap.appendChild(badge);
      }

      card.appendChild(thumbWrap);

      // Video info
      const info = document.createElement('div');
      info.className = 'vs-video-info';

      const title = document.createElement('div');
      title.className = 'vs-video-title';
      title.textContent = result.title || '';
      info.appendChild(title);

      const channel = document.createElement('div');
      channel.className = 'vs-video-channel';
      channel.textContent = result.channel_name || '';
      info.appendChild(channel);

      card.appendChild(info);

      const videoId = result.video_id;
      card.addEventListener('click', () => this.showVideoLightbox(videoId));
      card.style.cursor = 'pointer';
      grid.appendChild(card);
      loaded++;
    }

    if (loaded === 0) return;

    // Cancel linger timeout on first scroll — user is browsing
    if (!scroll._vsScrollHandler) {
      scroll._vsScrollHandler = () => {
        if (this._card._imageLingerTimeout) {
          clearTimeout(this._card._imageLingerTimeout);
          this._card._imageLingerTimeout = null;
        }
      };
      scroll.addEventListener('scroll', scroll._vsScrollHandler, { passive: true });
    }

    scroll.appendChild(grid);
    panel.classList.add('visible');
    this._globalUI.classList.add('has-images');

    // Auto-play: open lightbox with first video immediately
    if (autoPlay && results.length > 0) {
      this.showVideoLightbox(results[0].video_id);
    }
  }

  /**
   * Returns true if the image panel is currently visible.
   */
  hasVisibleImages() {
    if (!this._globalUI) return false;
    const panel = this._globalUI.querySelector('.vs-image-panel');
    return panel && panel.classList.contains('visible') && !panel.classList.contains('featured');
  }

  showLightbox(src) {
    if (!this._globalUI) return;
    const lb = this._globalUI.querySelector('.vs-lightbox');
    const img = lb.querySelector('.vs-lightbox-img');
    const iframe = lb.querySelector('.vs-lightbox-iframe');
    // Image mode — hide iframe, show img
    iframe.style.display = 'none';
    iframe.removeAttribute('src');
    img.style.display = '';
    img.src = src;
    lb.classList.add('visible');
    // Cancel the linger timeout — UI stays until user double-taps
    if (this._card._imageLingerTimeout) {
      clearTimeout(this._card._imageLingerTimeout);
      this._card._imageLingerTimeout = null;
    }
    // Tap lightbox to close it and return to the panel
    if (!lb._vsCloseHandler) {
      lb._vsCloseHandler = () => this.hideLightbox();
      lb.addEventListener('click', lb._vsCloseHandler);
    }
  }

  showVideoLightbox(videoId) {
    if (!this._globalUI) return;
    // Stop TTS if already playing, and suppress future TTS for this interaction
    if (this._card.tts.isPlaying) this._card.tts.stop();
    this._card._videoPlaying = true;
    const lb = this._globalUI.querySelector('.vs-lightbox');
    const img = lb.querySelector('.vs-lightbox-img');
    const iframe = lb.querySelector('.vs-lightbox-iframe');
    // Video mode — hide img, show iframe
    img.style.display = 'none';
    img.src = '';
    iframe.style.display = 'block';
    iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
    lb.classList.add('visible');
    // Cancel the linger timeout — UI stays until user double-taps
    if (this._card._imageLingerTimeout) {
      clearTimeout(this._card._imageLingerTimeout);
      this._card._imageLingerTimeout = null;
    }
    // Tap lightbox to close it and return to the panel
    if (!lb._vsCloseHandler) {
      lb._vsCloseHandler = () => this.hideLightbox();
      lb.addEventListener('click', lb._vsCloseHandler);
    }
  }

  hideLightbox() {
    if (!this._globalUI) return;
    this._card._videoPlaying = false;
    const lb = this._globalUI.querySelector('.vs-lightbox');
    lb.classList.remove('visible');
    lb.querySelector('.vs-lightbox-img').src = '';
    lb.querySelector('.vs-lightbox-img').style.display = '';
    const iframe = lb.querySelector('.vs-lightbox-iframe');
    iframe.removeAttribute('src');
    iframe.style.display = 'none';
  }

  _parseDuration(iso) {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
    if (!m) return iso;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const sec = parseInt(m[3] || '0', 10);
    if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  isLightboxVisible() {
    if (!this._globalUI) return false;
    const lb = this._globalUI.querySelector('.vs-lightbox');
    return lb && lb.classList.contains('visible');
  }

  /**
   * Clear all chat messages and the image panel.
   */
  clearChat() {
    if (!this._globalUI) return;
    const container = this._globalUI.querySelector('.vs-chat-container');
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.remove('visible');

    const panel = this._globalUI.querySelector('.vs-image-panel');
    if (panel) {
      const scroll = panel.querySelector('.vs-panel-scroll');
      if (scroll) {
        while (scroll.firstChild) scroll.removeChild(scroll.firstChild);
      }
      panel.classList.remove('visible', 'featured');
    }
    this._globalUI.classList.remove('has-images', 'has-featured');
    this.hideLightbox();
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

    pill.innerHTML =
      `<div class="vs-timer-progress" style="width:${pct}%"></div>` +
      '<div class="vs-timer-content">' +
        '<span class="vs-timer-icon">⏱</span>' +
        `<span class="vs-timer-time">${formatTime(timer.secondsLeft)}</span>` +
      '</div>';

    // Cache child references to avoid querySelector on every tick
    pill._vsTimeEl = pill.querySelector('.vs-timer-time');
    pill._vsProgressEl = pill.querySelector('.vs-timer-progress');

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
    const timeEl = el._vsTimeEl;
    if (timeEl) timeEl.textContent = formatTime(secondsLeft);

    const progressEl = el._vsProgressEl;
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

  _injectSkinCSS() {
    const skin = this._card._activeSkin;
    if (!skin?.css) return;
    let el = document.getElementById('voice-satellite-styles');
    if (!el) {
      el = document.createElement('style');
      el.id = 'voice-satellite-styles';
      document.head.appendChild(el);
    }
    el.textContent = skin.css;
  }

  _applyTextScale() {
    const scale = (this._card.config.text_scale || 100) / 100;
    document.documentElement.style.setProperty('--vs-text-scale', scale);
  }

  _applyBackgroundOpacity() {
    const overlay = this._globalUI?.querySelector('.vs-blur-overlay');
    if (!overlay) return;
    const skin = this._card._activeSkin;
    const c = skin?.overlayColor;
    if (c) {
      const skinDefault = Math.round((skin.defaultOpacity ?? 1) * 100);
      const alpha = (this._card.config.background_opacity ?? skinDefault) / 100;
      overlay.style.background = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
    }
  }

  _applyCustomCSS() {
    const css = this._card.config.custom_css || '';
    let el = document.getElementById('voice-satellite-custom-css');
    if (!css) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = 'voice-satellite-custom-css';
      document.head.appendChild(el);
    }
    el.textContent = css;
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
