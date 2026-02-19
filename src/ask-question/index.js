/**
 * Voice Satellite Card — AskQuestionManager
 *
 * Handles ask_question announcements: plays the question prompt,
 * enters STT-only mode to capture the user's spoken answer,
 * sends it to the integration, and provides audio/visual match feedback.
 */

import {
  initNotificationState,
  subscribe,
  unsubscribe,
  processNotification,
  claimNotification,
  dequeueNotification,
  playNotification,
  clearNotificationUI,
} from '../shared/satellite-notification.js';
import { sendAck } from '../shared/notification-comms.js';
import { BlurReason, Timing } from '../constants.js';
import { sendAnswer } from './comms.js';

const LOG = 'ask-question';

export class AskQuestionManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    initNotificationState(this);
  }

  get card() { return this._card; }
  get log() { return this._log; }

  update() {
    subscribe(this, (attrs) => this._onStateChange(attrs), LOG);
  }

  destroy() {
    unsubscribe(this);
  }

  playQueued() {
    const ann = dequeueNotification(this);
    if (!ann) return;
    this._log.log(LOG, `Playing queued ask_question #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _onStateChange(attrs) {
    const ann = processNotification(this, attrs, LOG);
    if (!ann) return;

    if (!ann.ask_question) return;

    claimNotification(ann.id);
    this._log.log(LOG, `New ask_question #${ann.id}: message="${ann.message || ''}" media="${ann.media_id || ''}"`);
    this._play(ann);
  }

  _play(ann) {
    playNotification(this, ann, (a) => this._onComplete(a), LOG);
  }

  _onComplete(ann) {
    this.playing = false;
    this.currentAudio = null;
    this._log.log(LOG, `Question #${ann.id} playback complete`);

    sendAck(this._card, ann.id, LOG);
    this._enterSttMode(ann);
  }

  /**
   * Enter STT-only mode, capture answer, submit to integration.
   */
  _enterSttMode(ann) {
    this._log.log(LOG, 'Entering STT-only mode');

    this._card.ui.showBlurOverlay(BlurReason.PIPELINE);

    const { pipeline } = this._card;
    if (!pipeline) return;

    const announceId = ann.id;
    const isRemote = this._card.config.tts_target && this._card.config.tts_target !== 'browser';

    // Play wake chime to signal the user should speak
    if (!isRemote) {
      this._card.tts.playChime('wake');
    }

    pipeline.restartContinue(null, {
      end_stage: 'stt',
      onSttEnd: (text) => {
        this._log.log(LOG, `STT result: "${text}"`);
        this._processAnswer(announceId, text, isRemote);
      },
    });
  }

  /**
   * Send answer to integration and show match feedback.
   */
  _processAnswer(announceId, text, isRemote) {
    const { pipeline } = this._card;
    let cleaned = false;
    let matchedResult = null;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (matchedResult !== null && !matchedResult) {
        this._card.ui.clearErrorBar();
      }
      clearNotificationUI(this);
      this._card.chat.clear();
      this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
      pipeline.restart(0);
    };
    setTimeout(cleanup, Timing.ASK_QUESTION_CLEANUP);

    sendAnswer(this._card, announceId, text, LOG).then((result) => {
      const matched = result?.matched;
      matchedResult = matched;

      if (!isRemote) {
        this._card.tts.playChime(matched ? 'done' : 'error');
      }

      if (!matched) {
        this._card.ui.flashErrorBar();
      }
    });
  }

}
