/**
 * Voice Satellite Card  -  StartConversationManager
 *
 * Handles start_conversation announcements: plays the prompt,
 * then clears the UI and enters full STT listening mode
 * so the user can begin a voice interaction.
 */

import {
  initNotificationState,
  dequeueNotification,
  playNotification,
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

    // Partial notification cleanup: clear only announcement-specific state and
    // blur. Do not restore/hide the speaking bar here; the pipeline restart
    // immediately transitions into STT/listening and a bar hide/show cycle can
    // cause a visible chat bubble reflow flicker in start_conversation.
    if (this.clearTimeoutId) {
      clearTimeout(this.clearTimeoutId);
      this.clearTimeoutId = null;
    }
    this._card.ui.setAnnouncementMode(false);
    this._card.ui.clearAnnouncementBubbles();
    this._card.ui.hideBlurOverlay(BlurReason.ANNOUNCEMENT);
    // MiniUIManager uses restoreBar() to clear its notification status
    // override, but calling restoreBar() here causes a fullscreen-card bar
    // flicker. Clear the override explicitly when supported.
    this._card.ui.clearNotificationStatusOverride?.();

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
