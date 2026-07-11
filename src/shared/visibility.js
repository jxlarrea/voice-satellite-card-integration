/**
 * VisibilityManager
 *
 * Handles tab visibility changes: releases the mic, wake word and pipeline
 * on hide (like the mute switch), restarts the full stack on show.
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';
import { hasPendingSatelliteEvent } from '../shared/satellite-notification.js';
import { refreshSatelliteSubscription } from '../shared/satellite-subscription.js';
import { startListening } from '../session/events.js';

export class VisibilityManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._isPaused = false;
    this._debounceTimer = null;
    this._handler = null;
    this._tornDown = false;
    this._stopPromise = null;
  }

  get isPaused() {
    return this._isPaused;
  }

  setup() {
    if (this._handler) return; // already registered
    this._handler = () => this._handleChange();
    document.addEventListener('visibilitychange', this._handler);
  }

  teardown() {
    if (this._handler) {
      document.removeEventListener('visibilitychange', this._handler);
      this._handler = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._isPaused = false;
    this._tornDown = false;
    this._stopPromise = null;
  }
  _handleChange() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    // Only the singleton owner should manage visibility - non-owner instances
    // have no mic or pipeline and must not interfere with the active owner.
    if (!this._card.isOwner) return;

    if (document.hidden) {
      const hasActivePipeline = !!this._card.pipeline?.binaryHandlerId;
      const hasActivePlayback = !!this._card.tts?.isPlaying;
      const isIdleNoSession = this._card.currentState === State.IDLE && !hasActivePipeline && !hasActivePlayback;
      if (isIdleNoSession) {
        // Nothing active to pause yet (common on mini card before first user
        // gesture in browsers that block mic startup). Keep the idle/start UI.
        return;
      }

      this._isPaused = true;

      // Cancel any in-progress ask_question flow - its cleanup timer
      // would otherwise fire after resume and double-restart the pipeline.
      this._card.askQuestion.cancel();

      const isInteracting = INTERACTING_STATES.includes(this._card.currentState);
      const isLingering = this._card._imageLingerTimeout || this._card.ui.hasVisibleImages() || this._card.ui.isLightboxVisible();

      if (isInteracting || isLingering) {
        this._log.log('visibility', `Tab hidden - cleaning up UI (interacting=${isInteracting}, lingering=${!!isLingering})`);
        if (this._card._imageLingerTimeout) {
          clearTimeout(this._card._imageLingerTimeout);
          this._card._imageLingerTimeout = null;
        }
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
        this._card.pipeline.clearContinueState();
        if (this._card.tts.isPlaying) {
          this._card.tts.stop();
        }
      }

      this._debounceTimer = setTimeout(() => {
        this._log.log('visibility', 'Tab hidden - releasing mic and wake word');
        this._pause();
      }, Timing.VISIBILITY_DEBOUNCE);
    } else {
      this._log.log('visibility', 'Tab visible - resuming');
      this._resume();
    }
  }

  _pause() {
    // Wake word detection can fire during the debounce window and take over
    // the resume (_onDetection clears _isPaused). Don't tear down the
    // session it just brought back.
    if (!this._isPaused) return;

    this._card.setState(State.PAUSED);

    // Fully release the mic, wake word and pipeline - same teardown the
    // mute switch does (_suspendForMute). Merely disabling the audio
    // tracks keeps the OS-level capture session open, which on Android
    // holds the device in communication audio mode: the hardware volume
    // keys adjust call volume instead of media volume for as long as the
    // tab sits in the background (#91). Releasing everything also drops
    // the OS mic indicator and stops inference battery drain while hidden.
    this._tornDown = true;
    const session = this._card;
    try { session.wakeWord?.release(); } catch (e) { this._log.log('visibility', `pause: wakeWord.release: ${e.message || e}`); }
    // Keep the stop() promise so _resume can await it - starting a new
    // subscription while the server is still cancelling the old pipeline
    // task makes async_accept_pipeline_from_satellite() silently fail.
    try { this._stopPromise = session.pipeline.stop().catch(() => {}); } catch (e) { this._log.log('visibility', `pause: pipeline.stop: ${e.message || e}`); }
    try { session.audio.stopMicrophone(); } catch (e) { this._log.log('visibility', `pause: stopMicrophone: ${e.message || e}`); }
  }

  async _resume() {
    if (!this._isPaused) return;

    // If wake word detection is already handling the resume (AudioContext +
    // pipeline start), bail out — _onDetection owns the full resume flow
    // and will clear _isPaused itself.
    if (this._wakeWordResuming) {
      this._log.log('visibility', 'Tab visible - wake word already resuming, skipping');
      this._wakeWordResuming = false;
      return;
    }

    const { pipeline, audio } = this._card;

    // Cancel any pending restart timeout BEFORE yielding to the event loop.
    // Browsers throttle setTimeout in background tabs (≥1s in Chrome).
    // When the tab becomes visible, the throttled timeout can fire during
    // our await below, starting a concurrent pipeline.start() that races
    // with our own restart(0) - two subscriptions clobber each other's
    // binaryHandlerId, sending audio to a dead handler.
    pipeline.resetForResume();

    if (this._tornDown) {
      // The debounced _pause released the mic, wake word and pipeline.
      // Bring the whole stack back through the same full-start path the
      // mute switch uses on unmute - startListening re-checks the wake
      // mode and mute switch, and its one-time setup steps are idempotent.
      // pipeline.start() re-acquires the mic on demand for any satellite
      // event (ask_question etc.) replayed alongside this resume.
      this._tornDown = false;
      if (this._stopPromise) {
        await this._stopPromise;
        this._stopPromise = null;
      }
      this._isPaused = false;
      refreshSatelliteSubscription();
      this._log.log('visibility', 'Resuming - restarting mic and wake word');
      this._card._starting = false;
      try {
        await startListening(this._card);
      } catch (e) {
        this._log.error('visibility', `Resume failed: ${e.message || e}`);
      }
      return;
    }

    // Tab was re-shown inside the debounce window - nothing was torn down.
    // Resume AudioContext - browser suspends it in background tabs,
    // and the worklet/processor can't produce audio until it's running.
    // Keep _isPaused = true during this await so stale pipeline events
    // from the still-active subscription are blocked by handlePipelineMessage.
    await this._card.audio.resume();

    // Now unpause and immediately enter restart - the synchronous path from
    // here to restart(0) / hasPendingSatelliteEvent has no awaits, so no
    // stale events can slip through the gap.
    this._isPaused = false;

    // If a satellite event (announcement/ask_question/start_conversation) was
    // queued while the tab was hidden, skip the wake-word pipeline restart.
    // The replayed event's flow will manage the pipeline (e.g. ask_question
    // calls restartContinue after playback).
    if (hasPendingSatelliteEvent()) {
      this._log.log('visibility', 'Resuming - satellite event pending, deferring pipeline restart');
      return;
    }

    // Re-establish satellite subscription - the WebSocket may have silently
    // reconnected while the tab was hidden, invalidating the old subscription.
    refreshSatelliteSubscription();

    this._log.log('visibility', 'Resuming - restarting pipeline');
    pipeline.restart(0);
  }
}
