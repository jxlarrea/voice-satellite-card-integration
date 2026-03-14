/** Shared notification dispatch, queueing, and playback flow. */

import { CHIME_ANNOUNCE_URI } from '../audio/chime.js';
import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';
import { playRemote } from '../tts/comms.js';
import { BlurReason, Timing } from '../constants.js';

/** Safety timeout for remote notification playback (matches TTS manager) */
const REMOTE_SAFETY_TIMEOUT = 30_000;

let _lastAnnounceId = 0;


let _pendingEvent = null;
let _pendingCard = null;
let _visibilityListenerAdded = false;

/**
 * Remove the visibilitychange listener and clear pending state.
 * Called from teardownSatelliteSubscription to prevent stale closures.
 */
export function teardownVisibilityListener() {
  if (_visibilityListenerAdded) {
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    _visibilityListenerAdded = false;
  }
  _pendingEvent = null;
  _pendingCard = null;
}

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

  // TTS audio duration - route to TTS manager and any active notification manager
  if (type === 'tts-audio-duration') {
    card.tts.setAudioDuration(data.duration, data.tts_url);
    _setNotificationAudioDuration(card, data.duration);
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

  // UI: blur overlay + wake screen + notification state
  mgr.card.ui.showBlurOverlay(BlurReason.ANNOUNCEMENT);
  mgr.barWasVisible = mgr.card.ui.onNotificationStart();

  // Only center on screen for passive announcements (not ask_question or start_conversation)
  const isPassive = !ann.ask_question && !ann.start_conversation;
  if (isPassive) {
    mgr.card.ui.setAnnouncementMode(true);
  }

  // Pre-announcement
  const isRemote = !!mgr.card.ttsTarget;
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
    } else if (isRemote) {
      // Skip browser chime when remote — consistent with pipeline chime behavior
      mgr.log.log(logPrefix, 'Skipping chime - remote TTS output');
      _playMain(mgr, ann, onComplete, logPrefix);
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
    // Stop word disabled — kept for future re-enablement
    // _enableStopWordDelayed(mgr);
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

  _disableStopWord(mgr);

  mgr.card.ui.setAnnouncementMode(false);
  mgr.card.ui.clearAnnouncementBubbles();
  mgr.card.ui.hideBlurOverlay(BlurReason.ANNOUNCEMENT);
  mgr.card.ui.onNotificationDismiss(mgr.barWasVisible);
}


/**
 * Play a media URL with volume from config.
 * Routes to remote media player when TTS output is configured.
 */
export function playMediaFor(mgr, urlPath, logPrefix, onDone) {
  const ttsTarget = mgr.card.ttsTarget;
  if (ttsTarget) {
    _playMediaForRemote(mgr, urlPath, ttsTarget, logPrefix, onDone);
    return;
  }

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

function _playMediaForRemote(mgr, urlPath, ttsTarget, logPrefix, onDone) {
  const remoteUrl = urlPath.startsWith('media-source://') ? urlPath : buildMediaUrl(urlPath);
  mgr.log.log(logPrefix, `Playing on remote: ${ttsTarget} media: ${remoteUrl}`);
  mgr.card.mediaPlayer.notifyAudioStart('notification');

  const entity = mgr.card.hass?.states?.[ttsTarget];
  mgr._remotePlayback = {
    target: ttsTarget,
    sawPlaying: false,
    initialState: entity?.state,
    initialContentId: entity?.attributes?.media_content_id || null,
    onDone: () => {
      _clearRemotePlayback(mgr);
      mgr.card.mediaPlayer.notifyAudioEnd('notification');
      onDone?.();
    },
    logPrefix,
  };

  playRemote(mgr.card, remoteUrl).catch(() => {
    mgr.log.log(logPrefix, 'Remote play service call failed - forcing completion');
    mgr._remotePlayback?.onDone();
  });

  mgr._remoteTimeout = setTimeout(() => {
    mgr.log.log(logPrefix, 'Remote safety timeout - forcing completion');
    mgr._remotePlayback?.onDone();
  }, REMOTE_SAFETY_TIMEOUT);
}

/**
 * Set a duration-based completion timer on whichever notification manager
 * has active remote playback. Replaces the 30s safety timeout.
 */
function _setNotificationAudioDuration(card, duration) {
  if (!duration) return;
  const managers = [card.announcement, card.startConversation, card.askQuestion];
  for (const mgr of managers) {
    if (!mgr?._remotePlayback) continue;
    mgr.log.log(mgr._remotePlayback.logPrefix, `Audio duration received: ${duration}s — setting completion timer`);
    // Replace safety timeout with duration-based one (+ 2s buffer)
    if (mgr._remoteTimeout) {
      clearTimeout(mgr._remoteTimeout);
    }
    mgr._remoteTimeout = setTimeout(() => {
      mgr.log.log(mgr._remotePlayback?.logPrefix || 'notify', 'Duration-based timer fired — completing');
      mgr._remotePlayback?.onDone();
    }, (duration + 2) * 1000);
    return; // Only one manager should be playing at a time
  }
}

function _clearRemotePlayback(mgr) {
  if (mgr._remoteTimeout) {
    clearTimeout(mgr._remoteTimeout);
    mgr._remoteTimeout = null;
  }
  mgr._remotePlayback = null;
}

/**
 * Check remote media player state for notification playback completion.
 * Called from session.updateHass() for each notification manager.
 * Same pattern as TtsManager.checkRemotePlayback().
 * @param {object} mgr - Notification manager instance
 * @param {object} hass
 */
export function checkRemoteNotificationPlayback(mgr, hass) {
  if (!mgr?._remotePlayback) return;

  const { target, initialState, initialContentId, onDone, logPrefix } = mgr._remotePlayback;
  const entity = hass.states?.[target];
  if (!entity) return;

  const state = entity.state;
  const contentId = entity.attributes?.media_content_id || null;
  const isActive = state === 'playing' || state === 'buffering';

  // Phase 1: detect our content started playing
  if (!mgr._remotePlayback.sawPlaying) {
    if (!isActive) return;
    const wasAlreadyActive = initialState === 'playing' || initialState === 'buffering';
    if (wasAlreadyActive && contentId === initialContentId) return;
    mgr._remotePlayback.sawPlaying = true;
    return;
  }

  // Phase 2: detect our content finished
  if (!isActive) {
    mgr.log.log(logPrefix, `Remote player stopped (state: ${state}) — completing`);
    onDone();
    return;
  }

  if (initialContentId && contentId === initialContentId) {
    mgr.log.log(logPrefix, 'Remote player resumed original content — completing');
    onDone();
  }
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
  mgr._remotePlayback = null;
  mgr._remoteTimeout = null;
  mgr._stopWordTimer = null;
}


// ── Stop word helpers ─────────────────────────────────────────────

function _enableStopWordDelayed(mgr) {
  if (mgr._stopWordTimer) clearTimeout(mgr._stopWordTimer);
  mgr._stopWordTimer = setTimeout(() => {
    mgr._stopWordTimer = null;
    const wakeWord = mgr.card.wakeWord;
    if (wakeWord && mgr.playing) {
      wakeWord.enableStopModel(true);
    }
  }, 1000);
}

function _disableStopWord(mgr) {
  if (mgr._stopWordTimer) {
    clearTimeout(mgr._stopWordTimer);
    mgr._stopWordTimer = null;
  }
  mgr.card.wakeWord?.disableStopModel();
}
