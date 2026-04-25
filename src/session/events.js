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
import { getSwitchState, getSelectState, getNumberState, getSatelliteAttr } from '../shared/satellite-state.js';
import { setChimeDurationOverrides } from '../audio/chime.js';

const WAKE_MODE_HA = 'home-assistant';
const WAKE_MODE_LOCAL = 'on-device';
const WAKE_MODE_DISABLED = 'disabled';

/**
 * Read the wake-word detection mode from the integration's select entity.
 * @returns {'home-assistant'|'on-device'|'disabled'}
 */
export function getWakeWordMode(session) {
  const raw = getSelectState(
    session.hass, session.config.satellite_entity,
    'wake_word_detection', 'Home Assistant',
  );
  if (raw === 'On Device') return WAKE_MODE_LOCAL;
  if (raw === 'Disabled') return WAKE_MODE_DISABLED;
  return WAKE_MODE_HA;
}

/**
 * Fetch the server-probed chime duration manifest from
 * `/voice_satellite/sounds/durations.json` and install the values into
 * the chime module.  The integration writes this file in
 * `_write_sound_durations()` (__init__.py) after syncing any user-
 * supplied sound files, so the values reflect the *real* lengths of
 * whatever chimes are currently installed — including custom user
 * overrides.  Logs through the session logger so the lines only show
 * with debug enabled.  Called from startListening once the session has
 * been configured (logger.debug already reflects the user's setting).
 */
async function fetchChimeDurations(session) {
  const log = session.logger;
  try {
    const resp = await fetch('/voice_satellite/sounds/durations.json', {
      cache: 'no-cache',
      credentials: 'same-origin',
    });
    if (!resp.ok) {
      log.error('chime', `duration manifest fetch: HTTP ${resp.status}; using hardcoded defaults`);
      return;
    }
    const data = await resp.json();
    if (!data || typeof data !== 'object') {
      log.error('chime', 'duration manifest: invalid JSON payload; using hardcoded defaults');
      return;
    }
    setChimeDurationOverrides(data);
    const summary = Object.entries(data)
      .map(([k, v]) => `${k}=${Number(v).toFixed(3)}s`)
      .join(' ');
    log.log('chime', `duration manifest loaded: ${summary || '(empty)'}`);
  } catch (e) {
    log.error('chime', `duration manifest fetch failed: ${e?.message || e}; using hardcoded defaults`);
  }
}

function isConstrainedWebView() {
  const ua = navigator.userAgent || '';
  return /Fully Kiosk/i.test(ua) || /\bwv\b/i.test(ua);
}

async function settleBeforeWakeWordStart(session) {
  if (!isConstrainedWebView()) return;
  session.logger.log('wake-word', 'Constrained WebView detected — delaying initial wake-word startup');
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

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

  // Dismiss screensaver when a voice interaction begins; also manage
  // the external-screensaver keep-alive loop so the tablet's native
  // screensaver can't cover the voice UI mid-conversation.  We keep
  // the keep-alive running while TTS audio is still playing even if
  // the pipeline state has already transitioned away — otherwise the
  // external screensaver can sneak back in before the response
  // finishes speaking.  onTTSComplete stops the loop once playback
  // actually ends.
  const wasInteracting = INTERACTING_STATES.includes(oldState);
  const isInteracting = INTERACTING_STATES.includes(newState);
  if (isInteracting) {
    session.screensaver.dismiss();
    if (!wasInteracting) session.screensaver.startExternalKeepalive();
  } else if (wasInteracting && !session.tts?.isPlaying) {
    session.screensaver.stopExternalKeepalive();
  }

  // Swap mic DSP config between wake-word and STT modes.  WAKE_WORD_DETECTED
  // fires locally *before* the server sends `stt-start`, giving us a ~200 ms
  // head start to re-acquire the mic with STT constraints so no audio is
  // dropped once STT actually begins recording.  On the way back out of STT
  // (INTENT/TTS/IDLE/LISTENING), we swap back to wake-word mode — that
  // happens during server-side intent processing, not while the user is
  // speaking, so dropout there is free.
  //
  // Fire-and-forget (async): the setState flow must stay synchronous so UI
  // updates render immediately.  The mic swap runs in the background and
  // settles within a few tens of ms.
  const sttPhase = (s) => s === State.WAKE_WORD_DETECTED || s === State.STT;
  const wasStt = sttPhase(oldState);
  const isStt = sttPhase(newState);
  if (wasStt !== isStt && session._hasStarted && session.audio?.switchMicMode) {
    const targetMode = isStt ? 'stt' : 'wake_word';
    session.audio.switchMicMode(targetMode).catch((e) => {
      session.logger.error('mic', `switchMicMode(${targetMode}) failed: ${e.message || e}`);
    });
  }

  session.ui.updateForState(newState, session.pipeline.serviceUnavailable, session.tts.isPlaying);

  // Don't sync back to idle/listening while TTS is still playing (barge-in restart)
  if (session.tts.isPlaying && (newState === State.LISTENING || newState === State.IDLE)) return;
  syncSatelliteState(session, newState);
}

/**
 * Handle start button click.
 *
 * In Disabled wake-word mode the start button doubles as the wake
 * affordance: once the session is up, tapping it triggers the same flow
 * as the voice_satellite.wake action (mic + STT) instead of trying to
 * (re)start a wake-word listener that doesn't exist.
 *
 * @param {import('./index.js').VoiceSatelliteSession} session
 */
export async function handleStartClick(session) {
  await session.audio.ensureAudioContextForGesture();
  if (session._hasStarted && getWakeWordMode(session) === WAKE_MODE_DISABLED) {
    await triggerWake(session);
    return;
  }
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
    const mode = getWakeWordMode(session);

    // Disabled: don't acquire the mic and don't start the pipeline. The
    // session sits idle waiting for voice_satellite.wake to fire, which
    // starts the mic on demand and jumps straight to STT.  The full
    // card's start-button overlay stays hidden — wake is driven by the
    // service action (or dashboard buttons wired to it).  The mini card
    // still surfaces its small mic icon for IDLE state via _statusFor.
    if (mode === WAKE_MODE_DISABLED) {
      session.logger.log('wake-word', 'Mode = Disabled — skipping mic and pipeline');
      session._hasStarted = true;
      setState(session, State.IDLE);
      session.ui.hideStartButton();
      fetchChimeDurations(session);
      session.visibility.setup();
      session.timer.update();
      subscribeSatelliteEvents(session, (event) => dispatchSatelliteEvent(session, event));
      session.doubleTap.setup();
      return;
    }

    setState(session, State.CONNECTING);
    await session.audio.startMicrophone();

    // On-device wake word: load module lazily, start local inference
    if (mode === WAKE_MODE_LOCAL) {
      const ww = await session._loadWakeWordModule();
      await settleBeforeWakeWordStart(session);
      await ww.start();
    } else {
      await session.pipeline.start();
    }

    session._hasStarted = true;
    session.ui.hideStartButton();

    // Pull the server-probed chime durations (custom user MP3s included)
    // now that the session is up and the logger reflects the user's
    // debug preference — earlier in bootstrap the logger is still gated
    // off, so the manifest-load line never reaches the console even
    // with debug on.
    fetchChimeDurations(session);

    // Log session duration setting
    const sessionDuration = getSelectState(
      session.hass, session.config.satellite_entity, 'session_duration', 'Persistent',
    );
    session.logger.log('session', `Session duration: ${sessionDuration}`);

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
      // Microphone acquisition failed. The start button is already
      // shown with a reason-specific title ("Tap to enable microphone",
      // "No microphone found", etc.), which is the right call-to-action
      // here; a redundant toast on top would just add noise.
      session.ui.showStartButton(reason);
    } else {
      // Error #4: generic pipeline start failure (missing connection,
      // missing entity, misconfigured pipeline, etc). Surface it before
      // scheduling the retry so the user knows the retry loop is running.
      const pipelineName = getSatelliteAttr(
        session.hass,
        session.config.satellite_entity,
        'pipeline',
      );
      const startCategory = pipelineName ? `Pipeline "${pipelineName}"` : 'Assist pipeline';
      session.toast.show({
        id: 'pipeline.start-failed',
        severity: 'error',
        category: startCategory,
        description: `Could not start. ${msg}`,
        action: { label: 'Open Diagnostics', type: 'diagnostics' },
      });
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
    // Capture the wake word slot before clearContinueState so the follow-
    // up turn stays on the same Pipeline N (otherwise slot 2 conversations
    // flip back to Pipeline 1's voice / agent on the second turn).
    const slot = session.pipeline.activeWakeWordSlot;
    session.pipeline.clearContinueState();
    session.chat.streamEl = null;

    // Keep blur, bar, and chat visible
    session.pipeline.restartContinue(conversationId, { wake_word_slot: slot });
    return;
  }

  // Normal completion - skip done chime on error (error chime already played)
  if (!playbackFailed && getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false) {
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

    // Now that the interaction has really ended (TTS audio too), stop
    // forcing the external screensaver off so whatever owns that
    // switch (usually Fully Kiosk) can resume its own idle timer.
    session.screensaver.stopExternalKeepalive();

    // Reset screensaver idle timer after interaction completes
    session.screensaver.notifyActivity();

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
    const overlayLingerS = getNumberState(session.hass, session.config.satellite_entity, 'overlay_linger', 0);
    if (overlayLingerS > 0) {
      session.ui.stopReactive();
      if (session._imageLingerTimeout) clearTimeout(session._imageLingerTimeout);
      session._imageLingerTimeout = setTimeout(cleanup, overlayLingerS * 1000);
    } else {
      cleanup();
    }
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
    case 'intent-start':
      setState(session, State.INTENT);
      session.chat.showThinking();
      break;
    case 'intent-progress':
      session.pipeline.handleIntentProgress(eventData);
      break;
    case 'intent-end': session.pipeline.handleIntentEnd(eventData); break;
    case 'tts-start': setState(session, State.TTS); break;
    case 'tts-end': session.pipeline.handleTtsEnd(eventData); break;
    case 'tts-audio-duration': session.tts.setAudioDuration(eventData.duration); break;
    case 'run-end': session.pipeline.handleRunEnd(); break;
    case 'error': session.pipeline.handleError(eventData); break;
    case 'displaced':
      session.logger.error('pipeline', 'Pipeline displaced - another browser is using this satellite entity');
      session.toast.show({
        id: 'session.displaced',
        severity: 'warn',
        category: 'Session',
        description: 'Another browser took over this satellite. This device has stopped listening.',
      });
      session.teardown();
      session.chat.clear();
      session.ui.hideBlurOverlay(BlurReason.PIPELINE);
      session.ui.hideBlurOverlay(BlurReason.ANNOUNCEMENT);
      // The wake-word event that preceded displace left the rainbow bar
      // in 'listening' / 'speaking' mode. teardown() stops the pipeline
      // but does not touch DOM; drop the bar explicitly so nothing stays
      // painted on screen when the overlay is gone.
      session.ui.hideBar();
      session.currentState = State.IDLE;
      session.ui.showStartButton();
      break;
    case 'reload':
      session.logger.log('pipeline', 'Integration reloading - pipeline will restart');
      break;
  }
}

/**
 * Trigger the satellite as if a wake word had fired. Mode-aware: skips
 * any local detection / running pipeline and routes straight to STT.
 * Called by voice_satellite.wake via the satellite event dispatcher.
 *
 * @param {import('./index.js').VoiceSatelliteSession} session
 */
export async function triggerWake(session) {
  // Block if mid-interaction — the user is already in STT/INTENT/TTS
  // and another wake would just thrash state.
  const interacting = INTERACTING_STATES.includes(session.currentState);
  if (interacting) {
    session.logger.log('wake', `Ignored - already interacting (${session.currentState})`);
    return;
  }

  if (!session._hasStarted) {
    // Card hasn't started yet (no gesture, satellite_entity unset, etc.).
    // Defer: try start() first, which will pick the right path including
    // the disabled fast-path that skips mic acquisition.
    session.logger.log('wake', 'Session not started — starting first');
    try { await session.start(); } catch (_) { /* fall through */ }
  }

  const mode = getWakeWordMode(session);
  session.logger.log('wake', `Triggering manual wake (mode=${mode})`);

  try {
    if (mode === WAKE_MODE_LOCAL && session.wakeWord) {
      // Local detector is running.  Stop it, then start the server
      // pipeline at STT — same shape as a real local detection.
      try { session.wakeWord.stop(); } catch (_) { /* ignore */ }
    } else if (mode === WAKE_MODE_HA) {
      // Server pipeline is currently waiting for a wake word.  Stop it
      // first so the next start() begins from STT instead of wake_word.
      await session.pipeline.stop();
    } else if (mode === WAKE_MODE_DISABLED) {
      // Mic is intentionally off in disabled mode — bring it up now.
      if (!session.audio._mediaStream) {
        await session.audio.startMicrophone('stt');
      }
    }

    setState(session, State.WAKE_WORD_DETECTED);

    // Hide the manual-wake affordance for the duration of the
    // interaction so it doesn't overlap the active UI.  The pipeline
    // restart's disabled branch re-shows it once the turn ends.
    session.ui.hideStartButton();

    // Show the blur overlay — normally the HA wake_word-end handler or
    // the local wake-word detection path raises this; manual wake skips
    // both so we have to do it explicitly.
    session.ui.showBlurOverlay(BlurReason.PIPELINE);

    // Audible cue so the user (or whoever fired the action) knows the
    // satellite is now listening.  Honors the per-satellite wake_sound
    // switch, matching local/HA wake behavior.
    if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false) {
      session.tts.playChime('wake');
    }

    await session.pipeline.start({ start_stage: 'stt' });
  } catch (e) {
    session.logger.error('wake', `Manual wake failed: ${e?.message || e}`);
    setState(session, State.IDLE);
    // Always re-expose the wake affordance so the user can retry — pass
    // the not-allowed reason when relevant so the title prompt asks for
    // mic permission instead of just "tap to start".
    session.ui.showStartButton(e?.name === 'NotAllowedError' ? 'not-allowed' : undefined);
  }
}
