# Voice Satellite Card — Design Document

## 1. Overview

Voice Satellite Card is a custom Home Assistant Lovelace card that turns any browser into a full-featured voice satellite with feature parity with physical devices like the Home Assistant Voice Preview Edition. It captures microphone audio, routes it through the integration's `voice_satellite/run_pipeline` WebSocket subscription to Home Assistant's Assist pipeline, and plays back TTS responses — all without leaving the HA dashboard.

The source is organized as ES6 modules in `src/`, bundled via Webpack + Babel into a single `voice-satellite-card.js` for deployment. The card is invisible (`getCardSize() = 0`). All visual feedback is rendered via a global overlay appended to `document.body`, outside HA's Shadow DOM, so it persists across dashboard view changes.

**Architecture note:** The card routes ALL pipeline communication through the integration's `voice_satellite/run_pipeline` WebSocket subscription. There is no anonymous/standalone pipeline mode.

See [DESIGN-INTEGRATION.md](DESIGN-INTEGRATION.md) for the integration-side design.

---

## 2. High-Level Flow

1. The card acquires the browser microphone via `getUserMedia`.
2. Audio is captured via AudioWorklet (or ScriptProcessor fallback), resampled to 16 kHz mono PCM, and sent as binary WebSocket frames every 100 ms.
3. The integration's `voice_satellite/run_pipeline` subscription routes audio through the HA Assist pipeline (wake word → STT → intent → TTS) and relays events back to the card.
4. The card receives pipeline events, updates visual feedback (gradient bar, transcription/response bubbles), and plays the TTS audio.
5. When TTS playback begins, the pipeline is immediately restarted so it listens for the next wake word while audio plays (barge-in support). If the conversation agent signals `continue_conversation`, the card skips the wake word stage and restarts in STT mode for multi-turn dialogues.
6. The cycle repeats indefinitely.

### Integration Communication Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `voice_satellite/run_pipeline` | Card → Integration → Card | Bridged pipeline: card sends audio, receives pipeline events |
| `voice_satellite/subscribe_events` | Integration → Card | Push notifications: announcements, start_conversation, ask_question. Also drives entity availability — the integration marks the entity as unavailable when no subscriber is connected. |
| `voice_satellite/update_state` | Card → Integration | Sync card's pipeline state to the entity (idle/listening/processing/responding) |
| `voice_satellite/announce_finished` | Card → Integration | ACK that announcement playback completed (unblocks integration's `async_announce`) |
| `voice_satellite/question_answered` | Card → Integration | Submit STT transcription for hassil matching |
| `voice_satellite/cancel_timer` | Card → Integration | Cancel a specific timer by ID |
| `voice_satellite/media_player_event` | Card → Integration | Report media player playback state, volume, current media |
| `state_changed` (HA event bus) | Integration → Card | Timer state changes (active_timers attribute) |

---

## 3. Architecture

### 3.1 Module Structure

The codebase follows a **folder-per-feature** convention. Each feature folder has an `index.js` (the manager class) and helper files for events, comms, and UI. Shared utilities live in `shared/`.

```
voice-satellite-card-integration/
├── src/
│   ├── index.js                          ← Entry point, custom element registration
│   ├── constants.js                      ← State enum, DEFAULT_CONFIG, Timing, BlurReason, EXPECTED_ERRORS
│   ├── logger.js                         ← Shared Logger class
│   │
│   ├── card/                             ← Main card class + helpers
│   │   ├── index.js                      ← VoiceSatelliteCard (thin orchestrator)
│   │   ├── events.js                     ← State transitions, pipeline dispatch, TTS completion
│   │   ├── comms.js                      ← Satellite state sync (voice_satellite/update_state)
│   │   ├── ui.js                         ← UIManager (overlay, bar, blur, start button, chat, timer DOM)
│   │   ├── chat.js                       ← ChatManager (bubbles, streaming fade)
│   │   ├── double-tap.js                 ← DoubleTapHandler (cancel with touch dedup)
│   │   ├── entity-picker.js              ← Per-device satellite override (localStorage, picker overlay)
│   │   └── visibility.js                 ← VisibilityManager (tab pause/resume)
│   │
│   ├── audio/                            ← Audio capture + chimes + media playback + analysis
│   │   ├── index.js                      ← AudioManager (mic, worklet, send interval)
│   │   ├── analyser.js                   ← AnalyserManager (dual-analyser for reactive bar)
│   │   ├── processing.js                 ← AudioWorklet/ScriptProcessor setup, resample, buffer
│   │   ├── comms.js                      ← Binary WebSocket audio transmission
│   │   ├── chime.js                      ← Web Audio API chime generation (all chime patterns)
│   │   └── media-playback.js             ← HTML Audio element playback + URL normalization
│   │
│   ├── tts/                              ← TTS playback orchestration
│   │   ├── index.js                      ← TtsManager (browser/remote, streaming, chime facade)
│   │   └── comms.js                      ← Remote media_player service calls
│   │
│   ├── pipeline/                         ← Assist pipeline lifecycle
│   │   ├── index.js                      ← PipelineManager (start/stop/restart, mute polling, retry)
│   │   ├── events.js                     ← Pipeline event handlers (run-start through error)
│   │   └── comms.js                      ← subscribePipelineRun, setupReconnectListener
│   │
│   ├── timer/                            ← Timer countdown + alerts
│   │   ├── index.js                      ← TimerManager (timer state, alert lifecycle)
│   │   ├── events.js                     ← State change processing, dedup
│   │   ├── ui.js                         ← Timer pills, alert overlay, countdown tick
│   │   └── comms.js                      ← Timer cancel via voice_satellite/cancel_timer WS
│   │
│   ├── announcement/                     ← Simple announcements
│   │   └── index.js                      ← AnnouncementManager (chime → media → ACK → restart)
│   │
│   ├── ask-question/                     ← Ask question (STT capture + match feedback)
│   │   ├── index.js                      ← AskQuestionManager (prompt → STT → answer → feedback)
│   │   └── comms.js                      ← question_answered WS command
│   │
│   ├── media-player/                     ← Media player entity bridge
│   │   └── index.js                      ← MediaPlayerManager (playback, volume, state sync)
│   │
│   ├── start-conversation/               ← Start conversation (prompt → STT listening mode)
│   │   └── index.js                      ← StartConversationManager (prompt → restartContinue)
│   │
│   ├── skins/                            ← Skin definitions (CSS + config)
│   │   ├── index.js                      ← Skin registry (getSkin, getSkinOptions)
│   │   ├── default.js                    ← Default skin definition
│   │   ├── default.css                   ← Default skin styles
│   │   ├── default-preview.css           ← Default skin editor preview styles
│   │   ├── alexa.js                      ← Alexa skin definition
│   │   ├── alexa.css                     ← Alexa skin styles
│   │   ├── alexa-preview.css             ← Alexa skin editor preview styles
│   │   ├── google-home.js               ← Google Home skin definition
│   │   ├── google-home.css              ← Google Home skin styles
│   │   ├── google-home-preview.css      ← Google Home skin editor preview styles
│   │   ├── retro-terminal.js            ← Retro Terminal skin definition
│   │   ├── retro-terminal.css           ← Retro Terminal skin styles
│   │   └── retro-terminal-preview.css   ← Retro Terminal skin editor preview styles
│   │
│   ├── shared/                           ← Cross-feature utilities
│   │   ├── singleton.js                  ← Single-instance guarantee (window.__vsSingleton)
│   │   ├── satellite-subscription.js     ← WS subscription for integration-pushed events
│   │   ├── satellite-notification.js     ← Shared notification lifecycle (dispatch/queue/play/cleanup)
│   │   ├── satellite-state.js            ← Pure entity lookups (getSatelliteAttr, getSwitchState, getSelectEntityId, getNumberState)
│   │   ├── notification-comms.js         ← Shared ACK WebSocket call
│   │   ├── entity-subscription.js        ← HA state_changed subscription pattern
│   │   └── format.js                     ← Time + financial formatting utilities
│   │
│   └── editor/                           ← Config editor + preview
│       ├── index.js                      ← getConfigForm() schema assembler
│       ├── behavior.js                   ← satellite_entity, debug, mic processing
│       ├── skin.js                       ← Skin selector, reactive bar, text scale, opacity, custom CSS
│       ├── preview.js                    ← Static editor preview renderer
│       └── preview.css                   ← Editor preview styles
│
├── custom_components/voice_satellite/    ← Integration (see DESIGN-INTEGRATION.md)
├── scripts/
│   └── sync-version.js                  ← Syncs package.json version → manifest.json + const.py
├── webpack.config.js                     ← Webpack config (outputs to custom_components/.../frontend/)
├── babel.config.js
├── package.json                          ← Version source of truth
└── package-lock.json
```

### 3.2 Layering Principles

The codebase enforces strict separation of concerns:

1. **Pure helpers** (`shared/`) — No side effects, no state. Functions like `getSwitchState()`, `formatTime()`, `applyBubbleStyle()` are pure lookups or transformations.

2. **Comms modules** (`*/comms.js`) — WebSocket calls and HA service calls. No DOM, no state, no timers. Each function takes explicit parameters and returns results or fires callbacks. All comms files document "Uses ONLY public accessors on the card instance."

3. **Event modules** (`*/events.js`) — Transform pipeline/entity events into state changes and UI updates. Access manager state via the `mgr` parameter's public accessors. No WebSocket calls.

4. **Manager classes** (`*/index.js`) — Own feature-specific state, wire up subscriptions, delegate to event/comms/UI helpers. All managers receive the card instance via constructor injection.

5. **UIManager** (`card/ui.js`) — The **single owner** of all DOM manipulation. No other module creates, modifies, or removes DOM elements. Other modules request DOM changes through UIManager's public API (e.g., `addChatMessage()`, `showBlurOverlay()`, `syncTimerPills()`).

6. **Card orchestrator** (`card/index.js`) — Thin composition root. Creates all managers, exposes public accessors, delegates lifecycle methods. Contains no business logic.

### 3.3 Singleton Pattern

Only one card instance can own the microphone and pipeline at a time. This is critical because:
- A user may place the card on multiple dashboard views
- HA recreates the custom element when switching views
- HACS integrations like **card-mod** intercept card loading and create duplicate element instances (one for internal use, one for the DOM)
- Two active AudioContexts would conflict

The singleton state lives on `window.__vsSingleton` (module scope falls back to window namespace so multiple script loads share state):

```javascript
window.__vsSingleton = {
  instance: null,    // The owning card reference
  active: false,     // Whether any instance is active
  starting: false,   // Startup lock (prevents race conditions)
};
```

Key operations:
- `claim(card)` — called after successful mic + pipeline start
- `isOwner(card)` — returns true if no instance is active OR the given card is the owner
- `isActive()` — returns true only after `claim()` succeeds
- `isStarting()` / `setStarting(val)` — startup lock flag, prevents race conditions when multiple cards try to start simultaneously (e.g., view switch during startup)
- `propagateConfig(card)` — when a secondary card calls `setConfig()`, the config is forwarded to the active instance so live config changes take effect

**Gotcha:** Before `claim()`, `isOwner()` returns true for all cards (since `instance` is null). The `isActive()` check gates subscriptions so they only fire after a card has successfully started.

**Gotcha — card-mod duplicate instances:** Card-mod patches HA's `_loadElement` and creates two card instances. Instance #1 receives `setConfig` + `set hass` (and may start the pipeline) but never receives `connectedCallback`. Instance #2 is the DOM-attached element. The `VisibilityManager` ownership guard (`if (!this._card.isOwner) return`) prevents the non-owner instance's visibility handler from interfering with the active pipeline. Additionally, `visibility.setup()` is called from `startListening()` after `claim()` to guarantee the owner always has a visibility handler, even if `connectedCallback` never fired.

### 3.5 Logger (`logger.js`)

Centralized logging controlled by `config.debug`. All managers receive a reference to the shared Logger instance from the card.

- `log(category, msg, data?)` — Gated by `_debug` flag. Silent in production unless debug is enabled.
- `error(category, msg, data?)` — Always logs (not gated). Errors are never suppressed.
- Console output format: `[VS][category] message`
- The `debug` setter is updated by `setConfig()` whenever the config changes.

### 3.4 Global UI

The card renders nothing in its own Shadow DOM (just a hidden `<div>`). All visible UI lives in a single `#voice-satellite-ui` element appended to `document.body`:

```html
<div id="voice-satellite-ui">
  <div class="vs-blur-overlay"></div>
  <button class="vs-start-btn"><!-- SVG mic icon --></button>
  <div class="vs-chat-container"></div>
  <div class="vs-image-panel"><div class="vs-panel-scroll"></div></div>
  <div class="vs-lightbox">
    <img class="vs-lightbox-img" />
    <iframe class="vs-lightbox-iframe" frameborder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media;
             gyroscope; picture-in-picture; web-share"
      referrerpolicy="strict-origin-when-cross-origin"
      allowfullscreen></iframe>
  </div>
  <div class="vs-rainbow-bar"></div>
</div>
```

**Key containers:**
- `.vs-image-panel` — Fixed-position media panel (right side). Contains `.vs-panel-scroll` inner wrapper for scrollbar positioning. Holds image grids and video card grids.
- `.vs-lightbox` — Full-screen overlay for viewing full-size images or playing YouTube videos via iframe embed. Tap to dismiss.

Timer pills live in a separate `#voice-satellite-timers` container, also on `document.body`.

This design ensures the UI persists when the user navigates between dashboard views — HA destroys and recreates custom elements on navigation, but the global overlay remains.

---

## 4. Entry Point

`src/index.js` registers the custom element and announces the card to HA's card picker:

```javascript
customElements.define('voice-satellite-card', VoiceSatelliteCard);
window.customCards.push({ type: 'voice-satellite-card', ... });
```

A styled console log shows the card version on load (`__VERSION__` is injected at build time from `package.json` via Webpack's DefinePlugin).

---

## 5. Card Orchestrator (`card/index.js`)

`VoiceSatelliteCard` extends `HTMLElement` and composes 13 managers:

| Manager | Purpose |
|---------|---------|
| `AudioManager` | Microphone, AudioWorklet, send interval |
| `AnalyserManager` | Dual-analyser for reactive bar (mic + audio FFT) |
| `TtsManager` | TTS playback (browser + remote), chime facade |
| `MediaPlayerManager` | Media player entity bridge (volume, playback, state sync) |
| `PipelineManager` | Pipeline lifecycle (start/stop/restart/retry/mute) |
| `UIManager` | All DOM manipulation |
| `ChatManager` | Chat bubble state, streaming text fade |
| `DoubleTapHandler` | Double-tap to cancel interactions |
| `VisibilityManager` | Tab pause/resume |
| `TimerManager` | Timer entity subscription + pills + alerts |
| `AnnouncementManager` | Announcement playback + ACK |
| `AskQuestionManager` | Question → STT → answer → match feedback |
| `StartConversationManager` | Prompt → STT listening mode |

### 5.1 Lifecycle

**`connectedCallback()`** — Called when HA inserts the element:
1. Clears any pending disconnect timeout
2. Renders the hidden Shadow DOM container
3. If this is an editor preview, renders the static preview and returns
4. **Browser satellite override:** If `satellite_entity` is empty and `browser_satellite_override` is enabled, attempts `resolveEntity(hass)` to resolve from localStorage. If resolved, injects the entity and continues. Otherwise returns early (picker shows from `set hass`).
5. Ensures the global UI exists
6. Sets up visibility change listener
7. If no singleton is active and we have a connection, starts listening

**`disconnectedCallback()`** — Called when HA removes the element (e.g., view navigation):
1. If a picker overlay or deferred observer is pending (`_pickerTeardown`), cancels it and nulls the reference. This prevents a stale instance's deferred picker from firing after HA recreates the card.
2. Sets a 100ms grace period (`DISCONNECT_GRACE`) before tearing down. This prevents the pipeline from restarting when the user simply switches views.

**`set hass(hass)`** — Called by HA when state updates arrive:
1. Editor previews return immediately
2. If this is the active owner: updates TimerManager, checks remote TTS playback state (`tts.checkRemotePlayback`), and retries satellite subscription if needed
3. If not yet started:
   - **Browser satellite override:** If `satellite_entity` is empty and `browser_satellite_override` is enabled, attempts `resolveEntity(hass)`. If resolved, injects the entity. If not (and `hass.entities` is populated and no picker is already showing), calls `_showEntityPicker(hass)` and returns.
   - Acquires connection, ensures global UI, starts listening

**`setConfig(config)`** — Called when the user saves config in the editor:
1. Captures whether satellite_entity was previously empty
2. Resolves skin via `getSkin(config.skin)` → stored as `_activeSkin`
3. Merges config with defaults
4. Updates logger debug flag
5. **Browser satellite override:** If `browser_satellite_override` is enabled, localStorage takes full control — injects the stored entity if present, otherwise clears `satellite_entity` (so the startup path in `set hass` shows the picker). If override is disabled, clears localStorage via `clearStoredEntity()`.
6. Applies styles to the global UI (skin CSS injection, opacity, text scale, custom CSS)
7. Updates editor preview if in preview context
8. Propagates config to the active singleton instance
9. **Config reactivity:** If satellite_entity was just configured (empty → value), triggers startup without requiring a page reload

**Gotcha — Config reactivity:** When a user adds a satellite entity in the editor and saves, `set hass` may have already returned early (before `_hasStarted` is set) because `satellite_entity` was empty at the time. `setConfig` detects this transition and triggers startup directly.

**`_showEntityPicker(hass)`** — Shows the picker overlay (may be deferred if HA's editor dialog is blocking). On entity selection:
1. Displaces any stale singleton owner (stops its pipeline, mic, TTS, timers; tears down satellite subscription; releases singleton)
2. Injects the selected entity into config, sets `_isLocalStorageEntity = true`
3. Uses the current `this._hass` (falls back to captured `hass`) for the connection
4. Starts the pipeline via `startListening(this)`

### 5.2 Event Delegation

The card delegates all event handling to free functions in `card/events.js`:

- `setState(card, newState)` — Updates card state, triggers UIManager update, syncs state to integration (with barge-in guard: skips idle/listening sync while TTS is playing)
- `startListening(card)` — Claims singleton, starts mic + pipeline, subscribes to satellite events, sets up double-tap
- `handleStartClick(card)` — Ensures AudioContext on gesture, then calls `startListening`
- `onTTSComplete(card, playbackFailed)` — Handles post-TTS cleanup: continue conversation, done chime, clear UI, play queued notifications
- `handlePipelineMessage(card, message)` — Dispatches pipeline events by type to PipelineManager handlers (with guards for paused/restarting)

---

## 6. Audio System (`audio/`)

### 6.1 AudioManager

Manages the microphone lifecycle:

1. **Acquisition** — `startMicrophone()` creates an AudioContext (16 kHz requested), gets `getUserMedia` with configurable constraints (noise suppression, echo cancellation, auto gain control, voice isolation).

2. **Capture** — Tries AudioWorklet first (inline processor via Blob URL), falls back to ScriptProcessor (2048 buffer). Both push `Float32Array` chunks to `audioBuffer`.

3. **Send loop** — `startSending(binaryHandlerIdGetter)` starts a 100ms `setInterval` that:
   - Combines all buffered chunks into one `Float32Array`
   - Resamples to 16 kHz if the browser's actual sample rate differs (linear interpolation)
   - Converts to 16-bit PCM (`Int16Array`)
   - Sends as binary WebSocket frame with the handler ID byte prefix

4. **Pause/Resume** — On tab hide: disables audio tracks and stops sending. On tab show: flushes stale audio buffer, re-enables tracks, resumes AudioContext if suspended.

**Gotcha — AudioWorklet inline code:** The worklet processor is defined as an inline string, converted to a Blob URL, loaded as a module, then the URL is immediately revoked. This avoids CORS issues with external worklet files in HA's WebView.

### 6.2 Binary Audio Protocol

Audio is sent over the existing HA WebSocket connection as binary frames:

```
[handler_id: 1 byte][pcm_data: N bytes of Int16Array]
```

The `handler_id` byte is obtained from the init event of `voice_satellite/run_pipeline`. HA's WebSocket implementation routes the binary data to the registered handler.

### 6.3 Chime System

Five predefined chime patterns synthesized via Web Audio API oscillators:

| Chime | Pattern | Used For |
|-------|---------|----------|
| `CHIME_WAKE` | 3-note ascending sine (C5→E5→G5) | Wake word detected |
| `CHIME_DONE` | 2-note descending sine (G5→E5) | Interaction complete |
| `CHIME_ERROR` | 2-note descending square (quiet) | Error / unmatched answer |
| `CHIME_ANNOUNCE` | 2-note ding-dong sine (G5→D5) | Pre-announcement |
| `CHIME_ALERT` | 3-note rising sine (A5→E5→A5) | Timer finished (loops every 3s) |

Single-note chimes (`playChime`) use one oscillator with frequency steps. Multi-note chimes (`playMultiNoteChime`) create separate oscillators per note with individual envelopes.

Volume sourced from `card.mediaPlayer.volume` (perceptual curve applied), scaled to max 0.5 for single-note chimes and 0.25 for multi-note chimes. Error chime additionally reduced to 30%.

### 6.4 AnalyserManager (`audio/analyser.js`)

Provides real-time audio level data for reactive bar animations via two separate AnalyserNodes — a **mic analyser** and an **audio analyser** — to structurally prevent open-mic feedback loops.

**Problem:** A single AnalyserNode architecture routes audio through `createMediaElementSource` → analyser → `AudioContext.destination`. If the mic source is also connected to the same analyser, the mic signal gains a path to the speakers through the Web Audio graph, creating a feedback loop on devices without hardware echo cancellation.

**Solution — Dual-analyser architecture:**

```
Mic path:    getUserMedia → sourceNode → _micAnalyser  (dead end — no destination)
Audio path:  <audio> → createMediaElementSource → _audioAnalyser → destination (speakers)
```

- `_micAnalyser` — Connected to the mic source node but **never** connected to `AudioContext.destination`. It only provides FFT data for the reactive bar. Feedback is structurally impossible because there is no audio path from mic to speakers through this node.
- `_audioAnalyser` — Routes TTS/notification audio through to `destination` for playback. Connected only during active audio playback via `attachAudio()`.
- `_activeAnalyser` — Pointer that determines which node `_tick()` reads FFT data from. Defaults to mic; switches to audio during playback; reverts to mic when audio detaches.

**Key methods:**
- `attachMic(sourceNode, audioContext)` — One-time setup: creates `_micAnalyser`, connects mic source. Sets as active if no audio is playing.
- `attachAudio(audioEl, audioContext)` — Creates `_audioAnalyser`, routes `<audio>` element through it to destination. Switches `_activeAnalyser` to audio.
- `detachAudio()` — Disconnects audio routing, reverts `_activeAnalyser` to mic.
- `reconnectMic()` — Switches `_activeAnalyser` back to mic. **No-op guard:** Skips if `_mediaSourceNode` is still set, preventing mid-playback switches (e.g., `updateForState` fires for TTS state).
- `start(barEl)` / `stop()` — Start/stop the `requestAnimationFrame` tick loop that writes `--vs-audio-level` CSS variable (RMS volume, 0–1 range, 2× boost for visual responsiveness).

### 6.5 Media Playback

`media-playback.js` provides two utilities:
- `buildMediaUrl(path)` — Normalizes a URL path: full URLs pass through, root-relative paths are prefixed with `window.location.origin`
- `playMediaUrl(url, volume, callbacks)` — Creates an `<audio>` element, wires `onended`/`onerror` callbacks, returns the element for external stop

---

## 7. TTS Playback (`tts/`)

### 7.1 TtsManager

Handles two playback targets:

**Browser playback** — Creates an HTML Audio element via `playMediaUrl()`. Includes a stall-detection watchdog (`setInterval`) that monitors `audio.currentTime` progression. If the audio stops advancing between intervals, playback is force-completed (workaround for HA Companion App WebView quirks). Unlike a fixed timeout, this supports TTS responses of any length.

**Remote playback** — Calls `media_player.play_media` on the configured `tts_target` entity (resolved from the integration's TTS Output select entity via `getSelectEntityId`). Completion is detected by monitoring the remote entity's state via `checkRemotePlayback()`, which is called from the card's `set hass()` on every state update. The method tracks a `_remoteSawPlaying` flag — only completes after the entity has been in `playing`/`buffering` state first (avoids false triggers during the startup delay). A 120-second safety timeout (`REMOTE_SAFETY_TIMEOUT`) forces completion if state monitoring never fires.

### 7.2 Streaming TTS

If the pipeline's `run-start` event includes `tts_output.stream_response: true`, the TTS URL is stored. When `intent-progress` fires with `tts_start_streaming: true`, playback begins immediately — before the full TTS audio is generated. This reduces perceived latency. No pipeline restart at this point — text chunks are still arriving.

### 7.3 Chime Facade

`TtsManager.playChime(type)` maps `'wake'`/`'error'`/`'done'` to the corresponding chime pattern and delegates to `audio/chime.js`. This keeps chime logic centralized while letting all code paths call `tts.playChime()`.

### 7.4 Streaming Token Refresh

HA's TTS proxy pre-allocates a streaming token at `run-start` (in `tts_output.url`). The server-side cache evicts tokens based on creation time (not TTS generation time), with a TTL of ~5-10 minutes. If the user doesn't trigger a wake word for longer than the TTL, the token expires and TTS playback fails with a 404/NotSupportedError. The `tts-end` URL uses the **same** token — there is no fresh URL available from that pipeline run.

**Workaround:** PipelineManager starts a `TOKEN_REFRESH_INTERVAL` (4 minute) timer on every `run-start` when a streaming URL is present. If the timer fires and the card is still in LISTENING state (idle wake-word detection), it calls `restart(0)` to get a fresh pipeline subscription with a new token. The ~200ms restart gap during idle listening is imperceptible. The timer is cleared on `wake_word-end` (interaction started) and `stop()` (pipeline torn down).

See also: [home-assistant/core#159262](https://github.com/home-assistant/core/issues/159262)

### 7.5 Video Playback TTS Suppression

When a video is playing in the lightbox (`card._videoPlaying === true`), TTS audio is suppressed at both play sites in the pipeline event handlers. See §16A.9 for the full `_videoPlaying` flag design.

### 7.6 TTS Retry Mechanism

On browser playback failure, the TTS manager retries once using the stored `tts-end` URL:

1. `handleTtsEnd` stores the tts-end URL via `tts.storeTtsEndUrl(url)` before calling `tts.play(url)`
2. If `play()` encounters an error and `isRetry` is false, it tries the stored `_pendingTtsEndUrl`
3. On successful playback start (`onStart`), the pending URL is cleared
4. If the retry also fails, `_onComplete(true)` is called (playback failed path)

This covers transient failures where the TTS proxy token wasn't ready yet at the time of the first attempt.

### 7.7 TTS Stop Safety

When stopping TTS playback (`tts.stop()`), `onended` and `onerror` handlers are nulled BEFORE calling `pause()`. Otherwise the pause triggers `onended`, which calls `_onComplete()`, which can trigger continue-conversation or cleanup incorrectly (ghost events).

---

## 7A. Media Player (`media-player/`)

### 7A.1 MediaPlayerManager

Bridges the integration's `media_player` entity to the browser. The integration pushes media commands via the satellite event subscription; the card plays audio and reports state back via a dedicated WS command.

**Commands received** (via `dispatchSatelliteEvent` → `handleCommand`):

| Command | Action |
|---------|--------|
| `play` | Stop current playback, sign relative URLs via `auth/sign_path`, play via `playMediaUrl()` |
| `pause` | Pause HTML Audio element |
| `resume` | Resume paused audio |
| `stop` | Stop and clean up audio |
| `volume_set` | Update volume, apply to all active audio (own + TTS + notification) |
| `volume_mute` | Mute/unmute, apply to all active audio |

**State reporting** — `_reportState(state)` sends playback state back to the integration via `voice_satellite/media_player_event`:

```json
{
  "type": "voice_satellite/media_player_event",
  "entity_id": "media_player.kitchen_tablet_media_player",
  "state": "playing",
  "volume": 0.75,
  "media_id": "/api/tts_proxy/abc123.mp3"
}
```

### 7A.2 Unified Audio State Tracking

The media player entity reflects ALL audio output from the satellite, not just direct `play_media` calls. This matches Voice PE behavior where the media player shows "Playing" during chimes, TTS, and announcements.

**Mechanism:** `_activeSources` (a `Set`) tracks active audio sources by name (`'tts'`, `'chime'`, `'notification'`, `'announce-chime'`). Callers use:

- `notifyAudioStart(source)` — Adds source, reports "playing"
- `notifyAudioEnd(source)` — Removes source. When no sources remain (and no own playback is active), reports "idle" after a 200ms debounce

The debounce prevents flickering during rapid audio transitions (e.g., chime → TTS gap).

**Integration points:**
- TTS: `onStart` → `notifyAudioStart('tts')`, `stop()`/`_onComplete()` → `notifyAudioEnd('tts')`
- Chimes: `playChime()` → `notifyAudioStart('chime')`, setTimeout → `notifyAudioEnd('chime')`
- Notifications: playback `onStart` → `notifyAudioStart('notification')`, `onEnd`/`onError` → `notifyAudioEnd('notification')`
- Announce chime: `onStart` → `notifyAudioStart('announce-chime')`, `onEnd`/`onError` → `notifyAudioEnd('announce-chime')`

### 7A.3 Unified Volume

All audio uses `card.mediaPlayer.volume` instead of per-feature config sliders. The `volume` getter applies a perceptual quadratic curve (`volume²`) so the HA slider feels linear to human ears.

**Initial sync:** On first access after page load, `_syncInitialVolume()` reads `hass.states[entityId].attributes.volume_level` and `is_volume_muted` from the HA entity state. This is gated by a `_volumeSynced` flag so it runs exactly once.

**Real-time updates:** When `volume_set` or `volume_mute` commands arrive, `_applyVolumeToExternalAudio()` reaches into active TTS and notification `Audio` elements to update their volume immediately:

```javascript
_applyVolumeToExternalAudio(vol) {
  const ttsAudio = this._card.tts?._currentAudio;
  if (ttsAudio) ttsAudio.volume = vol;
  for (const mgr of [this._card.announcement, this._card.askQuestion, this._card.startConversation]) {
    if (mgr?.currentAudio) mgr.currentAudio.volume = vol;
  }
}
```

### 7A.4 Entity Lookup

`_getEntityId()` finds the `media_player.*` entity on the same device as the satellite entity. Uses the same `hass.entities` device lookup pattern as `getSwitchState()` — searches for a `media_player.*` entity with matching `device_id` and `platform === 'voice_satellite'`.

### 7A.5 Barge-In

`interrupt()` stops any active media player playback when the wake word is detected or a notification starts playing. Only affects own playback (play/pause/resume commands) — external audio sources (TTS, chimes) manage their own lifecycle.

---

## 8. Pipeline System (`pipeline/`)

### 8.1 PipelineManager

The pipeline manager handles the full lifecycle of the bridged pipeline:

**Starting (`start()`):**
1. Checks mute state — if the mute switch is on, shows error bar and polls every 2 seconds until unmuted
2. Cleans up any previous subscription
3. Sets up the reconnect listener
4. Subscribes to `voice_satellite/run_pipeline` via the integration
5. Waits for the synthetic `init` event that carries the binary handler ID
6. Discards stale audio buffer (prevents chime residue from reaching VAD)
7. Starts audio sending

**Stopping (`stop()`):**
- Stops audio sending, clears mute poll timer, unsubscribes from the pipeline

**Restarting (`restart(delay)`):**
- Guards against concurrent restarts via `_isRestarting` flag
- Stops, waits `delay` ms, then starts again
- On start failure: shows error bar, sets `serviceUnavailable`, retries with backoff

**Continue conversation (`restartContinue(conversationId, opts)`):**
- Stops and restarts with `start_stage: 'stt'` (skipping wake word)
- Optionally sets `askQuestionCallback` for STT-only mode
- Optionally passes `extra_system_prompt` for start_conversation

### 8.2 Mute Polling

When the mute switch is on, the pipeline doesn't start. Instead, `start()` shows an error bar and schedules a retry every 2 seconds:

```javascript
if (getSwitchState(hass, entity, 'mute') === true) {
  this._muteCheckId = setTimeout(() => this.start(), MUTE_POLL_INTERVAL);
  return;
}
```

When the mute switch is turned off, the next poll starts the pipeline normally.

### 8.3 Stale Event Filtering

The bridged pipeline can receive events from a previous pipeline run that hasn't fully torn down on the server. The manager uses three flags to filter stale events:

- `_runStartReceived` — Set to `true` on `run-start`. All events before the first `run-start` for a given subscription are ignored.
- `_wakeWordPhase` — Set `true` on `wake_word-start`, `false` on valid `wake_word-end`. A `run-end` during wake word phase (without error) triggers an automatic pipeline restart (see §8.8).
- `_errorReceived` — Set `true` on `error`. Allows `run-end` to proceed with normal cleanup during wake word phase if an error preceded it.

**Gotcha — Empty wake_word-end:** When the pipeline is stopped/restarted, the server sends a `wake_word-end` with empty `wake_word_output`. This is not a real wake word detection — the manager ignores it to avoid entering a retry loop.

### 8.4 Retry Backoff

On failure, `calculateRetryDelay()` uses linear backoff:
- `delay = min(RETRY_BASE_DELAY × retryCount, MAX_RETRY_DELAY)`
- Base: 5000ms, max: 30000ms
- Reset on successful `wake_word-start` or reconnection

### 8.5 Pipeline Events

Events flow from `voice_satellite/run_pipeline` → `card.onPipelineMessage()` → `handlePipelineMessage()` → individual handlers on PipelineManager:

| Event | Handler | Action |
|-------|---------|--------|
| `run-start` | `handleRunStart` | Store streaming TTS URL, set state (LISTENING or STT for continue), start token refresh timer |
| `wake_word-start` | `handleWakeWordStart` | Track recovery from service unavailable |
| `wake_word-end` | `handleWakeWordEnd` | Clear token refresh timer, play wake chime (if enabled), show blur, enter WAKE_WORD_DETECTED |
| `stt-start` | (inline) | Set state STT |
| `stt-end` | `handleSttEnd` | Show transcription bubble, invoke askQuestionCallback if set |
| `intent-start` | (inline) | Set state INTENT |
| `intent-progress` | `handleIntentProgress` | Stream response text, start streaming TTS, route `tool_result` (image/video/web search, Wikipedia, weather — §16A) |
| `intent-end` | `handleIntentEnd` | Show final response, handle continue_conversation, handle errors |
| `tts-start` | (inline) | Set state TTS |
| `tts-end` | `handleTtsEnd` | Play TTS audio (if not already streaming), restart pipeline |
| `run-end` | `handleRunEnd` | During wake_word phase (no error): restart pipeline immediately (§8.8). Otherwise: clean up, restart (or defer if TTS playing) |
| `error` | `handleError` | Expected errors: restart silently. Unexpected: error bar + backoff retry |

### 8.6 Wake Sound Switch

Before playing the wake chime, `handleWakeWordEnd` checks the integration's `wake_sound` switch via `getSwitchState()`. This function looks up the switch entity through HA's entity registry (finding the switch with `translation_key: 'wake_sound'` on the same device as the satellite entity).

The done chime after TTS playback follows the same pattern.

**Chime audio muting:** Echo cancellation isn't perfect on all devices, so chime audio can leak into the microphone and be misinterpreted by VAD as speech — causing VAD to close STT prematurely. Two complementary protections exist:

1. **Active-pipeline chime guard** (`handleWakeWordEnd`): Stops sending audio before playing the wake chime, resumes after chime duration + 50ms, and flushes the buffer on resume. This covers chimes that play while the pipeline is actively streaming audio to the server.

2. **Pipeline-start buffer discard** (`start()`): Clears the audio buffer immediately before `startSending()` on every pipeline start. The mic worklet keeps buffering audio even when no pipeline is active, so stale audio (including chime residue from ask_question/start_conversation flows) would otherwise be sent to the server as soon as the new pipeline begins. This covers chimes that play *between* pipeline runs (e.g., the wake chime in `_enterSttMode` before `restartContinue`).

**Gotcha — getSwitchState lookup:** The function uses `hass.entities` (HA frontend entity registry cache) to find sibling switch entities by `device_id` + `translation_key`. This is more reliable than reading `extra_state_attributes` on the satellite entity, which can be stale if the state_changed listener wasn't set up in time.

### 8.7 Deferred Run-End

When `run-end` arrives while TTS is playing, `pendingRunEnd = true`. The cleanup is deferred. When `onTTSComplete()` eventually fires, it handles the full cleanup. `finishRunEnd()` clears chat, hides blur, sets state to IDLE, then restarts pipeline (unless `serviceUnavailable` is true, in which case retry is already scheduled).

**Linger/video guard:** `finishRunEnd()` also defers cleanup when a linger timeout is active (`_imageLingerTimeout`), a video is playing (`_videoPlaying`), or the lightbox is visible (`isLightboxVisible()`). In these cases it skips chat/blur/state cleanup and only restarts the pipeline, letting the linger timeout or user dismissal handle the UI teardown.

### 8.8 Wake-Phase Run-End Restart

When `run-end` arrives during the wake_word phase without a preceding error, the pipeline is restarted immediately via `restart(0)` instead of proceeding with normal cleanup.

This handles a post-reboot race condition: after HA reconnects, the HA frontend WebSocket library auto-replays active subscriptions (including `run_pipeline`). The card's explicit reconnect handler also creates a new pipeline after a 2-second delay. The replayed pipeline starts first, but the card's restart kills it and creates a second pipeline. The server-side pipeline may genuinely end during wake_word detection (e.g., the audio stream ends due to reconnect timing), sending a valid `run-end`. Rather than ignoring this as "stale", the card restarts the pipeline to ensure continuous wake word listening.

If the `run-end` during wake_word phase was preceded by an error (`_errorReceived` is true), normal cleanup and error handling proceed instead.

### 8.9 Streaming Token Refresh Timer

Prevents stale TTS streaming tokens by periodically restarting the pipeline during idle wake-word listening (see §7.4 for root cause).

**Lifecycle:**
- **Started** in `handleRunStart` after storing the streaming URL — only if a streaming URL was allocated
- **Cleared** in `handleWakeWordEnd` (user interaction started — no longer idle)
- **Cleared** in `stop()` (pipeline torn down)
- **Fires** after `TOKEN_REFRESH_INTERVAL` (4 minutes) — only executes `restart(0)` if `currentState === LISTENING`, ensuring it never interrupts active interactions, continue-conversation, ask-question, or TTS playback

---

## 9. Timer System (`timer/`)

### 9.1 TimerManager

Timers are managed server-side by HA's intent system. The integration registers as a timer handler; HA routes `HassStartTimer`/`HassUpdateTimer`/`HassCancelTimer` intents to it. The integration stores active timers in the satellite entity's `active_timers` attribute.

The card watches the satellite entity's state via `subscribeToEntity()` (HA's `state_changed` event bus). When the `active_timers` attribute changes:

1. **processStateChange** — JSON-based dedup prevents duplicate processing. Compares current timer IDs with known IDs to detect additions and removals.
2. **syncTimers** — Creates/updates timer objects with server-side `started_at` (epoch seconds) for accurate elapsed time calculation.
3. **Tick** — A 1-second `setInterval` updates `secondsLeft` for each timer and refreshes pill displays.
4. **Alert** — When timers are removed with `last_timer_event: "finished"`, shows a full-screen alert with looping chime.

### 9.2 Timer Cancellation

Timers can be cancelled two ways:
- **Voice:** "Cancel the timer" → HA's intent system processes it normally
- **Double-tap:** Double-tapping a timer pill sends `voice_satellite/cancel_timer` to the integration, which calls `timer_manager.cancel_timer(timer_id)` on HA's intent system. The pill is removed immediately (optimistic UI) while the server-side cancel propagates. A "done" chime plays as audio confirmation.

Timer alert dismissal (double-tap on alert overlay) also plays a "done" chime before clearing the alert.

### 9.3 Timer UI

Timer pills render in a separate `#voice-satellite-timers` container positioned based on `timer_position` config (top-left, top-right, bottom-left, bottom-right). Each pill shows:
- Timer icon (⏱)
- Countdown in HH:MM:SS format
- Progress bar (percentage of total time remaining)

Timer alert: Full-screen overlay centered on viewport, repeating `CHIME_ALERT` every 3 seconds, with blur overlay (`BlurReason.TIMER`). Auto-dismiss after `timer_finished_duration` seconds (0 = manual dismiss only via double-tap).

---

## 10. Notification System

Three notification features share a common lifecycle defined in `shared/satellite-notification.js`:

### 10.1 Event Flow

1. **Integration pushes event** via `voice_satellite/subscribe_events` subscription
2. **`dispatchSatelliteEvent()`** routes to the correct manager based on type/flags:
   - `type === "media_player"` → MediaPlayerManager (early return, no `id` field required)
   - `ask_question: true` → AskQuestionManager
   - `start_conversation: true` or `type === "start_conversation"` → StartConversationManager
   - Otherwise → AnnouncementManager
3. **Pipeline-busy queuing** — If the card is in an active interaction or TTS is playing, the notification is queued. Queued notifications play after `onTTSComplete()` calls `playQueued()`.
4. **Hidden-tab queuing** — If the tab is hidden, events are queued and replayed when the tab becomes visible. Only the latest event is kept.
5. **Dedup** — Monotonic announce IDs prevent duplicate processing.

### 10.2 Playback Orchestration (`playNotification`)

All three managers use the same playback flow:

1. Show blur overlay (`BlurReason.ANNOUNCEMENT`)
2. Show rainbow bar in speaking mode
3. Set announcement mode for passive notifications (centers chat container on viewport)
4. Play pre-announcement chime (or custom media if `preannounce_media_id` provided)
5. Show message as chat bubble (passive: `'announcement'` type centered; interactive: `'assistant'` type follows chat layout)
6. Play main media
7. Call manager-specific `_onComplete` handler

### 10.3 AnnouncementManager

After playback:
1. ACK to integration (`announce_finished`)
2. Restart pipeline (HA cancels the running pipeline when triggering announcements)
3. After configurable delay (`announcementDisplayDuration` — from integration number entity, default 3.5s): clear UI, then either play done chime or play queued notification

**Queued notification priority:** If a notification is queued when the display timer fires, the done chime is skipped and the queued notification plays immediately (it has its own announce chime). Playing the done chime (Web Audio oscillator) concurrently with the announce chime (HTML Audio MP3) causes audio distortion in HA Companion App WebView.

### 10.4 StartConversationManager

After playback:
1. ACK to integration
2. Clear announcement UI
3. Show pipeline blur overlay
4. `restartContinue(null, { extra_system_prompt })` — Restarts pipeline in STT mode, skipping wake word, with the automation's system prompt

### 10.5 AskQuestionManager

After playback:
1. ACK to integration (signals question was played)
2. Switch from centered announcement mode to interactive mode
3. Play wake chime (delayed 500ms for chime settle — prevents false VAD trigger from mic picking up the chime)
4. `restartContinue(null, { end_stage: 'stt', onSttEnd })` — STT-only pipeline
5. On STT result: send answer via `voice_satellite/question_answered`
6. Integration matches against hassil templates, returns `{ matched, id }`
7. Play done chime (matched) or error chime + flash bar (unmatched)
8. Cleanup with safety timeouts

**Cancel flow:** `cancel()` handles mid-flow cancellation (triggered by double-tap or tab hide):
- Clears all pending timeouts (chime settle, STT safety, cleanup)
- Sends empty answer to release the integration's server-side `_question_event`
- Hides the ANNOUNCEMENT blur overlay

**STT safety timeout:** If the STT pipeline never produces a result (timeout, error, etc.), a 30-second safety timer sends an empty answer to release the integration's blocking event. The `_answerSent` flag prevents double-submission.

---

## 11. Satellite Subscription (`shared/satellite-subscription.js`)

A single WebSocket subscription to `voice_satellite/subscribe_events` delivers all notification events:

```javascript
connection.subscribeMessage(onEvent, {
  type: 'voice_satellite/subscribe_events',
  entity_id: config.satellite_entity,
});
```

The subscription is:
- **Idempotent** — No-op if already subscribed
- **Owner-only** — Only the singleton owner subscribes
- **Reconnect-aware** — Re-subscribes on the connection's `ready` event
- **Refreshable** — `refreshSatelliteSubscription()` tears down and re-establishes (called on tab resume to recover from stale connections)
- **Retry with backoff** — If subscription fails (e.g., integration entities not yet loaded after HA reboot), retries with exponential backoff: 2s, 4s, 8s, 16s, 30s (capped). Retry state is reset on successful subscription or full cleanup.

---

## 12. Entity Subscription (`shared/entity-subscription.js`)

A reusable pattern for watching HA entity state changes. Used by TimerManager to monitor `active_timers`:

```javascript
subscribeToEntity(manager, connection, entityId, onAttrs, logTag);
```

Features:
- Subscribes to `state_changed` events filtered by entity_id
- Performs immediate state check on subscribe (catches existing state)
- Re-subscribes on connection `ready` event
- Cleanup via `unsubscribeEntity(manager)`

---

## 13. Satellite State Helpers (`shared/satellite-state.js`)

Four pure lookup functions used across all managers. All follow the same pattern: find a sibling entity on the same device via `hass.entities` (frontend entity registry cache) matching `device_id` + `platform === 'voice_satellite'` + `translation_key`.

### `getSatelliteAttr(hass, entityId, name)`
Reads an attribute from the satellite entity's HA state cache.

### `getSwitchState(hass, satelliteId, translationKey)`
Reads a sibling switch entity's state. The lookup strategy:
1. **Primary:** Search `hass.entities` for a switch with matching `device_id` and `translation_key` on the `voice_satellite` platform. Read its state from `hass.states`.
2. **Fallback:** Read `extra_state_attributes` on the satellite entity (may be stale).

Used for:
- `mute` switch — Blocks pipeline start when on
- `wake_sound` switch — Controls chime playback (wake, done chimes)

### `getSelectEntityId(hass, satelliteId, translationKey)`
Reads a sibling select entity's `entity_id` attribute (the selected option value). Used to resolve the TTS Output select to a `media_player.*` entity ID.

### `getNumberState(hass, satelliteId, translationKey, defaultValue)`
Reads a sibling number entity's numeric state. Parses `hass.states[eid].state` as float, returns `defaultValue` if not found or NaN. Used for announcement display duration.

---

## 14. Visibility Management (`card/visibility.js`)

Handles browser tab show/hide transitions.

**Ownership guard:** Only the singleton owner handles visibility events (`if (!this._card.isOwner) return`). Non-owner instances (e.g., card-mod duplicates) are silently ignored.

**Idempotent setup:** `setup()` checks `this._handler` before registering to prevent double-registration. Called from both `connectedCallback` (for DOM-attached instances) and `startListening` after `claim()` (for the owner instance that may never receive `connectedCallback`).

**`teardown()`** — Removes the visibility change listener, clears the debounce timer, and resets `_isPaused`. Used during full lifecycle resets (e.g., entity picker re-selection).

### Tab Hidden
1. Cancel any in-progress ask_question flow (prevents cleanup timers firing after resume)
2. If in an active interaction OR media is lingering: clear image linger timeout, clear chat, hide blur, clear continue state, stop TTS
3. After 500ms debounce: set state PAUSED, disable audio tracks

**Linger detection:** During the image/video linger phase (30s timeout after TTS completes), the card state is `LISTENING` — not in `INTERACTING_STATES`. The visibility handler must independently check for lingering UI:

```javascript
const isLingering = this._card._imageLingerTimeout
  || this._card.ui.hasVisibleImages()
  || this._card.ui.isLightboxVisible();
```

The `isLingering` check is evaluated alongside `isInteracting`. If either is true, the full UI cleanup runs (clear linger timeout, clear chat, hide blur, stop TTS).

**Gotcha — No `pipeline.stop()` on hide:** Calling `stop()` creates a race condition where the server is still cancelling the old pipeline when `resume()` starts a new one, causing `async_accept_pipeline_from_satellite()` to silently fail. The `restart(0)` call in `_resume()` handles the properly sequenced stop→start.

### Tab Visible
1. Cancel pending restart timeouts via `resetForResume()` BEFORE yielding to the event loop (prevents throttled background-tab `setTimeout` from racing with resume)
2. Resume AudioContext (browser suspends it in background)
3. Clear `_isPaused` flag synchronously (no stale events can slip through the gap)
4. If a satellite event was queued while hidden: let the replayed event's flow manage the pipeline
5. Otherwise: refresh satellite subscription and restart pipeline

**Pipeline generation counter:** `stop()` increments `_pipelineGen`; `start()` captures the current gen and checks after each `await`. If a stale `start()` (from a throttled background-tab timeout) detects a gen mismatch, it aborts without clobbering the current subscription.

---

## 14A. Entity Picker (`card/entity-picker.js`)

Self-contained module for the per-device satellite override feature. Handles localStorage CRUD, entity discovery, HA dialog detection, and the picker overlay UI.

### Purpose

When multiple wall-mounted tablets share a single dashboard, each device needs to use a different satellite entity. The `browser_satellite_override` config option enables per-device entity selection via a browser popup, with the choice persisted in localStorage.

### localStorage CRUD

- **Key:** `vs-satellite-entity`
- `getStoredEntity()` → reads from localStorage, returns `string | null`. Catches exceptions for private browsing.
- `setStoredEntity(entityId)` → saves to localStorage.
- `clearStoredEntity()` → removes from localStorage. Called when `browser_satellite_override` is disabled in `setConfig()`.

### Entity Discovery

`discoverSatelliteEntities(hass)` — Filters `hass.entities` for entries where `platform === 'voice_satellite'` AND `entityId.startsWith('assist_satellite.')`. Returns `[{entity_id, friendly_name}]` sorted alphabetically by name. Friendly names are read from `hass.states[entityId].attributes.friendly_name`.

### Entity Resolution

`resolveEntity(hass)` — Resolution chain:
1. Check localStorage → validate entity still exists in `hass.entities` → return if valid, clear if stale
2. Auto-select if exactly one satellite entity exists (saves to localStorage, returns immediately — no picker shown)
3. Return `null` (caller should show picker)

### HA Dialog Detection

When HA's card editor dialog is open, it uses `<dialog>.showModal()` which puts the editor in the browser's **top layer**. This makes everything else in the document non-interactive regardless of z-index. HA also sets `inert` on `<home-assistant-main>` within its shadow DOM.

Two helper functions handle this:

- `isHADialogBlocking()` — Checks if `<home-assistant-main>` inside `<home-assistant>`'s shadow root has the `inert` attribute. Returns `true` when any HA modal dialog is open.
- `waitForDialogClose(callback)` — Sets up a `MutationObserver` watching for the `inert` attribute to be removed from `<home-assistant-main>`. Calls the callback when the dialog closes. Returns the observer (for cleanup).

### Picker Overlay

`showPicker(hass, onSelect)` — Entry point. Returns a teardown function.

**Deferred mode:** If `isHADialogBlocking()` is true, the picker is deferred via `waitForDialogClose()`. The returned teardown cancels the pending observer. When the dialog closes, the observer fires and `doShowPicker()` is called. The teardown function handles both states (pending observer OR active overlay).

**Immediate mode:** If no dialog is blocking, calls `doShowPicker()` directly.

`doShowPicker(hass, onSelect)` — Creates the overlay:
1. Injects picker styles into `document.head` (once, cached via `pickerStyleEl`)
2. Creates a fullscreen `div.vs-picker-overlay` appended to `document.body`
3. Builds entity list from `discoverSatelliteEntities(hass)` as `<button>` elements
4. If no entities found, shows "No voice satellites found" message
5. Click handler: matches `.vs-picker-item` → saves to localStorage → removes overlay → calls `onSelect(entityId)`

### Styling

The picker uses HA theme CSS variables with dark fallbacks, so it automatically matches the user's light/dark theme:

| Element | Variable | Fallback |
|---------|----------|----------|
| Card background | `--ha-card-background` / `--card-background-color` | `#1c1c1e` |
| Card border radius | `--ha-card-border-radius` | `16px` |
| Card shadow | `--ha-card-box-shadow` | `0 8px 32px rgba(0,0,0,0.5)` |
| Title/item text | `--primary-text-color` | `#fff` |
| Subtitle/empty text | `--secondary-text-color` | `#999` |
| Item background | `--secondary-background-color` | `#2c2c2e` |
| Item border / hover | `--divider-color` | `#3a3a3c` |
| Active border accent | `--primary-color` | `#48484a` |
| Font family | `--ha-font-family` | system font stack |

The overlay uses `position: fixed; inset: 0; z-index: 2147483647` with a blurred dark backdrop.

### Singleton Displacement

When the picker callback fires after a user selection, the card's `_showEntityPicker` method checks if a stale singleton owner exists (e.g., a previous card instance that HA destroyed during editor close). If so, it performs a full teardown on the stale owner via `window.__vsSingleton.instance`:
- `pipeline.stop()`, `audio.stopMicrophone()`, `tts.stop()`, `timer.destroy()`
- `teardownSatelliteSubscription()`
- `singleton.release()`

This prevents duplicate pipelines and allows the new instance to claim singleton ownership.

---

## 15. Double-Tap / Escape Handler (`card/double-tap.js`)

Listens on `document` for touch/click events and keyboard events. On double-tap (within 400ms threshold) **or** Escape key press:

**Activation conditions:** The handler is active when any of these are true:
- Card is in an `INTERACTING_STATE` or TTS is playing
- Image/video media is lingering (linger timeout active, lightbox visible, or panel has visible images)
- Timer alert is active
- A notification is playing or in display-timeout phase

**Priority order:**
1. **Timer alert active** → Dismiss alert
2. **Notification playing** → ACK each active notification, stop audio, clear UI, cancel ask_question's server-side event, restart pipeline
3. **Active interaction or media linger** → Cancel image linger timeout, stop TTS, cancel ask_question, clear continue state, set IDLE, clear chat/blur, play done chime, restart pipeline

**Escape key:** Registered as a `keydown` listener on `document`. Fires `_cancel()` directly (no double-tap threshold needed). Uses the same activation conditions and priority order.

Touch/click deduplication prevents double-firing on touch devices (touchstart fires before click).

---

## 16. Chat System (`card/chat.js`)

Manages chat message state. All DOM operations delegate to UIManager.

**Bubble types:**
- `user` — Transcription bubble (styled by skin CSS)
- `assistant` — Response bubble (styled by skin CSS)
- `announcement` — Notification message (styled by skin CSS, always centered)

**Chat bubble max-height:** Assistant/announcement bubbles have `max-height: 70vh` with `overflow-y: auto` and thin scrollbar, allowing longer responses (e.g., web search summaries, Wikipedia articles) to remain readable without overflowing the viewport. This value is consistent across all four skins.

**Streaming text fade:** During `intent-progress` streaming, the last 24 characters fade from opaque to transparent using per-character `<span>` elements with decreasing opacity. When the final text arrives in `intent-end`, the full text replaces the faded version.

**Layout modes:**
- `chat` — User bubbles right-aligned, assistant left-aligned
- `centered` — All bubbles centered

**Gotcha — `streamEl` must be cleared between turns:** If not reset in `handleIntentEnd` and continue-conversation transitions, streaming text appends to the previous turn's bubble.

---

## 16A. Rich Media System (Experimental)

The card supports displaying image search, video search, web search, Wikipedia, weather forecast, and financial data results from LLM tool calls. This requires the external [Voice Satellite Card - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools) integration, which registers custom tools with the conversational AI agent. Results arrive as `tool_result` payloads inside `intent-progress` pipeline events.

**Requirement:** The HA Assist pipeline must use a conversational AI agent (e.g., OpenAI, Google Generative AI). The built-in Home Assistant agent does not support LLM tool calls.

### 16A.1 Data Flow

```
LLM tool call → intent-progress (tool_result) → handleIntentProgress
  → endsWith('get_weather_forecast')              → chat.addWeather()    → ui.showWeatherPanel()
  → includes('financial-data__get_financial_data') → chat.addFinancial()  → ui.showFinancialPanel()
  → filter by video_id                            → chat.addVideos()     → ui.showVideoPanel()
  → filter by image_url                           → chat.addImages()     → ui.showImagePanel()
  → featured_image                                → chat.addImages([{image_url}], false, true) → ui.showImagePanel(featured=true)
```

The `intent-progress` event carries `chat_log_delta` with `role: 'tool_result'`. The `tool_result` object contains:
- `results[]` — Array of search results (image/video search)
- `auto_display` (images) / `auto_play` (videos) — Boolean flag for auto-opening lightbox
- `featured_image` — Single image URL string (web search / Wikipedia)
- `forecast[]` — Weather forecast array (weather forecast tool — see §16A.5)
- `query_type`, `current_price`, `change`, `percent_change`, etc. — Financial data fields (financial data tool — see §16A.6)

**Result routing priority:** Weather is checked first (by `tool_name.endsWith('get_weather_forecast')`), then financial data (by `tool_name.includes('financial-data__get_financial_data')`), then video (`video_id`), then image (`image_url && !video_id`), then featured image (`featured_image`).

**Result routing:** Results with `video_id` are routed to the video path. Results with `image_url` (and no `video_id`) are routed to the image path. If `featured_image` is present (no `results[]` array needed), it is routed to the image panel in featured mode. This allows mixed results to route correctly (though unlikely in practice).

### 16A.2 Image Search

**Image result format:**
```json
{
  "image_url": "https://example.com/full.jpg",
  "thumbnail_url": "https://example.com/thumb.jpg",
  "title": "Image title"
}
```

`showImagePanel(results, autoDisplay, featured)`:
1. Creates a `.vs-image-grid` container (`.single` class for single-result layout)
2. For each result: creates `<img>` with `thumbnail_url` (falls back to `image_url`)
3. Click handler → `showLightbox(image_url)` opens full-size image
4. `onerror` removes the failed image; if grid is empty, hides the panel
5. Toggles `.featured` class on panel and `.has-featured` on global UI (see §16A.4A)
6. If not featured, adds `.has-images` class (normal image search layout)
7. If `autoDisplay`, opens lightbox with the first image immediately

### 16A.3 Video Search

**Video result format:**
```json
{
  "video_id": "dQw4w9WgXcQ",
  "title": "Video Title",
  "channel_name": "Channel Name",
  "thumbnail_url": "https://i.ytimg.com/vi/.../hqdefault.jpg",
  "duration": "PT15M32S"
}
```

`showVideoPanel(results, autoPlay)`:
1. Creates a `.vs-video-grid` container
2. For each result: creates a `.vs-video-card` with:
   - `.vs-video-thumb-wrap` — Thumbnail image + duration badge overlay
   - `.vs-video-info` — Title (2-line clamp) + channel name
3. Click handler → `showVideoLightbox(video_id)` opens YouTube embed
4. If `autoPlay`, opens lightbox with the first video immediately

**Duration parsing:** `_parseDuration(iso)` converts ISO 8601 durations to display format:
- `PT1H15M32S` → `"1:15:32"`
- `PT5M8S` → `"5:08"`
- Regex: `/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/`

### 16A.4 Web Search & Wikipedia (Featured Image)

Web search and Wikipedia tool calls return a single featured image (e.g., a Wikipedia article's main photo or a web result's Open Graph image) rather than an array of search results. This uses the same image panel but in a narrower "featured" layout that sits alongside the chat response without dominating the screen.

**Tool result format:**
```json
{
  "featured_image": "https://upload.wikimedia.org/wikipedia/commons/..."
}
```

**Routing in `handleIntentProgress`:**
```js
if (toolResult?.featured_image) {
  mgr.card.chat.addImages([{ image_url: toolResult.featured_image }], false, true);
}
```

The `featured_image` string is wrapped into the same `[{image_url}]` array format used by image search, then passed with `featured=true`. This reuses the existing image panel infrastructure without a separate code path.

**Featured vs. normal image panel:**

| Aspect | Normal (image search) | Featured (web/wiki/weather/financial) |
|--------|-----------------------|---------------------------------------|
| Panel width | 30% | 25% |
| Chat container offset | `right: calc(37.5% + 40px)` | `right: calc(32.5% + 40px)` |
| Chat message max-width | `100%` (overridden from default 85%) | `100%` (overridden from default 85%) |
| CSS class on panel | `.visible` | `.visible.featured` |
| CSS class on global UI | `.has-images` | `.has-featured` |
| Auto-display lightbox | Controlled by `auto_display` | Never (always `false`) |
| `hasVisibleImages()` | Returns `true` | Returns `false` (excluded via `!panel.classList.contains('featured')`) |

**Why `hasVisibleImages()` excludes featured:** This method gates whether TTS-end should defer dismissal for image browsing. Featured images are passive context alongside a text response — they don't represent a browsing session that should delay pipeline restart.

**Skin CSS (all skins):** Each skin defines the panel layout. Image search uses a wider offset than featured panels since the image panel (30%) is wider than the featured panel (25%). When any media panel is open, chat messages expand to fill the narrowed container:
```css
#voice-satellite-ui.has-images .vs-chat-container {
  right: calc(37.5% + 40px);
}
#voice-satellite-ui.has-featured .vs-chat-container {
  right: calc(32.5% + 40px);
}
#voice-satellite-ui.has-images .vs-chat-msg,
#voice-satellite-ui.has-featured .vs-chat-msg {
  max-width: 100%;
}
#voice-satellite-ui .vs-image-panel.featured {
  width: 25%;
}
```

### 16A.5 Weather Forecast

The `get_weather_forecast` tool returns current conditions and a forecast array. The card displays a weather widget in the media panel using the same featured panel infrastructure as web search / Wikipedia.

**Tool detection in `handleIntentProgress`:**
```js
const toolName = eventData.chat_log_delta.tool_name
  || eventData.chat_log_delta.tool_call?.tool_name;

if (toolName?.endsWith('get_weather_forecast') && toolResult?.forecast && !toolResult.error) {
  mgr.card.chat.addWeather(toolResult);
  return;
}
```

**HA tool name prefixing:** Home Assistant prefixes tool names with the integration name + `__` (e.g., `voice-satellite-card-weather-forecast__get_weather_forecast`). Detection uses `.endsWith('get_weather_forecast')` to match regardless of prefix.

**Tool result format:**
```json
{
  "current_temperature": 29,
  "current_humidity": 87,
  "condition_icon": "https://www.gstatic.com/images/icons/material/system/2x/rainy_24px.svg",
  "forecast_type": "daily",
  "forecast": [
    { "date": "2026-02-24", "condition": "rainy", "temperature_low": 23, "temperature_high": 30, "humidity": 81 },
    { "date": "2026-02-25", "condition": "rainy", "temperature_low": 23, "temperature_high": 28, "humidity": 65 }
  ]
}
```

**Routing:** `chat.addWeather(data)` → `ui.showWeatherPanel(data)`.

**DOM structure built by `showWeatherPanel(data)`:**
```
.vs-weather-card
  .vs-weather-header          (flex row: icon + info)
    img.vs-weather-icon       (96×96, src=condition_icon, onerror→remove)
    .vs-weather-info
      .vs-weather-temp        (current_temperature — large text)
      .vs-weather-condition   (first forecast entry's condition → label via CONDITION_LABELS map)
      .vs-weather-humidity    ("Humidity: XX%")
  .vs-weather-divider         (1px line)
  .vs-weather-forecast
    .vs-weather-row ×N        (3-column flex row)
      span.vs-weather-row-time   (time or date)
      span.vs-weather-row-cond   (condition label)
      span.vs-weather-row-temp   (temperature)
```

**`CONDITION_LABELS` constant** (module-level in `ui.js`): Maps HA condition values to display labels — `partlycloudy` → "Partly Cloudy", `lightning-rainy` → "Thunderstorm", `snowy-rainy` → "Sleet", etc. (15 entries).

**Forecast time display:** Varies by `forecast_type`:
- `hourly` — uses `entry.time`
- `daily` — uses `entry.date`
- `twice_daily` — uses `entry.date` + " Day" or " Night" based on `entry.is_daytime`

**Temperature display:** If both `temperature_low` and `temperature_high` exist, shows "low - high°". Otherwise shows whichever single value is present with "°" suffix.

**Panel behavior:** Uses featured mode — `panel.classList.add('weather', 'featured', 'visible')` and `globalUI.classList.add('has-featured')`. Since `hasVisibleImages()` excludes `.featured`, no 30-second linger timeout applies — the UI dismisses immediately after TTS completes.

**Weather panel CSS (`.vs-image-panel.weather`):** Strips all container styles (`background: none`, no shadow/border/padding) so content floats directly over the blur overlay, matching the borderless aesthetic of the chat bubbles. Inherits the 25% width from `.vs-image-panel.featured`. Each skin applies its own color palette to the weather elements.

**Cleanup:** `clearChat()` empties `.vs-panel-scroll` and removes `visible`/`featured`/`weather`/`financial` from the panel.

### 16A.6 Financial Data

The `get_financial_data` tool returns stock prices, crypto prices, or currency conversions. The card displays a financial widget in the media panel using the same featured panel infrastructure as weather.

**Tool detection in `handleIntentProgress`:**
```js
if (toolName?.includes('financial-data__get_financial_data') && toolResult?.query_type && !toolResult.error) {
  mgr.card.chat.addFinancial(toolResult);
  return;
}
```

**HA tool name prefixing:** Uses `.includes('financial-data__get_financial_data')` since the full tool name is `voice-satellite-card-financial-data__get_financial_data`.

**Tool result format (stock/crypto):**
```json
{
  "query_type": "stock",
  "name": "Apple Inc",
  "symbol": "AAPL",
  "exchange": "NASDAQ",
  "current_price": 245.55,
  "change": 2.15,
  "percent_change": 0.88,
  "currency": "USD",
  "open": 243.40,
  "high": 246.10,
  "low": 242.30,
  "market_cap": 3750000000000,
  "featured_image": "https://logo.clearbit.com/apple.com"
}
```

**Tool result format (currency):**
```json
{
  "query_type": "currency",
  "from_currency": "USD",
  "to_currency": "EUR",
  "amount": 100,
  "converted_amount": 92.15,
  "exchange_rate": 0.921543
}
```

**Routing:** `chat.addFinancial(data)` → `ui.showFinancialPanel(data)`.

**Formatting utilities (`shared/format.js`):**
- `formatPrice(value, currency)` — Locale-aware currency formatting via `Intl.NumberFormat`. Uses 6 decimal places for sub-$1 values (crypto), 2 for $1+.
- `formatLargeNumber(value, currency)` — Abbreviates large numbers: `3750000000000` → `$3.75T`. Suffixes: M, B, T.
- `formatChange(change, percentChange, currency)` — Formats change with sign prefix and optional percent: `+$2.15 (+0.88%)`.

**DOM structure built by `showFinancialPanel(data)` — Stock/Crypto:**
```
.vs-financial-card
  .vs-financial-header          (flex row: logo + name + badge)
    img.vs-financial-logo       (32px rounded, src=featured_image, onerror→remove)
    .vs-financial-name          ("Apple Inc (AAPL)")
    span.vs-financial-badge     ("NASDAQ" or "Crypto")
  .vs-financial-price           (large text: "$245.55")
  .vs-financial-change.up|.down (colored: "▲ +$2.15 (+0.88%)" or "▼ -$1.50 (-0.61%)")
  .vs-financial-details         ("Open: $243.40 · High: $246.10 · Low: $242.30")
```

**DOM structure — Currency:**
```
.vs-financial-card
  .vs-financial-conversion      (large: "100 USD = 92.15 EUR")
  .vs-financial-rate            (smaller: "1 USD = 0.921543 EUR")
```

**Change indicator:** The `.vs-financial-change` element gets `.up` class (green + ▲) when `change > 0`, `.down` class (red + ▼) when `change < 0`. Colors are skin-specific.

**Badge text:** Uses `data.exchange`, truncated to first word before ` - ` for long exchange names. Crypto uses `"Crypto"` as badge text.

**Logo handling:** `featured_image` is used as logo `src`. An `onerror` handler removes the `<img>` element if the logo fails to load — the card renders normally without it.

**Detail row:**
- Stock: `Open · High · Low` (only present fields shown, separated by ` · `)
- Crypto: `24h High · 24h Low` + optional `MCap: formatLargeNumber(market_cap)`

**Panel behavior:** Uses featured mode — `panel.classList.add('financial', 'featured', 'visible')` and `globalUI.classList.add('has-featured')`. Since `hasVisibleImages()` excludes `.featured`, no 30-second linger timeout applies.

**Financial panel CSS (`.vs-image-panel.financial`):** Strips all container styles (same pattern as `.weather`) so content floats over the blur overlay. Inherits 25% width from `.vs-image-panel.featured`. Each skin applies its own color palette:

| Skin | Price | Up color | Down color | Details | Badge bg |
|------|-------|----------|------------|---------|----------|
| default | #333 | #16a34a | #dc2626 | #888 | rgba(0,0,0,0.06) |
| alexa | #FFF bold | #00e676 | #ff5252 | white 50% | rgba(0,202,255,0.15) |
| google-home | #202124 | #0f9d58 | #ea4335 | #80868b | rgba(60,64,67,0.08) |
| retro-terminal | #33ff33+glow | #33ff33+glow | #ff3333+glow | green 50% | rgba(51,255,51,0.1) |
| siri | #FFF 600 | #34D399 | #F87171 | white 50% | rgba(255,255,255,0.1) |

### 16A.7 Inner Scroll Wrapper

The media panel uses a two-layer structure for proper scrollbar positioning:

```html
<div class="vs-image-panel">     <!-- overflow: hidden (clips at border-radius) -->
  <div class="vs-panel-scroll">  <!-- overflow-y: auto (actual scrollbar) -->
    <!-- grids appended here -->
  </div>
</div>
```

**Why:** Direct scrollbar styling on the panel via `::-webkit-scrollbar` pseudo-elements does not work in the HA Companion App WebView. The inner wrapper pattern moves the scrollbar inside the rounded container, and `padding-right: 8px` on `.vs-panel-scroll` creates a gap between content and the scrollbar.

**Gotcha — `padding-right` vs `margin-right`:** `margin-right` on the scroll wrapper pushes the entire container (including scrollbar) leftward but does NOT create space between content and scrollbar. `padding-right` creates the gap between content and the scrollbar — this is what actually works.

**Scroll-cancels-linger:** A `scroll` event listener on `.vs-panel-scroll` clears the `_imageLingerTimeout` — once the user starts browsing results, the auto-dismiss timer is cancelled.

### 16A.8 Lightbox

Two modes sharing a single `.vs-lightbox` container:

**Image mode** (`showLightbox(src)`):
- Hides iframe, shows `<img>` with `src`
- Tap to close → returns to media panel

**Video mode** (`showVideoLightbox(videoId)`):
- Hides img, shows `<iframe>` with `src="https://www.youtube-nocookie.com/embed/{videoId}?autoplay=1"`
- Stops TTS if playing and sets `_videoPlaying = true` (see §16A.9)
- Tap to close → clears iframe `src` to stop playback, sets `_videoPlaying = false`

**Gotcha — `youtube-nocookie.com`:** Standard `youtube.com/embed` triggers error 153 in some contexts. Using `youtube-nocookie.com` avoids this (enhanced privacy mode, no tracking cookies).

**Gotcha — iframe permissions:** The iframe requires `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"` and `allowfullscreen` for proper YouTube playback within HA's WebView.

Both modes cancel the linger timeout on open (UI stays until user dismisses). Close handler is registered once (`_vsCloseHandler` guard on the lightbox element).

### 16A.9 `_videoPlaying` Flag

Bridges the timing gap between video lightbox open and TTS events. When a video is playing in the lightbox, TTS audio must not play over it.

**Problem:** The LLM returns tool results (video search) during `intent-progress`, BEFORE `tts-end` arrives. By the time `tts-end` fires with the TTS URL, the user is already watching a video. Playing TTS over the video would be disruptive.

**Solution:** `card._videoPlaying` flag:
- Set `true` by `showVideoLightbox()` (also stops any in-progress TTS)
- Set `false` by `hideLightbox()`
- Checked at both TTS play sites in `handleTtsEnd`:
  - Streaming TTS (`intent-progress` with `tts_start_streaming`): skips `tts.play()` if `_videoPlaying`
  - Normal TTS (`tts-end`): calls `onTTSComplete(card, false)` instead of `tts.play()` to run cleanup without audio
- Checked at streaming TTS early-start in `handleIntentProgress`: skips `tts.play()` if `_videoPlaying`

### 16A.10 Image Linger Timeout

After TTS completes, if images/videos are visible, the UI lingers for 30 seconds before auto-dismissing:

```javascript
// In onTTSComplete:
if (card.ui.hasVisibleImages()) {
  card.ui.stopReactive();  // Stop mic reactivity on bar
  card._imageLingerTimeout = setTimeout(cleanup, 30000);
} else if (playbackFailed) {
  // TTS failed (e.g. autoplay blocked) — keep response visible
  card.ui.stopReactive();
  card._imageLingerTimeout = setTimeout(cleanup, Timing.TTS_FAILED_LINGER);  // 5s
} else {
  cleanup();  // Immediate dismiss
}
```

**TTS failure linger:** When the browser blocks TTS autoplay (`playbackFailed = true`), the response text lingers for 5 seconds (`TTS_FAILED_LINGER`) so the user can read the LLM response. Without this, the interaction would dismiss instantly because the TTS error fires as immediate completion.

**Featured images skip linger:** `hasVisibleImages()` returns `false` when the panel has the `.featured` class (web search / Wikipedia). Featured images are passive conversational context displayed alongside a text response — they are not browsable media that the user needs time to explore. The `cleanup()` path runs immediately, dismissing the UI normally after TTS completes.

The linger timeout is cancelled by:
- **User scrolling** the media panel (browsing results)
- **Opening the lightbox** (viewing a specific result)
- **New wake word** detection (`handleWakeWordEnd` clears it)
- **Tab visibility change** (visibility handler clears it)
- **Double-tap / Escape** (dismiss handler clears it)

**Gotcha — Lightbox blocks cleanup:** If the lightbox is open when the linger timeout fires, the `cleanup` function returns early (`if (card.ui.isLightboxVisible()) return`). The UI stays until the user closes the lightbox and double-taps/presses Escape.

---

## 17. UI Manager (`card/ui.js`)

Single owner of all DOM manipulation. Key responsibilities:

### Blur Overlay (Reference-Counted)
Multiple features can request the blur overlay simultaneously (pipeline, timer, announcement). Uses a `_blurReasons` object to track active reasons. The overlay hides only when all reasons are cleared. Forgetting to clear a reason leaves a permanent blur.

### Rainbow Bar
State-driven animation speeds:
- `listening` — 3s flow (slow)
- `processing` — 0.5s flow (fast)
- `speaking` — 2s flow (medium)
- `error-mode` — Red gradient, 2s flow
- `error-flash` — 3x flash animation (ask_question unmatched answer)

**Reactive mode:** When the skin opts in (`reactiveBar: true`) and the card config allows it (`reactive_bar !== false`), states with `useReactive: true` drive bar visuals from real-time audio levels via the `--vs-audio-level` CSS custom property (0–1). The `useReactive` flag is per-state:
- `WAKE_WORD_DETECTED` — reactive (mic levels)
- `STT` — reactive (mic levels)
- `INTENT` — **not** reactive (CSS-only processing animation)
- `TTS` — reactive (audio output levels)

On reactive state entry, `reconnectMic()` switches the analyser to mic input. When TTS `attachAudio()` fires, the analyser switches to audio output. INTENT uses CSS animation only because no meaningful audio data flows during intent processing.

**Bar-hide guard:** `updateForState()` refuses to hide the bar (states with `barVisible: false`) when any of these are active: TTS is playing, a linger timeout is set (`_imageLingerTimeout`), a video is playing (`_videoPlaying`), or the lightbox is visible. This prevents the pipeline restart (which transitions to LISTENING/IDLE) from prematurely hiding the bar during TTS-failed linger, image linger, or video playback.

**Reactive bar rendering — GPU-accelerated glow:** All skins use GPU-composited properties (`filter`, `opacity`, `box-shadow`) driven by `--vs-audio-level` to avoid layout thrashing. The specific technique varies by skin:

| Skin | Reactive technique |
|------|--------------------|
| Default | `scaleY` for bar height + `::after` pseudo-element with `filter: blur()` and audio-level-driven `opacity` (`calc(var(--vs-audio-level) * 2.5)`) for glow, gradient position synced via `@property --vs-gp` |
| Alexa | `::after` pseudo-element with `filter: blur()` and `opacity` for cyan glow halo; no `scaleY` — bar stays fixed height |
| Google Home | `scaleY` for bar height + `::after` pseudo-element with `filter: blur()` and `opacity` for 4-color glow, gradient synced via `@property --vs-gp` |
| Retro Terminal | `filter: drop-shadow()` for outer glow + `box-shadow: inset` for inner glow around the full-screen border frame; no `scaleY` or `::after` |
| Siri | `filter: drop-shadow()` for outer glow + `box-shadow: inset` for inner glow around full-screen conic-gradient border; gradient rotates via `@property --siri-angle` |

The Default and Google Home skins use `@property --vs-gp` (registered via `@property` at-rule) to animate `background-position` on both the bar and its `::after` glow pseudo-element simultaneously, ensuring perfect gradient color sync between the bar and its glow. All `transition` durations on reactive properties are set to `0.05s linear` for near-instant response to audio level changes.

**GPU compositing hints:** All five skins apply CSS hints to offload animation to the GPU and isolate layout:
- `.vs-rainbow-bar` — `will-change: filter, opacity` (pre-allocates GPU layer for reactive bar); `contain: strict` (isolates layout/paint)
- `.vs-rainbow-bar.reactive` — `transform: translateZ(0)` on Alexa, Siri, Retro Terminal (forces compositing layer for skins without `scaleY` transforms)
- `.vs-blur-overlay` — `will-change: opacity` (keeps blur overlay on GPU during fade transitions)
- `.vs-chat-container` — `contain: content` (isolates streaming text mutations from triggering global layout)
- `.vs-timer-pill` — `contain: content` (isolates per-second countdown updates)

**Analyser throttle:** The reactive bar's CSS transitions are 50ms, so updating at 60fps is wasteful. The analyser tick loop skips frames closer than 32ms apart (~30fps cap), halving `getByteFrequencyData()` calls with no visible difference.

### Start Button
Floating mic button with pulse animation. Shows on initial load, microphone permission denied, microphone not found, or generic mic error.

### Chat Container
Fixed position, centered horizontally. Bottom offset accounts for bar height. `announcement-mode` class centers vertically (for passive announcements). Notification system manages the toggle between announcement mode and normal mode.

### Timer DOM
Timer pills, alert overlay, progress bar updates, expired pill animations — all coordinated by TimerManager but executed by UIManager.

---

## 17A. Skin System (`skins/`)

### 17A.1 Overview

Skins define the complete visual theme — activity bar, blur overlay, chat bubbles, timer pills, and animations. All visual styling is owned by skins via CSS; the card has no hardcoded gradient colors or layout values. Five built-in skins ship with the card.

### 17A.2 Skin Definition

Each skin is a JS module exporting a definition object:

```javascript
{
  id: 'default',          // Config value
  name: 'Default',        // Editor dropdown label
  css: '...',             // Imported CSS string (injected into <style>)
  reactiveBar: true,      // Whether this skin supports reactive (audio-driven) bar
  overlayColor: [0, 0, 0],// RGB for blur overlay background
  defaultOpacity: 0.3,    // Default blur overlay opacity (0–1)
  fontURL: '...',         // Google Fonts URL (loaded via @import in CSS + <link> in preview)
  previewCSS: '...',      // Imported CSS for editor preview rendering
}
```

### 17A.3 Built-in Skins

| Skin | ID | Overlay Color | Default Opacity | Description |
|------|----|--------------|-----------------|-------------|
| Default | `default` | `[255, 255, 255]` (white) | 0.85 | Rainbow gradient bar, light overlay, DM Sans font |
| Alexa | `alexa` | `[0, 8, 20]` (dark blue) | 0.7 | Cyan accent glow, Echo Show-inspired |
| Google Home | `google-home` | `[255, 255, 255]` (white) | 0.75 | 4-color palette, Material Design, frosted overlay |
| Retro Terminal | `retro-terminal` | `[0, 10, 0]` (deep green-black) | 0.92 | Green phosphor CRT aesthetic, monospace font, scanlines, bezel frame |
| Siri | `siri` | `[0, 0, 0]` (black) | 0.75 | Full-screen gradient border glow, Inter/Apple system font, frosted glass elements |

All five skins have `reactiveBar: true`.

### 17A.4 Skin Registry (`skins/index.js`)

- `getSkin(id)` — Returns skin definition by ID. Falls back to default if ID is unknown.
- `getSkinOptions()` — Returns `{ value, label }[]` for the editor dropdown.

### 17A.5 Skin Application

On `setConfig()`, the card resolves the skin via `getSkin(config.skin)` and stores it as `_activeSkin`. UIManager applies the skin in `applyStyles()`:

1. **`_injectSkinCSS()`** — Replaces the `<style id="voice-satellite-styles">` element with the skin's CSS string. All visual theming (bar gradient, bubble styles, animations) comes from this.
2. **`_applyBackgroundOpacity()`** — Sets `--vs-bg-opacity` CSS variable. Uses `config.background_opacity / 100` if set, otherwise falls back to `skin.defaultOpacity`. The overlay color is set from `skin.overlayColor` as an `rgba()` background.
3. **`_applyTextScale()`** — Sets `--vs-text-scale` CSS variable (50–200%).
4. **`_applyCustomCSS()`** — Appends user's `custom_css` overrides in a separate `<style>` element.

### 17A.6 Reactive Bar Opt-In

The reactive bar (audio-level-driven animation) requires **both** the skin and the user config to agree. This is centralized in a single getter on the card class:

```javascript
get isReactiveBarEnabled() {
  return !!this._activeSkin?.reactiveBar && this._config.reactive_bar !== false;
}
```

All call sites use `this._card.isReactiveBarEnabled` instead of repeating the condition:
- `updateForState()` — Determines whether to start the analyser tick loop
- `showBarForNotification()` — Enables reactive mode during notification playback
- `AudioManager.startMicrophone()` — Decides whether to connect mic to analyser
- `TtsManager.play()` — Decides whether to route audio through analyser
- `satellite-notification.js` — Decides whether to attach notification audio to analyser

---

## 18. State Machine

The card tracks its state via a string enum:

```
IDLE → CONNECTING → LISTENING → WAKE_WORD_DETECTED → STT → INTENT → TTS → IDLE
                                                                          ↓
                                                                    (continue conversation)
                                                                          ↓
                                                                    STT → INTENT → TTS
```

| State | Meaning | Bar |
|-------|---------|-----|
| `IDLE` | Waiting / inactive | Hidden |
| `CONNECTING` | Starting mic + pipeline | Hidden |
| `LISTENING` | Pipeline running, waiting for wake word | Hidden |
| `PAUSED` | Tab hidden | Hidden |
| `WAKE_WORD_DETECTED` | Wake word heard, now capturing speech | Visible (slow) |
| `STT` | Capturing speech | Visible (slow) |
| `INTENT` | Processing intent / generating response | Visible (fast) |
| `TTS` | Playing response audio | Visible (medium) |
| `ERROR` | Error state | Hidden |

State changes are synced to the integration entity via `voice_satellite/update_state`. The integration maps card states to HA satellite states:

| Card State | HA State |
|-----------|----------|
| IDLE, CONNECTING, LISTENING, PAUSED, ERROR | `idle` |
| WAKE_WORD_DETECTED, STT | `listening` |
| INTENT | `processing` |
| TTS | `responding` |

---

## 19. Configuration

### 19.1 Config Defaults

`DEFAULT_CONFIG` in `constants.js` defines all configuration keys with their defaults. Visual styling (bar appearance, bubble styles, layout) is fully handled by skins (§17A) and is no longer in the card config.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| **Behavior** ||||
| `satellite_entity` | string | `''` | **Required.** Integration satellite entity ID (e.g., `assist_satellite.kitchen_tablet`) |
| `browser_satellite_override` | bool | `false` | Per-device satellite override. When enabled, localStorage takes full control of entity selection, overriding the YAML entity. A picker popup appears on each device for initial selection. See §14A. |
| `debug` | bool | `false` | Enable debug logging to browser console |
| **Microphone Processing** ||||
| `noise_suppression` | bool | `true` | WebRTC noise suppression |
| `echo_cancellation` | bool | `true` | WebRTC echo cancellation |
| `auto_gain_control` | bool | `true` | WebRTC auto gain control |
| `voice_isolation` | bool | `false` | Experimental voice isolation (Chrome-only) |
| **Skin** ||||
| `skin` | string | `'default'` | Active skin ID (`default`, `alexa`, `google-home`, `retro-terminal`) |
| `custom_css` | string | `''` | CSS overrides applied on top of the selected skin |
| `text_scale` | number | `100` | Text scale percentage (50–200%) |
| `reactive_bar` | bool | `true` | Audio-reactive activity bar (disable on slow devices) |

**Settings moved to integration entities:** Several options that were previously card config are now managed as integration entities per device, making them accessible from HA automations and the device page:

| Setting | Integration Entity | Type | Default |
|---------|-------------------|------|---------|
| TTS Output | Select (`tts_output`) | `select` | `"Browser"` |
| Announcement Display Duration | Number (`announcement_display_duration`) | `number` | `3.5s` |
| Screensaver | Select (`screensaver`) | `select` | `"Disabled"` |

The card reads these via `getSelectEntityId()` and `getNumberState()` (§13) through computed accessors:
- `card.ttsTarget` → reads `tts_output` select entity's `entity_id` attribute
- `card.announcementDisplayDuration` → reads `announcement_display_duration` number entity

**Note:** `background_opacity` (0–100%) is exposed in the editor but not in `DEFAULT_CONFIG`. When unset, it falls back to `_activeSkin.defaultOpacity`.

### 19.2 Editor

The editor uses HA's `ha-form` schema system. Each section is defined in its own file:

| File | Section |
|------|---------|
| `behavior.js` | Satellite entity selector (required), microphone processing expandable, browser satellite override toggle, debug toggle |
| `skin.js` | Appearance expandable: skin selector dropdown, reactive bar toggle, text scale slider, background opacity slider, custom CSS textarea |

The editor assembler (`editor/index.js`) concatenates `behaviorSchema`, `skinSchema`, `microphoneSchema`, and `debugSchema`, then merges all label/helper maps into `getConfigForm()`. The skin dropdown options are populated dynamically from the skin registry via `getSkinOptions()`. The `browser_satellite_override` toggle and `debug` toggle are both in `debugSchema` (rendered after microphone processing).

### 19.3 Preview

`editor/preview.js` renders a static preview inside the card's Shadow DOM when it detects it's inside HA's card editor (via ancestor element detection: `HUI-CARD-PREVIEW` or `HUI-CARD[preview]` or any tag containing "PREVIEW").

The preview shows:
- Checkered transparency background (light/dark mode aware)
- Rainbow bar with animation
- Sample chat bubbles ("What's the temperature outside?" / "It's currently 75°F and sunny.")
- Timer pill with mock countdown (00:04:32)

All preview elements respect the current config for live style updates:
- **Text scale:** `--vs-text-scale` CSS variable set as inline style on the preview container from `config.text_scale`. All font sizes in preview CSS use `calc(Xpx * var(--vs-text-scale, 1))`.
- **Background opacity:** The blur overlay's `background` is computed inline from `skin.overlayColor` and `config.background_opacity` (falling back to `skin.defaultOpacity`), overriding the skin preview CSS default.
- **Font:** Skins with `fontURL` inject a `<link>` element into `document.head` for Google Fonts loading.

---

## 20. Build System

### 20.1 Dependencies

```json
{
  "@babel/core": "^7.24.0",
  "@babel/preset-env": "^7.24.0",
  "babel-loader": "^9.1.3",
  "webpack": "^5.90.0",
  "webpack-cli": "^5.1.4"
}
```

All are devDependencies. There are no runtime dependencies — the card is a self-contained single-file bundle.

### 20.2 Build Pipeline

**Webpack** bundles all ES6 modules into a single `voice-satellite-card.js` output in `custom_components/voice_satellite/frontend/`.

**Babel** transpiles ES6+ features for broader browser support.

**CSS** — Each skin's CSS files and the editor preview CSS are imported as raw strings via Webpack's `asset/source` rule. Skin CSS is injected into the document head at runtime by UIManager (`_injectSkinCSS`).

**Version** is defined in `package.json` (single source of truth) and synced to `manifest.json` + `const.py` via `scripts/sync-version.js` (runs as a prebuild/predev hook). Webpack's `DefinePlugin` injects the version into the JS bundle as `__VERSION__`.

**Build commands:**
- `npm run dev` — Production build + xcopy to hassio network share (`\\hassio\config\custom_components\voice_satellite\`)
- `npm run build` — Production build only (for CI/releases)

---

## 21. Timing Constants

All timing values are centralized in `constants.js`:

| Constant | Value | Purpose |
|----------|-------|---------|
| `DOUBLE_TAP_THRESHOLD` | 400ms | Max interval between taps for double-tap |
| `TIMER_CHIME_INTERVAL` | 3000ms | Interval between alert chime loops |
| `PILL_EXPIRE_ANIMATION` | 400ms | Timer pill fade-out animation duration |
| `PLAYBACK_WATCHDOG` | 30000ms | Interval for stall-detection watchdog (checks `audio.currentTime` progression) |
| `RECONNECT_DELAY` | 2000ms | Delay before restarting pipeline after reconnect |
| `INTENT_ERROR_DISPLAY` | 3000ms | How long to show error bar for intent errors |
| `TTS_FAILED_LINGER` | 5000ms | How long to keep response text visible when TTS playback fails (e.g. autoplay blocked) |
| `NO_MEDIA_DISPLAY` | 3000ms | Delay before completing text-only announcements |
| `ASK_QUESTION_CLEANUP` | 2000ms | Safety timeout for sendAnswer promise |
| `ASK_QUESTION_STT_SAFETY` | 30000ms | Safety timeout if STT never produces a result |
| `TOKEN_REFRESH_INTERVAL` | 240000ms | Periodic pipeline restart to refresh streaming TTS token (§7.4, §8.9) |
| `MAX_RETRY_DELAY` | 30000ms | Maximum backoff delay |
| `RETRY_BASE_DELAY` | 5000ms | Base delay for linear backoff |
| `VISIBILITY_DEBOUNCE` | 500ms | Debounce before pausing on tab hide |
| `DISCONNECT_GRACE` | 100ms | Grace period before teardown on disconnect |
| `CHIME_SETTLE` | 500ms | Delay after wake chime before starting STT |

---

## 22. Error Handling

### Expected Pipeline Errors

These errors are normal and trigger a silent restart:
- `timeout` — Pipeline inactivity timeout
- `wake-word-timeout` — Wake word detection timeout
- `stt-no-text-recognized` — VAD ended but no speech detected
- `duplicate_wake_up_detected` — Multiple wake word detections (note: underscores, not dashes — HA API inconsistency)

If the card was in an interacting state, UI is cleaned up and done chime plays before restart.

### Intent Errors (response_type === 'error')

When the LLM returns an error response (e.g., tool failure, conversation agent error), `handleIntentEnd` sets `mgr.suppressTTS = true`. When `tts-end` subsequently fires, the handler detects the flag, calls `onTTSComplete(card, true)` for cleanup, and restarts the pipeline — without playing TTS audio.

**Why `onTTSComplete` is needed:** Without it, the blur overlay, chat bubbles, and media panel stay stuck on screen. The `playbackFailed = true` parameter suppresses the "done" chime (the error chime was already played by `handleIntentEnd`).

**Done chime suppression on error:** `onTTSComplete` checks `!playbackFailed` before playing the done chime. This prevents a double-chime scenario (error chime from `handleIntentEnd` + done chime from `onTTSComplete`).

### Unexpected Pipeline Errors

All other errors: show error bar (red gradient), play error chime, set `serviceUnavailable = true`, retry with linear backoff.

### Service Recovery

When `wake_word-start` fires after a period of `serviceUnavailable`, a 2-second recovery timer starts. If still `serviceUnavailable` when it fires: clear error bar, reset retry count. This prevents premature recovery clearing from transient events.

### Connection Recovery

The `setupReconnectListener` listens for the connection's `ready` event (HA reconnect). On reconnect: reset retry state, clear error bar, restart pipeline after 2-second delay (or defer if tab is paused).

---

## 23. Integration Coupling Points

These are the non-obvious coupling points between the card and the integration:

1. **Pipeline event relay** — The integration's `on_pipeline_event()` relays HA pipeline events to the card via `connection.send_event()`. The card expects the same event format as HA's `assist_pipeline/run` but receives it through a different WS subscription (`voice_satellite/run_pipeline`).

2. **Init event** — The `voice_satellite/run_pipeline` handler sends a synthetic `{ type: "init", handler_id: N }` event before the real pipeline events. This is how the card gets the binary handler ID for audio transmission. The card blocks on this event before starting audio.

3. **Stale event filtering (both sides)** — The integration gates on `_pipeline_run_started` (blocks events before run-start). The card uses `_runStartReceived`, `_wakeWordPhase`, and `_errorReceived` to filter events from overlapping pipeline runs.

4. **Pipeline stop protocol** — When replacing a pipeline run, the integration sends an empty bytes stop signal to the audio queue. It waits for the old task to exit naturally (3s timeout), only force-cancelling as a last resort. Immediate cancellation would race with the stop signal and leave orphaned HA pipeline tasks.

5. **Announcement blocking** — `async_announce()` blocks until the card sends `announce_finished`. If the card disconnects, `unregister_satellite_subscription()` releases the blocking event to prevent indefinite hangs.

6. **Ask question two-phase flow:**
   - Phase 1: Announcement playback (reuses `async_announce` flow)
   - Phase 2: STT capture (card sends `question_answered`, integration matches with hassil)
   - The `question_answered` WS handler waits for `_question_match_event` to get the hassil result before responding to the card
   - **Race condition:** `_question_match_result` is intentionally NOT cleared in the `finally` block because the asyncio scheduler might run `finally` before the WS handler reads the result

7. **Timer attribute immutability** — The integration creates new lists (not in-place mutation) for `_active_timers` on every change. In-place mutation would share the reference with the previously written state, causing HA to suppress the `state_changed` event (old == new).

8. **Screensaver keep-alive** — The integration sends `homeassistant.turn_off` every 5 seconds to the configured screensaver entity while the satellite is non-idle. This keeps the screen on during interactions.

9. **State sync ordering** — The card skips syncing `idle`/`listening` states while TTS is playing (barge-in scenario). This prevents the integration from showing `idle` while the user is still hearing the response.

---

## 24. Implementation Checklist

When recreating or modifying this card, verify:

**Architecture:**
- [ ] All comms files take `card` as first parameter, use only public accessors
- [ ] Helper files use public getters/setters, never `mgr._privateField`
- [ ] All WebSocket/service calls isolated in comms files
- [ ] All audio creation (AudioContext, Audio, oscillators) in `audio/` module
- [ ] All DOM manipulation in `card/ui.js`

**Pipeline:**
- [ ] Pipeline communicates through `voice_satellite/run_pipeline`, not `assist_pipeline/run`
- [ ] Init event provides binary handler ID (not `runner_data.stt_binary_handler_id`)
- [ ] No idle timeout — server manages pipeline lifecycle
- [ ] Stale event filtering: `_runStartReceived`, `_wakeWordPhase`, `_errorReceived`
- [ ] Empty `wake_word-end` (no `wake_word_id`) is ignored (pipeline restart artifact)
- [ ] `isRestarting` flag prevents concurrent restarts
- [ ] Mute switch blocks pipeline start with 2s polling
- [ ] `run-end` during wake_word phase (no error) triggers `restart(0)` (not ignored as stale)

**TTS:**
- [ ] `handleTtsEnd()` calls `tts.play()` then `pipeline.restart(0)` for barge-in
- [ ] `stop()` nulls `onended`/`onerror` before pausing (ghost event prevention)
- [ ] Stall-detection watchdog (`setInterval`) checks `audio.currentTime` progression, force-completes on stall
- [ ] Done chime controlled by `wake_sound` switch, suppressed for remote TTS and on playback failure
- [ ] `suppressTTS` flag: `handleIntentEnd` sets on intent error, `handleTtsEnd` skips play and calls `onTTSComplete(card, true)`
- [ ] `_videoPlaying` flag checked at both TTS play sites — suppresses TTS during video lightbox playback
- [ ] Streaming TTS: no restart at `tts_start_streaming`, skip duplicate at `tts-end`
- [ ] Remote TTS: entity state monitoring via `checkRemotePlayback()` in `set hass()`, not a fixed delay
- [ ] Remote TTS: `_remoteSawPlaying` guard prevents false completion before playback starts
- [ ] Remote TTS: 120-second safety timeout (`REMOTE_SAFETY_TIMEOUT`) as fallback
- [ ] Token refresh timer restarts pipeline every 4 min during idle LISTENING (prevents stale streaming token)
- [ ] Token refresh timer cleared on `wake_word-end` and `stop()`
- [ ] Retry mechanism: `_pendingTtsEndUrl` stored by `handleTtsEnd`, retried once on playback failure

**Audio Analyser:**
- [ ] Dual-analyser architecture: `_micAnalyser` (no destination) and `_audioAnalyser` (routes to destination)
- [ ] Mic analyser never connected to `AudioContext.destination` (feedback prevention)
- [ ] `_activeAnalyser` pointer switches between mic and audio analysers
- [ ] `reconnectMic()` is a no-op while `_mediaSourceNode` is set (prevents mid-playback switch)
- [ ] 30fps throttle: tick loop skips frames < 32ms apart (halves `getByteFrequencyData` calls)
- [ ] `useReactive` flag in UI state config: only WAKE_WORD_DETECTED, STT, TTS are reactive; INTENT uses CSS animation

**Notifications:**
- [ ] All three managers use `satellite-notification.js` lifecycle
- [ ] Events delivered via `voice_satellite/subscribe_events` (not entity attributes)
- [ ] Satellite subscription retries with exponential backoff on failure (2s, 4s, 8s, 16s, 30s)
- [ ] Pipeline-busy queuing, played via `playQueued()` on TTS complete
- [ ] Hidden-tab queuing with visibility replay
- [ ] Passive announcements: centered (`announcement-mode`), `'announcement'` bubble type
- [ ] Interactive notifications: normal chat layout, `'assistant'` bubble type
- [ ] Ask-question: ACK before STT, chime settle delay, STT safety timeout, `_answerSent` guard
- [ ] Ask-question: `askQuestionHandled` prevents `handleRunEnd` cleanup
- [ ] Start-conversation: clears UI before entering STT mode with `extra_system_prompt`

**Singleton & UI:**
- [ ] `window.__vsSingleton` for cross-bundle state (`instance`, `active`, `starting`)
- [ ] `isStarting()`/`setStarting()` startup lock prevents concurrent start races
- [ ] `disconnectedCallback` cancels `_pickerTeardown` before 100ms grace period for view switch detection
- [ ] Config propagated to active instance via `propagateConfig`
- [ ] Config reactivity: startup triggered when satellite_entity goes from empty to set
- [ ] Blur uses reference counting with `BlurReason` strings
- [ ] `chat.streamEl` cleared between conversation turns
- [ ] Escape key dismisses active interactions, media linger, timer alerts, and notifications (same priority as double-tap)

**Rich Media (Experimental — §16A):**
- [ ] `intent-progress` with `role: 'tool_result'` routes to weather/image/video handlers (weather checked first by tool name)
- [ ] `intent-progress` with `featured_image` routes to image panel in featured mode (narrower 25% layout)
- [ ] `intent-progress` with `get_weather_forecast` tool (matched via `.endsWith()`) routes to `chat.addWeather()` → `ui.showWeatherPanel()`
- [ ] Weather panel uses featured mode (`.weather.featured` classes, `has-featured` on global UI) — no linger timeout
- [ ] Weather panel strips container styles (`background: none`, no shadow/border/padding) — content floats over blur overlay
- [ ] `CONDITION_LABELS` maps HA condition values to display labels (15 entries)
- [ ] Forecast time varies by type: `entry.time` (hourly), `entry.date` (daily), `entry.date` + Day/Night (twice_daily)
- [ ] `hasVisibleImages()` excludes featured panels (returns `false` when `.featured` class present)
- [ ] Featured images and weather skip the 30-second linger timeout (conversational context, not browsable media)
- [ ] Chat bubble `max-height: 70vh` across all skins for longer responses (web search, Wikipedia)
- [ ] Chat messages expand to `max-width: 100%` when media panel is open (`.has-images` / `.has-featured`)
- [ ] Video results filtered by `video_id`, image results filtered by `image_url && !video_id`
- [ ] `showImagePanel`: 2-column grid (`.single` class for 1 result), `onerror` removes failed images
- [ ] `showVideoPanel`: video cards with thumbnail, duration badge, title, channel name
- [ ] `_parseDuration(iso)` converts ISO 8601 (`PT1H15M32S`) to display format (`1:15:32`)
- [ ] Inner scroll wrapper: `.vs-image-panel` (overflow: hidden) → `.vs-panel-scroll` (overflow-y: auto, padding-right: 8px)
- [ ] Lightbox: image mode (img) and video mode (iframe), tap-to-close, `_vsCloseHandler` registered once
- [ ] YouTube embed uses `youtube-nocookie.com` (avoids error 153)
- [ ] Iframe requires full permissions: `autoplay`, `encrypted-media`, `picture-in-picture`, `web-share`, `allowfullscreen`
- [ ] `_videoPlaying` flag: set by `showVideoLightbox`, cleared by `hideLightbox`
- [ ] `_videoPlaying` suppresses TTS at both play sites (streaming in `handleIntentProgress`, normal in `handleTtsEnd`)
- [ ] Image linger: 30s timeout after TTS, cancelled by scroll/lightbox/wake-word/tab-hide/double-tap/Escape
- [ ] TTS-failed linger: 5s timeout (`TTS_FAILED_LINGER`) keeps response visible when browser blocks autoplay
- [ ] Lightbox blocks linger cleanup (`isLightboxVisible()` returns early from cleanup function)
- [ ] `updateForState` refuses to hide bar during linger timeout, video playback, or lightbox
- [ ] `finishRunEnd` defers cleanup during linger timeout, video playback, or lightbox
- [ ] `auto_display` (images) / `auto_play` (videos) flags auto-open lightbox with first result
- [ ] Visibility handler checks `isLingering` independently of `INTERACTING_STATES` for tab-hide cleanup
- [ ] `clearChat()` also clears panel scroll children, hides panel, removes `has-images`/`has-featured` classes, removes `weather`/`featured` from panel, hides lightbox
- [ ] `hideLightbox()` clears iframe `src` to stop video playback

**Entity Picker (§14A):**
- [ ] localStorage key is `vs-satellite-entity`
- [ ] `resolveEntity()` validates stored entity against `hass.entities`, clears stale entries
- [ ] Auto-selects when exactly one satellite entity exists (no picker shown)
- [ ] `setConfig()`: when override enabled, localStorage takes full control; when disabled, `clearStoredEntity()` called
- [ ] Picker only shows from `set hass()` startup path (when `_hasStarted` is false), never from `setConfig()`
- [ ] `isEditorPreview()` guard prevents picker/override logic on preview instances
- [ ] `isHADialogBlocking()` checks `inert` attribute on `<home-assistant-main>` in HA's shadow DOM
- [ ] Picker deferred via `MutationObserver` when HA dialog is open, shown when dialog closes
- [ ] `disconnectedCallback` cancels pending picker observer (`_pickerTeardown`) to prevent double-picker
- [ ] Picker callback displaces stale singleton owner before calling `startListening`
- [ ] Picker uses HA theme CSS variables (`--ha-card-background`, `--primary-text-color`, etc.) with dark fallbacks
- [ ] `discoverSatelliteEntities()` filters by `platform === 'voice_satellite'` AND `assist_satellite.` prefix

**Media Player:**
- [ ] `MediaPlayerManager` receives commands via `dispatchSatelliteEvent` → `handleCommand`
- [ ] Plays audio via `playMediaUrl()`, signs relative URLs via `auth/sign_path`
- [ ] Reports state via `voice_satellite/media_player_event` WS command
- [ ] Unified audio tracking: `_activeSources` Set with `notifyAudioStart`/`notifyAudioEnd`
- [ ] 200ms debounced idle reporting to prevent flickering
- [ ] All audio sources (TTS, chimes, notifications) notify start/end
- [ ] Volume from media player entity with perceptual curve (`volume²`)
- [ ] Initial volume sync from entity state on first access (`_syncInitialVolume`)
- [ ] `_syncInitialVolume()` called at start of `_reportState` to prevent stale volume overwriting entity
- [ ] Real-time volume propagation to active TTS/notification Audio elements
- [ ] `interrupt()` called on wake word detection and notification start
- [ ] Entity lookup via `hass.entities` device_id matching (same pattern as `getSwitchState`)

**Skins:**
- [ ] All visual styling owned by skin CSS — no hardcoded gradient colors or layout values in card
- [ ] Skin resolved via `getSkin(config.skin)` in `setConfig()`, stored as `_activeSkin`
- [ ] CSS injected into `<style id="voice-satellite-styles">` by `_injectSkinCSS()`
- [ ] `background_opacity` falls back to `skin.defaultOpacity` when unset in config
- [ ] `overlayColor` from skin definition sets blur overlay `rgba()` background
- [ ] Reactive bar check centralized in `card.isReactiveBarEnabled` getter (used in 7 call sites)
- [ ] GPU hints: `will-change`/`contain` on bar, overlay, chat, timer pills; `translateZ(0)` on reactive bar (Alexa, Siri, Retro Terminal)
- [ ] Timer pill cancel plays "done" chime; timer alert dismiss plays "done" chime
- [ ] Preview respects `text_scale` (via `--vs-text-scale` inline style) and `background_opacity` (via inline `rgba()` on blur)
- [ ] Skins with `fontURL` load Google Fonts via `@import` in CSS (live card) and `<link>` injection (preview)
- [ ] Editor skin dropdown populated dynamically from `getSkinOptions()`
- [ ] Each skin has paired preview CSS for editor preview rendering

**Integration Entity Lookups:**
- [ ] `ttsTarget` computed accessor reads `tts_output` select entity via `getSelectEntityId()`
- [ ] `announcementDisplayDuration` computed accessor reads number entity via `getNumberState()`
- [ ] All entity lookups use `hass.entities` device_id + platform + translation_key pattern

**Version:**
- [ ] Single source of truth: `package.json` → `scripts/sync-version.js` propagates to `manifest.json` + `const.py`
- [ ] `__VERSION__` injected into JS via Webpack DefinePlugin
