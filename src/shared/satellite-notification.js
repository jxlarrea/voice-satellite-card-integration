/**
 * Voice Satellite Card — Satellite Notification Base
 *
 * Shared lifecycle for features triggered by satellite entity state:
 * entity subscription, dedup, pipeline-busy queuing, playback orchestration.
 *
 * DOM operations delegate to UIManager.
 * Audio operations delegate to audio/chime and audio/media-playback.
 *
 * Each manager provides its own onComplete handler.
 */

import { subscribeToEntity, unsubscribeEntity } from './entity-subscription.js';
import { isOwner } from './singleton.js';
import { playMultiNoteChime, CHIME_ANNOUNCE } from '../audio/chime.js';
import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';
import { BlurReason, Timing } from '../constants.js';

let _lastAnnounceId = 0;

// ─── Entity Subscription ───────────────────────────────────────────

/**
 * Subscribe to the satellite entity's announcement attribute.
 * @param {object} mgr - Manager instance
 * @param {Function} onNotification - Called with (attrs) on state change
 * @param {string} logPrefix
 */
export function subscribe(mgr, onNotification, logPrefix) {
  const { config, connection } = mgr.card;
  if (!config.satellite_entity) return;
  if (!isOwner(mgr.card)) return;
  if (mgr._subscribed) return;
  if (!connection) return;

  subscribeToEntity(
    mgr, connection, config.satellite_entity,
    onNotification, logPrefix,
  );
}

/**
 * Unsubscribe from entity updates.
 * @param {object} mgr
 */
export function unsubscribe(mgr) {
  unsubscribeEntity(mgr);
}

// ─── Dedup & Queuing ───────────────────────────────────────────────

/**
 * Process an incoming notification, handling dedup and queuing.
 * Does NOT claim the dedup ID — caller must call claimNotification()
 * after confirming the notification belongs to this manager.
 *
 * @param {object} mgr
 * @param {object} attrs - Entity attributes
 * @param {string} logPrefix
 * @returns {object|null} Announcement to play, or null
 */
export function processNotification(mgr, attrs, logPrefix) {
  if (!attrs.announcement) return null;

  const ann = attrs.announcement;
  if (!ann.id) return null;

  
  if (ann.id <= _lastAnnounceId) return null;

  if (mgr.playing) {
    mgr.log.log(logPrefix, `Notification #${ann.id} ignored - already playing`);
    return null;
  }

  const cardState = mgr.card.currentState;
  const pipelineBusy = cardState === 'WAKE_WORD_DETECTED' ||
    cardState === 'STT' || cardState === 'INTENT' || cardState === 'TTS';
  if (pipelineBusy || mgr.card.tts.isPlaying) {
    if (!mgr.queued || mgr.queued.id !== ann.id) {
      mgr.queued = ann;
      mgr.log.log(logPrefix, `Notification #${ann.id} queued - pipeline busy (${cardState})`);
    }
    return null;
  }

  mgr.queued = null;
  return ann;
}

/**
 * Claim a notification ID so other managers won't process it.
 * @param {number} id
 */
export function claimNotification(id) {
  _lastAnnounceId = id;
}

/**
 * Try to play a queued notification.
 * @param {object} mgr
 * @returns {object|null}
 */
export function dequeueNotification(mgr) {
  if (!mgr.queued) return null;
  const ann = mgr.queued;
  mgr.queued = null;

  if (ann.id <= (_lastAnnounceId || 0)) return null;
  if (mgr.playing) return null;

  _lastAnnounceId = ann.id;
  return ann;
}

// ─── Playback Orchestration ────────────────────────────────────────

/**
 * Full playback: blur → bar → preannounce → main media → onComplete.
 * DOM delegated to UIManager, audio to chime/media-playback.
 *
 * @param {object} mgr
 * @param {object} ann
 * @param {Function} onComplete - Called with (ann)
 * @param {string} logPrefix
 */
export function playNotification(mgr, ann, onComplete, logPrefix) {
  mgr.playing = true;

  // UI: blur overlay + wake screen + bar
  mgr.card.ui.showBlurOverlay(BlurReason.ANNOUNCEMENT);
  mgr.card.turnOffWakeWordSwitch();
  mgr.barWasVisible = mgr.card.ui.showBarSpeaking();

  // Pre-announcement
  if (ann.preannounce === false) {
    mgr.log.log(logPrefix, 'Preannounce disabled — skipping chime');
    _playMain(mgr, ann, onComplete, logPrefix);
  } else {
    const hasPreAnnounce = ann.preannounce_media_id && ann.preannounce_media_id !== '';

    if (hasPreAnnounce) {
      mgr.log.log(logPrefix, `Playing pre-announcement media: ${ann.preannounce_media_id}`);
      playMediaFor(mgr, ann.preannounce_media_id, logPrefix, () => {
        _playMain(mgr, ann, onComplete, logPrefix);
      });
    } else {
      playMultiNoteChime(mgr.card, CHIME_ANNOUNCE, {
        onDone: () => _playMain(mgr, ann, onComplete, logPrefix),
        log: mgr.log,
      });
      mgr.log.log(logPrefix, 'Announcement chime played');
    }
  }
}

function _playMain(mgr, ann, onComplete, logPrefix) {
  const mediaUrl = ann.media_id || '';

  if (ann.message) {
    mgr.card.ui.addChatMessage(ann.message, 'announcement');
  }

  if (mediaUrl) {
    mgr.log.log(logPrefix, `Playing media: ${mediaUrl}`);
    playMediaFor(mgr, mediaUrl, logPrefix, () => onComplete(ann));
  } else {
    mgr.log.log(logPrefix, 'No media — completing after message display');
    setTimeout(() => onComplete(ann), Timing.NO_MEDIA_DISPLAY);
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────

/**
 * Clear notification UI: bubbles, blur, bar restore.
 * @param {object} mgr
 */
export function clearNotificationUI(mgr) {
  if (mgr.clearTimeoutId) {
    clearTimeout(mgr.clearTimeoutId);
    mgr.clearTimeoutId = null;
  }

  mgr.card.ui.clearAnnouncementBubbles();
  mgr.card.ui.hideBlurOverlay(BlurReason.ANNOUNCEMENT);
  mgr.card.ui.restoreBar(mgr.barWasVisible);
}

// ─── Audio Helper ──────────────────────────────────────────────────

/**
 * Play a media URL with volume from config.
 */
export function playMediaFor(mgr, urlPath, logPrefix, onDone) {
  const url = buildMediaUrl(urlPath);
  const volume = mgr.card.config.tts_volume / 100;

  mgr.currentAudio = playMediaUrl(url, volume, {
    onEnd: () => {
      mgr.log.log(logPrefix, 'Media playback complete');
      mgr.currentAudio = null;
      onDone?.();
    },
    onError: (e) => {
      mgr.log.error(logPrefix, `Media playback error: ${e}`);
      mgr.currentAudio = null;
      onDone?.();
    },
    onStart: () => {
      mgr.log.log(logPrefix, 'Media playback started');
    },
  });
}

// ─── Common State Init ─────────────────────────────────────────────

/**
 * Initialize shared notification state on a manager instance.
 * @param {object} mgr
 */
export function initNotificationState(mgr) {
  mgr.playing = false;
  mgr.currentAudio = null;
  mgr.clearTimeoutId = null;
  mgr.barWasVisible = false;
  mgr.queued = null;
}
