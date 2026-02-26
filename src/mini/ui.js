/**
 * Voice Satellite Mini Card - Local UIManager
 *
 * Local (non-fullscreen) card UI that implements the subset/superset of
 * UIManager APIs used by shared managers (pipeline, notifications, chat, timer).
 * Rich-media methods are intentionally no-ops.
 */

import { formatTime } from '../shared/format.js';
import { t } from '../i18n/index.js';

const MINI_CSS = `
:host {
  display: block;
  height: 100%;
  min-height: 0;
}
ha-card.vs-mini-card-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--ha-card-background, var(--card-background-color, transparent));
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, rgba(127,127,127,0.2)));
  box-shadow: var(--ha-card-box-shadow, none);
}
ha-card.vs-mini-card-shell.tall {
  height: 100%;
  min-height: 0;
  max-height: none;
}
/* Masonry has no row-based sizing, so give tall mode a sensible default height. */
:host-context(hui-masonry-view) ha-card.vs-mini-card-shell.tall {
  min-height: 180px;
}
ha-card.vs-mini-card-shell.compact {
  justify-content: center;
}
.vs-mini-root {
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: var(--ha-card-border-radius, 12px);
  background: var(--ha-card-background, var(--card-background-color, transparent));
  border: none;
  box-shadow: none;
  color: var(--primary-text-color, #fff);
  overflow: hidden;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  --vs-mini-font-size-sm: var(--ha-font-size-m, var(--paper-font-body1_-_font-size, var(--mdc-typography-body1-font-size, 13px)));
  --vs-mini-font-size-md: var(--ha-font-size-l, var(--ha-font-size-m, var(--paper-font-subhead_-_font-size, var(--paper-font-body1_-_font-size, var(--mdc-typography-body1-font-size, 14px)))));
}
.vs-mini-root.compact {
  min-height: 48px;
  justify-content: center;
}
.vs-mini-root.tall {
  min-height: 0;
  height: 100%;
}
.vs-mini-surface {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  min-width: 0;
  box-sizing: border-box;
}
.vs-mini-root.tall .vs-mini-surface {
  display: flex;
  flex-direction: column;
  height: 100%;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.vs-mini-blur {
  position: absolute;
  inset: 0;
  background: none;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}
.vs-mini-root.blur .vs-mini-blur {
  opacity: 0;
}
.vs-mini-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}
.vs-mini-root.compact .vs-mini-header {
  min-height: 0;
  flex: 0 0 auto;
}
.vs-mini-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--disabled-text-color, #6b7280);
  flex: 0 0 auto;
}
.vs-mini-dot.clickable {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: none;
  background: var(--primary-color, #03a9f4);
  color: var(--text-primary-color, var(--primary-background-color, #fff));
  cursor: pointer;
  transition: background 120ms ease, transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}
.vs-mini-dot.clickable svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}
.vs-mini-dot.clickable:hover {
  filter: brightness(1.08);
}
.vs-mini-dot.clickable:active {
  transform: scale(0.96);
}
.vs-mini-dot.clickable:focus-visible {
  outline: 2px solid var(--primary-color, #03a9f4);
  outline-offset: 1px;
}
.vs-mini-dot.connecting { background: var(--primary-color, #03a9f4); }
.vs-mini-dot.listening { background: var(--primary-color, #03a9f4); }
.vs-mini-dot.waiting { background: var(--success-color, #34d399); }
.vs-mini-dot.processing { background: var(--warning-color, #f59e0b); }
.vs-mini-dot.responding { background: var(--success-color, #34d399); }
.vs-mini-dot.error { background: var(--error-color, #ef4444); }
.vs-mini-dot.pulse {
  animation: vs-mini-dot-pulse 1.25s ease-in-out infinite;
  transform-origin: center;
}
@keyframes vs-mini-dot-pulse {
  0%, 100% {
    opacity: 0.75;
  }
  50% {
    opacity: 1;
  }
}
.vs-mini-status {
  font-size: calc(var(--vs-mini-font-size-sm) * var(--vs-mini-text-scale, 1));
  color: var(--secondary-text-color, rgba(255,255,255,0.7));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vs-mini-status.hidden {
  display: none;
}
.vs-mini-bar {
  display: none;
}
.vs-mini-body {
  display: block;
  min-width: 0;
}
.vs-mini-timers {
  display: none;
}
.vs-mini-root.compact .vs-mini-timers {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
.vs-mini-root.tall .vs-mini-timers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.vs-mini-root.tall .vs-mini-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.vs-mini-timer-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  color: var(--secondary-text-color, rgba(255,255,255,0.75));
  font-size: calc(var(--vs-mini-font-size-sm) * var(--vs-mini-text-scale, 1));
}
.vs-mini-timer-pill .vs-mini-timer-time {
  color: var(--primary-text-color, #fff);
  font-variant-numeric: tabular-nums;
}
.vs-mini-root.tall .vs-mini-timer-pill {
  background: var(--secondary-background-color, rgba(127,127,127,0.12));
  border-radius: 999px;
  padding: 2px 8px;
}
.vs-mini-timer-alert {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.vs-mini-timer-alert-text {
  color: var(--primary-text-color, #fff);
  background: var(--ha-card-background, var(--card-background-color, rgba(0,0,0,0.4)));
  border-radius: 999px;
  padding: 6px 10px;
  font-size: calc(var(--vs-mini-font-size-md) * var(--vs-mini-text-scale, 1));
}
.vs-mini-root.compact .vs-mini-surface {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.vs-mini-root.compact.notification-active .vs-mini-surface {
  gap: 4px;
}
.vs-mini-root.tall .vs-mini-line {
  display: none;
}
.vs-mini-root.compact .vs-mini-body {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  flex: 1 1 auto;
  min-width: 0;
}
.vs-mini-root.compact.notification-active .vs-mini-body {
  gap: 4px;
}
.vs-mini-line {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
  font-size: calc(var(--vs-mini-font-size-md) * var(--vs-mini-text-scale, 1));
  line-height: 1.35;
}
.vs-mini-line::-webkit-scrollbar {
  display: none;
}
.vs-mini-line .vs-mini-msg {
  display: inline;
}
.vs-mini-line .vs-mini-sep {
  opacity: 0.35;
  margin: 0 6px;
  font-weight: 700;
}
.vs-mini-line .user { color: var(--secondary-text-color, rgba(255,255,255,0.75)); }
.vs-mini-line .assistant { color: var(--primary-text-color, #fff); }
.vs-mini-line .announcement { color: var(--primary-text-color, #fff); }
.vs-mini-transcript {
  display: none;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--divider-color, rgba(127,127,127,0.5)) transparent;
}
.vs-mini-root.tall .vs-mini-transcript {
  display: block;
  flex: 1 1 0;
  min-height: 0;
  height: 0;
}
.vs-mini-root.tall .vs-mini-transcript::-webkit-scrollbar {
  width: 8px;
}
.vs-mini-root.tall .vs-mini-transcript::-webkit-scrollbar-track {
  background: transparent;
}
.vs-mini-root.tall .vs-mini-transcript::-webkit-scrollbar-thumb {
  background: var(--divider-color, rgba(127,127,127,0.5));
  border-radius: 999px;
}
.vs-mini-root.tall .vs-mini-transcript::-webkit-scrollbar-thumb:hover {
  background: var(--secondary-text-color, rgba(127,127,127,0.8));
}
.vs-mini-msg {
  font-size: calc(var(--vs-mini-font-size-md) * var(--vs-mini-text-scale, 1));
  line-height: 1.35;
  word-break: break-word;
}
.vs-mini-root.tall .vs-mini-msg + .vs-mini-msg {
  margin-top: 6px;
}
.vs-mini-root.tall .vs-mini-transcript .vs-mini-msg {
  flex: 0 0 auto;
}
.vs-mini-transcript .vs-mini-msg.user {
  color: var(--secondary-text-color, rgba(255,255,255,0.75));
}
.vs-mini-transcript .vs-mini-msg.assistant {
  color: var(--primary-text-color, #fff);
}
.vs-mini-transcript .vs-mini-msg.announcement {
  color: var(--primary-text-color, #fff);
}
.vs-mini-start {
  display: none;
  align-self: flex-start;
  border: none;
  border-radius: 999px;
  padding: 6px 10px;
  font-size: calc(var(--vs-mini-font-size-sm) * var(--vs-mini-text-scale, 1));
  background: none;
  color: var(--primary-color, #03a9f4);
  cursor: pointer;
}
.vs-mini-start.visible {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
`;

export class MiniUIManager {
  constructor(card) {
    this._card = card;
    this._root = null;
    this._shellEl = null;
    this._surface = null;
    this._statusEl = null;
    this._dotEl = null;
    this._lineEl = null;
    this._transcriptEl = null;
    this._timersEl = null;
    this._timerAlertEl = null;
    this._startBtn = null;
    this._barEl = null;
    this._blurReasons = {};
    this._pendingStartButtonReason = undefined;
    this._notificationStatus = null;
    this._marqueeRaf = null;
    this._marqueePauseUntil = 0;
    this._marqueeLastTs = 0;
  }

  get element() {
    return this._root;
  }

  ensureLocalUI() {
    const shadow = this._card.shadowRoot;
    if (!shadow) return;

    if (this._root && shadow.contains(this._root)) {
      this.applyStyles();
      this._flushPendingStartButton();
      return;
    }

    shadow.innerHTML = `
      <style id="vs-mini-style">${MINI_CSS}</style>
      <style id="vs-mini-custom-style"></style>
      <ha-card class="vs-mini-card-shell">
        <div class="vs-mini-root ${this._modeClass()}">
          <div class="vs-mini-surface">
            <div class="vs-mini-blur"></div>
            <div class="vs-mini-header">
              <span class="vs-mini-dot"></span>
              <div class="vs-mini-status">Idle</div>
            </div>
            <div class="vs-mini-body">
              <div class="vs-mini-timers"></div>
              <div class="vs-mini-line"></div>
              <button class="vs-mini-start">${this._t('mini.start_button', 'Start')}</button>
              <div class="vs-mini-bar"></div>
              <div class="vs-mini-transcript"></div>
            </div>
          </div>
        </div>
      </ha-card>
    `;

    this._root = shadow.querySelector('.vs-mini-root');
    this._shellEl = shadow.querySelector('.vs-mini-card-shell');
    this._surface = shadow.querySelector('.vs-mini-surface');
    this._statusEl = shadow.querySelector('.vs-mini-status');
    this._dotEl = shadow.querySelector('.vs-mini-dot');
    this._lineEl = shadow.querySelector('.vs-mini-line');
    this._transcriptEl = shadow.querySelector('.vs-mini-transcript');
    this._timersEl = shadow.querySelector('.vs-mini-timers');
    this._startBtn = shadow.querySelector('.vs-mini-start');
    this._barEl = shadow.querySelector('.vs-mini-bar');

    this._startBtn?.addEventListener('click', () => this._card.onStartClick());
    this._dotEl?.addEventListener('click', () => {
      if (this._dotEl?.classList.contains('clickable')) this._card.onStartClick();
    });

    this.applyStyles();
    this._flushPendingStartButton();
  }

  applyStyles() {
    if (!this._root) return;
    this._shellEl?.classList.remove('compact', 'tall');
    this._shellEl?.classList.add(this._modeClass());
    this._root.classList.remove('compact', 'tall');
    this._root.classList.add(this._modeClass());
    this._applyTextScale();
    this._applyCustomCSS();
    this.updateForState(
      this._card.currentState,
      this._card.pipeline?.serviceUnavailable,
      this._card.tts?.isPlaying,
    );
    if (this._card.config.mini_mode === 'compact') this._refreshCompactMarquee();
    else this._stopMarquee();
  }

  updateForState(state, serviceUnavailable, ttsPlaying) {
    if (!this._root) return;

    // Compact mode UX: avoid a brief CONNECTING blue-dot flash during page-load
    // auto-start attempts and immediately after tapping the mic button. Keep the
    // idle mic-button presentation until startup either succeeds (next state) or
    // fails back to IDLE.
    if (
      this._card.config.mini_mode === 'compact'
      && state === 'CONNECTING'
      && this._dotEl?.classList.contains('clickable')
    ) {
      return;
    }

    const status = this._notificationStatus || this._statusFor(state, serviceUnavailable, ttsPlaying);
    this._root.classList.toggle('notification-active', !!status.kind);
    this._root.classList.toggle('notification-announcement', status.kind === 'announcement');
    this._root.classList.toggle('notification-conversation', status.kind === 'conversation');
    this._root.classList.toggle('notification-question', status.kind === 'question');
    if (this._statusEl) {
      this._statusEl.textContent = status.label;
      const showCompactStatus = status.showCompactStatus !== false;
      this._statusEl.classList.toggle(
        'hidden',
        this._card.config.mini_mode === 'compact' && !showCompactStatus,
      );
    }
    if (this._dotEl) {
      this._dotEl.className = `vs-mini-dot ${status.dot || ''}`;
      this._dotEl.classList.toggle('clickable', !!status.micAction);
      this._dotEl.title = status.micAction ? this._t('mini.state.tap_to_start', 'Tap to start') : '';
      this._dotEl.innerHTML = status.micAction
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>'
        : '';
    }
  }

  stopReactive() {}

  showStartButton(reason) {
    // Mini card uses the idle mic icon in the status row as the start affordance.
    // Keep the hidden button unused to preserve a compact single-line layout.
    const _ = reason;
    if (this._startBtn) this._startBtn.classList.remove('visible');
    // Force the compact/tall status row into the idle gesture-required state.
    // This protects against startup attempts that leave the last visual state
    // as CONNECTING (blue dot) before the fallback UI is shown.
    this.updateForState('IDLE', false, false);
  }

  hideStartButton() {
    this._startBtn?.classList.remove('visible');
  }

  showBlurOverlay(reason) {
    this._blurReasons[reason || 'default'] = true;
    this._root?.classList.add('blur');
  }

  hideBlurOverlay(reason) {
    delete this._blurReasons[reason || 'default'];
    if (Object.keys(this._blurReasons).length === 0) {
      this._root?.classList.remove('blur');
    }
  }

  showErrorBar() {
    this.updateForState(this._card.currentState, true, this._card.tts?.isPlaying);
  }

  clearErrorBar() {
  }

  hideBar() {}

  getTtsLingerTimeoutMs() {
    // Compact mode only: if the marquee is actively scrolling, keep the text
    // visible a bit longer after TTS completes so the user can read it.
    if (this._card.config.mini_mode !== 'compact') return 0;
    return this._marqueeRaf ? 6000 : 0;
  }

  showBarSpeaking() {
    this._notificationStatus = this._getNotificationStatus();
    this.updateForState(this._card.currentState, this._card.pipeline?.serviceUnavailable, this._card.tts?.isPlaying);
    return false;
  }

  clearNotificationStatusOverride() {
    this._notificationStatus = null;
    this.updateForState(this._card.currentState, this._card.pipeline?.serviceUnavailable, this._card.tts?.isPlaying);
  }

  restoreBar(_wasVisible) {
    this._notificationStatus = null;
    this.updateForState(this._card.currentState, this._card.pipeline?.serviceUnavailable, this._card.tts?.isPlaying);
  }

  addChatMessage(text, type) {
    if (!this._root) return null;
    if (this._card.config.mini_mode === 'compact') {
      if (this._lineEl?.childNodes?.length) {
        const sep = document.createElement('span');
        sep.className = 'vs-mini-sep';
        sep.textContent = '→';
        this._lineEl.appendChild(sep);
      }
      const el = document.createElement('span');
      el.className = `vs-mini-msg ${type}`;
      el.textContent = text;
      this._lineEl?.appendChild(el);
      this._scrollLineToEnd();
      return el;
    }

    const el = document.createElement('div');
    el.className = `vs-mini-msg ${type}`;
    el.textContent = text;
    this._transcriptEl?.appendChild(el);
    this._scrollTranscriptToEnd();
    return el;
  }

  updateChatText(el, text) {
    if (!el) return;
    el.textContent = text;
    if (this._card.config.mini_mode === 'compact') this._refreshCompactMarquee();
    else this._scrollTranscriptToEnd();
  }

  updateChatHtml(el, html) {
    if (!el) return;
    el.innerHTML = html;
    if (this._card.config.mini_mode === 'compact') this._refreshCompactMarquee();
    else this._scrollTranscriptToEnd();
  }

  showImagePanel() {}
  showVideoPanel() {}
  showWeatherPanel() {}
  showFinancialPanel() {}
  hasVisibleImages() { return false; }
  showLightbox() {}
  showVideoLightbox() {}
  hideLightbox() {}
  isLightboxVisible() { return false; }

  clearChat() {
    if (this._lineEl) this._lineEl.innerHTML = '';
    if (this._transcriptEl) this._transcriptEl.innerHTML = '';
    this._stopMarquee();
  }

  setAnnouncementMode(on) {
    this._root?.classList.toggle('announcement-mode', !!on);
  }

  clearAnnouncementBubbles() {
    for (const el of this._root?.querySelectorAll('.vs-mini-msg.announcement') || []) {
      el.remove();
    }
    if (this._card.config.mini_mode === 'compact') {
      // Also remove separators left dangling in compact mode.
      this._normalizeCompactSeparators();
    }
  }

  ensureTimerContainer() {
    if (!this._timersEl && this._card.shadowRoot) {
      this._timersEl = this._card.shadowRoot.querySelector('.vs-mini-timers');
    }
  }

  removeTimerContainer() {
    this.ensureTimerContainer();
    if (this._timersEl) this._timersEl.innerHTML = '';
  }

  createTimerPill(timer, onDoubleTap) {
    const pill = document.createElement('div');
    pill.className = 'vs-mini-timer-pill';
    pill.dataset.timerId = timer.id;
    pill.innerHTML = '<span class="vs-mini-timer-icon">⏱</span><span class="vs-mini-timer-time"></span>';
    pill._vsTimeEl = pill.querySelector('.vs-mini-timer-time');
    this.updateTimerPill(pill, timer.secondsLeft, timer.totalSeconds);
    if (onDoubleTap) _attachMiniDoubleTap(pill, onDoubleTap);
    return pill;
  }

  syncTimerPills(timers, onDoubleTap) {
    this.ensureTimerContainer();
    if (!this._timersEl) return;

    const visibleTimers = this._card.config.mini_mode === 'compact'
      ? (timers.length
        ? [timers.reduce((a, b) => (a.secondsLeft <= b.secondsLeft ? a : b))]
        : [])
      : timers;

    const visibleIds = new Set(visibleTimers.map((t) => t.id));

    for (const child of Array.from(this._timersEl.children)) {
      if (!visibleIds.has(child.dataset.timerId)) child.remove();
    }

    for (const t of timers) {
      if (!visibleIds.has(t.id)) {
        if (t.el && t.el.parentNode === this._timersEl) t.el.remove();
        t.el = null;
      }
    }

    for (const t of visibleTimers) {
      if (!t.el || !this._timersEl.contains(t.el)) {
        t.el = this.createTimerPill(t, onDoubleTap(t.id));
        this._timersEl.appendChild(t.el);
      }
      this.updateTimerPill(t.el, t.secondsLeft, t.totalSeconds);
    }
  }

  updateTimerPill(el, secondsLeft) {
    if (!el) return;
    const timeEl = el._vsTimeEl || el.querySelector('.vs-mini-timer-time');
    if (timeEl) timeEl.textContent = formatTime(secondsLeft);
  }

  expireTimerPill(timerId) {
    this.ensureTimerContainer();
    const pill = this._timersEl?.querySelector(`.vs-mini-timer-pill[data-timer-id="${timerId}"]`);
    if (pill) pill.remove();
  }

  showTimerAlert(onDoubleTap) {
    this.clearTimerAlert();
    if (!this._root) return;
    const alert = document.createElement('div');
    alert.className = 'vs-mini-timer-alert';
    alert.innerHTML = `<div class="vs-mini-timer-alert-text">⏱ ${this._t('mini.timer.finished', 'Timer finished')}</div>`;
    if (onDoubleTap) _attachMiniDoubleTap(alert, onDoubleTap);
    alert.addEventListener('click', () => onDoubleTap?.());
    this._root.appendChild(alert);
    this._timerAlertEl = alert;
  }

  clearTimerAlert() {
    if (this._timerAlertEl) {
      this._timerAlertEl.remove();
      this._timerAlertEl = null;
    }
    for (const el of this._root?.querySelectorAll('.vs-mini-timer-alert') || []) el.remove();
  }

  _modeClass() {
    return this._card.config.mini_mode === 'tall' ? 'tall' : 'compact';
  }

  _statusFor(state, serviceUnavailable, ttsPlaying) {
    if (serviceUnavailable) return { label: this._t('mini.state.service_unavailable', 'Service unavailable'), dot: 'error', showCompactStatus: false };
    if (ttsPlaying || state === 'TTS') return { label: this._t('mini.state.responding', 'Responding'), dot: 'responding', showCompactStatus: false };
    switch (state) {
      case 'CONNECTING': return { label: this._t('mini.state.connecting', 'Connecting'), dot: 'connecting', showCompactStatus: false };
      case 'WAKE_WORD_DETECTED': return { label: this._t('mini.state.wake_word_detected', 'Wake word detected'), dot: 'listening', showCompactStatus: false };
      case 'STT': return { label: this._t('mini.state.listening', 'Listening'), dot: 'listening pulse', showCompactStatus: false };
      case 'INTENT': return { label: this._t('mini.state.processing', 'Processing'), dot: 'processing', showCompactStatus: false };
      case 'PAUSED': return { label: this._t('mini.state.paused', 'Paused'), dot: '', showCompactStatus: false };
      case 'ERROR': return { label: this._t('mini.state.error', 'Error'), dot: 'error', showCompactStatus: false };
      case 'LISTENING': return { label: this._t('mini.state.waiting_for_wake_word', 'Waiting for wake word'), dot: 'waiting pulse', showCompactStatus: true };
      case 'IDLE':
      default: return { label: this._t('mini.state.tap_to_start', 'Tap to start'), dot: '', micAction: true, showCompactStatus: true };
    }
  }

  _getNotificationStatus() {
    const arrow = this._t('mini.notification.arrow_suffix', ' →');
    if (this._card.askQuestion?.playing) {
      return { label: `${this._t('mini.notification.question', 'Question')}${arrow}`, dot: 'responding', showCompactStatus: true, kind: 'question' };
    }
    if (this._card.startConversation?.playing) {
      return { label: `${this._t('mini.notification.conversation', 'Conversation')}${arrow}`, dot: 'responding', showCompactStatus: true, kind: 'conversation' };
    }
    if (this._card.announcement?.playing) {
      return { label: `${this._t('mini.notification.announcement', 'Announcement')}${arrow}`, dot: 'responding', showCompactStatus: true, kind: 'announcement' };
    }
    return { label: this._t('mini.state.responding', 'Responding'), dot: 'responding', showCompactStatus: true };
  }

  _scrollLineToEnd() {
    this._refreshCompactMarquee();
  }

  _scrollTranscriptToEnd() {
    if (!this._transcriptEl) return;
    requestAnimationFrame(() => {
      this._transcriptEl.scrollTop = this._transcriptEl.scrollHeight;
    });
  }

  _normalizeCompactSeparators() {
    if (!this._lineEl) return;
    const nodes = Array.from(this._lineEl.childNodes);
    let sawMsg = false;
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || !node.classList.contains('vs-mini-sep')) {
        sawMsg = true;
        continue;
      }
      const prev = node.previousElementSibling;
      const next = node.nextElementSibling;
      if (!prev || !next) node.remove();
    }
    if (!sawMsg) this._lineEl.innerHTML = '';
    this._refreshCompactMarquee();
  }

  _refreshCompactMarquee() {
    if (!this._lineEl || this._card.config.mini_mode !== 'compact') return;
    requestAnimationFrame(() => {
      if (!this._lineEl) return;
      const max = Math.max(0, this._lineEl.scrollWidth - this._lineEl.clientWidth);
      if (max <= 0) {
        this._lineEl.scrollLeft = 0;
        this._stopMarquee();
        return;
      }
      // Do not reset to the beginning on each new turn. Continue from the
      // current position and only scroll forward to the new end.
      if (this._lineEl.scrollLeft > max) this._lineEl.scrollLeft = max;
      if (this._lineEl.scrollLeft >= max) {
        this._stopMarquee();
        return;
      }
      this._marqueePauseUntil = performance.now() + 250;
      this._startMarquee();
    });
  }

  _startMarquee() {
    if (this._marqueeRaf) return;
    this._marqueeLastTs = 0;
    this._marqueeRaf = requestAnimationFrame((ts) => this._marqueeTick(ts));
  }

  _stopMarquee() {
    if (this._marqueeRaf) {
      cancelAnimationFrame(this._marqueeRaf);
      this._marqueeRaf = null;
    }
    this._marqueeLastTs = 0;
  }

  _marqueeTick(ts) {
    if (!this._lineEl || this._card.config.mini_mode !== 'compact') {
      this._stopMarquee();
      return;
    }

    const max = Math.max(0, this._lineEl.scrollWidth - this._lineEl.clientWidth);
    if (max <= 0) {
      this._lineEl.scrollLeft = 0;
      this._stopMarquee();
      return;
    }

    if (!this._marqueeLastTs) this._marqueeLastTs = ts;
    const dt = ts - this._marqueeLastTs;
    this._marqueeLastTs = ts;

    if (ts >= this._marqueePauseUntil) {
      const speedPxPerSec = 42;
      let next = this._lineEl.scrollLeft + (speedPxPerSec * dt / 1000);

      if (next >= max) {
        next = max;
        this._lineEl.scrollLeft = next;
        this._stopMarquee();
        return;
      }

      this._lineEl.scrollLeft = next;
    }

    this._marqueeRaf = requestAnimationFrame((nextTs) => this._marqueeTick(nextTs));
  }

  _applyTextScale() {
    const scale = (this._card.config.text_scale || 100) / 100;
    this._root?.style.setProperty('--vs-mini-text-scale', String(scale));
  }

  _applyCustomCSS() {
    const styleEl = this._card.shadowRoot?.querySelector('#vs-mini-custom-style');
    if (styleEl) styleEl.textContent = this._card.config.custom_css || '';
  }

  _flushPendingStartButton() {
    if (this._pendingStartButtonReason !== undefined) {
      this.showStartButton(this._pendingStartButtonReason);
      this._pendingStartButtonReason = undefined;
    }
  }

  _t(key, fallback, vars) {
    return t(this._card?.hass, key, fallback, vars);
  }
}

function _attachMiniDoubleTap(el, callback) {
  let lastTap = 0;
  let lastTouchTime = 0;
  const handler = (e) => {
    const now = Date.now();
    if (e.type === 'touchstart') lastTouchTime = now;
    if (e.type === 'click' && (now - lastTouchTime) < 400) return;
    if (now - lastTap < 400 && now - lastTap > 0) {
      e.preventDefault();
      e.stopPropagation();
      callback();
    }
    lastTap = now;
  };
  el.addEventListener('touchstart', handler, { passive: false });
  el.addEventListener('click', handler);
}
