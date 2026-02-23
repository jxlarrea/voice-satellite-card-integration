/**
 * Voice Satellite Card — Card Events
 *
 * State transitions, user interactions, pipeline message dispatch,
 * and TTS completion handling.
 *
 * Uses ONLY public accessors on the card instance.
 */

import { State, INTERACTING_STATES, BlurReason } from '../constants.js';
import { syncSatelliteState } from './comms.js';
import * as singleton from '../shared/singleton.js';
import { subscribeSatelliteEvents, teardownSatelliteSubscription } from '../shared/satellite-subscription.js';
import { dispatchSatelliteEvent } from '../shared/satellite-notification.js';
import { getSwitchState } from '../shared/satellite-state.js';

/**
 * Set card state and update UI.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {string} newState
 */
export function setState(card, newState) {
  const oldState = card.currentState;
  card.currentState = newState;
  card.logger.log('state', `${oldState} → ${newState}`);
  card.ui.updateForState(newState, card.pipeline.serviceUnavailable, card.tts.isPlaying);

  // Don't sync back to idle/listening while TTS is still playing (barge-in restart)
  if (card.tts.isPlaying && (newState === State.LISTENING || newState === State.IDLE)) return;
  syncSatelliteState(card, newState);
}

/**
 * Handle start button click.
 * @param {import('./index.js').VoiceSatelliteCard} card
 */
export async function handleStartClick(card) {
  await card.audio.ensureAudioContextForGesture();
  await startListening(card);
}

/**
 * Start the voice pipeline (mic + pipeline).
 * @param {import('./index.js').VoiceSatelliteCard} card
 */
export async function startListening(card) {
  if (singleton.isActive() && !singleton.isOwner(card)) {
    card.logger.log('lifecycle', 'Another instance is active, skipping');
    return;
  }
  if (singleton.isStarting()) {
    card.logger.log('lifecycle', 'Pipeline already starting globally, skipping');
    return;
  }

  singleton.setStarting(true);

  try {
    setState(card, State.CONNECTING);
    await card.audio.startMicrophone();
    await card.pipeline.start();

    singleton.claim(card);
    card.ui.hideStartButton();

    // Ensure visibility handler is on the owner — connectedCallback may
    // not have fired for this instance (e.g. card-mod creates an extra
    // element that gets config+hass but is never attached to the DOM).
    card.visibility.setup();

    // Subscribe notification managers now that we're the active owner
    card.timer.update();
    subscribeSatelliteEvents(card, (event) => dispatchSatelliteEvent(card, event));

    // Setup double-tap after first successful start
    card.doubleTap.setup();
  } catch (e) {
    const msg = e?.message || JSON.stringify(e);
    card.logger.error('pipeline', `Failed to start: ${msg}`);

    let reason = 'error';
    if (e.name === 'NotAllowedError') {
      reason = 'not-allowed';
      card.logger.log('mic', 'Access denied — browser requires user gesture');
    } else if (e.name === 'NotFoundError') {
      reason = 'not-found';
      card.logger.error('mic', 'No microphone found');
    } else if (e.name === 'NotReadableError' || e.name === 'AbortError') {
      reason = 'not-readable';
      card.logger.error('mic', 'Microphone in use or not readable');
    }

    setState(card, State.IDLE);
    if (reason !== 'error') {
      card.ui.showStartButton(reason);
    } else {
      card.pipeline.restart(card.pipeline.calculateRetryDelay());
    }
  } finally {
    singleton.setStarting(false);
  }
}

/**
 * Handle TTS playback completion.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {boolean} [playbackFailed]
 */
export function onTTSComplete(card, playbackFailed) {
  // If a NEW interaction started during TTS, don't clean up
  const newInteractionStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT];
  if (newInteractionStates.includes(card.currentState)) {
    card.logger.log('tts', 'New interaction in progress — skipping cleanup');
    return;
  }

  // Continue conversation (only if TTS played successfully)
  if (!playbackFailed && card.pipeline.shouldContinue && card.pipeline.continueConversationId) {
    card.logger.log('pipeline', 'Continuing conversation — skipping wake word');
    const conversationId = card.pipeline.continueConversationId;
    card.pipeline.clearContinueState();
    card.chat.streamEl = null;

    // Keep blur, bar, and chat visible
    card.pipeline.restartContinue(conversationId);
    return;
  }

  // Normal completion
  const isRemote = !!card.ttsTarget;
  if (getSwitchState(card.hass, card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
    card.tts.playChime('done');
  }

  card.chat.clear();
  card.ui.hideBlurOverlay(BlurReason.PIPELINE);
  card.ui.updateForState(card.currentState, card.pipeline.serviceUnavailable, false);
  syncSatelliteState(card, 'IDLE');

  // Play any queued notifications
  card.announcement.playQueued();
  card.askQuestion.playQueued();
  card.startConversation.playQueued();
}

/**
 * Dispatch a pipeline event message to the appropriate handler.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {object} message
 */
export function handlePipelineMessage(card, message) {
  if (card.visibility.isPaused) {
    card.logger.log('event', `Ignoring event while paused: ${message.type}`);
    return;
  }

  if (card.pipeline.isRestarting) {
    card.logger.log('event', `Ignoring event while restarting: ${message.type}`);
    return;
  }

  const eventType = message.type;
  const eventData = message.data || {};

  if (card.config.debug) {
    const timestamp = message.timestamp ? message.timestamp.split('T')[1].split('.')[0] : '';
    card.logger.log('event', `${timestamp} ${eventType} ${JSON.stringify(eventData).substring(0, 500)}`);
  }

  switch (eventType) {
    case 'run-start': card.pipeline.handleRunStart(eventData); break;
    case 'wake_word-start': card.pipeline.handleWakeWordStart(); break;
    case 'wake_word-end': card.pipeline.handleWakeWordEnd(eventData); break;
    case 'stt-start': setState(card, State.STT); break;
    case 'stt-vad-start': card.logger.log('event', 'VAD: speech started'); break;
    case 'stt-vad-end': card.logger.log('event', 'VAD: speech ended'); break;
    case 'stt-end': card.pipeline.handleSttEnd(eventData); break;
    case 'intent-start': setState(card, State.INTENT); break;
    case 'intent-progress':
      card.pipeline.handleIntentProgress(eventData);
      break;
    case 'intent-end': card.pipeline.handleIntentEnd(eventData); break;
    case 'tts-start': setState(card, State.TTS); break;
    case 'tts-end': card.pipeline.handleTtsEnd(eventData); break;
    case 'run-end': card.pipeline.handleRunEnd(); break;
    case 'error': card.pipeline.handleError(eventData); break;
    case 'displaced':
      card.logger.error('pipeline', 'Pipeline displaced — another browser is using this satellite entity');
      card.pipeline.stop();
      card.audio.stopMicrophone();
      card.tts.stop();
      card.timer.destroy();
      teardownSatelliteSubscription();
      card.chat.clear();
      card.ui.hideBlurOverlay(BlurReason.PIPELINE);
      card.ui.hideBlurOverlay(BlurReason.ANNOUNCEMENT);
      singleton.release();
      card.currentState = State.IDLE;
      card.ui.showStartButton();
      break;
  }
}
