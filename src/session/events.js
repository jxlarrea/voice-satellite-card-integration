/**
 * Session Events
 *
 * State transitions, user interactions, pipeline message dispatch,
 * TTS completion handling, and satellite state sync.
 *
 * All functions operate on the VoiceSatelliteSession instance
 * (which implements the same interface managers expect from a card).
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';
import { subscribeSatelliteEvents, teardownSatelliteSubscription } from '../shared/satellite-subscription.js';
import { dispatchSatelliteEvent } from '../shared/satellite-notification.js';
import { getSwitchState } from '../shared/satellite-state.js';

/**
 * Sync pipeline state to the integration entity.
 * @param {import('./index.js').VoiceSatelliteSession} session
 * @param {string} state
 */
function syncSatelliteState(session, state) {
  const entityId = session.config.satellite_entity;
  if (!entityId || !session.hass?.connection) return;

  if (state === session.lastSyncedSatelliteState) return;
  session.lastSyncedSatelliteState = state;

  session.hass.connection.sendMessagePromise({
    type: 'voice_satellite/update_state',
    entity_id: entityId,
    state,
  }).catch(() => { /* fire-and-forget */ });
}

/**
 * Set session state and update all card UIs.
 * @param {import('./index.js').VoiceSatelliteSession} session
 * @param {string} newState
 */
export function setState(session, newState) {
  const oldState = session.currentState;
  session.currentState = newState;
  session.logger.log('state', `${oldState} -> ${newState}`);
  session.ui.updateForState(newState, session.pipeline.serviceUnavailable, session.tts.isPlaying);

  // Don't sync back to idle/listening while TTS is still playing (barge-in restart)
  if (session.tts.isPlaying && (newState === State.LISTENING || newState === State.IDLE)) return;
  syncSatelliteState(session, newState);
}

/**
 * Handle start button click.
 * @param {import('./index.js').VoiceSatelliteSession} session
 */
export async function handleStartClick(session) {
  await session.audio.ensureAudioContextForGesture();
  await startListening(session);
}

/**
 * Start the voice pipeline (mic + pipeline).
 * @param {import('./index.js').VoiceSatelliteSession} session
 */
export async function startListening(session) {
  if (session._hasStarted && session.pipeline.binaryHandlerId) {
    session.logger.log('lifecycle', 'Session already running');
    return;
  }
  if (session._starting) {
    session.logger.log('lifecycle', 'Session already starting, skipping');
    return;
  }

  session._starting = true;

  try {
    setState(session, State.CONNECTING);
    await session.audio.startMicrophone();
    await session.pipeline.start();

    session._hasStarted = true;
    session.ui.hideStartButton();

    // Setup visibility handler for tab pause/resume
    session.visibility.setup();

    // Subscribe notification managers
    session.timer.update();
    subscribeSatelliteEvents(session, (event) => dispatchSatelliteEvent(session, event));

    // Setup double-tap after first successful start
    session.doubleTap.setup();
  } catch (e) {
    // Rollback: if mic was started but pipeline failed, stop it
    try { session.audio.stopMicrophone(); } catch (_) {}

    const msg = e?.message || JSON.stringify(e);
    session.logger.error('pipeline', `Failed to start: ${msg}`);
    const errText = `${e?.name || ''} ${e?.message || ''}`.toLowerCase();

    let reason = 'error';
    if (
      e.name === 'NotAllowedError'
      || (
        (errText.includes('audio context') || errText.includes('audiocontext'))
        && (
          errText.includes('failed to start')
          || errText.includes('not allowed')
          || errText.includes('user gesture')
          || errText.includes('suspended')
        )
      )
    ) {
      reason = 'not-allowed';
      session.logger.log('mic', 'Access denied - browser requires user gesture');
    } else if (e.name === 'NotFoundError') {
      reason = 'not-found';
      session.logger.error('mic', 'No microphone found');
    } else if (e.name === 'NotReadableError' || e.name === 'AbortError') {
      reason = 'not-readable';
      session.logger.error('mic', 'Microphone in use or not readable');
    }

    setState(session, State.IDLE);
    if (reason !== 'error') {
      session.ui.showStartButton(reason);
    } else {
      session.pipeline.restart(session.pipeline.calculateRetryDelay());
    }
  } finally {
    session._starting = false;
  }
}

/**
 * Handle TTS playback completion.
 * @param {import('./index.js').VoiceSatelliteSession} session
 * @param {boolean} [playbackFailed]
 */
export function onTTSComplete(session, playbackFailed) {
  // If a NEW interaction started during TTS, don't clean up
  const newInteractionStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT];
  if (newInteractionStates.includes(session.currentState)) {
    session.logger.log('tts', 'New interaction in progress - skipping cleanup');
    return;
  }

  // Continue conversation (only if TTS played successfully)
  if (!playbackFailed && session.pipeline.shouldContinue && session.pipeline.continueConversationId) {
    session.logger.log('pipeline', 'Continuing conversation - skipping wake word');
    const conversationId = session.pipeline.continueConversationId;
    session.pipeline.clearContinueState();
    session.chat.streamEl = null;

    // Keep blur, bar, and chat visible
    session.pipeline.restartContinue(conversationId);
    return;
  }

  // Normal completion - skip done chime on error (error chime already played)
  const isRemote = !!session.ttsTarget;
  if (!playbackFailed && getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
    session.tts.playChime('done');
  }

  const cleanup = () => {
    session._imageLingerTimeout = null;
    // User is actively browsing images - don't auto-dismiss
    if (session.ui.isLightboxVisible()) return;
    session.chat.clear();
    session.ui.hideBlurOverlay(BlurReason.PIPELINE);
    session.ui.updateForState(session.currentState, session.pipeline.serviceUnavailable, false);
    syncSatelliteState(session, 'IDLE');

    // Play any queued notifications
    session.announcement.playQueued();
    session.askQuestion.playQueued();
    session.startConversation.playQueued();
  };

  // Mini-card hook: keep the text visible briefly while a compact marquee is
  // actively scrolling, so the user can finish reading after TTS ends.
  const customLingerMs = typeof session.ui?.getTtsLingerTimeoutMs === 'function'
    ? session.ui.getTtsLingerTimeoutMs()
    : 0;
  if (customLingerMs > 0) {
    session.ui.stopReactive();
    if (session._imageLingerTimeout) clearTimeout(session._imageLingerTimeout);
    session._imageLingerTimeout = setTimeout(cleanup, customLingerMs);
    return;
  }

  // When images are showing, keep the visual UI for 30 seconds
  // Stop only the mic reactivity so the bar doesn't respond to audio
  if (session.ui.hasVisibleImages()) {
    session.ui.stopReactive();
    if (session._imageLingerTimeout) clearTimeout(session._imageLingerTimeout);
    session._imageLingerTimeout = setTimeout(cleanup, Timing.IMAGE_LINGER);
  } else if (playbackFailed) {
    // TTS failed (e.g. autoplay blocked) - keep response visible so the user can read it
    session.logger.log('tts', 'Playback failed - lingering response text');
    session.ui.stopReactive();
    if (session._imageLingerTimeout) clearTimeout(session._imageLingerTimeout);
    session._imageLingerTimeout = setTimeout(cleanup, Timing.TTS_FAILED_LINGER);
  } else {
    cleanup();
  }
}

/**
 * Dispatch a pipeline event message to the appropriate handler.
 * @param {import('./index.js').VoiceSatelliteSession} session
 * @param {object} message
 */
export function handlePipelineMessage(session, message) {
  if (session.visibility.isPaused) {
    session.logger.log('event', `Ignoring event while paused: ${message.type}`);
    return;
  }

  if (session.pipeline.isRestarting) {
    session.logger.log('event', `Ignoring event while restarting: ${message.type}`);
    return;
  }

  const eventType = message.type;
  const eventData = message.data || {};

  if (session.config.debug) {
    const timestamp = message.timestamp ? message.timestamp.split('T')[1].split('.')[0] : '';
    session.logger.log('event', `${timestamp} ${eventType} ${JSON.stringify(eventData).substring(0, 500)}`);
  }

  switch (eventType) {
    case 'run-start': session.pipeline.handleRunStart(eventData); break;
    case 'wake_word-start': session.pipeline.handleWakeWordStart(); break;
    case 'wake_word-end': session.pipeline.handleWakeWordEnd(eventData); break;
    case 'stt-start': setState(session, State.STT); break;
    case 'stt-vad-start': session.logger.log('event', 'VAD: speech started'); break;
    case 'stt-vad-end': session.logger.log('event', 'VAD: speech ended'); break;
    case 'stt-end': session.pipeline.handleSttEnd(eventData); break;
    case 'intent-start': setState(session, State.INTENT); break;
    case 'intent-progress':
      session.pipeline.handleIntentProgress(eventData);
      break;
    case 'intent-end': session.pipeline.handleIntentEnd(eventData); break;
    case 'tts-start': setState(session, State.TTS); break;
    case 'tts-end': session.pipeline.handleTtsEnd(eventData); break;
    case 'run-end': session.pipeline.handleRunEnd(); break;
    case 'error': session.pipeline.handleError(eventData); break;
    case 'displaced':
      session.logger.error('pipeline', 'Pipeline displaced - another browser is using this satellite entity');
      session.teardown();
      session.chat.clear();
      session.ui.hideBlurOverlay(BlurReason.PIPELINE);
      session.ui.hideBlurOverlay(BlurReason.ANNOUNCEMENT);
      session.currentState = State.IDLE;
      session.ui.showStartButton();
      break;
  }
}
