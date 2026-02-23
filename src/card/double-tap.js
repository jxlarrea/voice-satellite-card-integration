/**
 * Voice Satellite Card — DoubleTapHandler
 *
 * Detects double-taps on the document to cancel active interactions.
 * Includes touch/click deduplication for touch devices.
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';
import { clearNotificationUI } from '../shared/satellite-notification.js';
import { sendAck } from '../shared/notification-comms.js';
import { getSwitchState } from '../shared/satellite-state.js';

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
      const isActive = INTERACTING_STATES.includes(this._card.currentState) || this._card.tts.isPlaying;
      const isTimerAlert = this._card.timer.alertActive;
      const isNotification = this._card.announcement.playing
        || this._card.askQuestion.playing
        || this._card.startConversation.playing
        || this._card.announcement.clearTimeoutId
        || this._card.startConversation.clearTimeoutId;

      if (!isActive && !isTimerAlert && !isNotification) return;

      // Touch/click deduplication
      if (e.type === 'click' && this._lastTapWasTouch) return;
      this._lastTapWasTouch = (e.type === 'touchstart');

      const now = Date.now();
      const timeSinceLastTap = now - this._lastTapTime;
      this._lastTapTime = now;

      if (timeSinceLastTap < Timing.DOUBLE_TAP_THRESHOLD && timeSinceLastTap > 0) {
        e.preventDefault();

        if (this._card.timer.alertActive) {
          this._log.log('ui', 'Double-tap detected — dismissing timer alert');
          this._card.timer.dismissAlert();
          return;
        }

        if (isNotification) {
          this._log.log('ui', 'Double-tap detected — dismissing notification');
          for (const mgr of [this._card.announcement, this._card.askQuestion, this._card.startConversation]) {
            if (!mgr.playing && !mgr.clearTimeoutId) continue;
            if (mgr.currentAnnounceId) {
              sendAck(this._card, mgr.currentAnnounceId, 'double-tap');
            }
            if (mgr.currentAudio) {
              mgr.currentAudio.pause();
              mgr.currentAudio = null;
            }
            mgr.playing = false;
            mgr.currentAnnounceId = null;
            clearNotificationUI(mgr);
          }
          // Release server-side _question_event if ask_question was playing
          this._card.askQuestion.cancel();
          this._card.pipeline.restart(0);
          return;
        }

        this._log.log('ui', 'Double-tap detected — cancelling interaction');

        if (this._card.tts.isPlaying) {
          this._card.tts.stop();
        }

        // Clean up ask_question STT mode (timers, server release, ANNOUNCEMENT blur)
        this._card.askQuestion.cancel();

        this._card.pipeline.clearContinueState();
        this._card.setState(State.IDLE);
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);

        const isRemote = !!this._card.ttsTarget;
        if (getSwitchState(this._card.hass, this._card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
          this._card.tts.playChime('done');
        }

        this._card.pipeline.restart(0);
      }
    };

    document.addEventListener('touchstart', this._handler, { passive: false });
    document.addEventListener('click', this._handler);
  }
}
