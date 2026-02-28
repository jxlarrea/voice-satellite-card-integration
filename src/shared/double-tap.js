/**
 * DoubleTapHandler
 *
 * Detects double-taps on the document to cancel active interactions.
 * Also supports Escape key and includes touch/click deduplication.
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
    this._lastTouchTime = 0;
    this._handler = null;
    this._keyHandler = null;
  }

  setup() {
    // Idempotency guard - prevent duplicate listeners on repeated calls
    if (this._handler) return;

    this._handler = (e) => {
      const state = this._getInteractionState();
      if (!state) return;

      const now = Date.now();

      // Touch/click deduplication - skip synthetic click that follows a recent touch
      if (e.type === 'touchstart') this._lastTouchTime = now;
      if (e.type === 'click' && (now - this._lastTouchTime) < 400) return;
      const timeSinceLastTap = now - this._lastTapTime;
      this._lastTapTime = now;

      if (timeSinceLastTap < Timing.DOUBLE_TAP_THRESHOLD && timeSinceLastTap > 0) {
        e.preventDefault();
        this._cancel(state.isTimerAlert, state.isNotification);
      }
    };

    document.addEventListener('touchstart', this._handler, { passive: false });
    document.addEventListener('click', this._handler);

    // Escape key cancels the same way as double-tap
    this._keyHandler = (e) => {
      if (e.key !== 'Escape') return;

      const state = this._getInteractionState();
      if (!state) return;

      e.preventDefault();
      this._cancel(state.isTimerAlert, state.isNotification);
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  _getInteractionState() {
    const isActive = INTERACTING_STATES.includes(this._card.currentState) || this._card.tts.isPlaying;
    const isImageLinger = !!this._card._imageLingerTimeout || this._card.ui.isLightboxVisible() || this._card.ui.hasVisibleImages();
    const isTimerAlert = this._card.timer.alertActive;
    const isNotification = this._card.announcement.playing
      || this._card.askQuestion.playing
      || this._card.startConversation.playing
      || this._card.announcement.clearTimeoutId
      || this._card.startConversation.clearTimeoutId;

    if (!isActive && !isImageLinger && !isTimerAlert && !isNotification) return null;
    return { isTimerAlert, isNotification };
  }

  _cancel(isTimerAlert, isNotification) {
    if (isTimerAlert) {
      this._log.log('ui', 'Cancel detected - dismissing timer alert');
      this._card.timer.dismissAlert();
      return;
    }

    if (isNotification) {
      this._log.log('ui', 'Cancel detected - dismissing notification');
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
        mgr.queued = null;
        clearNotificationUI(mgr);
      }
      // Release server-side _question_event if ask_question was playing
      this._card.askQuestion.cancel();
      this._card.chat.clear();
      this._card.ui.clearNotificationStatusOverride();

      const isRemote = !!this._card.ttsTarget;
      if (getSwitchState(this._card.hass, this._card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
        this._card.tts.playChime('done');
      }

      this._card.pipeline.restart(0);
      return;
    }

    this._log.log('ui', 'Cancel detected - cancelling interaction');

    // Cancel image linger timeout if active
    if (this._card._imageLingerTimeout) {
      clearTimeout(this._card._imageLingerTimeout);
      this._card._imageLingerTimeout = null;
    }

    if (this._card.tts.isPlaying) {
      this._card.tts.stop();
    }

    // Clean up ask_question STT mode (timers, server release, ANNOUNCEMENT blur)
    this._card.askQuestion.cancel();

    this._card.pipeline.clearContinueState();
    this._card.setState(State.IDLE);
    this._card.chat.clear();
    this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
    this._card.ui.updateForState(State.IDLE, this._card.pipeline.serviceUnavailable, false);

    const isRemote = !!this._card.ttsTarget;
    if (getSwitchState(this._card.hass, this._card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
      this._card.tts.playChime('done');
    }

    this._card.pipeline.restart(0);
  }
}
