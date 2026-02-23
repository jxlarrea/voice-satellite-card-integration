/**
 * Voice Satellite Card — VisibilityManager
 *
 * Handles tab visibility changes: pauses mic and blocks events on hide,
 * resumes and restarts pipeline on show.
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';
import { hasPendingSatelliteEvent } from '../shared/satellite-notification.js';
import { refreshSatelliteSubscription } from '../shared/satellite-subscription.js';

export class VisibilityManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._isPaused = false;
    this._debounceTimer = null;
    this._handler = null;
  }

  get isPaused() {
    return this._isPaused;
  }

  setup() {
    if (this._handler) return; // already registered
    this._handler = () => this._handleChange();
    document.addEventListener('visibilitychange', this._handler);
  }

  // --- Private ---

  _handleChange() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    // Only the singleton owner should manage visibility — non-owner instances
    // have no mic or pipeline and must not interfere with the active owner.
    if (!this._card.isOwner) return;

    if (document.hidden) {
      this._isPaused = true;

      // Cancel any in-progress ask_question flow — its cleanup timer
      // would otherwise fire after resume and double-restart the pipeline.
      this._card.askQuestion.cancel();

      if (INTERACTING_STATES.includes(this._card.currentState)) {
        this._log.log('visibility', 'Tab hidden during interaction — cleaning up UI');
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
        this._card.pipeline.clearContinueState();
        if (this._card.tts.isPlaying) {
          this._card.tts.stop();
        }
      }

      this._debounceTimer = setTimeout(() => {
        this._log.log('visibility', 'Tab hidden — pausing mic');
        this._pause();
      }, Timing.VISIBILITY_DEBOUNCE);
    } else {
      this._log.log('visibility', 'Tab visible — resuming');
      this._resume();
    }
  }

  _pause() {
    this._isPaused = true;
    this._card.setState(State.PAUSED);
    this._card.audio.pause();
    // Do NOT call pipeline.stop() here — the unawaited stop() creates a
    // race where the server is still cancelling the old pipeline task when
    // _resume() → restart(0) → start() creates a new subscription, causing
    // async_accept_pipeline_from_satellite() to silently fail.
    // restart(0) in _resume() handles the properly sequenced stop→start.
  }

  async _resume() {
    if (!this._isPaused) return;

    const { pipeline, audio } = this._card;

    // Cancel any pending restart timeout BEFORE yielding to the event loop.
    // Browsers throttle setTimeout in background tabs (≥1s in Chrome).
    // When the tab becomes visible, the throttled timeout can fire during
    // our await below, starting a concurrent pipeline.start() that races
    // with our own restart(0) — two subscriptions clobber each other's
    // binaryHandlerId, sending audio to a dead handler.
    pipeline.resetForResume();

    // Resume AudioContext — browser suspends it in background tabs,
    // and the worklet/processor can't produce audio until it's running.
    // Keep _isPaused = true during this await so stale pipeline events
    // from the still-active subscription are blocked by handlePipelineMessage.
    await this._card.audio.resume();

    // Now unpause and immediately enter restart — the synchronous path from
    // here to restart(0) / hasPendingSatelliteEvent has no awaits, so no
    // stale events can slip through the gap.
    this._isPaused = false;

    // If a satellite event (announcement/ask_question/start_conversation) was
    // queued while the tab was hidden, skip the wake-word pipeline restart.
    // The replayed event's flow will manage the pipeline (e.g. ask_question
    // calls restartContinue after playback).
    if (hasPendingSatelliteEvent()) {
      this._log.log('visibility', 'Resuming — satellite event pending, deferring pipeline restart');
      return;
    }

    // Re-establish satellite subscription — the WebSocket may have silently
    // reconnected while the tab was hidden, invalidating the old subscription.
    refreshSatelliteSubscription();

    this._log.log('visibility', 'Resuming — restarting pipeline');
    pipeline.restart(0);
  }
}
