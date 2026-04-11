/**
 * Pipeline Events
 *
 * Handlers for all pipeline event types (run-start through error).
 */

import { State, INTERACTING_STATES, EXPECTED_ERRORS, BlurReason, Timing } from '../constants.js';
import { getSwitchState } from '../shared/satellite-state.js';
import { CHIME_WAKE } from '../audio/chime.js';
import { onTTSComplete } from '../session/events.js';
import { humanizeToolName } from '../shared/tool-name.js';

/**
 * Run-start: binaryHandlerId is already set from the init event.
 * Server-side run-start doesn't include runner_data - only pipeline,
 * language, conversation_id, satellite_id, and tts_output.
 * @param {import('./index.js').PipelineManager} mgr
 */
export function handleRunStart(mgr, eventData) {
  // Store streaming TTS URL (tts_output is at the top level)
  mgr.card.tts.storeStreamingUrl(eventData);

  // Reset per-turn state for the chat event payload
  mgr.currentSttText = '';
  mgr.currentToolCalls.length = 0;
  mgr.wasContinuation = mgr.continueMode;
  mgr.currentLanguage = eventData?.language || null;

  if (mgr.continueMode) {
    mgr.continueMode = false;
    mgr.card.setState(State.STT);
    mgr.log.log('pipeline', `Running (continue conversation) - binary handler ID: ${mgr.binaryHandlerId}`);
    mgr.log.log('pipeline', 'Listening for speech...');
    return;
  }

  // When start_stage is 'stt' (on-device wake word), we're already in
  // WAKE_WORD_DETECTED — don't regress to LISTENING (which maps to idle
  // in HA and would cause automations to see a brief idle bounce).
  if (mgr._startStage !== 'stt') {
    mgr.card.setState(State.LISTENING);
  }
  mgr.log.log('pipeline', `Running - binary handler ID: ${mgr.binaryHandlerId}`);
  mgr.log.log('pipeline', mgr._startStage === 'stt' ? 'Listening for speech...' : 'Listening for wake word...');
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleWakeWordStart(mgr) {
  if (mgr.serviceUnavailable) {
    if (mgr.recoveryTimeout) clearTimeout(mgr.recoveryTimeout);
    mgr.recoveryTimeout = setTimeout(() => {
      if (mgr.serviceUnavailable) {
        mgr.log.log('recovery', 'Wake word service recovered');
        mgr.serviceUnavailable = false;
        mgr.retryCount = 0;
        mgr.card.ui.clearServiceError();
        mgr.card.ui.hideBar();
      }
    }, Timing.RECONNECT_DELAY);
  }
}

/**
 * Wake-word-end: respects the integration's wake_sound switch.
 * @param {import('./index.js').PipelineManager} mgr
 */
export function handleWakeWordEnd(mgr, eventData) {
  const wakeOutput = eventData.wake_word_output;
  if (!wakeOutput || Object.keys(wakeOutput).length === 0) {
    mgr.log.error('error', 'Wake word service unavailable (empty wake_word_output)');

    if (mgr.recoveryTimeout) {
      clearTimeout(mgr.recoveryTimeout);
      mgr.recoveryTimeout = null;
    }

    mgr.binaryHandlerId = null;
    mgr.card.ui.showServiceError();
    mgr.serviceUnavailable = true;
    mgr.restart(mgr.calculateRetryDelay());
    return;
  }

  // Valid wake word - service healthy
  if (mgr.recoveryTimeout) {
    clearTimeout(mgr.recoveryTimeout);
    mgr.recoveryTimeout = null;
  }
  mgr.serviceUnavailable = false;
  mgr.retryCount = 0;
  mgr.card.ui.clearServiceError();

  mgr.card.mediaPlayer.interrupt();

  const { tts } = mgr.card;
  if (tts.isPlaying) {
    tts.stop();
    mgr.pendingRunEnd = false;
  }
  if (mgr.intentErrorBarTimeout) {
    clearTimeout(mgr.intentErrorBarTimeout);
    mgr.intentErrorBarTimeout = null;
  }

  // Cancel any pending image linger timeout from previous interaction
  if (mgr.card._imageLingerTimeout) {
    clearTimeout(mgr.card._imageLingerTimeout);
    mgr.card._imageLingerTimeout = null;
  }

  mgr.card.chat.clear();
  mgr.shouldContinue = false;
  mgr.continueConversationId = null;

  mgr.card.setState(State.WAKE_WORD_DETECTED);

  // Check the integration's wake_sound switch (default: on)
  const wakeSound = getSwitchState(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false;
  if (wakeSound) {
    // Stop sending audio during the chime - echo cancellation isn't
    // perfect and the chime can leak into the mic, causing VAD to
    // interpret it as speech and close STT prematurely.
    const audio = mgr.card.audio;
    audio.stopSending();
    tts.playChime('wake');
    const resumeDelay = (CHIME_WAKE.duration * 1000) + 50;
    setTimeout(() => {
      // Discard audio captured during the chime, then resume sending.
      audio.audioBuffer = [];
      if (mgr.binaryHandlerId) {
        audio.startSending(() => mgr.binaryHandlerId);
      }
    }, resumeDelay);
  }
  mgr.card.ui.showBlurOverlay(BlurReason.PIPELINE);
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleSttEnd(mgr, eventData) {
  const text = eventData.stt_output?.text || '';
  if (text) {
    mgr.currentSttText = text;
    mgr.card.chat.showTranscription(text);
  }

  // If this is an ask_question STT-only pipeline, invoke the callback
  if (mgr.askQuestionCallback) {
    const cb = mgr.askQuestionCallback;
    mgr.askQuestionCallback = null;
    mgr.askQuestionHandled = true;
    mgr.log.log('pipeline', `Ask question STT complete: "${text}"`);
    cb(text);
  }
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleIntentProgress(mgr, eventData) {
  const { tts } = mgr.card;

  if (eventData.tts_start_streaming && tts.streamingUrl && !tts.isPlaying && !mgr.card._videoPlaying) {
    mgr.log.log('tts', 'Streaming TTS started - playing early');
    mgr.card.setState(State.TTS);
    tts.play(tts.streamingUrl);
    tts.streamingUrl = null;
  }

  if (!eventData.chat_log_delta) return;

  // Handle tool calls - show which tool the LLM is invoking and record for the chat event
  const toolCalls = eventData.chat_log_delta.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    for (const tool of toolCalls) {
      const rawName = tool.tool_name || tool.name || '';
      if (!rawName) continue;
      const displayName = humanizeToolName(rawName);
      mgr.log.log('pipeline', `Tool call: ${rawName}`);
      mgr.currentToolCalls.push({ name: rawName, display_name: displayName });
      mgr.card.chat.showToolCall(displayName);
    }
  }

  // Handle tool results (e.g., image search, video search, weather, financial)
  if (eventData.chat_log_delta.role === 'tool_result') {
    const toolResult = eventData.chat_log_delta.tool_result;
    const toolName = eventData.chat_log_delta.tool_name
      || eventData.chat_log_delta.tool_call?.tool_name;

    // Weather forecast - show weather card in media panel
    // Tool name is prefixed by HA integration: voice-satellite-card-weather-forecast__get_weather_forecast
    if (toolName?.endsWith('get_weather_forecast') && toolResult?.forecast && !toolResult.error) {
      mgr.card.chat.addWeather(toolResult);
      return;
    }

    // Financial data - show stock/crypto/currency card in media panel
    // Tool name: voice-satellite-card-financial-data__get_financial_data
    if (toolName?.includes('financial-data__get_financial_data') && toolResult?.query_type && !toolResult.error) {
      mgr.card.chat.addFinancial(toolResult);
      return;
    }

    const results = toolResult?.results;
    if (Array.isArray(results)) {
      const videos = results.filter(r => r.video_id);
      if (videos.length > 0) {
        mgr.card.chat.addVideos(videos, !!toolResult.auto_play);
      }
      const images = results.filter(r => r.image_url && !r.video_id);
      if (images.length > 0) {
        mgr.card.chat.addImages(images, !!toolResult.auto_display);
      }
    }
    // Featured image from web search / Wikipedia - narrower panel
    if (toolResult?.featured_image) {
      mgr.card.chat.addImages([{ image_url: toolResult.featured_image }], false, true);
    }
    return;
  }

  const chunk = eventData.chat_log_delta.content;
  if (typeof chunk !== 'string') return;

  const { chat } = mgr.card;
  chat.streamedResponse = (chat.streamedResponse || '') + chunk;
  chat.updateResponse(chat.streamedResponse);
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleIntentEnd(mgr, eventData) {
  const responseType = eventData?.intent_output?.response?.response_type;

  if (responseType === 'error') {
    const errorText = extractResponseText(eventData) || 'An error occurred';
    mgr.log.error('error', `Intent error: ${errorText}`);

    mgr.card.ui.showServiceError();
    if (getSwitchState(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false) {
      mgr.card.tts.playChime('error');
    }

    mgr.suppressTTS = true;

    if (mgr.intentErrorBarTimeout) clearTimeout(mgr.intentErrorBarTimeout);
    mgr.intentErrorBarTimeout = setTimeout(() => {
      mgr.intentErrorBarTimeout = null;
      mgr.card.ui.clearServiceError();
      mgr.card.ui.hideBar();
    }, Timing.INTENT_ERROR_DISPLAY);

    mgr.card.chat.removeThinking();
    mgr.card.chat.streamedResponse = '';
    return;
  }

  const responseText = extractResponseText(eventData);
  if (responseText) {
    mgr.card.chat.showResponse(responseText);
  } else if (mgr.card.chat.streamedResponse) {
    // Streaming text exists but intent_output had no extractable string.
    // Use the accumulated text so the UI finalises (fade spans → plain text,
    // compact marquee starts, etc.).
    mgr.card.chat.showResponse(mgr.card.chat.streamedResponse);
  }

  mgr.shouldContinue = false;
  mgr.continueConversationId = null;
  if (eventData?.intent_output?.continue_conversation === true) {
    mgr.shouldContinue = true;
    mgr.continueConversationId = eventData.intent_output.conversation_id || null;
    mgr.log.log('pipeline', `Continue conversation requested - id: ${mgr.continueConversationId}`);
  }

  // Fire chat event with the full turn payload, then clear per-turn state
  fireChatEvent(mgr, eventData, responseText);

  mgr.card.chat.streamedResponse = '';
  mgr.card.chat.streamEl = null;
}

/**
 * Send the voice_satellite/fire_chat_event WebSocket command to the integration,
 * which fires a `voice_satellite_chat` event on the HA bus. Fire-and-forget.
 * @param {import('./index.js').PipelineManager} mgr
 * @param {object} eventData - the intent-end event data
 * @param {string|null} responseText - extracted TTS response text
 */
function fireChatEvent(mgr, eventData, responseText) {
  const { hass, config } = mgr.card;
  if (!hass?.connection || !config?.satellite_entity) return;

  const payload = {
    type: 'voice_satellite/fire_chat_event',
    entity_id: config.satellite_entity,
    stt_text: mgr.currentSttText || '',
    tts_text: responseText || mgr.card.chat.streamedResponse || '',
    tool_calls: mgr.currentToolCalls.slice(),
    conversation_id: eventData?.intent_output?.conversation_id || null,
    is_continuation: !!mgr.wasContinuation,
    continue_conversation: eventData?.intent_output?.continue_conversation === true,
    language: mgr.currentLanguage || null,
  };

  hass.connection.sendMessagePromise(payload).catch((e) => {
    mgr.log.error('pipeline', `fire_chat_event failed: ${e?.message || e}`);
  });

  // Clear per-turn buffers now that the event has been dispatched
  mgr.currentSttText = '';
  mgr.currentToolCalls.length = 0;
  mgr.wasContinuation = false;
  mgr.currentLanguage = null;
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleTtsEnd(mgr, eventData) {
  if (mgr.suppressTTS) {
    mgr.suppressTTS = false;
    mgr.log.log('tts', 'TTS suppressed (intent error)');
    // Still run cleanup so blur/chat don't stay stuck on screen
    onTTSComplete(mgr.card, true);
    mgr.restart(0);
    return;
  }

  const { tts } = mgr.card;

  // Store canonical tts-end URL for duration event correlation
  const ttsUrl = eventData.tts_output?.url || eventData.tts_output?.url_path || null;
  if (ttsUrl) tts.ttsUrl = ttsUrl;

  if (tts.isPlaying) {
    // Store tts-end URL as retry fallback for the in-progress streaming playback
    const endUrl = eventData.tts_output?.url || eventData.tts_output?.url_path || null;
    if (endUrl) tts.storeTtsEndUrl(endUrl);
    mgr.log.log('tts', 'Streaming TTS already playing - skipping duplicate playback');
    mgr.restart(0);
    return;
  }

  const url = eventData.tts_output?.url || eventData.tts_output?.url_path || null;
  const mediaId = eventData.tts_output?.media_id || null;
  if (url) {
    tts.storeTtsEndUrl(url);
    if (!mgr.card._videoPlaying) {
      tts.play(url, false, mediaId);
    } else {
      // Video is playing - skip TTS but still run cleanup so UI doesn't get stuck
      onTTSComplete(mgr.card, false);
    }
  }

  mgr.restart(0);
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleRunEnd(mgr) {
  mgr.log.log('pipeline', 'Run ended');
  mgr.binaryHandlerId = null;

  if (mgr.isRestarting) {
    mgr.log.log('pipeline', 'Restart already in progress - skipping run-end restart');
    return;
  }

  // If ask_question just completed, the announcement manager handles cleanup
  if (mgr.askQuestionHandled) {
    mgr.log.log('pipeline', 'Ask question handled - announcement manager owns cleanup');
    mgr.askQuestionHandled = false;
    return;
  }

  if (mgr.serviceUnavailable) {
    mgr.log.log('ui', 'Error recovery handling restart');
    mgr.card.ui.hideBlurOverlay(BlurReason.PIPELINE);
    return;
  }

  if (mgr.card.tts.isPlaying) {
    mgr.log.log('ui', 'TTS playing - deferring cleanup');
    mgr.pendingRunEnd = true;
    return;
  }

  mgr.finishRunEnd();
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleError(mgr, errorData) {
  const errorCode = errorData.code || '';
  const errorMessage = errorData.message || '';

  mgr.log.log('error', `${errorCode} - ${errorMessage}`);

  // If an ask_question callback is pending, invoke it with empty string on error
  if (mgr.askQuestionCallback) {
    const cb = mgr.askQuestionCallback;
    mgr.askQuestionCallback = null;
    mgr.log.log('pipeline', `Ask question error (${errorCode}) - sending empty answer`);
    cb('');
    return;
  }

  if (EXPECTED_ERRORS.includes(errorCode)) {
    mgr.log.log('pipeline', `Expected error: ${errorCode} - restarting`);

    // Special case for cross-tablet wake word dedupe: if our wake chime
    // is still pending (we're inside the WAKE_DEDUPE_WINDOW_MS window
    // after a local detection), cancel it so the user doesn't hear
    // anything from this tablet at all. The other tablet — the one
    // that won the dedupe race — handles the user's actual interaction.
    if (errorCode === 'duplicate_wake_up_detected'
        && mgr.card.wakeWord?.cancelPendingChime?.()) {
      mgr.log.log('pipeline',
        'Duplicate wake-up — cancelled pending chime, silently aborting');
      mgr.card.ui.hideBlurOverlay(BlurReason.PIPELINE);
      if (INTERACTING_STATES.includes(mgr.card.currentState)) {
        mgr.card.setState(State.IDLE);
        mgr.card.chat.clear();
        mgr.shouldContinue = false;
        mgr.continueConversationId = null;
        // Skip the "done" chime — the whole point of this branch is
        // that the losing tablet should make zero sound.
      }
      mgr.restart(0);
      return;
    }

    // Always hide blur — duplicate_wake_up_detected arrives after run-start
    // has already moved state out of INTERACTING_STATES, but overlay is still up.
    mgr.card.ui.hideBlurOverlay(BlurReason.PIPELINE);

    if (INTERACTING_STATES.includes(mgr.card.currentState)) {
      mgr.log.log('ui', 'Cleaning up interaction UI after expected error');
      mgr.card.setState(State.IDLE);
      mgr.card.chat.clear();
      mgr.shouldContinue = false;
      mgr.continueConversationId = null;
      if (getSwitchState(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false) {
        mgr.card.tts.playChime('done');
      }
    }

    mgr.restart(0);
    return;
  }

  mgr.log.error('error', `Unexpected: ${errorCode} - ${errorMessage}`);

  const wasInteracting = INTERACTING_STATES.includes(mgr.card.currentState);
  mgr.binaryHandlerId = null;

  if (wasInteracting && getSwitchState(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false) {
    mgr.card.tts.playChime('error');
  }
  mgr.card.ui.showServiceError();
  mgr.serviceUnavailable = true;
  mgr.card.chat.clear();
  mgr.card.ui.hideBlurOverlay(BlurReason.PIPELINE);

  mgr.restart(mgr.calculateRetryDelay());
}

/**
 * Extract response text from intent_output, trying multiple HA response formats.
 * @param {object} eventData
 * @returns {string|null}
 */
function extractResponseText(eventData) {
  const response = eventData?.intent_output?.response;
  if (!response) return null;

  const result = response?.speech?.plain?.speech
    || response?.speech?.speech
    || (typeof response?.plain === 'string' ? response.plain : null)
    || (typeof response === 'string' ? response : null);
  return result;
}
