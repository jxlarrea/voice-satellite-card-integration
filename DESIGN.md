# Voice Satellite Card - Design Document

**Version:** 1.11.0  
**Last Updated:** February 2026

## Overview

Voice Satellite Card is a custom Home Assistant Lovelace card that transforms any browser into a voice-activated satellite for Home Assistant's Assist. It enables wake word detection, speech-to-text, intent processing, and text-to-speech playback directly in the browser.

## Architecture

### High-Level Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser   │────▶│  Home Assistant  │────▶│  Assist Pipeline │
│ Microphone  │     │   WebSocket API  │     │  (Wake/STT/TTS)  │
└─────────────┘     └──────────────────┘     └─────────────────┘
      │                      │                        │
      │                      │                        │
      ▼                      ▼                        ▼
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Audio     │     │   Pipeline       │     │   TTS Audio     │
│  Processing │     │   Events         │     │   Playback      │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

### Components

1. **VoiceSatelliteCard** - Main custom element extending HTMLElement
2. **VoiceSatelliteCardEditor** - Visual configuration editor
3. **AudioWorklet/ScriptProcessor** - Audio capture and processing
4. **Global UI Overlay** - Visual feedback (rainbow bar, transcription bubbles)

## State Machine

```
IDLE ──────────────▶ CONNECTING ──────────────▶ LISTENING
  ▲                                                  │
  │                                                  ▼
  │                                          WAKE_WORD_DETECTED
  │                                                  │
  │                                                  ▼
  │                                               STT
  │                                                  │
  │                                                  ▼
  │                                              INTENT
  │                                                  │
  │                                                  ▼
  │                                               TTS
  │                                                  │
  └──────────────────────────────────────────────────┘
                         │
                         ▼
                       ERROR
```

### States

| State | Description |
|-------|-------------|
| `IDLE` | Not connected, waiting to start |
| `CONNECTING` | Establishing WebSocket connection |
| `LISTENING` | Pipeline active, listening for wake word |
| `PAUSED` | Microphone paused (tab hidden) |
| `WAKE_WORD_DETECTED` | Wake word heard, transitioning to STT |
| `STT` | Speech-to-text in progress |
| `INTENT` | Processing user intent |
| `TTS` | Playing text-to-speech response |
| `ERROR` | Error state with recovery |

## Audio Pipeline

### Capture Chain

```
Microphone (getUserMedia)
    │
    ▼
MediaStreamSource
    │
    ▼
GainNode (mic_sensitivity: 0.1 - 3.0)
    │
    ▼
AudioWorklet (preferred) or ScriptProcessor (fallback)
    │
    ▼
PCM 16-bit @ 16kHz mono
    │
    ▼
WebSocket Binary Frames
```

### Audio Format

- **Sample Rate:** 16,000 Hz
- **Channels:** 1 (mono)
- **Bit Depth:** 16-bit signed PCM
- **Chunk Size:** 2048 samples (~128ms)
- **Send Interval:** 100ms

### Browser Audio Constraints

```javascript
{
  audio: {
    sampleRate: 16000,
    channelCount: 1,
    echoCancellation: config.echo_cancellation,
    noiseSuppression: config.noise_suppression,
    autoGainControl: false  // Disabled - manual gain via GainNode
  }
}
```

## Home Assistant WebSocket API

### Pipeline Initialization

```javascript
// List available pipelines
{ type: 'assist_pipeline/pipeline/list' }

// Run pipeline with audio
{
  type: 'assist_pipeline/run',
  start_stage: 'wake_word',
  end_stage: 'tts',
  input: { sample_rate: 16000 },
  pipeline: '<pipeline_id>',
  timeout: 300  // pipeline_idle_timeout
}
```

### Pipeline Events

| Event | Description | Data |
|-------|-------------|------|
| `run-start` | Pipeline initialized | `runner_data.stt_binary_handler_id`, `tts_output.url` |
| `wake_word-start` | Listening for wake word | `timeout` |
| `wake_word-end` | Wake word detected | `wake_word_id` |
| `stt-start` | Speech-to-text starting | - |
| `stt-vad-start` | Voice activity detected | - |
| `stt-vad-end` | Voice activity ended | - |
| `stt-end` | Transcription complete | `stt_output.text` |
| `intent-start` | Processing intent | - |
| `intent-end` | Intent processed | `intent_output.response.speech.plain.speech` |
| `tts-start` | TTS generation starting | - |
| `tts-end` | TTS ready | `tts_output.url`, `tts_output.url_path` |
| `run-end` | Pipeline complete | - |
| `error` | Error occurred | `code`, `message` |

### Binary Audio Transmission

```javascript
// Audio sent via WebSocket binary frames with handler_id prefix
const message = new Uint8Array(1 + audioData.length);
message[0] = binaryHandlerId;  // From run-start event
message.set(audioData, 1);
websocket.send(message.buffer);
```

## Configuration Schema

### Behavior Options

```yaml
start_listening_on_load: true      # Auto-start on page load
wake_word_switch: ''               # Entity to turn OFF on wake word (Fully Kiosk screensaver)
pipeline_timeout: 60               # Max seconds for pipeline response (0 = no timeout)
pipeline_idle_timeout: 300         # Seconds before pipeline restart for TTS refresh
chime_on_wake_word: true           # Play chime on wake word detection
chime_on_request_sent: true        # Play chime after request processed
chime_volume: 100                  # Chime volume (0-100)
tts_volume: 100                    # TTS playback volume (0-100)
debug: false                       # Console logging
```

### Microphone Processing

```yaml
noise_suppression: true            # Browser noise suppression
echo_cancellation: true            # Browser echo cancellation
mic_sensitivity: 1.0               # Gain multiplier (0.1-3.0)
```

### Appearance - Rainbow Bar

```yaml
bar_position: bottom               # 'bottom' or 'top'
bar_height: 16                     # Pixels (2-40)
bar_gradient: '#FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC'
background_blur: true              # Blur behind overlay
background_blur_intensity: 5       # Blur radius
```

### Appearance - Transcription Bubble

```yaml
show_transcription: true
transcription_font_size: 20
transcription_font_family: inherit
transcription_font_color: '#444444'
transcription_font_bold: true
transcription_font_italic: false
transcription_background: '#ffffff'
transcription_border_color: 'rgba(0, 180, 255, 0.5)'
transcription_padding: 16
transcription_rounded: true
```

### Appearance - Response Bubble

```yaml
show_response: true
streaming_response: false          # Real-time text streaming
response_font_size: 20
response_font_family: inherit
response_font_color: '#444444'
response_font_bold: true
response_font_italic: false
response_background: '#ffffff'
response_border_color: 'rgba(100, 200, 150, 0.5)'
response_padding: 16
response_rounded: true
```

## Global UI System

The card uses a **singleton global UI overlay** that persists across dashboard view changes. This is critical because:

1. Home Assistant destroys/recreates cards when switching views
2. The microphone and WebSocket connection must persist
3. Visual feedback must remain consistent

### Global UI Structure

```html
<div id="voice-satellite-ui">
  <div class="vs-blur-overlay"></div>
  <button class="vs-start-btn"><!-- Microphone icon --></button>
  <div class="vs-transcription"></div>
  <div class="vs-response"></div>
  <div class="vs-rainbow-bar"></div>
</div>
```

### Singleton Pattern

```javascript
// Global flags prevent duplicate initialization
window._voiceSatelliteActive = true;
window._voiceSatelliteStarting = true;
window._voiceSatelliteInstance = this;
```

## Error Handling & Recovery

### Server Error Events

The pipeline sends `error` events with a `code` field. We handle these categorically:

```javascript
// Error event structure
{
  type: 'event',
  event: {
    type: 'error',
    data: {
      code: 'error-code-here',
      message: 'Human readable message'
    }
  }
}
```

### Expected Errors (No Retry Delay)

These errors are normal operational events and trigger **immediate** pipeline restart (no delay, no error chime, no red bar):

| Code | Meaning |
|------|---------|
| `timeout` | Pipeline idle timeout (no wake word detected) |
| `stt-no-text-recognized` | User spoke but no text recognized |
| `duplicate-wake-word-id` | Wake word already being processed |

```javascript
var expectedErrors = ['timeout', 'stt-no-text-recognized', 'duplicate-wake-word-id'];
if (expectedErrors.indexOf(errorCode) !== -1) {
  // Restart immediately without error UI
  this._restartPipeline(0);
  return;
}
```

### Unexpected Errors (Full Error Handling)

All other errors trigger the full error sequence:

1. **Error Chime** - Plays error sound (if chimes enabled)
2. **Red Error Bar** - Rainbow bar turns solid red and stays visible
3. **Console Logging** - Error details logged with `[VoiceSatellite]` prefix
4. **Retry with Backoff** - Exponential delay before restart

```javascript
// Play error chime
this._playErrorChime();

// Show red error bar
this._showErrorBar();

// Set service unavailable flag (keeps red bar visible)
this._serviceUnavailable = true;

// Retry with exponential backoff
this._restartPipeline(retryDelay);
```

### Error Chime

A third embedded base64 WAV chime for errors:

```javascript
// Error chime - distinct sound indicating failure
this._errorChimeData = 'data:audio/wav;base64,...';

_playErrorChime() {
  if (!this._config.chime_on_wake_word) return;  // Respects chime setting
  var audio = new Audio(this._errorChimeData);
  audio.volume = this._config.chime_volume / 100;
  audio.play();
}
```

### Red Error Bar

When an unexpected error occurs, the rainbow bar:

1. Removes all animation classes
2. Adds `error-mode` class
3. Sets solid red background
4. Stays visible until recovery succeeds

```css
#voice-satellite-ui .vs-rainbow-bar.error-mode {
  background: #ff4444;
  opacity: 1;
}
```

The `_serviceUnavailable` flag prevents `_updateUI()` from hiding the bar during error state:

```javascript
_updateUI() {
  // If service is unavailable, keep error bar visible
  if (this._serviceUnavailable && !s.active) {
    return;
  }
  // ... normal UI updates
}
```

### Service Recovery

For connection failures or unexpected errors:

```javascript
// Exponential backoff: 3s, 6s, 12s, 24s, 30s (max)
retryDelay = Math.min(3000 * Math.pow(2, retryCount), 30000);
```

On successful recovery:
```javascript
this._serviceUnavailable = false;
this._retryCount = 0;
// Red bar automatically hides on next _updateUI() call
```

### WebSocket Error Handling

```javascript
// Connection errors
this._connection.socket.onerror = function(error) {
  console.error('[VoiceSatellite] WebSocket error:', error);
  self._handleConnectionError();
};

// Unexpected close
this._connection.socket.onclose = function(event) {
  if (!event.wasClean) {
    self._handleConnectionError();
  }
};
```

### Pipeline Message Error Handling

```javascript
// Subscribe to pipeline messages
this._connection.subscribeMessage(function(message) {
  if (message.type === 'event') {
    var event = message.event;
    if (event.type === 'error') {
      self._handlePipelineError(event.data);
    }
  }
}, { type: 'assist_pipeline/run', ... });
```

### Tab Visibility Handling

```javascript
// On tab hidden: pause microphone after 500ms debounce
// On tab visible: resume microphone
// Prevents rapid pause/resume on quick tab switches
```

## TTS Token Management

### Problem

Home Assistant TTS tokens expire. Long-idle pipelines may fail to play audio.

### Solution

The `pipeline_idle_timeout` (default 300 seconds) restarts the pipeline periodically to obtain fresh TTS tokens:

```javascript
// After pipeline starts, set idle timeout
this._idleTimeout = setTimeout(() => {
  this._restartPipeline();
}, this._config.pipeline_idle_timeout * 1000);

// Reset timeout on any pipeline activity
this._resetIdleTimeout();
```

## Chime System

### Built-in Chimes (Base64 WAV)

Three chimes are embedded as base64-encoded WAV files:

| Chime | Trigger | Purpose |
|-------|---------|---------|
| Wake Word Chime | `wake_word-end` event | Confirms wake word heard |
| Request Sent Chime | `intent-end` event | Confirms request processed |
| Error Chime | Unexpected error | Indicates failure |

### Volume Control

```javascript
// Applied to <audio> element
audioElement.volume = this._config.chime_volume / 100;
```

### Chime Configuration

```yaml
chime_on_wake_word: true    # Enables wake word chime
chime_on_request_sent: true # Enables request sent chime
chime_volume: 100           # Volume for all chimes (0-100)
```

Note: Error chime respects `chime_on_wake_word` setting - if chimes are disabled, error chime is also silent.

## Visual Editor

The card provides a full visual configuration editor with sections:

1. **Behavior** - Pipeline selection, auto-start, chimes
2. **Microphone Processing** - Noise suppression, echo cancellation, sensitivity
3. **Timeouts** - Pipeline timeout, idle timeout
4. **Volume** - Chime and TTS volume sliders
5. **Rainbow Bar** - Position, height, colors
6. **Transcription Bubble** - Font, colors, padding
7. **Response Bubble** - Font, colors, padding
8. **Background** - Blur settings

### Editor Registration

```javascript
static getConfigElement() {
  return document.createElement('voice-satellite-card-editor');
}

static getStubConfig() {
  return { start_listening_on_load: true };
}
```

## Browser Compatibility

### User Gesture Requirement

Modern browsers require a **user gesture** (click, tap, keypress) before allowing microphone access. This is a security feature to prevent websites from silently recording users.

**The Problem:**
- `start_listening_on_load: true` attempts to access the microphone on page load
- Without a prior user gesture, this fails silently or throws a permission error
- The card cannot automatically start listening on first visit

**The Solution:**
When microphone access fails on load, the card displays a floating **microphone button** in the bottom-right corner. The user taps this button once, which:
1. Provides the required user gesture
2. Triggers `getUserMedia()` successfully
3. Hides the button once microphone is active

```javascript
// On load, try to start automatically
if (this._config.start_listening_on_load) {
  try {
    await this._startMicrophone();
    // Success - hide button
  } catch (e) {
    // Failed - show mic button for manual start
    this._showStartButton();
  }
}
```

**Fully Kiosk Browser Exception:**
[Fully Kiosk Browser](https://www.fully-kiosk.com/) on Android does NOT have this restriction when properly configured. With microphone permissions granted in Fully Kiosk settings, the card can auto-start without any user interaction - ideal for wall-mounted tablets and kiosks.

Fully Kiosk settings required:
- Web Content Settings → Autoplay Videos → Enabled
- Web Content Settings → Microphone Access → Enabled
- Advanced Web Settings → Enable JavaScript Interface → Enabled

### Required APIs

- `navigator.mediaDevices.getUserMedia`
- `AudioContext` / `webkitAudioContext`
- `AudioWorklet` (preferred) or `ScriptProcessor` (fallback)
- `WebSocket`

### HTTPS Requirement

Microphone access requires secure context (HTTPS or localhost).

### Tested Browsers

- Chrome/Chromium (recommended)
- Firefox
- Safari (iOS/macOS)
- Fully Kiosk Browser (Android) - No user gesture required

## File Structure

```
voice-satellite-card/
├── voice-satellite-card.js    # Main card implementation
├── README.md                  # User documentation
└── DESIGN.md                  # This document
```

## Key Implementation Details

### Resampling

If browser doesn't support 16kHz natively, audio is resampled:

```javascript
// Linear interpolation resampling
var ratio = actualSampleRate / 16000;
for (var i = 0; i < outputLength; i++) {
  var srcIndex = i * ratio;
  var low = Math.floor(srcIndex);
  var high = Math.min(low + 1, input.length - 1);
  var frac = srcIndex - low;
  output[i] = input[low] * (1 - frac) + input[high] * frac;
}
```

### PCM Conversion

Float32 audio samples converted to Int16:

```javascript
for (var i = 0; i < samples.length; i++) {
  var s = Math.max(-1, Math.min(1, samples[i]));
  pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
}
```

### Connection Management

```javascript
// Use existing HA WebSocket when possible
if (this._hass && this._hass.connection) {
  this._connection = this._hass.connection;
}
```

## Version History

| Version | Changes |
|---------|---------|
| 1.0.0 | Initial release |
| 1.5.0 | Added transcription bubbles, visual editor |
| 1.8.0 | Tab switching stability, error recovery |
| 1.9.0 | TTS token refresh, expected error handling |
| 1.10.0 | Mic sensitivity control, removed auto_gain_control |
| 1.11.0 | Fixed live mic sensitivity updates, removed on-screen slider |

## Future Considerations

1. **On-device wake word detection** - Explored using microWakeWord/TFLite but abandoned due to complexity. Server-side detection via pipeline is simpler and more reliable.

2. **Multiple wake words** - Would require changes to HA Assist pipeline.

3. **Audio ducking** - Lower TTS volume when user starts speaking.

4. **Conversation history** - Display recent interactions.

## Troubleshooting Guide

### No microphone access
- Check HTTPS
- Check browser permissions
- Check device has microphone

### Wake word not detected
- Verify openWakeWord is running in HA
- Check pipeline configuration
- Enable debug mode

### TTS not playing
- Check TTS configured in pipeline
- Verify pipeline_idle_timeout is set
- Check browser audio permissions

### Card disappears on view change
- This is expected - UI persists via global overlay
- Card element is recreated but connection maintained

## Code Style Notes

- ES5 syntax for maximum browser compatibility
- No external dependencies (except HA APIs)
- Self-contained single file
- Inline CSS in JavaScript strings
- Console logging with `[VoiceSatellite]` prefix

---

## Appendix A: Complete CSS Styles

### Rainbow Bar

```css
#voice-satellite-ui .vs-rainbow-bar {
  position: fixed;
  left: 0;
  right: 0;
  height: 16px;  /* Configurable via bar_height */
  bottom: 0;     /* Or top: 0 if bar_position: top */
  background: linear-gradient(90deg, /* bar_gradient colors */);
  background-size: 200% 100%;
  opacity: 0;
  transition: opacity 0.3s ease;
  z-index: 10000;
}

#voice-satellite-ui .vs-rainbow-bar.visible {
  opacity: 1;
}

#voice-satellite-ui .vs-rainbow-bar.listening {
  animation: vs-gradient-flow 3s linear infinite;
}

#voice-satellite-ui .vs-rainbow-bar.processing {
  animation: vs-gradient-flow 0.5s linear infinite;
}

#voice-satellite-ui .vs-rainbow-bar.speaking {
  animation: vs-gradient-flow 2s linear infinite;
}

#voice-satellite-ui .vs-rainbow-bar.error-mode {
  background: #ff4444 !important;
  animation: none !important;
}

@keyframes vs-gradient-flow {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}
```

### Start Button

```css
#voice-satellite-ui .vs-start-btn {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--primary-color, #03a9f4);
  border: none;
  cursor: pointer;
  display: none;  /* Shown via .visible class */
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  z-index: 10001;
  transition: transform 0.2s, box-shadow 0.2s;
}

#voice-satellite-ui .vs-start-btn.visible {
  display: flex;
}

#voice-satellite-ui .vs-start-btn:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 16px rgba(0,0,0,0.4);
}

#voice-satellite-ui .vs-start-btn svg {
  width: 28px;
  height: 28px;
  fill: white;
}
```

### Transcription & Response Bubbles

```css
#voice-satellite-ui .vs-transcription,
#voice-satellite-ui .vs-response {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  padding: 16px;  /* Configurable */
  border-radius: 12px;  /* If rounded: true */
  opacity: 0;
  transition: opacity 0.3s ease;
  z-index: 10001;
  max-width: 80%;
  text-align: center;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  border: 3px solid /* border_color */;
}

#voice-satellite-ui .vs-transcription {
  top: 30%;
  background: #ffffff;  /* transcription_background */
  color: #444444;       /* transcription_font_color */
  font-size: 20px;      /* transcription_font_size */
}

#voice-satellite-ui .vs-response {
  top: 50%;
  background: #ffffff;  /* response_background */
  color: #444444;       /* response_font_color */
  font-size: 20px;      /* response_font_size */
}

#voice-satellite-ui .vs-transcription.visible,
#voice-satellite-ui .vs-response.visible {
  opacity: 1;
}
```

### Background Blur Overlay

```css
#voice-satellite-ui .vs-blur-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  backdrop-filter: blur(5px);  /* background_blur_intensity */
  -webkit-backdrop-filter: blur(5px);
  background: rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.3s ease;
  z-index: 9999;
  pointer-events: none;
}

#voice-satellite-ui .vs-blur-overlay.visible {
  opacity: 1;
}
```

---

## Appendix B: AudioWorklet Processor

The AudioWorklet processor is created as an inline Blob URL:

```javascript
var workletCode = `
  class VoiceSatelliteProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.buffer = [];
    }
    
    process(inputs, outputs, parameters) {
      var input = inputs[0];
      if (input && input[0]) {
        // Clone the Float32Array data
        var channelData = new Float32Array(input[0]);
        this.port.postMessage(channelData);
      }
      return true;  // Keep processor alive
    }
  }
  
  registerProcessor('voice-satellite-processor', VoiceSatelliteProcessor);
`;

var blob = new Blob([workletCode], { type: 'application/javascript' });
var workletUrl = URL.createObjectURL(blob);
await this._audioContext.audioWorklet.addModule(workletUrl);
```

### ScriptProcessor Fallback

For browsers without AudioWorklet support:

```javascript
this._scriptProcessor = this._audioContext.createScriptProcessor(2048, 1, 1);
this._scriptProcessor.onaudioprocess = function(e) {
  var inputData = e.inputBuffer.getChannelData(0);
  self._audioBuffer.push(new Float32Array(inputData));
};
sourceNode.connect(this._scriptProcessor);
this._scriptProcessor.connect(this._audioContext.destination);
```

---

## Appendix C: State Transition Logic

### Event to State Mapping

```javascript
// Pipeline event handlers
switch (event.type) {
  case 'run-start':
    this._binaryHandlerId = event.data.runner_data.stt_binary_handler_id;
    this._ttsUrl = event.data.tts_output?.url;
    this._setState(State.LISTENING);
    break;
    
  case 'wake_word-end':
    this._setState(State.WAKE_WORD_DETECTED);
    this._playWakeChime();
    this._turnOffWakeWordSwitch();
    this._showBlurOverlay();
    break;
    
  case 'stt-start':
    this._setState(State.STT);
    break;
    
  case 'stt-end':
    this._showTranscription(event.data.stt_output.text);
    break;
    
  case 'intent-start':
    this._setState(State.INTENT);
    break;
    
  case 'intent-end':
    var response = event.data.intent_output?.response?.speech?.plain?.speech;
    this._showResponse(response);
    this._playRequestSentChime();
    break;
    
  case 'tts-start':
    this._setState(State.TTS);
    break;
    
  case 'tts-end':
    this._playTTS(event.data.tts_output.url || event.data.tts_output.url_path);
    break;
    
  case 'run-end':
    this._hideOverlays();
    this._restartPipeline();
    break;
    
  case 'error':
    this._handleError(event.data);
    break;
}
```

### Bubble Display Timing

```javascript
// Transcription bubble
_showTranscription(text) {
  if (!this._config.show_transcription) return;
  var el = this._globalUI.querySelector('.vs-transcription');
  el.textContent = text;
  el.classList.add('visible');
  // Auto-hide after 5 seconds
  setTimeout(() => el.classList.remove('visible'), 5000);
}

// Response bubble
_showResponse(text) {
  if (!this._config.show_response) return;
  var el = this._globalUI.querySelector('.vs-response');
  el.textContent = text;
  el.classList.add('visible');
  // Hidden when TTS finishes or after 10 seconds
}
```

---

## Appendix D: Chime Audio Data

The chimes are short WAV files encoded as base64 data URIs. They should be:
- **Format:** WAV (PCM)
- **Sample Rate:** 44100 Hz
- **Channels:** Mono or Stereo
- **Duration:** ~200-500ms

### Wake Word Chime
A pleasant ascending tone indicating "I heard you"

### Request Sent Chime  
A confirmation tone indicating "Got it, processing"

### Error Chime
A distinct lower tone indicating "Something went wrong"

```javascript
// Structure in code
this._wakeChimeData = 'data:audio/wav;base64,UklGRl9vT19...';
this._requestChimeData = 'data:audio/wav;base64,UklGRm9vT19...';
this._errorChimeData = 'data:audio/wav;base64,UklGRn9vT19...';
```

Note: Actual base64 data is ~10-50KB per chime. Generate using any audio editor, export as WAV, then base64 encode.

---

## Appendix E: Visual Editor Field Reference

### Section: Behavior

| Field ID | Config Key | Type | Default |
|----------|------------|------|---------|
| pipeline_id | pipeline_id | dropdown | '' (default pipeline) |
| start_listening_on_load | start_listening_on_load | checkbox | true |
| wake_word_switch | wake_word_switch | entity picker | '' |
| debug | debug | checkbox | false |

### Section: Microphone Processing

| Field ID | Config Key | Type | Range | Default |
|----------|------------|------|-------|---------|
| noise_suppression | noise_suppression | checkbox | - | true |
| echo_cancellation | echo_cancellation | checkbox | - | true |
| mic_sensitivity | mic_sensitivity | slider | 10-300 (displayed as %) | 100 (1.0) |

### Section: Timeouts

| Field ID | Config Key | Type | Range | Default |
|----------|------------|------|-------|---------|
| pipeline_timeout | pipeline_timeout | number | 0-300 | 60 |
| pipeline_idle_timeout | pipeline_idle_timeout | number | 0-3600 | 300 |

### Section: Volume

| Field ID | Config Key | Type | Range | Default |
|----------|------------|------|-------|---------|
| chime_volume | chime_volume | slider | 0-100 | 100 |
| tts_volume | tts_volume | slider | 0-100 | 100 |
| chime_on_wake_word | chime_on_wake_word | checkbox | - | true |
| chime_on_request_sent | chime_on_request_sent | checkbox | - | true |

### Section: Rainbow Bar

| Field ID | Config Key | Type | Default |
|----------|------------|------|---------|
| bar_position | bar_position | dropdown (top/bottom) | bottom |
| bar_height | bar_height | slider (2-40) | 16 |
| bar_gradient | bar_gradient | text | '#FF7777, #FF9977...' |

### Section: Transcription Bubble

| Field ID | Config Key | Type | Default |
|----------|------------|------|---------|
| show_transcription | show_transcription | checkbox | true |
| transcription_font_size | transcription_font_size | slider (10-48) | 20 |
| transcription_font_family | transcription_font_family | text | 'inherit' |
| transcription_font_color | transcription_font_color | color | '#444444' |
| transcription_font_bold | transcription_font_bold | checkbox | true |
| transcription_font_italic | transcription_font_italic | checkbox | false |
| transcription_background | transcription_background | color | '#ffffff' |
| transcription_border_color | transcription_border_color | color | 'rgba(0,180,255,0.5)' |
| transcription_padding | transcription_padding | slider (0-32) | 16 |
| transcription_rounded | transcription_rounded | checkbox | true |

### Section: Response Bubble

| Field ID | Config Key | Type | Default |
|----------|------------|------|---------|
| show_response | show_response | checkbox | true |
| streaming_response | streaming_response | checkbox | false |
| response_font_size | response_font_size | slider (10-48) | 20 |
| response_font_family | response_font_family | text | 'inherit' |
| response_font_color | response_font_color | color | '#444444' |
| response_font_bold | response_font_bold | checkbox | true |
| response_font_italic | response_font_italic | checkbox | false |
| response_background | response_background | color | '#ffffff' |
| response_border_color | response_border_color | color | 'rgba(100,200,150,0.5)' |
| response_padding | response_padding | slider (0-32) | 16 |
| response_rounded | response_rounded | checkbox | true |

### Section: Background

| Field ID | Config Key | Type | Default |
|----------|------------|------|---------|
| background_blur | background_blur | checkbox | true |
| background_blur_intensity | background_blur_intensity | slider (0-20) | 5 |

---

## Appendix F: Home Assistant Custom Card Registration

```javascript
// Register the main card
customElements.define('voice-satellite-card', VoiceSatelliteCard);

// Register the editor
customElements.define('voice-satellite-card-editor', VoiceSatelliteCardEditor);

// Register with Home Assistant's custom card registry
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'voice-satellite-card',
  name: 'Voice Satellite Card',
  description: 'Transform your browser into a voice satellite for Home Assistant Assist',
  preview: false,
  documentationURL: 'https://github.com/owner/voice-satellite-card'
});

// Console branding
console.info(
  '%c VOICE-SATELLITE-CARD %c v1.11.0 ',
  'color: white; background: #03a9f4; font-weight: bold;',
  'color: #03a9f4; background: white; font-weight: bold;'
);
```

---

## Appendix G: TTS Playback Logic

### TTS URL Handling

Home Assistant provides TTS URLs in two formats depending on the event:

```javascript
// From run-start event (pre-generated token)
event.data.tts_output.url = '/api/tts_proxy/6SS3OJwsjwQOKnGG6Pn16w.mp3'

// From tts-end event (may have url or url_path)
event.data.tts_output.url = '/api/tts_proxy/...'
event.data.tts_output.url_path = '/api/tts_proxy/...'
```

### Building Full TTS URL

```javascript
_buildTtsUrl(urlPath) {
  // If already absolute URL, return as-is
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    return urlPath;
  }
  
  // Build from Home Assistant base URL
  var baseUrl = this._hass.hassUrl || window.location.origin;
  
  // Remove trailing slash from base, ensure leading slash on path
  baseUrl = baseUrl.replace(/\/$/, '');
  if (!urlPath.startsWith('/')) {
    urlPath = '/' + urlPath;
  }
  
  return baseUrl + urlPath;
}
```

### TTS Playback Implementation

```javascript
_playTTS(urlPath) {
  var self = this;
  var url = this._buildTtsUrl(urlPath);
  
  // Create audio element
  var audio = new Audio();
  
  // Apply volume setting
  audio.volume = this._config.tts_volume / 100;
  
  // Set up event handlers before setting src
  audio.onended = function() {
    console.log('[VoiceSatellite] TTS playback complete');
    self._onTTSComplete();
  };
  
  audio.onerror = function(e) {
    console.error('[VoiceSatellite] TTS playback error:', e);
    console.error('[VoiceSatellite] TTS URL was:', url);
    self._onTTSComplete();  // Continue even on error
  };
  
  audio.oncanplaythrough = function() {
    console.log('[VoiceSatellite] TTS audio ready, playing...');
  };
  
  // Set source and play
  audio.src = url;
  audio.play().catch(function(e) {
    console.error('[VoiceSatellite] TTS play() failed:', e);
    self._onTTSComplete();
  });
  
  // Store reference to allow stopping if needed
  this._currentAudio = audio;
}

_onTTSComplete() {
  this._currentAudio = null;
  this._hideResponse();
  this._hideBlurOverlay();
  // Pipeline will restart via run-end event
}

_stopTTS() {
  if (this._currentAudio) {
    this._currentAudio.pause();
    this._currentAudio.src = '';
    this._currentAudio = null;
  }
}
```

### TTS Token Expiration

TTS tokens expire after some time. The `pipeline_idle_timeout` ensures fresh tokens:

```javascript
// Token received at pipeline start
// run-start event: tts_output.token = "6SS3OJwsjwQOKnGG6Pn16w"

// If pipeline sits idle too long, token expires
// Solution: restart pipeline before expiration
this._idleTimeout = setTimeout(function() {
  console.log('[VoiceSatellite] Idle timeout - restarting pipeline for fresh TTS token');
  self._restartPipeline(0);
}, this._config.pipeline_idle_timeout * 1000);
```

---

## Appendix H: WebSocket Subscription Pattern

### Accessing Home Assistant Connection

```javascript
// The hass object is provided by Home Assistant to custom cards
set hass(hass) {
  this._hass = hass;
  
  // Connection is available via hass.connection
  // This is a persistent WebSocket connection managed by HA frontend
  if (hass && hass.connection && !this._isConnected) {
    this._connection = hass.connection;
    this._startPipeline();
  }
}
```

### Pipeline Subscription

```javascript
async _startPipeline() {
  var self = this;
  
  // First, get available pipelines
  var pipelines = await this._connection.sendMessagePromise({
    type: 'assist_pipeline/pipeline/list'
  });
  
  // Select pipeline (configured or default)
  var pipelineId = this._config.pipeline_id;
  if (!pipelineId) {
    // Find preferred pipeline or use first one
    var preferred = pipelines.pipelines.find(function(p) { return p.preferred; });
    pipelineId = preferred ? preferred.id : pipelines.pipelines[0].id;
  }
  
  // Subscribe to pipeline events
  this._unsubscribe = await this._connection.subscribeMessage(
    function(message) {
      self._handlePipelineMessage(message);
    },
    {
      type: 'assist_pipeline/run',
      start_stage: 'wake_word',
      end_stage: 'tts',
      input: { sample_rate: 16000 },
      pipeline: pipelineId,
      timeout: this._config.pipeline_idle_timeout
    }
  );
}
```

### Message Handler Structure

```javascript
_handlePipelineMessage(message) {
  // Message structure from HA WebSocket
  // {
  //   type: 'event',
  //   event: {
  //     type: 'wake_word-end',  // Event type
  //     data: { ... }           // Event-specific data
  //   }
  // }
  
  if (message.type !== 'event') return;
  
  var event = message.event;
  var eventType = event.type;
  var eventData = event.data || {};
  
  if (this._config.debug) {
    console.log('[VoiceSatellite] Event:', eventType, JSON.stringify(eventData));
  }
  
  // Route to specific handler
  switch (eventType) {
    case 'run-start':
      this._handleRunStart(eventData);
      break;
    case 'wake_word-start':
      this._handleWakeWordStart(eventData);
      break;
    case 'wake_word-end':
      this._handleWakeWordEnd(eventData);
      break;
    // ... etc
  }
}
```

### Binary Audio Transmission

Audio is sent separately from the subscription, using the binary handler ID:

```javascript
_sendAudioBuffer() {
  if (!this._binaryHandlerId || !this._audioBuffer.length) return;
  
  // Collect buffered audio
  var samples = this._collectAudioBuffer();
  
  // Resample to 16kHz if needed
  if (this._actualSampleRate !== 16000) {
    samples = this._resample(samples, this._actualSampleRate, 16000);
  }
  
  // Convert to 16-bit PCM
  var pcmData = this._floatTo16BitPCM(samples);
  
  // Prepend binary handler ID
  var message = new Uint8Array(1 + pcmData.length);
  message[0] = this._binaryHandlerId;
  message.set(new Uint8Array(pcmData.buffer), 1);
  
  // Send via WebSocket
  this._connection.socket.send(message.buffer);
}
```

### Unsubscribing

```javascript
async _stopPipeline() {
  // Clear audio sending interval
  if (this._sendInterval) {
    clearInterval(this._sendInterval);
    this._sendInterval = null;
  }
  
  // Unsubscribe from pipeline events
  if (this._unsubscribe) {
    await this._unsubscribe();
    this._unsubscribe = null;
  }
  
  // Clear binary handler
  this._binaryHandlerId = null;
}
```

### Reconnection Handling

```javascript
// HA connection provides reconnection events
this._connection.addEventListener('ready', function() {
  console.log('[VoiceSatellite] Connection ready');
  if (self._wasConnected) {
    // Reconnected after disconnect - restart pipeline
    self._startPipeline();
  }
});

this._connection.addEventListener('disconnected', function() {
  console.log('[VoiceSatellite] Connection lost');
  self._wasConnected = true;
  self._isConnected = false;
});
```

---

## Appendix I: Complete Method Reference

### Lifecycle Methods

| Method | Purpose |
|--------|---------|
| `constructor()` | Initialize state, flags, config defaults |
| `connectedCallback()` | Called when card added to DOM |
| `disconnectedCallback()` | Called when card removed from DOM |
| `setConfig(config)` | Receive and process configuration |
| `set hass(hass)` | Receive Home Assistant object (called frequently) |
| `getCardSize()` | Return card size for layout (returns 0 - invisible) |

### Audio Methods

| Method | Purpose |
|--------|---------|
| `_startMicrophone()` | Request mic access, set up audio chain |
| `_stopMicrophone()` | Release mic, disconnect audio nodes |
| `_setupAudioWorklet(sourceNode)` | Create AudioWorklet processor |
| `_setupScriptProcessor(sourceNode)` | Fallback audio processing |
| `_sendAudioBuffer()` | Collect, resample, convert, send audio |
| `_resample(input, fromRate, toRate)` | Linear interpolation resampling |
| `_floatTo16BitPCM(samples)` | Convert Float32 to Int16 PCM |
| `setMicSensitivity(value)` | Update gain node value |

### Pipeline Methods

| Method | Purpose |
|--------|---------|
| `_startPipeline()` | Subscribe to pipeline, start audio send |
| `_stopPipeline()` | Unsubscribe, stop audio send |
| `_restartPipeline(delay)` | Stop and restart with optional delay |
| `_handlePipelineMessage(message)` | Route pipeline events |
| `_handleError(errorData)` | Process error events |
| `_resetIdleTimeout()` | Reset pipeline idle timer |

### UI Methods

| Method | Purpose |
|--------|---------|
| `_render()` | Render card HTML (minimal - just a div) |
| `_ensureGlobalUI()` | Create/find global overlay |
| `_updateUI()` | Update rainbow bar state |
| `_showStartButton()` | Display manual start button |
| `_hideStartButton()` | Hide manual start button |
| `_showBlurOverlay()` | Activate background blur |
| `_hideBlurOverlay()` | Deactivate background blur |
| `_showTranscription(text)` | Display transcription bubble |
| `_hideTranscription()` | Hide transcription bubble |
| `_showResponse(text)` | Display response bubble |
| `_hideResponse()` | Hide response bubble |
| `_showErrorBar()` | Show red error state |
| `_setState(state)` | Update state with logging |

### Playback Methods

| Method | Purpose |
|--------|---------|
| `_playWakeChime()` | Play wake word detection chime |
| `_playRequestSentChime()` | Play request processed chime |
| `_playErrorChime()` | Play error notification chime |
| `_playTTS(url)` | Play text-to-speech audio |
| `_stopTTS()` | Stop current TTS playback |
| `_buildTtsUrl(urlPath)` | Construct full TTS URL |

### Utility Methods

| Method | Purpose |
|--------|---------|
| `_turnOffWakeWordSwitch()` | Call HA service to turn off switch |
| `_handleVisibilityChange()` | Respond to tab visibility |
| `_handleStartClick()` | Handle manual start button click |

### Static Methods

| Method | Purpose |
|--------|---------|
| `getConfigElement()` | Return editor element |
| `getStubConfig()` | Return default config for new cards |

---

## Appendix J: Singleton Instance Coordination

### The Problem

Home Assistant may create multiple instances of the card:
- Card on multiple dashboard views
- Card in both YAML and UI-configured dashboards
- Browser back/forward navigation recreates cards

Without coordination, each instance would:
- Try to access the microphone separately
- Create duplicate WebSocket subscriptions
- Show multiple UI overlays

### Global Flags

```javascript
// Set when any instance is actively running
window._voiceSatelliteActive = true;

// Set during startup to prevent race conditions
window._voiceSatelliteStarting = true;

// Reference to the active instance
window._voiceSatelliteInstance = this;
```

### Startup Coordination

```javascript
async _startListening() {
  // Check if another instance is already active
  if (window._voiceSatelliteActive && window._voiceSatelliteInstance !== this) {
    console.log('[VoiceSatellite] Another instance is active, skipping');
    return;
  }
  
  // Check if startup is in progress
  if (window._voiceSatelliteStarting) {
    console.log('[VoiceSatellite] Pipeline already starting globally, skipping');
    return;
  }
  
  // Claim startup
  window._voiceSatelliteStarting = true;
  
  try {
    await this._startMicrophone();
    await this._startPipeline();
    
    // Mark as active
    window._voiceSatelliteActive = true;
    window._voiceSatelliteInstance = this;
  } finally {
    window._voiceSatelliteStarting = false;
  }
}
```

### Instance Takeover

When a new card instance is created and the old one is destroyed:

```javascript
disconnectedCallback() {
  // Don't stop if we're the active instance and just being moved
  // (HA does this when switching views)
  
  // Use a small delay to see if we're reconnected
  var self = this;
  this._disconnectTimeout = setTimeout(function() {
    if (window._voiceSatelliteInstance === self) {
      // We're still the active instance but truly disconnected
      // Keep running - the global UI persists
    }
  }, 100);
}

connectedCallback() {
  // Cancel any pending disconnect cleanup
  if (this._disconnectTimeout) {
    clearTimeout(this._disconnectTimeout);
  }
  
  // If we're the active instance, continue
  // If not, check if we should take over
  if (!window._voiceSatelliteActive) {
    this._startListening();
  }
}
```

---

## Appendix K: Tab Visibility Handling

### The Problem

When user switches tabs:
- Browser may throttle or suspend JavaScript
- Microphone may be released
- WebSocket may disconnect
- Audio buffers may overflow

Quick tab switches (cmd+tab back and forth) shouldn't interrupt the pipeline.

### Debounced Visibility Handler

```javascript
_setupVisibilityHandler() {
  var self = this;
  this._visibilityDebounceTimer = null;
  
  document.addEventListener('visibilitychange', function() {
    // Clear any pending debounce
    if (self._visibilityDebounceTimer) {
      clearTimeout(self._visibilityDebounceTimer);
    }
    
    if (document.hidden) {
      // Tab hidden - wait before pausing (user might switch back quickly)
      self._visibilityDebounceTimer = setTimeout(function() {
        console.log('[VoiceSatellite] Tab hidden - pausing microphone');
        self._pauseMicrophone();
      }, 500);  // 500ms debounce
    } else {
      // Tab visible - resume immediately
      console.log('[VoiceSatellite] Tab visible - resuming microphone');
      self._resumeMicrophone();
    }
  });
}
```

### Pause vs Stop

```javascript
_pauseMicrophone() {
  // Don't fully stop - just pause the stream
  // This allows faster resume
  this._isPaused = true;
  this._setState(State.PAUSED);
  
  // Stop sending audio but keep connection
  if (this._sendInterval) {
    clearInterval(this._sendInterval);
    this._sendInterval = null;
  }
  
  // Optionally mute the media track (browser-dependent)
  if (this._mediaStream) {
    this._mediaStream.getAudioTracks().forEach(function(track) {
      track.enabled = false;
    });
  }
}

_resumeMicrophone() {
  if (!this._isPaused) return;
  
  this._isPaused = false;
  
  // Re-enable tracks
  if (this._mediaStream) {
    this._mediaStream.getAudioTracks().forEach(function(track) {
      track.enabled = true;
    });
  }
  
  // Restart send interval
  var self = this;
  this._sendInterval = setInterval(function() {
    self._sendAudioBuffer();
  }, 100);
  
  this._setState(State.LISTENING);
}
```

---

## Appendix L: Home Assistant Service Calls

### Wake Word Switch

Turn off a switch when wake word is detected (e.g., Fully Kiosk screensaver):

```javascript
_turnOffWakeWordSwitch() {
  if (!this._config.wake_word_switch) return;
  
  var entityId = this._config.wake_word_switch;
  
  // Validate entity format
  if (!entityId.includes('.')) {
    console.warn('[VoiceSatellite] Invalid wake_word_switch entity:', entityId);
    return;
  }
  
  console.log('[VoiceSatellite] Turning off wake word switch:', entityId);
  
  // Call Home Assistant service
  this._hass.callService('homeassistant', 'turn_off', {
    entity_id: entityId
  }).catch(function(err) {
    console.error('[VoiceSatellite] Failed to turn off switch:', err);
  });
}
```

### Service Call Format

```javascript
// General format for HA service calls
this._hass.callService(domain, service, serviceData);

// Examples:
this._hass.callService('switch', 'turn_off', { entity_id: 'switch.screensaver' });
this._hass.callService('homeassistant', 'turn_off', { entity_id: 'switch.screensaver' });
this._hass.callService('light', 'turn_on', { entity_id: 'light.room', brightness: 255 });
```

---

## Appendix M: Audio Data Conversion

### Float32 to Int16 PCM

Web Audio API provides samples as Float32 (-1.0 to 1.0). Home Assistant expects Int16 PCM (-32768 to 32767).

```javascript
_floatTo16BitPCM(float32Array) {
  var pcmData = new Int16Array(float32Array.length);
  
  for (var i = 0; i < float32Array.length; i++) {
    // Clamp to -1.0 to 1.0 range
    var sample = Math.max(-1, Math.min(1, float32Array[i]));
    
    // Convert to Int16
    // Negative: multiply by 0x8000 (32768)
    // Positive: multiply by 0x7FFF (32767)
    // This asymmetry matches the Int16 range (-32768 to 32767)
    pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }
  
  return pcmData;
}
```

### Why the Asymmetry?

```
Int16 range: -32768 to 32767
Float range: -1.0 to 1.0

-1.0 * 32768 = -32768 ✓
+1.0 * 32767 = +32767 ✓

If we used 32768 for both:
+1.0 * 32768 = 32768 (overflow! wraps to -32768)
```

### Linear Interpolation Resampling

When browser sample rate ≠ 16000 Hz:

```javascript
_resample(inputSamples, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) {
    return inputSamples;
  }
  
  var ratio = fromSampleRate / toSampleRate;
  var outputLength = Math.round(inputSamples.length / ratio);
  var output = new Float32Array(outputLength);
  
  for (var i = 0; i < outputLength; i++) {
    // Calculate source position (floating point)
    var srcIndex = i * ratio;
    
    // Get integer indices for interpolation
    var low = Math.floor(srcIndex);
    var high = Math.min(low + 1, inputSamples.length - 1);
    
    // Fractional part for interpolation weight
    var frac = srcIndex - low;
    
    // Linear interpolation
    output[i] = inputSamples[low] * (1 - frac) + inputSamples[high] * frac;
  }
  
  return output;
}
```

### Example: 48kHz to 16kHz

```
Input: 4800 samples at 48kHz = 100ms of audio
Output: 1600 samples at 16kHz = 100ms of audio
Ratio: 48000/16000 = 3

For output[0]: srcIndex = 0 * 3 = 0 → input[0]
For output[1]: srcIndex = 1 * 3 = 3 → input[3]
For output[2]: srcIndex = 2 * 3 = 6 → input[6]
...

With fractional positions:
output[0]: srcIndex = 0.0 → input[0] * 1.0
output[1]: srcIndex = 3.0 → input[3] * 1.0
output[533]: srcIndex = 1599.0 → interpolate between input[1599] and input[1600]
```

---

## Appendix N: Debug Mode

When `debug: true` is set in config:

```javascript
// All pipeline events are logged
console.log('[VoiceSatellite] Event:', eventType, JSON.stringify(eventData));

// State transitions are logged
console.log('[VoiceSatellite] State:', oldState, '->', newState);

// Audio stats (optional - can be enabled)
console.log('[VoiceSatellite] Audio buffer:', this._audioBuffer.length, 'chunks');
console.log('[VoiceSatellite] Sample rate:', this._actualSampleRate);
```

### Console Log Prefix

All logs use `[VoiceSatellite]` prefix for easy filtering in browser console:

```
Filter: VoiceSatellite
```

### Useful Debug Commands

In browser console while card is running:

```javascript
// Get active instance
window._voiceSatelliteInstance

// Check state
window._voiceSatelliteInstance._state

// Check if streaming
window._voiceSatelliteInstance._isStreaming

// Manually restart pipeline
window._voiceSatelliteInstance._restartPipeline(0)

// Check config
window._voiceSatelliteInstance._config
```

---

## Appendix O: Timeout Configuration & Behavior

### Overview of Timeouts

The card uses multiple timeouts at different layers:

| Timeout | Config Key | Default | Purpose |
|---------|------------|---------|---------|
| Pipeline Response | `pipeline_timeout` | 60s | Max time for entire voice interaction |
| Pipeline Idle | `pipeline_idle_timeout` | 300s | Time before pipeline restart for fresh TTS tokens |
| Retry Backoff | (internal) | 3-30s | Delay between error recovery attempts |
| Tab Visibility Debounce | (internal) | 500ms | Delay before pausing on tab hide |
| Bubble Auto-Hide | (internal) | 5-10s | Time before transcription/response bubbles hide |

### Pipeline Response Timeout (`pipeline_timeout`)

**Purpose:** Prevents the pipeline from hanging indefinitely during a voice interaction.

**Scope:** Covers the entire interaction from wake word detection through TTS playback.

**Sent to Home Assistant:** Yes - passed in the `assist_pipeline/run` message.

```javascript
{
  type: 'assist_pipeline/run',
  start_stage: 'wake_word',
  end_stage: 'tts',
  input: { sample_rate: 16000 },
  pipeline: pipelineId,
  timeout: this._config.pipeline_timeout  // Sent to HA
}
```

**Behavior:**
- If set to 0: No timeout (not recommended)
- If exceeded: HA sends `error` event with code `timeout`
- On timeout during wake word listening: Expected, immediate restart
- On timeout during STT/intent/TTS: Unexpected, triggers error handling

### Pipeline Idle Timeout (`pipeline_idle_timeout`)

**Purpose:** Keeps TTS tokens fresh by periodically restarting the pipeline.

**Scope:** Client-side only - measures idle time while listening for wake word.

**Not sent to Home Assistant:** This is purely client-side logic.

```javascript
_startIdleTimeout() {
  var self = this;
  
  // Clear any existing timeout
  this._clearIdleTimeout();
  
  if (this._config.pipeline_idle_timeout <= 0) {
    return;  // Disabled
  }
  
  this._idleTimeoutId = setTimeout(function() {
    console.log('[VoiceSatellite] Idle timeout reached, restarting pipeline');
    self._restartPipeline(0);  // Immediate restart, no delay
  }, this._config.pipeline_idle_timeout * 1000);
}

_clearIdleTimeout() {
  if (this._idleTimeoutId) {
    clearTimeout(this._idleTimeoutId);
    this._idleTimeoutId = null;
  }
}

_resetIdleTimeout() {
  // Called on any pipeline activity
  this._startIdleTimeout();
}
```

**When it resets:**
- On `run-start` (pipeline started)
- On `wake_word-end` (wake word detected)
- On `run-end` (interaction complete, new pipeline starts)

**Why 300 seconds default:**
- TTS tokens typically expire after several minutes
- 5 minutes balances freshness vs unnecessary restarts
- User can increase if their setup has longer token validity

### Retry Backoff Timeout

**Purpose:** Prevents rapid retry loops on persistent errors.

**Algorithm:** Exponential backoff with cap

```javascript
_calculateRetryDelay() {
  // Base delay: 3 seconds
  // Multiplier: 2x per retry
  // Maximum: 30 seconds
  
  var delay = Math.min(3000 * Math.pow(2, this._retryCount), 30000);
  this._retryCount++;
  
  return delay;
}

// Retry sequence:
// Attempt 1: 3000ms (3s)
// Attempt 2: 6000ms (6s)
// Attempt 3: 12000ms (12s)
// Attempt 4: 24000ms (24s)
// Attempt 5+: 30000ms (30s) - capped
```

**Reset on success:**
```javascript
_onPipelineSuccess() {
  this._retryCount = 0;  // Reset backoff
  this._serviceUnavailable = false;
}
```

**Bypassed for expected errors:**
```javascript
var expectedErrors = ['timeout', 'stt-no-text-recognized', 'duplicate-wake-word-id'];
if (expectedErrors.indexOf(errorCode) !== -1) {
  // No backoff - restart immediately
  this._restartPipeline(0);
  return;
}
```

### Tab Visibility Debounce

**Purpose:** Prevents mic pause/resume thrashing on quick tab switches.

**Value:** 500ms (hardcoded)

```javascript
// User switches away
// Timer starts: 500ms
// User switches back within 500ms
// Timer cancelled - no pause occurred

// User switches away
// Timer starts: 500ms
// 500ms passes
// Microphone paused
// User switches back
// Microphone resumed immediately (no debounce on resume)
```

### Bubble Display Timeouts

**Transcription bubble:**
```javascript
_showTranscription(text) {
  // Show bubble
  el.classList.add('visible');
  
  // Auto-hide after 5 seconds
  this._transcriptionTimeout = setTimeout(function() {
    el.classList.remove('visible');
  }, 5000);
}
```

**Response bubble:**
```javascript
_showResponse(text) {
  // Show bubble
  el.classList.add('visible');
  
  // Hidden when TTS ends OR after 10 seconds (whichever first)
  this._responseTimeout = setTimeout(function() {
    el.classList.remove('visible');
  }, 10000);
}

_onTTSComplete() {
  // Clear timeout and hide immediately
  clearTimeout(this._responseTimeout);
  this._hideResponse();
}
```

### Timeout Interaction Diagram

```
User says wake word
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│                    pipeline_timeout (60s)                  │
│                                                           │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐     │
│  │ Wake Word   │──▶│    STT      │──▶│   Intent    │──┐  │
│  │  Detection  │   │  (speech)   │   │ Processing  │  │  │
│  └─────────────┘   └─────────────┘   └─────────────┘  │  │
│         │                                              │  │
│         │ pipeline_idle_timeout                        ▼  │
│         │ resets here                           ┌─────────┤
│         ▼                                       │   TTS   │
│  ┌─────────────┐                                │ Playback│
│  │  Listening  │◀───────────────────────────────┴─────────┤
│  │ (idle wait) │                                          │
│  └─────────────┘                                          │
│         │                                                 │
│         │ pipeline_idle_timeout (300s)                    │
│         ▼                                                 │
│  ┌─────────────┐                                          │
│  │  Restart    │ (get fresh TTS token)                    │
│  │  Pipeline   │                                          │
│  └─────────────┘                                          │
└───────────────────────────────────────────────────────────┘
```

### Configuration Recommendations

| Use Case | pipeline_timeout | pipeline_idle_timeout |
|----------|------------------|----------------------|
| Default | 60 | 300 |
| Slow STT/LLM | 120 | 300 |
| Long responses | 90 | 300 |
| Unreliable network | 30 | 180 |
| Always-on kiosk | 60 | 600 |
| Testing/Debug | 30 | 60 |

---

## Appendix P: Audio Buffer Management

### Buffer Structure

Audio arrives in chunks from AudioWorklet/ScriptProcessor and is collected before sending:

```javascript
// Initialize buffer
this._audioBuffer = [];

// AudioWorklet posts Float32Array chunks
this._workletNode.port.onmessage = function(e) {
  self._audioBuffer.push(new Float32Array(e.data));
};

// ScriptProcessor provides chunks via callback
this._scriptProcessor.onaudioprocess = function(e) {
  var inputData = e.inputBuffer.getChannelData(0);
  self._audioBuffer.push(new Float32Array(inputData));
};
```

### Send Interval

Audio is sent every 100ms regardless of how many chunks have accumulated:

```javascript
this._sendInterval = setInterval(function() {
  self._sendAudioBuffer();
}, 100);
```

### Buffer Collection & Flush

```javascript
_sendAudioBuffer() {
  if (!this._binaryHandlerId || this._audioBuffer.length === 0) {
    return;
  }
  
  // Calculate total length
  var totalLength = 0;
  for (var i = 0; i < this._audioBuffer.length; i++) {
    totalLength += this._audioBuffer[i].length;
  }
  
  // Combine all chunks into single array
  var combined = new Float32Array(totalLength);
  var offset = 0;
  for (var i = 0; i < this._audioBuffer.length; i++) {
    combined.set(this._audioBuffer[i], offset);
    offset += this._audioBuffer[i].length;
  }
  
  // Clear buffer
  this._audioBuffer = [];
  
  // Resample if needed
  if (this._actualSampleRate !== 16000) {
    combined = this._resample(combined, this._actualSampleRate, 16000);
  }
  
  // Convert and send
  var pcmData = this._floatTo16BitPCM(combined);
  this._sendBinaryAudio(pcmData);
}
```

### Buffer Size Considerations

```
At 16kHz sample rate:
- 100ms = 1,600 samples
- 1,600 samples × 2 bytes = 3,200 bytes per send

At 48kHz (common browser default):
- 100ms = 4,800 samples collected
- Resampled to 1,600 samples
- 3,200 bytes sent

AudioWorklet chunk size: typically 128 samples
- 100ms at 48kHz ≈ 37 chunks collected per send
```

---

## Appendix Q: Embedded SVG Icons

### Microphone Icon (Start Button)

```html
<svg viewBox="0 0 24 24">
  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
</svg>
```

This is the Material Design microphone icon, used for:
- Start button (floating action button)
- Visual editor section headers

---

## Appendix R: Streaming Response Feature

### Config Option

```yaml
streaming_response: false  # Default: disabled
```

### How It Works

When enabled, the response bubble updates in real-time as the LLM generates text:

```javascript
case 'intent-progress':
  // HA sends partial responses during LLM generation
  if (this._config.streaming_response && eventData.partial_response) {
    this._updateResponse(eventData.partial_response);
  }
  break;

case 'intent-end':
  // Final response
  this._showResponse(eventData.intent_output.response.speech.plain.speech);
  break;
```

### Implementation

```javascript
_updateResponse(text) {
  if (!this._config.show_response) return;
  
  var el = this._globalUI.querySelector('.vs-response');
  el.textContent = text;
  
  // Show if not already visible
  if (!el.classList.contains('visible')) {
    el.classList.add('visible');
  }
}
```

### Requirements

- Requires a conversation agent that supports streaming (e.g., OpenAI, some local LLMs)
- Home Assistant must be configured to enable streaming responses
- Not all pipelines support this feature

### Limitations

- Standard Home Assistant conversation agent doesn't stream
- Piper TTS waits for complete text anyway
- Visual effect only - doesn't speed up actual response

---

## Appendix S: Visual Editor Entity Picker

### Fetching Entities

The wake_word_switch field needs to show available switch entities:

```javascript
async _loadEntities() {
  if (!this._hass) return;
  
  // Get all entities from hass.states
  var entities = Object.keys(this._hass.states)
    .filter(function(entityId) {
      // Filter to switches only
      return entityId.startsWith('switch.');
    })
    .sort();
  
  return entities;
}
```

### Rendering Entity Dropdown

```javascript
_renderEntityPicker(fieldId, currentValue, entityFilter) {
  var entities = Object.keys(this._hass.states)
    .filter(function(entityId) {
      return entityId.startsWith(entityFilter);
    })
    .sort();
  
  var html = '<select id="' + fieldId + '">';
  html += '<option value="">None</option>';
  
  for (var i = 0; i < entities.length; i++) {
    var entityId = entities[i];
    var friendlyName = this._hass.states[entityId].attributes.friendly_name || entityId;
    var selected = entityId === currentValue ? ' selected' : '';
    html += '<option value="' + entityId + '"' + selected + '>' + friendlyName + ' (' + entityId + ')</option>';
  }
  
  html += '</select>';
  return html;
}
```

### Alternative: Text Input with Autocomplete

For simplicity, the current implementation uses a text input:

```javascript
'<input type="text" id="wake_word_switch" value="' + (this._config.wake_word_switch || '') + '" placeholder="switch.tablet_screensaver">'
```

This allows any entity, not just switches, for flexibility.

---

## Appendix T: Known Limitations & Quirks

### Browser Limitations

| Issue | Cause | Workaround |
|-------|-------|------------|
| Mic stops when screen off | OS power management | Use screensaver, not screen off |
| Mic stops in background tab | Browser throttling | Tab must be visible or use Fully Kiosk |
| No auto-start on first visit | User gesture requirement | Click mic button once |
| Audio glitches on slow devices | Buffer underrun | Increase send interval (not configurable yet) |

### Home Assistant Limitations

| Issue | Cause | Workaround |
|-------|-------|------------|
| TTS fails after long idle | Token expiration | Use pipeline_idle_timeout |
| Wake word missed during TTS | Single pipeline | Wait for TTS to finish |
| Slow response with local LLM | Processing time | Increase pipeline_timeout |
| No barge-in support | Pipeline design | Cannot interrupt TTS |

### Card Limitations

| Issue | Notes |
|-------|-------|
| Single active instance | Only one browser tab can be the satellite |
| No conversation history | Each interaction is independent |
| No multi-room awareness | Card doesn't know about other satellites |
| English-centric chimes | Chime timing assumes English speech patterns |

### Mobile Browser Quirks

| Browser | Issue | Notes |
|---------|-------|-------|
| iOS Safari | Mic releases on lock | Cannot run in background |
| iOS Safari | AudioContext suspended | Requires user gesture to resume |
| Chrome Android | Works well | Best mobile experience |
| Firefox Android | AudioWorklet issues | Falls back to ScriptProcessor |

### Fully Kiosk Specific

| Setting | Required Value | Why |
|---------|----------------|-----|
| Microphone Access | Enabled | Obviously |
| Autoplay Videos | Enabled | For TTS playback |
| Keep Screen On | Screensaver, not Off | Mic stops if screen fully off |
| JavaScript Interface | Enabled | For wake_word_switch integration |

---

## Appendix U: The `_hass` Setter Behavior

### How Home Assistant Updates Cards

Home Assistant calls the `hass` setter on custom cards **frequently** - potentially multiple times per second when entities update. The card must handle this efficiently.

```javascript
set hass(hass) {
  // Store reference
  this._hass = hass;
  
  // IMPORTANT: Don't re-initialize on every call
  // Only act on first connection or reconnection
  
  if (!this._hasStarted && hass && hass.connection) {
    this._hasStarted = true;
    this._connection = hass.connection;
    
    if (this._config.start_listening_on_load) {
      this._startListening();
    }
  }
}
```

### What Triggers `hass` Updates

- Any entity state change in Home Assistant
- Time updates (every minute)
- WebSocket reconnection
- Dashboard navigation

### Guards Against Re-initialization

```javascript
// Flag to track if we've started
this._hasStarted = false;

// Flag to track if pipeline is running
this._isStreaming = false;

// Flag to track active startup
window._voiceSatelliteStarting = false;

set hass(hass) {
  this._hass = hass;
  
  // Guard 1: Already started
  if (this._hasStarted) return;
  
  // Guard 2: No connection yet
  if (!hass || !hass.connection) return;
  
  // Guard 3: Another instance is starting
  if (window._voiceSatelliteStarting) return;
  
  // Guard 4: Another instance is active
  if (window._voiceSatelliteActive && window._voiceSatelliteInstance !== this) return;
  
  // Safe to initialize
  this._hasStarted = true;
  this._startListening();
}
```

### Accessing `hass` Later

The `_hass` reference is used throughout the card for:
- `this._hass.connection` - WebSocket for pipeline
- `this._hass.callService()` - Service calls (wake_word_switch)
- `this._hass.states` - Entity states (for visual editor)
- `this._hass.hassUrl` - Base URL for TTS

---

## Appendix V: Pipeline Run-End Restart Loop

### The Continuous Listening Loop

After each voice interaction completes, the pipeline must restart to listen for the next wake word:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │ Pipeline │───▶│ Voice    │───▶│ run-end  │──┐   │
│  │  Start   │    │Interaction│   │  Event   │  │   │
│  └──────────┘    └──────────┘    └──────────┘  │   │
│       ▲                                         │   │
│       │                                         │   │
│       └─────────── Restart ─────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### The `run-end` Handler

```javascript
case 'run-end':
  console.log('[VoiceSatellite] Pipeline run ended');
  
  // Clear the binary handler - no longer valid
  this._binaryHandlerId = null;
  
  // Hide UI elements
  this._hideBlurOverlay();
  this._hideTranscription();
  this._hideResponse();
  
  // Reset state
  this._setState(State.IDLE);
  
  // Unsubscribe from current pipeline
  if (this._unsubscribe) {
    this._unsubscribe();
    this._unsubscribe = null;
  }
  
  // Restart pipeline immediately (0ms delay)
  this._restartPipeline(0);
  break;
```

### Restart Flow

```javascript
_restartPipeline(delay) {
  var self = this;
  
  // Clear any existing restart timer
  if (this._restartTimeout) {
    clearTimeout(this._restartTimeout);
  }
  
  // Stop current pipeline if running
  this._stopPipeline();
  
  // Schedule restart
  this._restartTimeout = setTimeout(function() {
    self._startPipeline();
  }, delay || 0);
}
```

### Why Immediate Restart?

After a successful interaction (`run-end`), we restart immediately (0ms delay) because:
- User expects continuous listening
- No error occurred
- Connection is healthy
- Fresh TTS token obtained with new pipeline

### Restart with Delay (Errors)

After errors, we restart with backoff delay:
```javascript
case 'error':
  // ... error handling ...
  
  // Expected errors: immediate restart
  if (expectedErrors.indexOf(errorCode) !== -1) {
    this._restartPipeline(0);
  } else {
    // Unexpected errors: backoff delay
    this._restartPipeline(this._calculateRetryDelay());
  }
  break;
```

---

## Appendix W: Binary Handler ID Lifecycle

### What Is the Binary Handler ID?

The `stt_binary_handler_id` is a number assigned by Home Assistant that identifies where to route audio data. It's essentially an address for the audio stream.

### Lifecycle Stages

```
1. INVALID (null)     - No pipeline running
2. ASSIGNED (number)  - Pipeline started, received in run-start
3. ACTIVE (number)    - Sending audio data
4. INVALID (null)     - Pipeline ended or error
```

### Assignment (run-start)

```javascript
case 'run-start':
  // Extract binary handler ID from event data
  this._binaryHandlerId = eventData.runner_data.stt_binary_handler_id;
  console.log('[VoiceSatellite] Binary handler ID:', this._binaryHandlerId);
  
  // Now safe to start sending audio
  this._startSendingAudio();
  break;
```

### Using the Handler ID

```javascript
_sendBinaryAudio(pcmData) {
  // Guard: Don't send if no handler ID
  if (this._binaryHandlerId === null || this._binaryHandlerId === undefined) {
    return;
  }
  
  // Prepend handler ID as first byte
  var message = new Uint8Array(1 + pcmData.byteLength);
  message[0] = this._binaryHandlerId;
  message.set(new Uint8Array(pcmData), 1);
  
  // Send via WebSocket
  this._connection.socket.send(message.buffer);
}
```

### Invalidation

The handler ID becomes invalid and should be set to `null` when:

```javascript
// On run-end (normal completion)
case 'run-end':
  this._binaryHandlerId = null;
  break;

// On error
case 'error':
  this._binaryHandlerId = null;
  break;

// On manual stop
_stopPipeline() {
  this._binaryHandlerId = null;
  // ...
}

// On unsubscribe
if (this._unsubscribe) {
  this._binaryHandlerId = null;
  await this._unsubscribe();
}
```

### Why It Matters

Sending audio with an invalid or wrong handler ID:
- Audio gets dropped or routed incorrectly
- May cause errors in Home Assistant
- Won't be processed by STT

The guard in `_sendBinaryAudio` prevents sending when handler is invalid.

---

## Appendix X: AudioContext State Management

### AudioContext States

The Web Audio API `AudioContext` has three states:

| State | Meaning |
|-------|---------|
| `suspended` | Created but not running (mobile default) |
| `running` | Active and processing audio |
| `closed` | Permanently stopped |

### The Mobile Browser Problem

Mobile browsers create AudioContext in `suspended` state and require a user gesture to resume:

```javascript
var audioContext = new AudioContext();
console.log(audioContext.state);  // "suspended" on mobile
```

### Resuming AudioContext

```javascript
async _ensureAudioContextRunning() {
  if (!this._audioContext) {
    this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000
    });
  }
  
  if (this._audioContext.state === 'suspended') {
    console.log('[VoiceSatellite] Resuming suspended AudioContext');
    await this._audioContext.resume();
  }
  
  if (this._audioContext.state !== 'running') {
    throw new Error('AudioContext failed to start: ' + this._audioContext.state);
  }
}
```

### When to Resume

```javascript
async _startMicrophone() {
  // Resume AudioContext BEFORE getUserMedia
  await this._ensureAudioContextRunning();
  
  // Now safe to request microphone
  this._mediaStream = await navigator.mediaDevices.getUserMedia({...});
  
  // Connect to audio graph
  this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
  // ...
}
```

### User Gesture Trigger

The start button click provides the user gesture needed:

```javascript
_handleStartClick() {
  // This click IS the user gesture
  // AudioContext.resume() will now succeed
  this._startListening();
}
```

### State Change Monitoring

```javascript
this._audioContext.onstatechange = function() {
  console.log('[VoiceSatellite] AudioContext state:', self._audioContext.state);
  
  if (self._audioContext.state === 'suspended') {
    // Browser suspended our context (tab backgrounded on mobile)
    self._handleAudioContextSuspended();
  }
};
```

### iOS Safari Specifics

iOS Safari is particularly strict:
- AudioContext suspended on page load
- Re-suspended when tab backgrounded
- Must resume on EACH user interaction after background

```javascript
// iOS may need resume on visibility change
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && self._audioContext?.state === 'suspended') {
    // Try to resume, may fail without gesture
    self._audioContext.resume().catch(function() {
      // Show start button for user gesture
      self._showStartButton();
    });
  }
});
```

---

## Appendix Y: STT VAD Events

### What is VAD?

**Voice Activity Detection (VAD)** - The STT system's detection of when the user is speaking vs silence.

### VAD Events from Pipeline

```javascript
case 'stt-vad-start':
  // User started speaking (voice detected)
  console.log('[VoiceSatellite] VAD: Speech started');
  break;

case 'stt-vad-end':
  // User stopped speaking (silence detected)
  console.log('[VoiceSatellite] VAD: Speech ended');
  break;
```

### Event Sequence

```
wake_word-end      → Wake word detected
stt-start          → STT engine ready
stt-vad-start      → User voice detected ← VAD
stt-vad-end        → User stopped speaking ← VAD
stt-end            → Transcription complete
```

### Current Usage

In v1.11.0, VAD events are **logged but not acted upon**:

```javascript
case 'stt-vad-start':
  if (this._config.debug) {
    console.log('[VoiceSatellite] Event: stt-vad-start');
  }
  // No action taken
  break;

case 'stt-vad-end':
  if (this._config.debug) {
    console.log('[VoiceSatellite] Event: stt-vad-end');
  }
  // No action taken
  break;
```

### Potential Uses (Not Implemented)

VAD events could be used for:

1. **Visual feedback during speech**
   ```javascript
   case 'stt-vad-start':
     this._showSpeakingIndicator();
     break;
   case 'stt-vad-end':
     this._showProcessingIndicator();
     break;
   ```

2. **Audio ducking** (lower other audio while user speaks)

3. **Timeout extension** (reset timeout while user is speaking)

### Why Not Currently Used

- Adds visual complexity
- STT state already provides feedback via rainbow bar
- VAD timing can be imprecise with some STT engines

---

## Appendix Z: Response Text Extraction Path

### The Problem

Different conversation agents return response text in different JSON structures. The card must handle multiple formats.

### Standard Home Assistant Conversation Agent

```javascript
// intent-end event data structure
{
  intent_output: {
    response: {
      speech: {
        plain: {
          speech: "The living room light is now on"  // ← Target text
        }
      }
    }
  }
}
```

Extraction path:
```javascript
var text = eventData.intent_output?.response?.speech?.plain?.speech;
```

### OpenAI / ChatGPT Conversation Agent

Same structure (HA normalizes it):
```javascript
var text = eventData.intent_output?.response?.speech?.plain?.speech;
```

### Extended OpenAI Conversation (with extra data)

```javascript
{
  intent_output: {
    response: {
      speech: {
        plain: {
          speech: "Response text here",
          extra_data: null
        }
      },
      card: {},
      language: "en",
      response_type: "action_done"
    },
    conversation_id: "..."
  }
}
```

Still same extraction path.

### Robust Extraction Implementation

```javascript
_extractResponseText(eventData) {
  // Primary path (most conversation agents)
  var text = eventData.intent_output?.response?.speech?.plain?.speech;
  
  if (text) {
    return text;
  }
  
  // Fallback: Try alternate structures
  // Some agents might use different paths
  
  // Try direct speech object
  if (eventData.intent_output?.response?.speech?.speech) {
    return eventData.intent_output.response.speech.speech;
  }
  
  // Try plain text response
  if (eventData.intent_output?.response?.plain) {
    return eventData.intent_output.response.plain;
  }
  
  // Try raw response
  if (typeof eventData.intent_output?.response === 'string') {
    return eventData.intent_output.response;
  }
  
  // Give up
  console.warn('[VoiceSatellite] Could not extract response text from:', eventData);
  return null;
}
```

### Usage in Event Handler

```javascript
case 'intent-end':
  var responseText = this._extractResponseText(eventData);
  
  if (responseText) {
    this._showResponse(responseText);
  }
  
  this._playRequestSentChime();
  break;
```

### Handling Missing Response

Some intents don't produce speech (e.g., "never mind", "cancel"):

```javascript
if (responseText) {
  this._showResponse(responseText);
} else {
  // No response text - still continue normally
  // TTS may still play or may be empty
  console.log('[VoiceSatellite] No response text in intent-end');
}
```
