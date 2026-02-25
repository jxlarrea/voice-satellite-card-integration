/**
 * Voice Satellite Card — Pipeline Events
 *
 * Handlers for all pipeline event types (run-start through error).
 */

import { State, INTERACTING_STATES, EXPECTED_ERRORS, BlurReason, Timing } from '../constants.js';
import { getSwitchState } from '../shared/satellite-state.js';
import { CHIME_WAKE } from '../audio/chime.js';
import { onTTSComplete } from '../card/events.js';

/**
 * Run-start: binaryHandlerId is already set from the init event.
 * Server-side run-start doesn't include runner_data — only pipeline,
 * language, conversation_id, satellite_id, and tts_output.
 * @param {import('./index.js').PipelineManager} mgr
 */
export function handleRunStart(mgr, eventData) {
  // Store streaming TTS URL (tts_output is at the top level)
  mgr.card.tts.storeStreamingUrl(eventData);

  if (mgr.continueMode) {
    mgr.continueMode = false;
    mgr.card.setState(State.STT);
    mgr.log.log('pipeline', `Running (continue conversation) — binary handler ID: ${mgr.binaryHandlerId}`);
    mgr.log.log('pipeline', 'Listening for speech...');
    return;
  }

  mgr.card.setState(State.LISTENING);
  mgr.log.log('pipeline', `Running — binary handler ID: ${mgr.binaryHandlerId}`);
  mgr.log.log('pipeline', 'Listening for wake word...');
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
        mgr.card.ui.clearErrorBar();
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
    mgr.card.ui.showErrorBar();
    mgr.serviceUnavailable = true;
    mgr.restart(mgr.calculateRetryDelay());
    return;
  }

  // Valid wake word — service healthy
  if (mgr.recoveryTimeout) {
    clearTimeout(mgr.recoveryTimeout);
    mgr.recoveryTimeout = null;
  }
  mgr.serviceUnavailable = false;
  mgr.retryCount = 0;
  mgr.card.ui.clearErrorBar();

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
    // Stop sending audio during the chime — echo cancellation isn't
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
    mgr.log.log('tts', 'Streaming TTS started — playing early');
    mgr.card.setState(State.TTS);
    tts.play(tts.streamingUrl);
    tts.streamingUrl = null;
  }

  if (!eventData.chat_log_delta) return;

  // Handle tool results (e.g., image search, video search, weather, financial)
  if (eventData.chat_log_delta.role === 'tool_result') {
    const toolResult = eventData.chat_log_delta.tool_result;
    const toolName = eventData.chat_log_delta.tool_name
      || eventData.chat_log_delta.tool_call?.tool_name;

    // Weather forecast — show weather card in media panel
    // Tool name is prefixed by HA integration: voice-satellite-card-weather-forecast__get_weather_forecast
    if (toolName?.endsWith('get_weather_forecast') && toolResult?.forecast && !toolResult.error) {
      mgr.card.chat.addWeather(toolResult);
      return;
    }

    // Financial data — show stock/crypto/currency card in media panel
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
    // Featured image from web search / Wikipedia — narrower panel
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
  let responseType = null;
  try {
    responseType = eventData.intent_output.response.response_type;
  } catch (_) { /* ignore */ }

  if (responseType === 'error') {
    const errorText = extractResponseText(mgr, eventData) || 'An error occurred';
    mgr.log.error('error', `Intent error: ${errorText}`);

    mgr.card.ui.showErrorBar();
    if (getSwitchState(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false) {
      mgr.card.tts.playChime('error');
    }

    mgr.suppressTTS = true;

    if (mgr.intentErrorBarTimeout) clearTimeout(mgr.intentErrorBarTimeout);
    mgr.intentErrorBarTimeout = setTimeout(() => {
      mgr.intentErrorBarTimeout = null;
      mgr.card.ui.clearErrorBar();
      mgr.card.ui.hideBar();
    }, Timing.INTENT_ERROR_DISPLAY);

    mgr.card.chat.streamedResponse = '';
    return;
  }

  const responseText = extractResponseText(mgr, eventData);
  if (responseText) {
    mgr.card.chat.showResponse(responseText);
  }

  mgr.shouldContinue = false;
  mgr.continueConversationId = null;
  try {
    if (eventData.intent_output.continue_conversation === true) {
      mgr.shouldContinue = true;
      mgr.continueConversationId = eventData.intent_output.conversation_id || null;
      mgr.log.log('pipeline', `Continue conversation requested — id: ${mgr.continueConversationId}`);
    }
  } catch (_) { /* ignore */ }

  mgr.card.chat.streamedResponse = '';
  mgr.card.chat.streamEl = null;
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
  if (tts.isPlaying) {
    // Store tts-end URL as retry fallback for the in-progress streaming playback
    const endUrl = eventData.tts_output?.url || eventData.tts_output?.url_path || null;
    if (endUrl) tts.storeTtsEndUrl(endUrl);
    mgr.log.log('tts', 'Streaming TTS already playing — skipping duplicate playback');
    mgr.restart(0);
    return;
  }

  const url = eventData.tts_output?.url || eventData.tts_output?.url_path || null;
  if (url) {
    tts.storeTtsEndUrl(url);
    if (!mgr.card._videoPlaying) {
      tts.play(url);
    } else {
      // Video is playing — skip TTS but still run cleanup so UI doesn't get stuck
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
    mgr.log.log('pipeline', 'Restart already in progress — skipping run-end restart');
    return;
  }

  // If ask_question just completed, the announcement manager handles cleanup
  if (mgr.askQuestionHandled) {
    mgr.log.log('pipeline', 'Ask question handled — announcement manager owns cleanup');
    mgr.askQuestionHandled = false;
    return;
  }

  if (mgr.serviceUnavailable) {
    mgr.log.log('ui', 'Error recovery handling restart');
    mgr.card.ui.hideBlurOverlay(BlurReason.PIPELINE);
    return;
  }

  if (mgr.card.tts.isPlaying) {
    mgr.log.log('ui', 'TTS playing — deferring cleanup');
    mgr.pendingRunEnd = true;
    return;
  }

  mgr.finishRunEnd();
}

/** @param {import('./index.js').PipelineManager} mgr */
export function handleError(mgr, errorData) {
  const errorCode = errorData.code || '';
  const errorMessage = errorData.message || '';

  mgr.log.log('error', `${errorCode} — ${errorMessage}`);

  // If an ask_question callback is pending, invoke it with empty string on error
  if (mgr.askQuestionCallback) {
    const cb = mgr.askQuestionCallback;
    mgr.askQuestionCallback = null;
    mgr.log.log('pipeline', `Ask question error (${errorCode}) — sending empty answer`);
    cb('');
    return;
  }

  if (EXPECTED_ERRORS.includes(errorCode)) {
    mgr.log.log('pipeline', `Expected error: ${errorCode} — restarting`);

    if (INTERACTING_STATES.includes(mgr.card.currentState)) {
      mgr.log.log('ui', 'Cleaning up interaction UI after expected error');
      mgr.card.setState(State.IDLE);
      mgr.card.chat.clear();
      mgr.card.ui.hideBlurOverlay(BlurReason.PIPELINE);
      mgr.shouldContinue = false;
      mgr.continueConversationId = null;
      const isRemote = !!mgr.card.ttsTarget;
      if (getSwitchState(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
        mgr.card.tts.playChime('done');
      }
    }

    mgr.restart(0);
    return;
  }

  mgr.log.error('error', `Unexpected: ${errorCode} — ${errorMessage}`);

  const wasInteracting = INTERACTING_STATES.includes(mgr.card.currentState);
  mgr.binaryHandlerId = null;

  if (wasInteracting && getSwitchState(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false) {
    mgr.card.tts.playChime('error');
  }
  mgr.card.ui.showErrorBar();
  mgr.serviceUnavailable = true;
  mgr.card.chat.clear();
  mgr.card.ui.hideBlurOverlay(BlurReason.PIPELINE);

  mgr.restart(mgr.calculateRetryDelay());
}

/**
 * Extract response text from intent_output, trying multiple HA response formats.
 * @param {import('./index.js').PipelineManager} mgr
 * @param {object} eventData
 * @returns {string|null}
 */
function extractResponseText(mgr, eventData) {
  try {
    const text = eventData.intent_output.response.speech.plain.speech;
    if (text) return text;
  } catch (_) { /* ignore */ }

  try { if (eventData.intent_output.response.speech.speech) return eventData.intent_output.response.speech.speech; } catch (_) { /* ignore */ }
  try { if (eventData.intent_output.response.plain) return eventData.intent_output.response.plain; } catch (_) { /* ignore */ }
  try { if (typeof eventData.intent_output.response === 'string') return eventData.intent_output.response; } catch (_) { /* ignore */ }

  mgr.log.log('error', 'Could not extract response text');
  return null;
}
