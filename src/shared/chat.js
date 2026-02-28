/** Chat rendering state and incremental streaming updates. */

const FADE_LEN = 24;

export class ChatManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._streamEl = null;
    this._streamedResponse = '';

    // Reusable fade span pool - avoids creating/destroying 24 DOM nodes per update
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;

    // RAF coalescing - multiple rapid stream chunks produce one DOM write per frame
    this._pendingText = null;
    this._rafId = null;
  }

  get streamEl() { return this._streamEl; }
  set streamEl(el) { this._streamEl = el; }

  get streamedResponse() { return this._streamedResponse; }
  set streamedResponse(val) { this._streamedResponse = val; }

  showTranscription(text) {
    this.addUser(text);
  }

  showResponse(text) {
    if (this._streamEl) {
      this._card.ui.updateChatText(this._streamEl, text);
      this._autoScroll();
    } else {
      this.addAssistant(text);
    }
  }

  updateResponse(text) {
    if (!this._streamEl) {
      this.addAssistant(text);
    } else {
      this._scheduleStreaming(text);
    }
  }
  addUser(text) {
    this._card.ui.addChatMessage(text, 'user');
  }

  addImages(results, autoDisplay, featured) {
    this._card.ui.showImagePanel(results, autoDisplay, featured);
  }

  addVideos(results, autoPlay) {
    this._card.ui.showVideoPanel(results, autoPlay);
  }

  addWeather(weatherData) {
    this._card.ui.showWeatherPanel(weatherData);
  }

  addFinancial(data) {
    this._card.ui.showFinancialPanel(data);
  }

  addAssistant(text) {
    this._streamEl = this._card.ui.addChatMessage(text, 'assistant');
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;
  }

  clear() {
    this._card.ui.clearChat();
    this._streamEl = null;
    this._streamedResponse = '';
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._pendingText = null;
    }
  }
  /** Coalesce rapid stream chunks into one DOM write per frame. */
  _scheduleStreaming(text) {
    this._pendingText = text;
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        if (this._pendingText !== null) {
          this._updateStreaming(this._pendingText);
          this._pendingText = null;
        }
      });
    }
  }

  _updateStreaming(text) {
    if (!this._streamEl) return;

    if (text.length <= FADE_LEN) {
      this._card.ui.updateChatText(this._streamEl, text);
      this._autoScroll();
      return;
    }

    // Lazily create the fade DOM structure once, then reuse it
    if (!this._fadeSpans) {
      this._initFadeNodes();
    }

    const solid = text.slice(0, text.length - FADE_LEN);
    const tail = text.slice(text.length - FADE_LEN);

    // Update text nodes in-place - no innerHTML, no DOM creation/destruction
    this._solidNode.textContent = solid;
    for (let i = 0; i < FADE_LEN; i++) {
      this._fadeSpans[i].textContent = i < tail.length ? tail[i] : '';
    }

    this._autoScroll();
  }

  /** Scroll the stream element and its transcript container to the bottom. */
  _autoScroll() {
    const el = this._streamEl;
    if (el && el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight;
    }
    // Also scroll the transcript container (tall mini mode)
    this._card.ui._scrollTranscriptToEnd?.();
  }

  /** Build the fade DOM structure once: a text node for solid text + 24 reusable spans. */
  _initFadeNodes() {
    this._streamEl.textContent = '';
    this._solidNode = document.createTextNode('');
    this._streamEl.appendChild(this._solidNode);

    this._fadeSpans = [];
    for (let i = 0; i < FADE_LEN; i++) {
      const span = document.createElement('span');
      span.style.opacity = ((FADE_LEN - i) / FADE_LEN).toFixed(2);
      this._fadeSpans.push(span);
      this._streamEl.appendChild(span);
    }
  }
}
