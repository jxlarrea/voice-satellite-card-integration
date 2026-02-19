/**
 * Voice Satellite Card — StartConversationManager
 *
 * Handles start_conversation announcements: plays the prompt,
 * then clears the UI and enters full STT listening mode
 * so the user can begin a voice interaction.
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
import { BlurReason } from '../constants.js';

const LOG = 'start-conversation';

export class StartConversationManager {
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
    this._log.log(LOG, `Playing queued start_conversation #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _onStateChange(attrs) {
    const ann = processNotification(this, attrs, LOG);
    if (!ann) return;

    if (!ann.start_conversation) return;

    claimNotification(ann.id);
    this._log.log(LOG, `New start_conversation #${ann.id}: message="${ann.message || ''}" media="${ann.media_id || ''}"`);
    this._play(ann);
  }

  _play(ann) {
    playNotification(this, ann, (a) => this._onComplete(a), LOG);
  }

  _onComplete(ann) {
    this.playing = false;
    this.currentAudio = null;
    this._log.log(LOG, `Prompt #${ann.id} playback complete`);

    sendAck(this._card, ann.id, LOG);

    // Clear announcement UI and enter listening mode
    clearNotificationUI(this);
    this._card.ui.showBlurOverlay(BlurReason.PIPELINE);

    const { pipeline } = this._card;
    if (pipeline) {
      pipeline.restartContinue(null);
    }
  }
}
