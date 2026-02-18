/**
 * Voice Satellite Card — UIManager
 *
 * Manages the global overlay (outside Shadow DOM), rainbow bar, blur overlay,
 * start button, and state-driven visual updates.
 */

import STYLES from './styles.css';
import { seamlessGradient } from './constants.js';

export class UIManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._globalUI = null;
    this._pendingStartButtonReason = undefined;
  }

  get element() {
    return this._globalUI;
  }

  // --- Global UI Lifecycle ---

  ensureGlobalUI() {
    var alreadyExists = !!document.getElementById('voice-satellite-ui');

    if (alreadyExists) {
      this._globalUI = document.getElementById('voice-satellite-ui');
      this._flushPendingStartButton();
      return;
    }

    var ui = document.createElement('div');
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

    // Start button handler
    var self = this;
    ui.querySelector('.vs-start-btn').addEventListener('click', function () {
      self._card.onStartClick();
    });

    // Show start button by default
    var btn = ui.querySelector('.vs-start-btn');
    btn.classList.add('visible');
    btn.title = 'Tap to start voice assistant';

    this._flushPendingStartButton();
  }

  // --- Styles ---

  applyStyles() {
    if (!this._globalUI) return;
    var cfg = this._card.config;

    var bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.style.height = cfg.bar_height + 'px';
    bar.style[cfg.bar_position === 'top' ? 'top' : 'bottom'] = '0';
    bar.style[cfg.bar_position === 'top' ? 'bottom' : 'top'] = 'auto';
    bar.style.background = seamlessGradient(cfg.bar_gradient);
    bar.style.backgroundSize = '200% 100%';

    var blur = this._globalUI.querySelector('.vs-blur-overlay');
    if (cfg.background_blur) {
      blur.style.backdropFilter = 'blur(' + cfg.background_blur_intensity + 'px)';
      blur.style.webkitBackdropFilter = 'blur(' + cfg.background_blur_intensity + 'px)';
    } else {
      blur.style.backdropFilter = 'none';
      blur.style.webkitBackdropFilter = 'none';
    }

    var bubbleGap = 12;
    var barH = cfg.bar_height || 6;
    var chat = this._globalUI.querySelector('.vs-chat-container');
    if (cfg.bar_position === 'bottom') {
      chat.style.bottom = (barH + bubbleGap) + 'px';
      chat.style.top = 'auto';
    } else {
      chat.style.bottom = bubbleGap + 'px';
      chat.style.top = 'auto';
    }
  }

  // --- State-Driven Bar Updates ---

  updateForState(state, serviceUnavailable, ttsPlaying) {
    if (!this._globalUI) return;

    var states = {
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

    var config = states[state];
    if (!config) return;

    if (serviceUnavailable && !config.barVisible) return;
    if (ttsPlaying && !config.barVisible) return;

    var bar = this._globalUI.querySelector('.vs-rainbow-bar');

    if (config.barVisible) {
      if (bar.classList.contains('error-mode')) {
        this.clearErrorBar();
      }
      bar.classList.add('visible');
      bar.classList.remove('connecting', 'listening', 'processing', 'speaking');
      if (config.animation) {
        bar.classList.add(config.animation);
      }
    } else {
      if (bar.classList.contains('error-mode')) {
        this.clearErrorBar();
      }
      bar.classList.remove('visible', 'connecting', 'listening', 'processing', 'speaking');
    }
  }

  // --- Start Button ---

  showStartButton(reason) {
    if (!this._globalUI) {
      this._pendingStartButtonReason = reason;
      return;
    }
    var btn = this._globalUI.querySelector('.vs-start-btn');
    btn.classList.add('visible');

    if (reason === 'not-allowed') {
      btn.title = 'Tap to enable microphone';
    } else if (reason === 'not-found') {
      btn.title = 'No microphone found';
    } else if (reason === 'not-readable') {
      btn.title = 'Microphone unavailable - tap to retry';
    } else {
      btn.title = 'Tap to start voice assistant';
    }
  }

  hideStartButton() {
    if (!this._globalUI) return;
    this._globalUI.querySelector('.vs-start-btn').classList.remove('visible');
  }

  // --- Blur Overlay (reference-counted) ---

  showBlurOverlay(reason) {
    if (!this._globalUI || !this._card.config.background_blur) return;
    if (!this._blurReasons) this._blurReasons = {};
    this._blurReasons[reason || 'default'] = true;
    this._globalUI.querySelector('.vs-blur-overlay').classList.add('visible');
  }

  hideBlurOverlay(reason) {
    if (!this._globalUI) return;
    if (!this._blurReasons) this._blurReasons = {};
    delete this._blurReasons[reason || 'default'];

    // Only actually hide if no reasons remain
    var keys = Object.keys(this._blurReasons);
    if (keys.length === 0) {
      this._globalUI.querySelector('.vs-blur-overlay').classList.remove('visible');
    }
  }

  // --- Error Bar ---

  showErrorBar() {
    if (!this._globalUI) return;
    var bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('connecting', 'listening', 'processing', 'speaking');
    bar.classList.add('visible', 'error-mode');
    bar.style.background = 'linear-gradient(90deg, #ff4444, #ff6666, #cc2222, #ff4444, #ff6666, #cc2222, #ff4444)';
    bar.style.backgroundSize = '200% 100%';
  }

  clearErrorBar() {
    if (!this._globalUI) return;
    var bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('error-mode');
    bar.style.background = seamlessGradient(this._card.config.bar_gradient);
    bar.style.backgroundSize = '200% 100%';
  }

  hideBar() {
    if (!this._globalUI) return;
    this._globalUI.querySelector('.vs-rainbow-bar').classList.remove('visible');
  }

  // --- Private ---

  _injectGlobalStyles() {
    if (document.getElementById('voice-satellite-styles')) return;
    var style = document.createElement('style');
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