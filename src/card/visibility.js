/**
 * Voice Satellite Card — VisibilityManager
 *
 * Handles tab visibility changes: pauses mic and blocks events on hide,
 * resumes and restarts pipeline on show.
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';

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
    this._handler = () => this._handleChange();
    document.addEventListener('visibilitychange', this._handler);
  }

  // --- Private ---

  _handleChange() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    if (document.hidden) {
      this._isPaused = true;

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
  }

  _resume() {
    if (!this._isPaused) return;
    this._isPaused = false;

    this._card.audio.resume();

    const { audio, pipeline } = this._card;

    if (!audio.isStreaming && pipeline.isStreaming) {
      audio.startSending(() => pipeline.binaryHandlerId);
    }

    pipeline.resetForResume();
    this._log.log('visibility', 'Resuming — restarting pipeline');
    pipeline.restart(0);
  }
}
