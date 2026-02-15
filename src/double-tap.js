/**
 * Voice Satellite Card — DoubleTapHandler
 *
 * Detects double-taps on the document to cancel active interactions.
 * Includes touch/click deduplication for touch devices.
 */

import { State } from './constants.js';

export class DoubleTapHandler {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._lastTapTime = 0;
    this._lastTapWasTouch = false;
    this._handler = null;
  }

  setup() {
    var self = this;

    this._handler = function (e) {
      if (!self._card.config.double_tap_cancel) return;

      var activeStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
      if (activeStates.indexOf(self._card.currentState) === -1 && !self._card.tts.isPlaying) return;

      // Touch/click deduplication
      if (e.type === 'click' && self._lastTapWasTouch) return;
      self._lastTapWasTouch = (e.type === 'touchstart');

      var now = Date.now();
      var timeSinceLastTap = now - self._lastTapTime;
      self._lastTapTime = now;

      if (timeSinceLastTap < 400 && timeSinceLastTap > 0) {
        self._log.log('ui', 'Double-tap detected — cancelling interaction');
        e.preventDefault();

        if (self._card.tts.isPlaying) {
          self._card.tts.stop();
        }

        self._card.pipeline.clearContinueState();
        self._card.setState(State.IDLE);
        self._card.chat.clear();
        self._card.ui.hideBlurOverlay();
        self._card.updateInteractionState('IDLE');

        var isRemote = self._card.config.tts_target && self._card.config.tts_target !== 'browser';
        if (self._card.config.chime_on_request_sent && !isRemote) {
          self._card.tts.playChime('done');
        }

        self._card.pipeline.restart(0);
      }
    };

    document.addEventListener('touchstart', this._handler, { passive: false });
    document.addEventListener('click', this._handler);
  }
}