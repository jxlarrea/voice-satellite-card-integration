/**
 * Voice Satellite Card — ChatManager
 *
 * Manages chat message state, streaming text fade effect,
 * and legacy API wrappers. All DOM ops delegate to UIManager.
 */

const FADE_LEN = 24;

export class ChatManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._streamEl = null;
    this._streamedResponse = '';
  }

  get streamEl() { return this._streamEl; }
  set streamEl(el) { this._streamEl = el; }

  get streamedResponse() { return this._streamedResponse; }
  set streamedResponse(val) { this._streamedResponse = val; }

  // --- Legacy API wrappers ---

  showTranscription(text) {
    if (!this._card.config.show_transcription) return;
    this.addUser(text);
  }

  hideTranscription() { /* No-op: messages persist until clear() */ }

  showResponse(text) {
    if (!this._card.config.show_response) return;
    if (this._streamEl) {
      this._card.ui.updateChatText(this._streamEl, text);
    } else {
      this.addAssistant(text);
    }
  }

  updateResponse(text) {
    if (!this._card.config.show_response) return;
    if (!this._streamEl) {
      this.addAssistant(text);
    } else {
      this._updateStreaming(text);
    }
  }

  hideResponse() { /* No-op: messages persist until clear() */ }

  // --- Core Methods ---

  addUser(text) {
    this._card.ui.addChatMessage(text, 'user');
  }

  addAssistant(text) {
    this._streamEl = this._card.ui.addChatMessage(text, 'assistant');
  }

  clear() {
    this._card.ui.clearChat();
    this._streamEl = null;
    this._streamedResponse = '';
  }

  // --- Private ---

  _updateStreaming(text) {
    if (!this._streamEl) return;

    if (text.length <= FADE_LEN) {
      this._card.ui.updateChatText(this._streamEl, text);
      return;
    }

    const solid = text.slice(0, text.length - FADE_LEN);
    const tail = text.slice(text.length - FADE_LEN);

    let html = _escapeHtml(solid);
    for (let i = 0; i < tail.length; i++) {
      const opacity = ((FADE_LEN - i) / FADE_LEN).toFixed(2);
      html += `<span style="opacity:${opacity}">${_escapeHtml(tail[i])}</span>`;
    }
    this._card.ui.updateChatHtml(this._streamEl, html);
  }
}

function _escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
