/**
 * ChatBroadcastProxy
 *
 * Implements the ChatManager interface that session-level managers
 * expect, but broadcasts every call to ALL registered card ChatManagers.
 * Tracks shared streaming state (streamedResponse) at the session level.
 */

export class ChatBroadcastProxy {
  constructor(session) {
    this._session = session;
    this._streamedResponse = '';
  }

  /** @returns {Set<object>} Registered card instances */
  get _cards() { return this._session._cards; }

  // ── Shared streaming state ───────────────────────────────────────

  get streamedResponse() { return this._streamedResponse; }
  set streamedResponse(val) { this._streamedResponse = val; }

  /**
   * streamEl getter — truthy if any card has an active stream element.
   * Pipeline events check `chat.streamEl` to see if streaming is active.
   */
  get streamEl() {
    for (const c of this._cards) {
      if (c.chat?.streamEl) return c.chat.streamEl;
    }
    return null;
  }

  /**
   * streamEl setter — when set to null, clear all card ChatManagers' streamEl.
   * Pipeline events set `chat.streamEl = null` to signal end of streaming.
   */
  set streamEl(val) {
    if (val === null) {
      for (const c of this._cards) c.chat.streamEl = null;
    }
    // Non-null values are not set from session level (each card manages its own)
  }

  // ── Broadcast methods ────────────────────────────────────────────

  showTranscription(text) {
    for (const c of this._cards) c.chat.showTranscription(text);
  }

  showResponse(text) {
    for (const c of this._cards) c.chat.showResponse(text);
  }

  updateResponse(text) {
    for (const c of this._cards) c.chat.updateResponse(text);
  }

  addUser(text) {
    for (const c of this._cards) c.chat.addUser(text);
  }

  addAssistant(text) {
    for (const c of this._cards) c.chat.addAssistant(text);
  }

  addImages(results, autoDisplay, featured) {
    for (const c of this._cards) c.chat.addImages(results, autoDisplay, featured);
  }

  addVideos(results, autoPlay) {
    for (const c of this._cards) c.chat.addVideos(results, autoPlay);
  }

  addWeather(data) {
    for (const c of this._cards) c.chat.addWeather(data);
  }

  addFinancial(data) {
    for (const c of this._cards) c.chat.addFinancial(data);
  }

  clear() {
    this._streamedResponse = '';
    for (const c of this._cards) c.chat.clear();
  }
}
