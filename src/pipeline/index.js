/**
 * Voice Satellite Card — PipelineManager
 *
 * Manages the HA Assist pipeline lifecycle via the integration's
 * voice_satellite/run_pipeline subscription.
 *
 * Handles starting, stopping, restarting, error recovery with
 * linear backoff, continue conversation, mute state polling,
 * and stale event filtering.
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';
import { getSwitchState } from '../shared/satellite-state.js';
import { subscribePipelineRun, setupReconnectListener } from './comms.js';
import {
  handleRunStart,
  handleWakeWordStart,
  handleWakeWordEnd,
  handleSttEnd,
  handleIntentProgress,
  handleIntentEnd,
  handleTtsEnd,
  handleRunEnd,
  handleError,
} from './events.js';

const MUTE_POLL_INTERVAL = 2000;

export class PipelineManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._unsubscribe = null;
    this._binaryHandlerId = null;
    this._retryCount = 0;
    this._serviceUnavailable = false;
    this._restartTimeout = null;
    this._isRestarting = false;
    this._pendingRunEnd = false;
    this._recoveryTimeout = null;
    this._suppressTTS = false;
    this._intentErrorBarTimeout = null;
    this._continueConversationId = null;
    this._shouldContinue = false;
    this._continueMode = false;
    this._isStreaming = false;
    this._askQuestionCallback = null;
    this._askQuestionHandled = false;
    this._reconnectRef = { listener: null };

    this._muteCheckId = null;
    this._runStartReceived = false;
    this._wakeWordPhase = false;
    this._errorReceived = false;
  }

  // --- Public accessors ---

  get card() { return this._card; }
  get log() { return this._log; }
  get binaryHandlerId() { return this._binaryHandlerId; }
  set binaryHandlerId(val) { this._binaryHandlerId = val; }
  get isRestarting() { return this._isRestarting; }
  get serviceUnavailable() { return this._serviceUnavailable; }
  set serviceUnavailable(val) { this._serviceUnavailable = val; }
  get shouldContinue() { return this._shouldContinue; }
  set shouldContinue(val) { this._shouldContinue = val; }
  get continueConversationId() { return this._continueConversationId; }
  set continueConversationId(val) { this._continueConversationId = val; }
  get continueMode() { return this._continueMode; }
  set continueMode(val) { this._continueMode = val; }
  get retryCount() { return this._retryCount; }
  set retryCount(val) { this._retryCount = val; }
  get pendingRunEnd() { return this._pendingRunEnd; }
  set pendingRunEnd(val) { this._pendingRunEnd = val; }
  get suppressTTS() { return this._suppressTTS; }
  set suppressTTS(val) { this._suppressTTS = val; }
  get recoveryTimeout() { return this._recoveryTimeout; }
  set recoveryTimeout(val) { this._recoveryTimeout = val; }
  get intentErrorBarTimeout() { return this._intentErrorBarTimeout; }
  set intentErrorBarTimeout(val) { this._intentErrorBarTimeout = val; }
  get askQuestionCallback() { return this._askQuestionCallback; }
  set askQuestionCallback(val) { this._askQuestionCallback = val; }
  get askQuestionHandled() { return this._askQuestionHandled; }
  set askQuestionHandled(val) { this._askQuestionHandled = val; }

  // --- Start / Stop / Restart ---

  async start(options) {
    const opts = options || {};
    const { connection, config } = this._card;

    if (!connection) {
      throw new Error('No Home Assistant connection available');
    }
    if (!config.satellite_entity) {
      throw new Error('No satellite_entity configured');
    }

    // Clear any pending mute poll
    if (this._muteCheckId) {
      clearTimeout(this._muteCheckId);
      this._muteCheckId = null;
    }

    // Check mute state — if muted, show visual and poll for unmute
    if (getSwitchState(this._card.hass, config.satellite_entity, 'mute') === true) {
      this._log.log('pipeline', 'Satellite muted — pipeline blocked');
      this._card.ui.showErrorBar();
      this._muteCheckId = setTimeout(() => {
        this._muteCheckId = null;
        this.start(opts).catch(() => {});
      }, MUTE_POLL_INTERVAL);
      return;
    }

    // Clear error bar in case we were previously muted
    this._card.ui.clearErrorBar();

    // Defensive cleanup — stop any previous subscription before starting
    if (this._unsubscribe) {
      this._log.log('pipeline', 'Cleaning up previous subscription');
      try { await this._unsubscribe(); } catch (_) { /* cleanup */ }
      this._unsubscribe = null;
    }
    this._binaryHandlerId = null;

    setupReconnectListener(this._card, this, connection, this._reconnectRef);

    const runConfig = {
      start_stage: opts.start_stage || 'wake_word',
      end_stage: opts.end_stage || 'tts',
      sample_rate: 16000,
    };

    if (opts.conversation_id) {
      runConfig.conversation_id = opts.conversation_id;
    }

    if (opts.extra_system_prompt) {
      runConfig.extra_system_prompt = opts.extra_system_prompt;
    }

    // Reset run-start tracking — used to detect stale run-end events
    this._runStartReceived = false;

    this._log.log('pipeline', `Starting pipeline: ${JSON.stringify(runConfig)}`);

    // Wait for the init event (which carries the binary handler ID) before
    // starting audio.  subscribeMessage resolves on the WS "result" message,
    // but the init event arrives as a separate WS frame afterwards.
    let resolveInit;
    const initPromise = new Promise((resolve) => { resolveInit = resolve; });

    this._unsubscribe = await subscribePipelineRun(
      connection,
      config.satellite_entity,
      runConfig,
      (message) => {
        // Synthetic init event carries the WS binary handler ID
        if (message.type === 'init') {
          this._binaryHandlerId = message.handler_id;
          this._log.log('pipeline', `Init — handler ID: ${message.handler_id}`);
          resolveInit();
          return;
        }

        this._card.onPipelineMessage(message);
      },
    );

    this._log.log('pipeline', 'Pipeline subscribed, waiting for init event...');

    // Block until the init event arrives with the binary handler ID
    await initPromise;

    this._log.log('pipeline', `Handler ID confirmed: ${this._binaryHandlerId} — starting audio`);

    // Start sending audio now that handler ID is guaranteed to be set
    const { audio } = this._card;
    audio.startSending(() => this._binaryHandlerId);

    this._isStreaming = true;
    // No idle timeout — the server manages pipeline lifecycle and sends
    // run-end/error events when the run completes.
    // The reconnect handler covers WebSocket drops.
  }

  async stop() {
    this._card.audio.stopSending();
    this._binaryHandlerId = null;
    this._isStreaming = false;

    if (this._muteCheckId) {
      clearTimeout(this._muteCheckId);
      this._muteCheckId = null;
    }

    if (this._unsubscribe) {
      try { await this._unsubscribe(); } catch (_) { /* cleanup */ }
      this._unsubscribe = null;
    }
  }

  restart(delay) {
    if (this._isRestarting) {
      this._log.log('pipeline', 'Restart already in progress — skipping');
      return;
    }
    this._isRestarting = true;

    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }

    this.stop().then(() => {
      this._restartTimeout = setTimeout(() => {
        this._restartTimeout = null;
        this._isRestarting = false;
        this.start().catch((e) => {
          const msg = e?.message || JSON.stringify(e);
          this._log.error('pipeline', `Restart failed: ${msg}`);
          if (!this._serviceUnavailable) {
            this._card.ui.showErrorBar();
            this._serviceUnavailable = true;
          }
          this.restart(this.calculateRetryDelay());
        });
      }, delay || 0);
    });
  }

  restartContinue(conversationId, opts = {}) {
    if (this._isRestarting) {
      this._log.log('pipeline', 'Restart already in progress — skipping continue');
      return;
    }
    this._isRestarting = true;

    // Store ask_question callback if provided
    this._askQuestionCallback = opts.onSttEnd || null;

    this.stop().then(() => {
      this._isRestarting = false;
      this._continueMode = true;
      const startOpts = {
        start_stage: 'stt',
        end_stage: opts.end_stage || 'tts',
        conversation_id: conversationId,
      };
      if (opts.extra_system_prompt) {
        startOpts.extra_system_prompt = opts.extra_system_prompt;
      }
      this.start(startOpts).catch((e) => {
        this._log.error('pipeline', `Continue conversation failed: ${e?.message || JSON.stringify(e)}`);
        this._askQuestionCallback = null;
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
        this.restart(0);
      });
    });
  }

  // --- Event Handlers (with stale event filtering) ---

  handleRunStart(data) {
    this._runStartReceived = true;
    this._wakeWordPhase = false;
    this._errorReceived = false;
    handleRunStart(this, data);
  }

  handleWakeWordStart() {
    this._wakeWordPhase = true;
    handleWakeWordStart(this);
  }

  handleWakeWordEnd(data) {
    if (!this._runStartReceived) {
      this._log.log('pipeline', 'Ignoring stale wake_word-end (no run-start received for this subscription)');
      return;
    }
    // Empty wake_word_output means the pipeline's audio stream was stopped
    // (restart/stop signal). This is expected on every pipeline restart —
    // not a real error. Suppress it to avoid entering a retry loop.
    const output = data?.wake_word_output;
    if (!output || !output.wake_word_id) {
      this._log.log('pipeline', 'Ignoring empty wake_word-end (pipeline stopped during restart)');
      return;
    }
    this._wakeWordPhase = false;
    handleWakeWordEnd(this, data);
  }

  handleSttEnd(data) { handleSttEnd(this, data); }
  handleIntentProgress(data) { handleIntentProgress(this, data); }
  handleIntentEnd(data) { handleIntentEnd(this, data); }
  handleTtsEnd(data) { handleTtsEnd(this, data); }

  handleRunEnd() {
    if (!this._runStartReceived) {
      this._log.log('pipeline', 'Ignoring stale run-end (no run-start received for this subscription)');
      return;
    }
    // A run-end during wake_word phase (before valid wake_word-end) without
    // a preceding error is always from a stale/killed pipeline — suppress it
    // to prevent finishRunEnd → restart(0) from killing the active pipeline.
    if (this._wakeWordPhase && !this._errorReceived) {
      this._log.log('pipeline', 'Ignoring stale run-end (still in wake_word phase, no error)');
      return;
    }
    handleRunEnd(this);
  }

  handleError(data) {
    if (!this._runStartReceived) {
      this._log.log('pipeline', 'Ignoring stale error (no run-start received for this subscription)');
      return;
    }
    this._errorReceived = true;
    handleError(this, data);
  }

  // --- Public Helpers ---

  clearContinueState() {
    this._shouldContinue = false;
    this._continueConversationId = null;
  }

  resetForResume() {
    this._isRestarting = false;
    this._continueMode = false;
    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }
  }

  /**
   * Reset all retry/reconnect state. Called on successful reconnection.
   */
  resetRetryState() {
    this._retryCount = 0;
    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }
    if (this._isRestarting) {
      this._isRestarting = false;
    }
    this._serviceUnavailable = false;
  }

  // --- Private ---

  finishRunEnd() {
    this._pendingRunEnd = false;
    this._card.chat.clear();
    this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
    this._card.setState(State.IDLE);

    if (this._serviceUnavailable) {
      this._log.log('ui', 'Retry already scheduled — skipping restart');
      return;
    }
    this.restart(0);
  }

  calculateRetryDelay() {
    this._retryCount++;
    const delay = Math.min(Timing.RETRY_BASE_DELAY * this._retryCount, Timing.MAX_RETRY_DELAY);
    this._log.log('pipeline', `Retry in ${delay}ms (attempt #${this._retryCount})`);
    return delay;
  }
}
