/**
 * Voice Satellite Card — DoubleTapHandler
 *
 * Detects double-taps on the document to cancel active interactions.
 * Includes touch/click deduplication for touch devices.
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';

export class DoubleTapHandler {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._lastTapTime = 0;
    this._lastTapWasTouch = false;
    this._handler = null;
  }

  setup() {
    this._handler = (e) => {
      if (!this._card.config.double_tap_cancel) return;

      const isActive = INTERACTING_STATES.includes(this._card.currentState) || this._card.tts.isPlaying;
      const isTimerAlert = this._card.timer.isAlertActive;

      if (!isActive && !isTimerAlert) return;

      // Touch/click deduplication
      if (e.type === 'click' && this._lastTapWasTouch) return;
      this._lastTapWasTouch = (e.type === 'touchstart');

      const now = Date.now();
      const timeSinceLastTap = now - this._lastTapTime;
      this._lastTapTime = now;

      if (timeSinceLastTap < Timing.DOUBLE_TAP_THRESHOLD && timeSinceLastTap > 0) {
        e.preventDefault();

        if (this._card.timer.isAlertActive) {
          this._log.log('ui', 'Double-tap detected — dismissing timer alert');
          this._card.timer.dismissAlert();
          return;
        }

        this._log.log('ui', 'Double-tap detected — cancelling interaction');

        if (this._card.tts.isPlaying) {
          this._card.tts.stop();
        }

        this._card.pipeline.clearContinueState();
        this._card.setState(State.IDLE);
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
        this._card.updateInteractionState('IDLE');

        const isRemote = this._card.config.tts_target && this._card.config.tts_target !== 'browser';
        if (this._card.config.chime_on_request_sent && !isRemote) {
          this._card.tts.playChime('done');
        }

        this._card.pipeline.restart(0);
      }
    };

    document.addEventListener('touchstart', this._handler, { passive: false });
    document.addEventListener('click', this._handler);
  }
}
