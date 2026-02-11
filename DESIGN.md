# Voice Satellite Card — Design Document

## 1. Overview

Voice Satellite Card is a single-file custom Home Assistant Lovelace card (~2150 lines of ES5 JavaScript, no build step) that turns any browser into a voice-activated satellite. It captures microphone audio, sends it to Home Assistant's Assist pipeline over WebSocket, and plays back TTS responses — all without leaving the HA dashboard.

The card is invisible (returns `getCardSize() = 0`). All visual feedback is rendered via a global overlay appended to `document.body`, outside HA's Shadow DOM, so it persists across dashboard view changes.

---

## 2. High-Level Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser   │────▶│  Home Assistant  │────▶│  Assist Pipeline │
│ Microphone  │     │   WebSocket API  │     │  (Wake/STT/TTS)  │
└─────────────┘     └──────────────────┘     └─────────────────┘
      │                      │                        │
      ▼                      ▼                        ▼
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Audio     │     │   Pipeline       │     │   TTS Audio     │
│  Processing │     │   Events         │     │   Playback      │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

1. The card acquires the browser microphone via `getUserMedia`.
2. Audio is captured via AudioWorklet (or ScriptProcessor fallback), resampled to 16 kHz mono PCM, and sent as binary WebSocket frames every 100 ms.
3. Home Assistant's `assist_pipeline/run` subscription routes the audio through wake word detection → speech-to-text → intent processing → text-to-speech.
4. The card receives pipeline events, updates visual feedback (gradient bar, transcription/response bubbles), and plays the TTS audio via an `<audio>` element.
5. When TTS begins playing, the pipeline is immediately restarted so it listens for the next wake word while audio plays (barge-in support). If the conversation agent signals `continue_conversation`, the card skips the wake word stage and restarts in STT mode for multi-turn dialogues.
6. The cycle repeats indefinitely.

---

## 3. State Machine

```
IDLE → CONNECTING → LISTENING → WAKE_WORD_DETECTED → STT → INTENT → TTS → (restart → LISTENING)
                                                                                ↓
                                                                             ERROR → (backoff → restart)
                                                       ↑                        ↓
                                                       └──── STT ← (continue conversation, skip wake word)
```

| State | Description |
|-------|-------------|
| `IDLE` | Not connected, waiting to start |
| `CONNECTING` | Acquiring microphone, subscribing to pipeline |
| `LISTENING` | Pipeline active, listening for wake word. No visible bar. |
| `PAUSED` | Tab hidden, microphone tracks disabled, audio send stopped |
| `WAKE_WORD_DETECTED` | Wake word heard. Bar visible with "listening" animation. Blur overlay shown. |
| `STT` | Speech-to-text in progress. Bar continues "listening" animation. |
| `INTENT` | Processing user intent. Bar switches to "processing" (fast) animation. |
| `TTS` | TTS URL received, audio playing. Bar shows "speaking" animation. |
| `ERROR` | Unexpected error occurred. Red error bar visible. Retry with backoff. |

State transitions are driven exclusively by pipeline events from Home Assistant. The `_setState(newState)` method logs the transition and calls `_updateUI()` to update the gradient bar.

---

## 4. User Interface

### 4.1 Global UI Overlay

All UI elements are inside a single `<div id="voice-satellite-ui">` appended to `document.body`. This is required because Home Assistant destroys and recreates custom card elements when switching dashboard views, but the microphone, WebSocket, and visual feedback must persist.

```html
<div id="voice-satellite-ui">
  <div class="vs-blur-overlay"></div>
  <button class="vs-start-btn"><svg>...</svg></button>
  <div class="vs-chat-container"></div>
  <div class="vs-rainbow-bar"></div>
</div>
```

Only one instance of this overlay ever exists (singleton pattern). The active card instance is tracked via `window._voiceSatelliteInstance`.

### 4.2 Pointer Events — Critical

All overlay elements use `opacity: 0` when hidden but remain in the DOM as fixed-position elements with high `z-index`. Without `pointer-events: none`, these invisible elements block all mouse and touch events on the entire HA dashboard. Every hidden overlay element MUST have `pointer-events: none`, switching to `pointer-events: auto` only when the `.visible` class is added.

### 4.3 Blur Overlay

A full-screen semi-transparent backdrop with `backdrop-filter: blur()`. Shown when wake word is detected, hidden when TTS completes or an error occurs. Always has `pointer-events: none` so the user can still interact with the dashboard behind it.

### 4.4 Chat Container

All conversation messages (user transcriptions and assistant responses) are displayed in a unified chat container (`.vs-chat-container`). This replaces the previous separate transcription/response bubble system with a single code path that works for both single-turn and multi-turn conversations.

The container is a flex column positioned at the bottom of the screen above the gradient bar, centered horizontally. Messages are appended as child `<div class="vs-chat-msg">` elements with either a `.user` or `.assistant` class. Each message is styled according to the transcription or response bubble configuration (font, color, background, border, padding, rounding). Messages fade in with a CSS animation (`vs-chat-fade-in`).

**Key methods:**

- `_chatAddUser(text)` — appends a user message (styled with transcription config)
- `_chatAddAssistant(text)` — appends an assistant message (styled with response config), stores element as `_chatStreamEl`
- `_chatUpdateAssistant(text)` — updates the current `_chatStreamEl` text (used for streaming)
- `_chatClear()` — removes all messages, hides container, resets `_chatStreamEl`

**Legacy API wrappers** route old calls to the chat container so all existing callers work unchanged:

- `_showTranscription(text)` → `_chatAddUser(text)` (respects `show_transcription` config)
- `_showResponse(text)` → `_chatAddAssistant(text)` or `_chatUpdateAssistant(text)` if `_chatStreamEl` exists (respects `show_response` config)
- `_updateResponse(text)` → creates or updates assistant bubble via `_chatStreamEl`
- `_hideTranscription()` → no-op (messages persist until `_chatClear`)
- `_hideResponse()` → no-op (messages persist until `_chatClear`)

**Single-turn behavior:** One user message + one assistant message appear during the interaction, then `_chatClear()` removes everything when the conversation ends.

**Multi-turn behavior (continue conversation):** Messages accumulate in the container across turns, creating a chat-style thread. The container is only cleared when the conversation fully ends (done chime) or is interrupted (barge-in, tab switch, error).

The container has `overflow: visible` and no scrollbar — messages simply grow upward from the bottom. All messages are centered horizontally within the container.

### 4.5 Start Button

A floating circular microphone button (56×56px, bottom-right corner) with a pulsing animation. Shown when automatic microphone access fails (browser user gesture required, mic permission denied, no mic found). Hidden once the microphone starts successfully. The click handler is the critical user gesture entry point (see Section 10: Browser Microphone Restrictions).

---

## 5. Gradient Bar

An animated gradient bar fixed to the bottom (or top) of the screen. The bar's gradient colors, height, and position are all configurable.

### 5.1 Bar States

| State | Visible | Animation | Speed |
|-------|---------|-----------|-------|
| IDLE, CONNECTING, LISTENING, PAUSED | No | — | — |
| WAKE_WORD_DETECTED, STT | Yes | `vs-gradient-flow` | 3s (slow flow) |
| INTENT | Yes | `vs-gradient-flow` | 0.5s (fast flow) |
| TTS | Yes | `vs-gradient-flow` | 2s (medium flow) |
| ERROR | Yes | `vs-gradient-flow` | 2s, with red gradient |

### 5.2 Error Mode

When an unexpected error occurs, the bar switches to a red gradient (`#ff4444, #ff6666, #cc2222`) and stays visible via the `_serviceUnavailable` flag. The `_updateUI()` method checks this flag and refuses to hide the bar while it's set. The flag is cleared on successful pipeline recovery (`run-start` received, or wake word service recovers).

For intent-specific errors (LLM service down), a separate `_intentErrorBarTimeout` auto-hides the red bar after 3 seconds. This timeout is cancelled if a new wake word is detected.

### 5.3 TTS Bar Persistence

When TTS starts playing, the pipeline is immediately restarted for barge-in. This causes the state to transition to LISTENING, which normally hides the bar. The `_updateUI()` method has a special check: if `this._ttsPlaying` is true, the bar remains visible regardless of state. Once TTS finishes, `_onTTSComplete()` calls `_updateUI()` which then hides the bar normally.

### 5.4 CSS Animations

```css
@keyframes vs-gradient-flow {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}
```

The `background-size` is set to `200% 100%` so the gradient scrolls continuously. Different animation durations create the effect of faster/slower movement for different states.

A breathing animation (`vs-bar-breathe`) exists in the CSS for a potential CONNECTING state indicator but is currently unused because it looked bad alongside the start button.

---

## 6. Chimes

All chimes are generated programmatically using the Web Audio API oscillator. No audio files are used.

### 6.1 Chime Types

| Chime | Trigger | Waveform | Frequencies | Duration |
|-------|---------|----------|-------------|----------|
| Wake | `wake_word-end` (valid wake word) | Sine | C5→E5→G5 (523→659→784 Hz) at 0/80/160ms | 250ms |
| Done | TTS playback complete (not interrupted) | Sine | G5→E5 (784→659 Hz) at 0/80ms | 250ms |
| Error | Unexpected pipeline error or intent error | Square | 300→200 Hz at 0/80ms | 150ms |

### 6.2 Volume

Volume is scaled to a maximum of 0.5 to avoid clipping: `(config.chime_volume / 100) * 0.5`. The error chime is additionally reduced to 30% of that value for a subtler sound.

### 6.3 Timing

The wake chime plays immediately on `wake_word-end`. The done chime plays in `_onTTSComplete()` — NOT on `intent-end` — because playing it on `intent-end` would fire mid-interaction before TTS even starts. The done chime is also suppressed during barge-in (if the user said a new wake word while TTS was playing, the current state would be WAKE_WORD_DETECTED/STT/INTENT, not IDLE/LISTENING).

The error chime only plays if the user was actively interacting (state was WAKE_WORD_DETECTED, STT, INTENT, or TTS). Background pipeline errors during idle listening do not chime.

### 6.4 Configuration

`chime_on_wake_word: true` enables the wake chime. `chime_on_request_sent: true` enables the done chime. The error chime respects the `chime_on_wake_word` setting. Both can be independently disabled.

### 6.5 Implementation

Each chime creates a new `AudioContext`, plays the oscillator, then closes the context after 500ms via `setTimeout`. This avoids issues with suspended AudioContexts on mobile browsers.

---

## 7. Error Handling

### 7.1 Expected Errors

These are normal operational events. They trigger immediate pipeline restart with zero delay, no error chime, no red bar:

| Code | Meaning |
|------|---------|
| `timeout` | Pipeline-level idle timeout (from HA server) |
| `wake-word-timeout` | Wake word detection timed out |
| `stt-no-text-recognized` | User spoke but no text was recognized |
| `duplicate_wake_up_detected` | Wake word already being processed (note: underscores, not dashes — HA API inconsistency) |

**Interaction-aware cleanup:** Some expected errors (notably `stt-no-text-recognized`) occur after the wake word was detected, meaning the blur overlay and transcription bubble are still visible. Before restarting, the handler checks whether the current state is an active interaction state (WAKE_WORD_DETECTED, STT, INTENT, TTS). If so, it transitions to IDLE (via `_setState`, which also updates the gradient bar), hides the blur overlay, transcription, and response bubbles, and plays the done chime. For background expected errors like `timeout` or `wake-word-timeout`, the state is LISTENING so no cleanup runs.

### 7.2 Unexpected Errors

All other error codes (`stt-stream-failed`, `wake-stream-failed`, `intent-failed`, `tts-failed`, etc.) trigger full error handling:

1. Set `_serviceUnavailable = true` (keeps red bar visible)
2. Play error chime (if user was interacting)
3. Show red error bar
4. Hide blur overlay
5. Calculate retry delay and restart pipeline

### 7.3 Intent Errors

When the LLM service is down, `intent-end` still fires but with `response_type: "error"` inside `intent_output.response`. The card detects this, shows a red error bar (auto-hides after 3 seconds), plays the error chime, and sets `_suppressTTS = true` so the TTS of the error message ("Error talking to API") is skipped. The pipeline still restarts normally.

### 7.4 Wake Word Service Unavailable

When the wake word service itself is down, HA sends `wake_word-end` with an empty `wake_word_output` object (no `wake_word_id`). The card detects this via `Object.keys(wakeOutput).length === 0`, shows the error bar, and restarts with backoff.

Recovery detection uses a 2-second timer set on `wake_word-start`. If `wake_word-end` with empty output arrives within 2 seconds, the service is still down. If 2 seconds pass without the empty-output event, the service has recovered — `_serviceUnavailable` is cleared and `_retryCount` is reset.

---

## 8. Service Recovery & Retry Timeouts

### 8.1 Retry Backoff

Unexpected errors use linear backoff:

```javascript
delay = Math.min(5000 * retryCount, 30000);
// Attempt 1: 5s, Attempt 2: 10s, Attempt 3: 15s, ... Attempt 6+: 30s (cap)
```

The `_retryCount` is incremented on each retry and reset to 0 on successful recovery (when `run-start` event is received or a valid wake word fires).

### 8.2 Pipeline Idle Timeout (TTS Token Refresh)

TTS tokens expire after some time. The `pipeline_idle_timeout` (default 300 seconds) is a client-side timer that restarts the pipeline while it's sitting in LISTENING state to obtain fresh tokens. This is invisible to the user — no UI change, no chime.

The timeout resets on any pipeline activity (`run-start`, `wake_word-end`).

**Interaction guard:** When the idle timeout fires, it checks whether the user is mid-interaction (state is WAKE_WORD_DETECTED, STT, INTENT, or TTS) or TTS audio is still playing. If so, it defers by resetting itself rather than killing the active interaction. This prevents the timeout from interrupting a conversation if someone sets a short `pipeline_idle_timeout` combined with a slow LLM response.

### 8.3 Pipeline Response Timeout (Server-Side)

The `pipeline_timeout` value (default 60 seconds) is sent to Home Assistant in the `timeout` field of the pipeline run config. This is a per-run timeout — if a single pipeline run (wake word through TTS) exceeds this duration, HA sends an error event. In continue conversation mode, each turn is a separate pipeline run with its own timeout. Note: this is distinct from `pipeline_idle_timeout` which is a client-side timer (see §8.2).

### 8.4 Tab Visibility & Pause/Resume

When the tab is hidden, `_isPaused` is set **immediately** (before the debounce) to block all incoming pipeline events in `_handlePipelineMessage`. If the user is mid-interaction (WAKE_WORD_DETECTED, STT, INTENT, TTS), all UI is cleaned up immediately: chat container cleared, blur overlay hidden, TTS stopped, continue conversation state reset. After a 500ms debounce, `_pauseMicrophone` disables audio tracks and sets state to PAUSED.

When the tab becomes visible again, `_resumeMicrophone` resets all in-flight state (`_isRestarting`, `_continueMode`, pending `_restartTimeout`) and always calls `_restartPipeline(0)` to start fresh in wake word mode. This is necessary because while paused, the server-side pipeline likely completed or errored — the `run-end` event was dropped by the `_isPaused` guard — so the old subscription is stale.

### 8.5 Intent Error Bar Timeout

Intent errors show a red bar that auto-hides after 3 seconds via `_intentErrorBarTimeout`. This timeout is cancelled if a new wake word is detected (so the bar doesn't suddenly disappear mid-interaction).

### 8.6 Concurrent Restart Prevention — Critical

When the pipeline idle timeout fires, HA responds with both a `run-end` event and an `error` event (code `timeout`) in rapid succession. Without protection, three separate calls to `_restartPipeline` occur simultaneously within the same event loop tick:

1. The idle timeout callback fires → `_restartPipeline(0)`
2. The `run-end` event arrives → `_handleRunEnd` → `_finishRunEnd` → `_restartPipeline(0)`
3. The `error` event arrives → `_handlePipelineError` → `_restartPipeline(0)`

Since `_stopPipeline` is async (it awaits `_unsubscribe()`), the second and third calls see `_unsubscribe` as already null, resolve instantly, and each schedule their own `_startPipeline()`. This results in 3 parallel pipeline subscriptions with different `stt_binary_handler_id` values, all consuming server resources and causing unpredictable behavior.

The fix uses an `_isRestarting` flag:

```javascript
_restartPipeline(delay) {
  if (this._isRestarting) {
    this._log('pipeline', 'Restart already in progress — skipping');
    return;
  }
  this._isRestarting = true;
  this._clearIdleTimeout();  // Prevent idle timeout from firing during restart

  this._stopPipeline().then(function() {
    self._restartTimeout = setTimeout(function() {
      self._isRestarting = false;  // Clear flag right before starting new pipeline
      self._startPipeline().catch(...);
    }, delay || 0);
  });
}
```

The flag is set at entry, cleared just before `_startPipeline` executes. Additionally, `_handleRunEnd` checks `_isRestarting` early and skips entirely if a restart is already in flight.

---

## 9. WebSocket Communication

### 9.1 Connection

The card uses Home Assistant's existing WebSocket connection, available via `hass.connection`. It does not create its own WebSocket. The raw socket for binary audio is at `hass.connection.socket`.

### 9.2 Pipeline Subscription

```javascript
this._unsubscribe = await this._connection.subscribeMessage(
  function(message) { self._handlePipelineMessage(message); },
  {
    type: 'assist_pipeline/run',
    start_stage: 'wake_word',  // or 'stt' for continue conversation
    end_stage: 'tts',
    input: { sample_rate: 16000, timeout: 0 },
    pipeline: pipelineId,
    timeout: this._config.pipeline_idle_timeout,
    // conversation_id: '...'  // included for continue conversation
  }
);
```

**`input.timeout: 0` is critical.** If omitted, HA defaults to 3 seconds, causing `wake-word-timeout` errors every 3 seconds. Setting it to 0 means "listen indefinitely for the wake word." The `timeout` field is omitted when `start_stage` is `'stt'` (continue conversation) so the server VAD handles silence detection.

`_startPipeline` accepts an optional `options` parameter with `start_stage` and `conversation_id` for continue conversation mode. When not provided, defaults to `start_stage: 'wake_word'`.

The `timeout` at the top level is the overall pipeline response timeout sent to HA.

### 9.3 Pipeline Event Format

**HA's `subscribeMessage` for `assist_pipeline/run` delivers events DIRECTLY — NOT wrapped in `{ type: "event", event: {...} }`.**

```javascript
// What HA actually delivers to the callback:
{ type: "run-start", data: { runner_data: { stt_binary_handler_id: 1 } }, timestamp: "..." }
{ type: "wake_word-end", data: { wake_word_output: { wake_word_id: "ok_nabu" } }, timestamp: "..." }
{ type: "stt-end", data: { stt_output: { text: "turn on the lights" } }, timestamp: "..." }
```

The handler reads `message.type` and `message.data` directly. Do NOT check `message.type === 'event'` or access `message.event` — this will cause all events to be silently dropped.

### 9.4 Pipeline Events Reference

| Event | Description | Key Data Fields |
|-------|-------------|-----------------|
| `run-start` | Pipeline initialized, ready for audio | `data.runner_data.stt_binary_handler_id` — required for binary audio framing |
| `wake_word-start` | Listening for wake word | Used for recovery detection timing |
| `wake_word-end` | Wake word detected (or service unavailable if output empty) | `data.wake_word_output.wake_word_id` |
| `stt-start` | Speech-to-text engine started | State → STT |
| `stt-vad-start` | Voice activity detected (user speaking) | Logged, not acted upon |
| `stt-vad-end` | Voice activity ended (user stopped) | Logged, not acted upon |
| `stt-end` | Transcription complete | `data.stt_output.text` |
| `intent-start` | Intent processing started | State → INTENT |
| `intent-progress` | Streaming response token (when `streaming_response: true`) | `data.chat_log_delta.content` (string, append to accumulator). First chunk may be `{ role: "assistant" }` with no content — skip it. |
| `intent-end` | Intent processing complete | `data.intent_output.response.speech.plain.speech` — the response text. Also check `data.intent_output.response.response_type` — if `"error"`, the LLM service is down. `data.intent_output.continue_conversation` (boolean) — if `true`, the agent expects a follow-up. `data.intent_output.conversation_id` (string) — pass to next pipeline run for conversation context. |
| `tts-start` | TTS generation started | State → TTS |
| `tts-end` | TTS audio URL ready | `data.tts_output.url` or `data.tts_output.url_path` — relative path, must be prefixed with `window.location.origin` |
| `run-end` | Pipeline run complete | Cleanup and restart |
| `error` | Error occurred | `data.code` (string), `data.message` (string) |

### 9.5 Binary Audio Transmission

Audio is sent as raw binary WebSocket frames. The first byte is the `stt_binary_handler_id` from `run-start`, followed by the 16-bit PCM audio data:

```javascript
var message = new Uint8Array(1 + pcmData.byteLength);
message[0] = this._binaryHandlerId;
message.set(new Uint8Array(pcmData.buffer), 1);
this._connection.socket.send(message.buffer);
```

Before sending, the code checks `socket.readyState === WebSocket.OPEN` to avoid errors during connection teardown.

### 9.6 Unsubscription & Restart Serialization

When the pipeline restarts, `_restartPipeline` awaits `_stopPipeline()` which properly `await`s the unsubscribe function before the new subscription is created. This prevents stale subscriptions from piling up. All restart paths go through `_restartPipeline` — no manual fire-and-forget unsubscribe calls.

An `_isRestarting` flag serializes concurrent restart attempts. This is critical because the pipeline idle timeout, `run-end`, and `error` events can all fire within the same event loop tick, each trying to restart the pipeline. Without the flag, multiple parallel subscriptions are created (see Section 8.6).

---

## 10. Microphone

### 10.1 Audio Capture Chain

```
getUserMedia → MediaStreamSource → AudioWorklet (or ScriptProcessor) → Float32 buffer → resample → Int16 PCM → binary WebSocket
```

### 10.2 Audio Format

| Parameter | Value |
|-----------|-------|
| Sample Rate | 16,000 Hz (resampled if browser provides different rate) |
| Channels | 1 (mono) |
| Bit Depth | 16-bit signed PCM |
| Chunk Size | 2048 samples per ScriptProcessor callback, 128 per AudioWorklet frame |
| Send Interval | 100ms (collects all buffered chunks, combines, resamples, converts, sends) |

### 10.3 Audio Constraints

```javascript
var audioConstraints = {
  sampleRate: 16000,
  channelCount: 1,
  echoCancellation: config.echo_cancellation,    // default: true
  noiseSuppression: config.noise_suppression,     // default: true
  autoGainControl: config.auto_gain_control       // default: true
};

// Voice isolation is Chrome-only; applied via "advanced" array
// so browsers that don't support it silently ignore it
if (config.voice_isolation) {
  audioConstraints.advanced = [{ voiceIsolation: true }];
}
```

### 10.4 AudioWorklet

The preferred capture method. An inline processor is created as a Blob URL:

```javascript
class VoiceSatelliteProcessor extends AudioWorkletProcessor {
  process(inputs) {
    if (inputs[0] && inputs[0][0]) {
      this.port.postMessage(new Float32Array(inputs[0][0]));
    }
    return true;
  }
}
registerProcessor('voice-satellite-processor', VoiceSatelliteProcessor);
```

The Blob URL is revoked after `addModule()` completes. If AudioWorklet fails (older browsers), it falls back to ScriptProcessor.

### 10.5 Resampling

If the browser's actual sample rate differs from 16 kHz (common: 44.1 kHz, 48 kHz), linear interpolation resampling is applied:

```javascript
var ratio = fromSampleRate / toSampleRate;  // e.g. 48000/16000 = 3
for (var i = 0; i < outputLength; i++) {
  var srcIndex = i * ratio;
  var low = Math.floor(srcIndex);
  var high = Math.min(low + 1, inputSamples.length - 1);
  var frac = srcIndex - low;
  output[i] = inputSamples[low] * (1 - frac) + inputSamples[high] * frac;
}
```

### 10.6 PCM Conversion

Float32 samples (-1.0 to +1.0) are converted to Int16 with asymmetric mapping to match the Int16 range (-32768 to +32767):

```javascript
pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
```

### 10.7 Tab Visibility

When the tab is hidden, `_isPaused` is set immediately to block pipeline events, interaction UI is cleaned up (chat, blur, TTS, continue state), and after 500ms debounce audio tracks are disabled and the send interval cleared. When the tab becomes visible, tracks are re-enabled, the send interval restarts, in-flight restart guards are reset (`_isRestarting`, `_continueMode`, `_restartTimeout`), and a full pipeline restart is always triggered to start fresh in wake word mode.

---

## 11. Browser Microphone Restrictions

### 11.1 The Problem

Modern browsers enforce two security restrictions on microphone access:

1. **HTTPS Required:** `getUserMedia` only works in secure contexts (HTTPS or localhost).
2. **User Gesture Required:** The first call to `getUserMedia` must occur within a user-initiated event (click, tap, keypress). Without this, the browser either silently blocks the request or throws a `NotAllowedError`.

This means `start_listening_on_load: true` will fail on the first visit to the dashboard because there's no user gesture when the page loads.

### 11.2 The Solution

When `_startListening()` fails:

1. A floating microphone button appears in the bottom-right corner with a pulsing animation.
2. The tooltip indicates the failure reason ("Tap to enable microphone", "No microphone found", etc.).
3. When the user taps the button, the click handler (`_handleStartClick`) provides the required user gesture.
4. Inside the click handler, `AudioContext` creation and `getUserMedia` are initiated synchronously within the gesture context. Browsers track "user activation" state and it can expire if deferred.
5. Once the microphone starts, the button is hidden.

### 11.3 AudioContext Suspension

Mobile browsers (especially iOS Safari) create `AudioContext` in a `suspended` state and require a user gesture to resume. The card calls `audioContext.resume()` inside `_ensureAudioContextRunning()` before requesting the microphone. If the context can't be resumed, the start button is shown.

iOS Safari may also re-suspend the AudioContext when the tab is backgrounded. On tab visibility change, the card may need the user to tap the button again.

### 11.4 Fully Kiosk Browser Exception

Fully Kiosk Browser on Android does NOT have the user gesture restriction when properly configured (Microphone Access = Enabled, Autoplay Videos = Enabled, JavaScript Interface = Enabled). The card can auto-start without any interaction — ideal for wall-mounted tablets and kiosks.

---

## 12. Singleton Instance Coordination

Home Assistant may create multiple card instances (different views, YAML + UI configs, browser navigation). Without coordination, each would try to access the microphone and create subscriptions.

Three global flags prevent this:

| Flag | Purpose |
|------|---------|
| `window._voiceSatelliteActive` | Set when any instance is running |
| `window._voiceSatelliteStarting` | Set during startup to prevent races |
| `window._voiceSatelliteInstance` | Reference to the active instance |

`disconnectedCallback` uses a 100ms delay before cleanup to distinguish view switches (card destroyed and re-created within milliseconds) from real disconnects.

---

## 13. Configuration Reference

### Behavior

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `start_listening_on_load` | boolean | `true` | Auto-start on page load |
| `pipeline_id` | string | `''` | Pipeline ID (empty = preferred/first) |
| `wake_word_switch` | string | `''` | Entity to turn OFF on wake word (e.g. screensaver) |
| `pipeline_timeout` | number | `60` | Server-side: max seconds HA allows for a single pipeline run (sent to HA as `timeout`) |
| `pipeline_idle_timeout` | number | `300` | Client-side: seconds of inactivity before silent pipeline restart to refresh TTS tokens |
| `continue_conversation` | boolean | `true` | Continue listening after assistant asks a follow-up question (multi-turn) |
| `double_tap_cancel` | boolean | `true` | Double-tap screen to cancel active interaction and stop TTS |
| `chime_on_wake_word` | boolean | `true` | Play wake chime |
| `chime_on_request_sent` | boolean | `true` | Play done chime after TTS |
| `chime_volume` | number | `100` | Chime volume 0-100 |
| `tts_volume` | number | `100` | TTS playback volume 0-100 (browser only) |
| `tts_target` | string | `''` | TTS output device: empty = browser, or `media_player.*` entity ID |
| `debug` | boolean | `false` | Structured console logging |

### Microphone

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `noise_suppression` | boolean | `true` | Browser noise suppression |
| `echo_cancellation` | boolean | `true` | Browser echo cancellation |
| `auto_gain_control` | boolean | `true` | Browser automatic gain control |
| `voice_isolation` | boolean | `false` | AI voice isolation (Chrome only) |

### Rainbow Bar

| Key | Type | Default |
|-----|------|---------|
| `bar_position` | `'bottom'` \| `'top'` | `'bottom'` |
| `bar_height` | number (2-40) | `16` |
| `bar_gradient` | string | `'#FF7777, #FF9977, ..., #FF77CC'` |
| `background_blur` | boolean | `true` |
| `background_blur_intensity` | number (0-20) | `5` |

### Transcription Bubble

`show_transcription`, `transcription_font_size` (20), `transcription_font_family` ('inherit'), `transcription_font_color` ('#444444'), `transcription_font_bold` (true), `transcription_font_italic` (false), `transcription_background` ('#ffffff'), `transcription_border_color` ('rgba(0, 180, 255, 0.5)'), `transcription_padding` (16), `transcription_rounded` (true).

### Response Bubble

`show_response`, `streaming_response` (false), `response_font_size` (20), `response_font_family` ('inherit'), `response_font_color` ('#444444'), `response_font_bold` (true), `response_font_italic` (false), `response_background` ('#ffffff'), `response_border_color` ('rgba(100, 200, 150, 0.5)'), `response_padding` (16), `response_rounded` (true).

---

## 14. TTS Playback

### 14.1 URL Construction

TTS URLs from HA are relative paths (e.g. `/api/tts_proxy/abc123.mp3`). The card prefixes them with `window.location.origin`. If the URL is already absolute (starts with `http`), it's used as-is.

### 14.2 Browser Playback (Default)

When `tts_target` is empty or `'browser'`, TTS plays via a browser `Audio` element:

```javascript
var audio = new Audio();
audio.volume = config.tts_volume / 100;
audio.onended = function() { self._onTTSComplete(); };
audio.onerror = function() { self._onTTSComplete(); };
audio.src = url;
audio.play();
this._currentAudio = audio;
```

After starting TTS, `_restartPipeline(0)` is called immediately. The new pipeline listens for a wake word while audio plays. If the user says the wake word, `_handleWakeWordEnd` calls `_stopTTS()` which nulls the `onended`/`onerror` handlers (preventing ghost callbacks), pauses, and clears the audio element.

### 14.3 Remote Playback (Experimental)

When `tts_target` is set to a `media_player.*` entity ID, TTS is routed to that device via a Home Assistant service call:

```javascript
this._hass.callService('media_player', 'play_media', {
  entity_id: config.tts_target,
  media_content_id: url,
  media_content_type: 'music'
});
```

**Differences from browser playback:**

- **No `onended` callback.** There is no reliable way to know when a remote media player finishes playing. The UI (bubbles, blur, bar) is hidden after a fixed 2-second delay via `_ttsEndTimer`.
- **Done chime is skipped.** Since TTS plays on a different device than the browser, playing a chime locally would be disorienting. The done chime only fires for browser playback.
- **`tts_volume` does not apply.** The browser volume slider only controls the local `Audio` element. Remote player volume is controlled via the media player's own volume settings.
- **Barge-in calls `media_player.media_stop`.** When the user says the wake word during remote TTS, `_stopTTS` sends a stop command to the media player and clears the UI timer.

### 14.4 The `_ttsPlaying` Flag

A boolean `_ttsPlaying` flag tracks whether TTS is active, regardless of playback target. It replaces direct `_currentAudio` checks for all state logic:

- `_updateUI` — keeps the gradient bar visible while TTS plays
- `_handleRunEnd` — defers UI cleanup if TTS is still active
- `_handleWakeWordEnd` — triggers barge-in (stop TTS) if flag is set
- Idle timeout — defers pipeline restart if TTS is playing

`_currentAudio` is only used internally for browser `Audio` element management. `_ttsEndTimer` is only used for remote playback's 2-second UI cleanup delay.

### 14.5 Cleanup

`_onTTSComplete` clears both `_currentAudio` and `_ttsPlaying`, cancels `_ttsEndTimer` if pending, then checks if a new interaction is already in progress (barge-in). If so, it does nothing — the UI belongs to the new interaction.

Next, it checks if continue conversation mode is active (`_shouldContinue` and `_continueConversationId` set by `_handleIntentEnd`). If so, it keeps the chat container and blur overlay visible, clears `_chatStreamEl` so the next turn creates a fresh assistant bubble, and calls `_restartPipelineContinue(conversationId)` to start a new pipeline with `start_stage: 'stt'` and the stored `conversation_id`.

Otherwise (normal completion), it plays the done chime (browser only), calls `_chatClear()` to remove all chat messages, hides the blur overlay, and calls `_updateUI()`.

### 14.6 Chimes Stay Local

Chimes (wake, done, error) always play on the browser via the Web Audio API oscillator, regardless of `tts_target`. They are not routed to remote media players.

---

## 15. Continue Conversation

### 15.1 Overview

Continue conversation mode enables multi-turn dialogues. When the conversation agent (e.g. an LLM) asks a follow-up question, the card automatically listens for the user's response without requiring the wake word again. The conversation history is displayed in a chat-style interface where messages stack up.

### 15.2 Protocol

The `intent-end` pipeline event contains `intent_output.continue_conversation` (boolean) and `intent_output.conversation_id` (string). When `continue_conversation` is `true` and the `continue_conversation` config option is enabled, the card stores these values as `_shouldContinue` and `_continueConversationId`.

### 15.3 Flow

1. **`_handleIntentEnd`** — stores `_shouldContinue = true` and `_continueConversationId` from `intent_output`
2. **`_onTTSComplete`** — checks `_shouldContinue`. If true:
   - Clears `_shouldContinue` and `_continueConversationId` (consumed)
   - Resets `_chatStreamEl` (so next turn creates a new assistant bubble)
   - Keeps blur overlay, gradient bar, and chat messages visible
   - Calls `_restartPipelineContinue(conversationId)`
3. **`_restartPipelineContinue`** — stops the current pipeline, sets `_continueMode = true`, calls `_startPipeline({ start_stage: 'stt', conversation_id: conversationId })`
4. **`_startPipeline`** — builds the pipeline config with `start_stage: 'stt'` and includes `conversation_id` in the run config. The `input.timeout` field is omitted for STT start stage so the server VAD handles silence detection.
5. **`_handleRunStart`** — checks `_continueMode`. If true, sets state to STT (instead of LISTENING) so the gradient bar stays visible. Clears the flag.
6. **User speaks** → `stt-end` → new user message appended to chat → `intent-end` → new assistant message appended → cycle repeats if `continue_conversation` is still true
7. When `continue_conversation` is `false` or absent → normal `_onTTSComplete` path → done chime, `_chatClear()`, blur hidden

### 15.4 State Flags

| Flag | Type | Purpose |
|------|------|---------|
| `_shouldContinue` | boolean | Set by `_handleIntentEnd`, consumed by `_onTTSComplete` |
| `_continueConversationId` | string | Conversation ID to pass to next pipeline run |
| `_continueMode` | boolean | Set by `_restartPipelineContinue`, consumed by `_handleRunStart` to set state to STT instead of LISTENING |

### 15.5 Cleanup

Continue conversation state is cleared in all cleanup paths:

- **Barge-in** (`_handleWakeWordEnd`) — new wake word starts a fresh conversation
- **Expected errors** (e.g. `stt-no-text-recognized` during continue) — falls back to wake word mode
- **Tab hidden** — immediate cleanup, `_resumeMicrophone` restarts pipeline fresh
- **`_restartPipelineContinue` failure** — falls back to normal wake word mode

### 15.6 Chat Container Integration

The chat container (Section 4.4) handles both single-turn and multi-turn conversations with one code path. In single-turn mode, one user + one assistant message appear, then `_chatClear()` removes them. In multi-turn mode, messages accumulate across turns. The done chime only plays when the conversation actually ends (not between turns).

---

## 16. Double-Tap to Cancel

### 16.1 Overview

When `double_tap_cancel` is enabled (default: `true`), double-tapping anywhere on the screen during an active interaction cancels it immediately. This allows users to interrupt long TTS responses or abort mid-conversation without waiting for the pipeline to finish.

### 16.2 Implementation

`_setupDoubleTapHandler` registers listeners on `document` for both `touchstart` (mobile) and `click` (desktop). The handler uses a timestamp comparison — two taps within 400ms counts as a double-tap. It only activates when:

- `double_tap_cancel` config is enabled
- The current state is an active interaction (WAKE_WORD_DETECTED, STT, INTENT, TTS) OR `_ttsPlaying` is true

Since the listener is on `document`, it catches taps on any element: the blur overlay, chat messages, gradient bar, or empty space. Chat messages have `pointer-events: auto` when the container is visible, so events bubble up normally.

### 16.3 Cancellation Actions

When a double-tap is detected:

1. `_stopTTS()` — stops browser audio or sends `media_player.media_stop` for remote playback
2. Clears `_shouldContinue` and `_continueConversationId` — ends any multi-turn conversation
3. `_chatClear()` — removes all chat messages
4. `_hideBlurOverlay()` — hides the backdrop
5. Plays the done chime (browser only) to acknowledge cancellation
6. `_restartPipeline(0)` — restarts fresh in wake word mode

---

## 17. Structured Logging

All console output uses `_log(category, msg)` and `_logError(category, msg)`:

```
[VS][state] LISTENING → WAKE_WORD_DETECTED
[VS][event] 07:05:13 wake_word-end {"wake_word_output":{"wake_word_id":"ok_nabu"}}
[VS][tts] Playback complete
```

`_log` checks `this._config.debug` internally. Callers should NOT wrap calls with `if (this._config.debug)`. `_logError` always logs regardless of debug setting.

Categories: `state`, `lifecycle`, `mic`, `pipeline`, `event`, `error`, `recovery`, `tts`, `ui`, `switch`, `visibility`, `editor`.

---

## 18. Visual Editor

The card provides a visual configuration editor (`VoiceSatelliteCardEditor`) with collapsible sections: Behavior (including continue conversation and double-tap cancel toggles), Microphone Processing (including voice isolation), Timeouts (with server-side/client-side labels), Volume & Chimes (including TTS output device dropdown), Rainbow Bar, Transcription Bubble, Response Bubble, Background. The editor fetches available pipelines from HA for the pipeline dropdown, lists `media_player.*` entities for the TTS output device dropdown, and lists switch entities for the wake word switch picker.

---

## 19. Implementation Checklist

When recreating or modifying this card, verify:

- [ ] Pipeline messages read `message.type` / `message.data` directly (NOT `message.event.type`)
- [ ] Pipeline `input` includes `timeout: 0` for indefinite wake word listening
- [ ] Streaming response reads `eventData.chat_log_delta.content` (NOT `partial_response`)
- [ ] First streaming chunk `{ chat_log_delta: { role: "assistant" } }` is skipped
- [ ] All hidden overlay elements have `pointer-events: none`
- [ ] TTS playback triggers immediate `_restartPipeline(0)` for barge-in
- [ ] `_updateUI` keeps bar visible while `_ttsPlaying` is true
- [ ] No auto-hide timers on chat messages
- [ ] Chat container positioned with CSS `bottom`, not `top`
- [ ] Done chime plays in `_onTTSComplete`, not `_handleIntentEnd`
- [ ] Done chime suppressed during barge-in (check state), continue conversation, and remote TTS
- [ ] Intent errors detected via `response_type === 'error'`; TTS suppressed
- [ ] Intent error bar timeout cancelled on new `wake_word-end`
- [ ] All callbacks use `var self = this` (ES5, no arrow functions)
- [ ] `_stopTTS` nulls `onended`/`onerror` before pausing (ghost prevention)
- [ ] `_resumeMicrophone` always restarts pipeline (not conditional on `_unsubscribe`)
- [ ] `_log()` checks debug internally — no redundant guards
- [ ] `voice_isolation` uses `advanced` constraint array (graceful fallback)
- [ ] `duplicate_wake_up_detected` uses underscores (HA API inconsistency)
- [ ] `_restartPipeline` uses `_isRestarting` flag to prevent concurrent restarts
- [ ] `_restartPipeline` clears idle timeout at entry to prevent re-triggering during restart
- [ ] Idle timeout callback checks for active interaction and defers if user is mid-conversation
- [ ] `_handleRunEnd` checks `_isRestarting` and skips if restart already in flight
- [ ] `_restartPipeline` awaits `_stopPipeline` before scheduling new subscription
- [ ] `_sendBinaryAudio` checks `socket.readyState === WebSocket.OPEN`
- [ ] Remote TTS uses `media_player.play_media` service call, not browser Audio
- [ ] Remote TTS barge-in calls `media_player.media_stop`
- [ ] `_ttsPlaying` flag used for all TTS state checks (not `_currentAudio`)
- [ ] `_ttsEndTimer` cleans up UI after 2s for remote playback
- [ ] `setConfig` propagates config to `window._voiceSatelliteInstance` for live updates
- [ ] Expected errors clean up UI (chat, blur) and play done chime if user was mid-interaction
- [ ] `_chatClear()` called in all cleanup paths (finish run end, errors, barge-in, tab hidden, TTS complete)
- [ ] `_chatStreamEl` cleared between turns so `_showResponse` doesn't update stale bubble
- [ ] Continue conversation stores `_shouldContinue` and `_continueConversationId` from `intent-end`
- [ ] `_restartPipelineContinue` uses `start_stage: 'stt'` with `conversation_id`
- [ ] `_handleRunStart` checks `_continueMode` to set state to STT instead of LISTENING
- [ ] Tab hidden sets `_isPaused` immediately (before debounce) to block pipeline events
- [ ] `_resumeMicrophone` resets `_isRestarting`, `_continueMode`, `_restartTimeout` before restart
- [ ] `_handlePipelineMessage` drops all events while `_isPaused` is true
- [ ] `pipeline_timeout` (not `pipeline_idle_timeout`) sent to HA as the run config `timeout`
- [ ] Double-tap handler checks `double_tap_cancel` config before acting
- [ ] Double-tap listener on `document` catches events from chat messages, blur overlay, and empty space
- [ ] Double-tap cancellation stops TTS, clears chat, hides blur, plays done chime, restarts pipeline
