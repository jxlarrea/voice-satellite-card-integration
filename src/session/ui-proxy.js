/**
 * UIBroadcastProxy
 *
 * Implements the UI interface that session-level managers expect, but
 * broadcasts every call to ALL registered card UIs. Query methods
 * aggregate across cards (e.g. isLightboxVisible → any card).
 */

export class UIBroadcastProxy {
  constructor(session) {
    this._session = session;
  }

  /** @returns {Set<object>} Registered card instances */
  get _cards() { return this._session._cards; }

  // ── Property access ──────────────────────────────────────────────

  /** Return the first card's UI element (used by ask-question for DOM queries). */
  get element() {
    for (const c of this._cards) {
      if (c.ui?.element) return c.ui.element;
    }
    return null;
  }

  // ── Broadcast methods (fire on ALL card UIs) ─────────────────────

  updateForState(state, serviceUnavailable, ttsPlaying) {
    for (const c of this._cards) c.ui.updateForState(state, serviceUnavailable, ttsPlaying);
  }

  showBlurOverlay(reason) {
    for (const c of this._cards) c.ui.showBlurOverlay(reason);
  }

  hideBlurOverlay(reason) {
    for (const c of this._cards) c.ui.hideBlurOverlay(reason);
  }

  showServiceError() {
    for (const c of this._cards) c.ui.showServiceError();
  }

  clearServiceError() {
    for (const c of this._cards) c.ui.clearServiceError();
  }

  hideBar() {
    for (const c of this._cards) c.ui.hideBar();
  }

  onNotificationStart() {
    let wasVisible = false;
    for (const c of this._cards) {
      if (c.ui.onNotificationStart()) wasVisible = true;
    }
    return wasVisible;
  }

  showStartButton(reason) {
    for (const c of this._cards) c.ui.showStartButton(reason);
  }

  hideStartButton() {
    for (const c of this._cards) c.ui.hideStartButton();
  }

  stopReactive() {
    for (const c of this._cards) c.ui.stopReactive();
  }

  setAnnouncementMode(on) {
    for (const c of this._cards) c.ui.setAnnouncementMode(on);
  }

  clearAnnouncementBubbles() {
    for (const c of this._cards) c.ui.clearAnnouncementBubbles();
  }

  clearNotificationStatusOverride() {
    for (const c of this._cards) c.ui.clearNotificationStatusOverride();
  }

  onNotificationDismiss(wasVisible) {
    for (const c of this._cards) c.ui.onNotificationDismiss(wasVisible);
  }

  // ── Chat DOM (delegated via per-card ChatManagers, but some managers
  //    call card.ui directly for these) ─────────────────────────────

  addChatMessage(text, type) {
    let el = null;
    for (const c of this._cards) {
      const result = c.ui.addChatMessage(text, type);
      if (!el) el = result; // Return first element for callers that need one
    }
    return el;
  }

  updateChatText(el, text) {
    // el is from ONE card's UI. Broadcast — each UI's updateChatText
    // will no-op gracefully if the element isn't in its DOM.
    for (const c of this._cards) c.ui.updateChatText(el, text);
  }

  clearChat() {
    for (const c of this._cards) c.ui.clearChat();
  }

  // ── Rich media (full card supports these; mini card no-ops) ──────

  showImagePanel(results, autoDisplay, featured) {
    for (const c of this._cards) c.ui.showImagePanel(results, autoDisplay, featured);
  }

  showVideoPanel(results, autoPlay) {
    for (const c of this._cards) c.ui.showVideoPanel(results, autoPlay);
  }

  showWeatherPanel(data) {
    for (const c of this._cards) c.ui.showWeatherPanel(data);
  }

  showFinancialPanel(data) {
    for (const c of this._cards) c.ui.showFinancialPanel(data);
  }

  showLightbox(src) {
    for (const c of this._cards) c.ui.showLightbox(src);
  }

  showVideoLightbox(videoId) {
    for (const c of this._cards) c.ui.showVideoLightbox(videoId);
  }

  hideLightbox() {
    for (const c of this._cards) c.ui.hideLightbox();
  }

  // ── Timer UI ─────────────────────────────────────────────────────

  ensureTimerContainer() {
    for (const c of this._cards) c.ui.ensureTimerContainer();
  }

  removeTimerContainer() {
    for (const c of this._cards) c.ui.removeTimerContainer();
  }

  /**
   * Sync timer pills across all card UIs.
   *
   * Each UI creates its own pill DOM elements and stores them via `t.el`.
   * Since multiple UIs each set `t.el`, we save per-UI references in a
   * `_uiEls` Map on the timer object so every UI's pills can be updated
   * independently during tick().
   */
  syncTimerPills(timers, onDoubleTap) {
    for (const c of this._cards) {
      c.ui.syncTimerPills(timers, onDoubleTap);
      // Capture this UI's pill references
      for (const t of timers) {
        if (t.el) {
          if (!t._uiEls) t._uiEls = new Map();
          t._uiEls.set(c, t.el);
        }
      }
    }
  }

  updateTimerPill(el, secondsLeft, totalSeconds) {
    // Each UI's updateTimerPill operates on the passed element directly.
    // Since we call every UI, all pills get updated regardless of which
    // UI originally created `el`.
    for (const c of this._cards) {
      c.ui.updateTimerPill(el, secondsLeft, totalSeconds);
    }
  }

  expireTimerPill(timerId, animationMs) {
    for (const c of this._cards) c.ui.expireTimerPill(timerId, animationMs);
  }

  showTimerAlert(onDoubleTap) {
    for (const c of this._cards) {
      // Skip full card alerts when suppressed — they render in document.body
      // outside #voice-satellite-ui and would be visible despite suppression.
      if (this._session._fullCardSuppressed && c.cardType === 'full') continue;
      c.ui.showTimerAlert(onDoubleTap);
    }
  }

  clearTimerAlert() {
    for (const c of this._cards) c.ui.clearTimerAlert();
  }

  // ── Query methods (aggregate across cards) ───────────────────────

  isLightboxVisible() {
    for (const c of this._cards) {
      if (c.ui.isLightboxVisible()) return true;
    }
    return false;
  }

  hasVisibleImages() {
    for (const c of this._cards) {
      if (c.ui.hasVisibleImages()) return true;
    }
    return false;
  }

  getTtsLingerTimeoutMs() {
    let max = 0;
    for (const c of this._cards) {
      const val = c.ui.getTtsLingerTimeoutMs();
      if (val > max) max = val;
    }
    return max;
  }

  _scrollTranscriptToEnd() {
    for (const c of this._cards) c.ui._scrollTranscriptToEnd();
  }
}
