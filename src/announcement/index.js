/**
 * Voice Satellite Card — AnnouncementManager
 *
 * Simple announcements: plays chime + media, shows message bubble,
 * ACKs the integration, then auto-clears after configured duration.
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

const LOG = 'announce';

export class AnnouncementManager {
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
    this._log.log(LOG, `Playing queued announcement #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _onStateChange(attrs) {
    const ann = processNotification(this, attrs, LOG);
    if (!ann) return;

    // Only handle simple announcements (no ask_question or start_conversation)
    if (ann.ask_question || ann.start_conversation) return;

    claimNotification(ann.id);
    this._log.log(LOG, `New announcement #${ann.id}: message="${ann.message || ''}" media="${ann.media_id || ''}"`);
    this._play(ann);
  }

  _play(ann) {
    playNotification(this, ann, (a) => this._onComplete(a), LOG);
  }

  _onComplete(ann) {
    this.playing = false;
    this.currentAudio = null;
    this._log.log(LOG, `Announcement #${ann.id} playback complete`);

    sendAck(this._card, ann.id, LOG);

    const clearDelay = (this._card.config.announcement_display_duration || 5) * 1000;
    this.clearTimeoutId = setTimeout(() => clearNotificationUI(this), clearDelay);
  }
}
