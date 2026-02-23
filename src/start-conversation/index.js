/**
 * Voice Satellite Card — StartConversationManager
 *
 * Handles start_conversation announcements: plays the prompt,
 * then clears the UI and enters full STT listening mode
 * so the user can begin a voice interaction.
 */

import {
  initNotificationState,
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

  playQueued() {
    const ann = dequeueNotification(this);
    if (!ann) return;
    this._log.log(LOG, `Playing queued start_conversation #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _play(ann) {
    playNotification(this, ann, (a) => this._onComplete(a), LOG);
  }

  _onComplete(ann) {
    this.currentAudio = null;
    this._log.log(LOG, `Prompt #${ann.id} playback complete`);

    sendAck(this._card, ann.id, LOG);

    // Clear announcement UI and enter listening mode
    clearNotificationUI(this);
    this.playing = false;
    this._card.ui.showBlurOverlay(BlurReason.PIPELINE);

    const { pipeline } = this._card;
    if (pipeline) {
      pipeline.restartContinue(null, {
        extra_system_prompt: ann.extra_system_prompt || null,
      });
    }
  }
}
