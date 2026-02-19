/**
 * Voice Satellite Card — PipelineManager
 *
 * Manages the HA Assist pipeline lifecycle: starting, stopping, restarting,
 * idle timeouts, error recovery with linear backoff, and continue conversation.
 */

import { State, INTERACTING_STATES, BlurReason, Timing } from '../constants.js';
import { resolveDeviceId, listPipelines, subscribePipelineRun, setupReconnectListener } from './comms.js';
import {
  handleRunStart, handleWakeWordStart, handleWakeWordEnd,
  handleSttEnd, handleIntentProgress, handleIntentEnd,
  handleTtsEnd, handleRunEnd, handleError,
} from './events.js';

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
    this._idleTimeoutId = null;
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
  get isStreaming() { return this._isStreaming; }
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
    const { connection } = this._card;

    if (!connection) {
      throw new Error('No Home Assistant connection available');
    }

    setupReconnectListener(this._card, this, connection, this._reconnectRef);

    const pipelines = await listPipelines(connection);

    this._log.log('pipeline', 'Available: ' + pipelines.pipelines.map((p) =>
      `${p.name} (${p.id})${p.preferred ? ' [preferred]' : ''}`
    ).join(', '));

    const { config } = this._card;
    let pipelineId = config.pipeline_id;
    if (!pipelineId) {
      const preferred = pipelines.pipelines.find((p) => p.preferred);
      pipelineId = preferred ? preferred.id : pipelines.pipelines[0].id;
    }

    this._log.log('pipeline', `Starting pipeline: ${pipelineId}`);

    const startStage = opts.start_stage || 'wake_word';
    const endStage = opts.end_stage || 'tts';
    const runConfig = {
      type: 'assist_pipeline/run',
      start_stage: startStage,
      end_stage: endStage,
      input: {
        sample_rate: 16000,
        timeout: startStage === 'wake_word' ? 0 : undefined,
      },
      pipeline: pipelineId,
      timeout: config.pipeline_timeout,
    };

    if (opts.conversation_id) {
      runConfig.conversation_id = opts.conversation_id;
    }

    // Resolve device_id from satellite entity for timer support
    this._log.log('pipeline', 'Resolving device_id...');
    const deviceId = await resolveDeviceId(this._card);
    if (deviceId) {
      runConfig.device_id = deviceId;
    } else {
      this._log.log('pipeline', 'No device_id resolved (satellite_entity not configured or lookup failed)');
    }

    if (runConfig.input.timeout === undefined) {
      delete runConfig.input.timeout;
    }

    this._log.log('pipeline', `Run config: ${JSON.stringify(runConfig)}`);
    this._log.log('pipeline', 'Subscribing to pipeline...');

    this._unsubscribe = await subscribePipelineRun(
      connection,
      runConfig,
      (message) => this._card.onPipelineMessage(message),
    );

    this._log.log('pipeline', 'Subscribed, waiting for run-start...');

    // Start sending audio
    const { audio } = this._card;
    audio.startSending(() => this._binaryHandlerId);

    this._isStreaming = true;
    this.startIdleTimeout();
  }

  async stop() {
    this._card.audio.stopSending();
    this._binaryHandlerId = null;
    this._isStreaming = false;

    if (this._unsubscribe) {
      try { await this._unsubscribe(); } catch (_) { /* cleanup */ }
      this._unsubscribe = null;
    }

    this.clearIdleTimeout();
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

    this.clearIdleTimeout();

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
    this.clearIdleTimeout();

    // Store ask_question callback if provided
    this._askQuestionCallback = opts.onSttEnd || null;

    this.stop().then(() => {
      this._isRestarting = false;
      this._continueMode = true;
      this.start({
        start_stage: 'stt',
        end_stage: opts.end_stage || 'tts',
        conversation_id: conversationId,
      }).catch((e) => {
        this._log.error('pipeline', `Continue conversation failed: ${e?.message || JSON.stringify(e)}`);
        this._askQuestionCallback = null;
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
        this.restart(0);
      });
    });
  }

  // --- Event Handlers (delegated to events.js) ---

  handleRunStart(data) { handleRunStart(this, data); }
  handleWakeWordStart() { handleWakeWordStart(this); }
  handleWakeWordEnd(data) { handleWakeWordEnd(this, data); }
  handleSttEnd(data) { handleSttEnd(this, data); }
  handleIntentProgress(data) { handleIntentProgress(this, data); }
  handleIntentEnd(data) { handleIntentEnd(this, data); }
  handleTtsEnd(data) { handleTtsEnd(this, data); }
  handleRunEnd() { handleRunEnd(this); }
  handleError(data) { handleError(this, data); }

  // --- Public Helpers ---

  finishPendingRunEnd() {
    if (this._pendingRunEnd) this.finishRunEnd();
  }

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

  startIdleTimeout() {
    this.clearIdleTimeout();
    if (this._card.config.pipeline_idle_timeout <= 0) return;

    this._idleTimeoutId = setTimeout(() => {
      if (INTERACTING_STATES.includes(this._card.currentState)) {
        this._log.log('pipeline', 'Idle timeout fired but interaction in progress — deferring');
        this.resetIdleTimeout();
        return;
      }
      if (this._card.tts.isPlaying) {
        this._log.log('pipeline', 'Idle timeout fired but TTS playing — deferring');
        this.resetIdleTimeout();
        return;
      }
      this._log.log('pipeline', 'Idle timeout — restarting');
      this.restart(0);
    }, this._card.config.pipeline_idle_timeout * 1000);
  }

  clearIdleTimeout() {
    if (this._idleTimeoutId) {
      clearTimeout(this._idleTimeoutId);
      this._idleTimeoutId = null;
    }
  }

  resetIdleTimeout() {
    this.startIdleTimeout();
  }
}
