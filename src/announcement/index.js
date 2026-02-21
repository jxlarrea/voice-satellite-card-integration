/**
 * Voice Satellite Card — AnnouncementManager
 *
 * Simple announcements: plays chime + media, shows message bubble,
 * ACKs the integration, then auto-clears after configured duration.
 */

import {
  initNotificationState,
  dequeueNotification,
  playNotification,
  clearNotificationUI,
} from '../shared/satellite-notification.js';
import { sendAck } from '../shared/notification-comms.js';
import { getSwitchState } from '../shared/satellite-state.js';

const LOG = 'announce';

export class AnnouncementManager {
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
    this._log.log(LOG, `Playing queued announcement #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _play(ann) {
    playNotification(this, ann, (a) => this._onComplete(a), LOG);
  }

  _onComplete(ann) {
    this.playing = false;
    this.currentAudio = null;
    this._log.log(LOG, `Announcement #${ann.id} playback complete`);

    sendAck(this._card, ann.id, LOG);

    // HA's base class cancels the active pipeline when triggering an
    // announcement (async_internal_announce → _cancel_running_pipeline).
    // Restart immediately so wake word detection resumes.
    this._card.pipeline.restart(0);

    const clearDelay = (this._card.config.announcement_display_duration || 5) * 1000;
    this.clearTimeoutId = setTimeout(() => {
      const isRemote = this._card.config.tts_target && this._card.config.tts_target !== 'browser';
      if (getSwitchState(this._card.hass, this._card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
        this._card.tts.playChime('done');
      }
      clearNotificationUI(this);
    }, clearDelay);
  }
}
