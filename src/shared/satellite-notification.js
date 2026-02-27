/** Shared notification dispatch, queueing, and playback flow. */

import { CHIME_ANNOUNCE_URI } from '../audio/chime.js';
import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';
import { BlurReason, Timing } from '../constants.js';

let _lastAnnounceId = 0;


let _pendingEvent = null;
let _pendingCard = null;
let _visibilityListenerAdded = false;

/**
 * Whether a satellite event is queued for replay when the tab becomes visible.
 * Used by VisibilityManager to skip its own pipeline restart - the replayed
 * event's flow will manage the pipeline instead.
 */
export function hasPendingSatelliteEvent() {
  return _pendingEvent !== null;
}

function _onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!_pendingEvent || !_pendingCard) return;

  const card = _pendingCard;
  const event = _pendingEvent;
  _pendingEvent = null;
  _pendingCard = null;

  card.logger.log('satellite-notify', `Tab visible - replaying queued event #${event.data.id}`);
  dispatchSatelliteEvent(card, event);
}


/**
 * Dispatch a satellite event to the appropriate notification manager.
 * Called by the single satellite subscription with the raw event payload.
 *
 * @param {object} card - Card instance
 * @param {object} event - {type: "announcement"|"start_conversation", data: {...}}
 */
export function dispatchSatelliteEvent(card, event) {
  const { type, data } = event;

  // media_player events don't have an id field - route early
  if (type === 'media_player') {
    card.mediaPlayer.handleCommand(data);
    return;
  }

  if (!data || !data.id) return;

  // Queue events while the tab is hidden - audio can't play and UI state
  // gets corrupted.  Only keep the latest event (newer replaces older).
  // When the tab becomes visible, the queued event is replayed.
  if (document.visibilityState === 'hidden') {
    card.logger.log('satellite-notify', `Event #${data.id} queued - tab hidden`);
    _pendingEvent = event;
    _pendingCard = card;
    if (!_visibilityListenerAdded) {
      _visibilityListenerAdded = true;
      document.addEventListener('visibilitychange', _onVisibilityChange);
    }
    return;
  }

  const ann = { ...data };

  // Route to the correct manager based on event type / flags
  if (ann.ask_question) {
    _deliverToManager(card.askQuestion, ann, 'ask-question');
  } else if (type === 'start_conversation' || ann.start_conversation) {
    _deliverToManager(card.startConversation, ann, 'start-conversation');
  } else {
    _deliverToManager(card.announcement, ann, 'announce');
  }
}

function _deliverToManager(mgr, ann, logPrefix) {
  // Dedup check (monotonic IDs - safety net for duplicate events)
  if (ann.id <= _lastAnnounceId) return;

  if (mgr.playing) {
    if (!mgr.queued || mgr.queued.id !== ann.id) {
      mgr.queued = ann;
      mgr.log.log(logPrefix, `Notification #${ann.id} queued - still displaying`);
    }
    return;
  }

  const cardState = mgr.card.currentState;
  const pipelineBusy = cardState === 'WAKE_WORD_DETECTED' ||
    cardState === 'STT' || cardState === 'INTENT' || cardState === 'TTS';
  if (pipelineBusy || mgr.card.tts.isPlaying) {
    if (!mgr.queued || mgr.queued.id !== ann.id) {
      mgr.queued = ann;
      mgr.log.log(logPrefix, `Notification #${ann.id} queued - pipeline busy (${cardState})`);
    }
    return;
  }

  mgr.queued = null;
  _lastAnnounceId = ann.id;

  mgr.log.log(logPrefix, `New ${logPrefix} #${ann.id}: message="${ann.message || ''}" media="${ann.media_id || ''}"`);
  playNotification(mgr, ann, (a) => mgr._onComplete(a), logPrefix);
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


/**
 * Full playback: blur -> bar -> preannounce -> main media -> onComplete.
 * DOM delegated to UIManager, audio to chime/media-playback.
 *
 * @param {object} mgr
 * @param {object} ann
 * @param {Function} onComplete - Called with (ann)
 * @param {string} logPrefix
 */
export function playNotification(mgr, ann, onComplete, logPrefix) {
  // Cancel any pending UI clear from a previous notification
  if (mgr.clearTimeoutId) {
    clearNotificationUI(mgr);
  }

  // Interrupt media player if it's playing
  mgr.card.mediaPlayer.interrupt();

  mgr.playing = true;
  mgr.currentAnnounceId = ann.id;

  // UI: blur overlay + wake screen + bar
  mgr.card.ui.showBlurOverlay(BlurReason.ANNOUNCEMENT);
  mgr.barWasVisible = mgr.card.ui.showBarSpeaking();

  // Only center on screen for passive announcements (not ask_question or start_conversation)
  const isPassive = !ann.ask_question && !ann.start_conversation;
  if (isPassive) {
    mgr.card.ui.setAnnouncementMode(true);
  }

  // Pre-announcement
  if (ann.preannounce === false) {
    mgr.log.log(logPrefix, 'Preannounce disabled - skipping chime');
    _playMain(mgr, ann, onComplete, logPrefix);
  } else {
    const hasPreAnnounce = ann.preannounce_media_id && ann.preannounce_media_id !== '';

    if (hasPreAnnounce) {
      mgr.log.log(logPrefix, `Playing pre-announcement media: ${ann.preannounce_media_id}`);
      playMediaFor(mgr, ann.preannounce_media_id, logPrefix, () => {
        _playMain(mgr, ann, onComplete, logPrefix);
      });
    } else {
      const vol = mgr.card.mediaPlayer.volume;
      playMediaUrl(CHIME_ANNOUNCE_URI, vol, {
        onEnd: () => {
          mgr.card.mediaPlayer.notifyAudioEnd('announce-chime');
          _playMain(mgr, ann, onComplete, logPrefix);
        },
        onError: () => {
          mgr.card.mediaPlayer.notifyAudioEnd('announce-chime');
          _playMain(mgr, ann, onComplete, logPrefix);
        },
        onStart: () => {
          mgr.log.log(logPrefix, 'Announcement chime playing');
          mgr.card.mediaPlayer.notifyAudioStart('announce-chime');
        },
      });
    }
  }
}

function _playMain(mgr, ann, onComplete, logPrefix) {
  const mediaUrl = ann.media_id || '';

  if (ann.message) {
    // Passive announcements use centered 'announcement' style;
    // interactive notifications (ask_question, start_conversation)
    // use 'assistant' style so they follow the configured chat layout.
    const isPassive = !ann.ask_question && !ann.start_conversation;
    mgr.card.ui.addChatMessage(ann.message, isPassive ? 'announcement' : 'assistant');
  }

  if (mediaUrl) {
    mgr.log.log(logPrefix, `Playing media: ${mediaUrl}`);
    playMediaFor(mgr, mediaUrl, logPrefix, () => onComplete(ann));
  } else {
    mgr.log.log(logPrefix, 'No media - completing after message display');
    setTimeout(() => onComplete(ann), Timing.NO_MEDIA_DISPLAY);
  }
}


/**
 * Clear notification UI: bubbles, blur, bar restore.
 * @param {object} mgr
 */
export function clearNotificationUI(mgr) {
  if (mgr.clearTimeoutId) {
    clearTimeout(mgr.clearTimeoutId);
    mgr.clearTimeoutId = null;
  }

  mgr.card.ui.setAnnouncementMode(false);
  mgr.card.ui.clearAnnouncementBubbles();
  mgr.card.ui.hideBlurOverlay(BlurReason.ANNOUNCEMENT);
  mgr.card.ui.restoreBar(mgr.barWasVisible);
}


/**
 * Play a media URL with volume from config.
 */
export function playMediaFor(mgr, urlPath, logPrefix, onDone) {
  const url = buildMediaUrl(urlPath);
  const volume = mgr.card.mediaPlayer.volume;

  mgr.currentAudio = playMediaUrl(url, volume, {
    onEnd: () => {
      mgr.log.log(logPrefix, 'Media playback complete');
      mgr.currentAudio = null;
      mgr.card.analyser.detachAudio();
      mgr.card.mediaPlayer.notifyAudioEnd('notification');
      onDone?.();
    },
    onError: (e) => {
      mgr.log.error(logPrefix, `Media playback error: ${e}`);
      mgr.currentAudio = null;
      mgr.card.analyser.detachAudio();
      mgr.card.mediaPlayer.notifyAudioEnd('notification');
      onDone?.();
    },
    onStart: () => {
      mgr.log.log(logPrefix, 'Media playback started');
      mgr.card.mediaPlayer.notifyAudioStart('notification');
      if (mgr.card.isReactiveBarEnabled && mgr.currentAudio) {
        mgr.card.analyser.attachAudio(mgr.currentAudio, mgr.card.audio.audioContext);
      }
    },
  });
}


/**
 * Initialize shared notification state on a manager instance.
 * @param {object} mgr
 */
export function initNotificationState(mgr) {
  mgr.playing = false;
  mgr.currentAudio = null;
  mgr.currentAnnounceId = null;
  mgr.clearTimeoutId = null;
  mgr.barWasVisible = false;
  mgr.queued = null;
}
