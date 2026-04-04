/** Chat rendering state and incremental streaming updates. */

const FADE_GROUPS = 4;
const CHARS_PER_GROUP = 2;
const FADE_LEN = FADE_GROUPS * CHARS_PER_GROUP; // 8 chars total

export class ChatManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._streamEl = null;
    this._streamedResponse = '';
    this._thinkingEl = null;

    // Reusable fade span pool - grouped spans for efficient DOM updates
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
    // Remove animated dots if no tool call claimed them.
    // Frozen dots (from tool calls) are safe - showToolCall already nulled _thinkingEl.
    this.removeThinking();
    this._streamEl = this._card.ui.addChatMessage(text, 'assistant');
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;
  }

  /** Show an animated thinking indicator in the chat area. */
  showThinking() {
    this.removeThinking();
    this._thinkingEl = this._card.ui.addThinkingIndicator();
  }

  /**
   * Show a tool call as a permanent line in the chat flow.
   * If animated dots are showing, freeze them and append the tool name.
   * Subsequent tool calls get their own line with static dots.
   * @param {string} name - Humanized tool name
   */
  showToolCall(name) {
    if (this._thinkingEl) {
      this._card.ui.freezeThinkingWithText(this._thinkingEl, name);
      this._thinkingEl = null;
    } else {
      this._card.ui.addToolCallMessage(name);
    }
  }

  /** Remove the thinking dots indicator if present. */
  removeThinking() {
    if (this._thinkingEl) {
      this._thinkingEl.remove();
      this._thinkingEl = null;
    }
  }

  clear() {
    this.removeThinking();
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
    for (let g = 0; g < FADE_GROUPS; g++) {
      const start = g * CHARS_PER_GROUP;
      this._fadeSpans[g].textContent = tail.slice(start, start + CHARS_PER_GROUP);
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

  /** Build the fade DOM structure once: a text node for solid text + grouped fade spans. */
  _initFadeNodes() {
    this._streamEl.textContent = '';
    this._solidNode = document.createTextNode('');
    this._streamEl.appendChild(this._solidNode);

    this._fadeSpans = [];
    for (let g = 0; g < FADE_GROUPS; g++) {
      const span = document.createElement('span');
      span.style.opacity = ((FADE_GROUPS - g) / FADE_GROUPS).toFixed(2);
      this._fadeSpans.push(span);
      this._streamEl.appendChild(span);
    }
  }
}
