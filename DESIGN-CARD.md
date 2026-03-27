# Voice Satellite — Frontend Design Document

> Comprehensive design reference for the Voice Satellite frontend.
> This document contains everything needed to understand, maintain, or
> recreate the frontend from scratch.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Integration Interface](#3-integration-interface)
4. [File Map](#4-file-map)
5. [Entry Point & Engine Bootstrap](#5-entry-point--engine-bootstrap)
6. [Sidebar Panel](#6-sidebar-panel)
7. [Session Singleton](#7-session-singleton)
8. [Card Types](#8-card-types)
9. [Broadcast Proxies](#9-broadcast-proxies)
10. [Manager Inventory](#10-manager-inventory)
11. [Pipeline Lifecycle](#11-pipeline-lifecycle)
12. [Audio Architecture](#12-audio-architecture)
13. [Reactive Bar & AnalyserManager](#13-reactive-bar--analysermanager)
14. [TTS & Chimes](#14-tts--chimes)
15. [Notification System](#15-notification-system)
16. [Timer System](#16-timer-system)
17. [Media Player](#17-media-player)
18. [Visibility Management](#18-visibility-management)
19. [Double-Tap / Escape Handler](#19-double-tap--escape-handler)
20. [Entity Resolution & Browser Override](#20-entity-resolution--browser-override)
21. [Editor & Preview System](#21-editor--preview-system)
22. [Skins & Styling](#22-skins--styling)
23. [Rich Media](#23-rich-media)
24. [Chat & Streaming Text](#24-chat--streaming-text)
25. [Full Card Suppression](#25-full-card-suppression)
26. [Internationalization](#26-internationalization)
27. [Constants & Configuration](#27-constants--configuration)
28. [Build & Versioning](#28-build--versioning)
29. [On-Device Wake Word Detection](#29-on-device-wake-word-detection)
30. [Implementation Checklist](#30-implementation-checklist)

---

## 1. Overview

Voice Satellite turns a browser tab into a voice satellite for Home
Assistant Assist. It acquires the microphone, streams audio to a custom
HA integration (`voice_satellite`) via WebSocket, and renders visual
feedback for each pipeline stage (wake word → STT → intent → TTS).

### 1.1 Engine + Panel Architecture (v6.0)

The frontend uses a **global engine** pattern — no dashboard card
placement is required. The integration's `frontend.py` registers the
main JS bundle via `add_extra_js_url`, so it loads on **every page**.
On load, the engine bootstraps the session singleton, resolves the
satellite entity from localStorage, and starts the voice pipeline
automatically.

Users configure settings via a **sidebar panel** (Settings → Voice
Satellite), not via a card editor. The panel stores config in
`localStorage` (`vs-panel-config` key) per-browser, so each device
can have independent settings.

### 1.2 Component Summary

| Component | Custom Element | Bundle | Purpose |
|-----------|---------------|--------|---------|
| **Engine** | *(none — runs inline)* | `voice-satellite-card.js` | Global bootstrap: session init, hass observer, auto-start |
| **Panel** | `voice-satellite-panel` | `voice-satellite-panel.js` | Sidebar settings UI: entity picker, skin/mic/debug config, live preview |
| **Full Card** | `voice-satellite-card` | `voice-satellite-card.js` | Global overlay in `document.body`. Skin-themed rainbow bar, chat bubbles, rich media panels, lightbox. Created by the engine (hidden `display:none` element) for UI rendering. **Deprecated as a dashboard card** — shows migration message if placed on a dashboard. |
| **Mini Card** | `voice-satellite-mini-card` | `voice-satellite-card.js` | In-card text display. Compact (single-row marquee) or tall (scrollable transcript). No bar, no rich media. Still available as a dashboard card. |

All components share a **session singleton** that owns all managers
(pipeline, audio, TTS, timers, notifications, etc.). Cards are thin
rendering shells that register with the session and receive broadcast
UI/chat events.

---

## 2. Architecture

### 2.1 High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Engine (src/engine/index.js) — runs on every page via add_extra_js │
│                                                                     │
│  initEngine() → waitForHass() → bootstrapEngine()                  │
│    ├── VoiceSatelliteSession.getInstance()                         │
│    ├── startHassObserver(ha, session)  — 1s polling, survives navs │
│    └── attemptStart(hass, session)    — auto_start check, entity   │
│          └── ensureEngineCard()       — hidden full card for UI    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ creates & feeds
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    VoiceSatelliteSession (singleton)                │
│                      window.__vsSession                            │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────────┐ │
│  │ Pipeline  │ │  Audio   │ │   TTS    │ │  Notification Mgrs    │ │
│  │ Manager   │ │ Manager  │ │ Manager  │ │  ┌─────────────────┐  │ │
│  └─────┬─────┘ └────┬─────┘ └────┬─────┘ │  │ Announcement    │  │ │
│        │            │            │        │  │ AskQuestion     │  │ │
│  ┌─────┴─────┐ ┌────┴─────┐     │        │  │ StartConversatn │  │ │
│  │ pipeline/  │ │ audio/   │     │        │  └─────────────────┘  │ │
│  │ events.js  │ │analyser  │     │        └────────────────────────┘ │
│  │ comms.js   │ │process.  │     │                                   │
│  └───────────┘ │chime.js  │     │        ┌──────────┐ ┌──────────┐ │
│                │media-pb. │     │        │  Timer   │ │  Media   │ │
│                └──────────┘     │        │ Manager  │ │  Player  │ │
│                                 │        └──────────┘ └──────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌───┴──────┐                           │
│  │ Double   │ │Visibility│ │Analyser  │                           │
│  │ Tap      │ │ Manager  │ │ Manager  │                           │
│  └──────────┘ └──────────┘ └──────────┘                           │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐                       │
│  │ UIBroadcastProxy │  │ChatBroadcastProxy│    _cards: Set<Card>  │
│  └────────┬─────────┘  └────────┬─────────┘                       │
│           │                     │                                   │
└───────────┼─────────────────────┼───────────────────────────────────┘
            │ broadcast           │ broadcast
   ┌────────┼─────────────────────┼────────┐
   │        ▼                     ▼        │
   │  ┌──────────┐         ┌──────────┐   │
   │  │ Full Card│         │Mini Card │   │  Registered Cards
   │  │  UIManager│         │MiniUIMgr │   │  (thin shells)
   │  │  ChatMgr │         │ ChatMgr  │   │
   │  └──────────┘         └──────────┘   │
   └───────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Sidebar Panel (src/panel/index.js) — separate webpack entry        │
│                                                                     │
│  voice-satellite-panel custom element                               │
│    ├── Entity picker (ha-form with entitySchema)                   │
│    ├── Settings form (behavior + skin + mic + debug schemas)       │
│    ├── Live preview (shadow DOM, renderPreview)                    │
│    ├── Engine status + Start/Stop buttons                          │
│    └── Config stored in localStorage (vs-panel-config)             │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Key Design Principles

1. **Engine runs globally.** The main JS loads on every page via
   `add_extra_js_url`. The engine creates the session, observes hass
   changes across page navigations, and auto-starts the pipeline when
   an entity is configured and `auto_start !== false`.

2. **Panel replaces the card editor.** All user-facing configuration
   lives in the sidebar panel. Config is stored in `localStorage`
   (`vs-panel-config`) per-browser. The panel reads/writes the same
   session singleton the engine uses.

3. **Session owns all state.** Pipeline, audio context, WebSocket
   subscription, notification queue, and timer state live on the
   singleton. Cards hold only rendering state (DOM refs, CSS classes).

4. **Manager polymorphism.** Every manager receives the session as its
   `card` constructor argument. Managers call `this._card.setState()`,
   `this._card.ui.updateForState()`, `this._card.chat.showResponse()`,
   etc. The session implements the same interface, so **zero manager code
   was changed** during the migration from per-card to session ownership.

5. **Broadcast proxies.** `session.ui` and `session.chat` are proxy
   objects that iterate `session._cards` and forward every call to each
   card's local `UIManager` / `ChatManager`. Query methods (e.g.
   `isLightboxVisible()`) aggregate with logical OR across cards.

6. **Registration lifecycle.** Cards call `session.register(this)` to
   join and `session.unregister(this)` to leave. The session auto-syncs
   new cards to the current state on registration. Full cards never
   unregister (their DOM persists in `document.body`); mini cards
   unregister after a `DISCONNECT_GRACE` timeout on disconnectedCallback.

---

## 3. Integration Interface

The frontend does not talk to HA's voice pipeline directly. All
communication is brokered through the `voice_satellite` custom
integration via WebSocket. The integration creates a device with 13
entities per config entry. A separate document (`DESIGN-INTEGRATION.md`)
covers the integration in detail; this section documents the interface
contract from the frontend's perspective.

### 3.1 Communication Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Browser (Card)                             │
│                                                                      │
│  Pipeline subscription ──ws──► voice_satellite/run_pipeline          │
│  Binary audio frames ──binary──► [handler_id][PCM Int16]             │
│  State sync ──ws──► voice_satellite/update_state                     │
│  Notification ACK ──ws──► voice_satellite/announce_finished          │
│  Question answer ──ws──► voice_satellite/question_answered           │
│  Timer cancel ──ws──► voice_satellite/cancel_timer                   │
│  Media player state ──ws──► voice_satellite/media_player_event       │
│  Event subscription ──ws──► voice_satellite/subscribe_events         │
│  URL signing ──ws──► auth/sign_path                                  │
│  Remote TTS ──service──► media_player/play_media                     │
│  Remote TTS stop ──service──► media_player/media_stop                │
│                                                                      │
│  ◄── Pipeline events (run-start, stt-end, intent-progress, etc.)    │
│  ◄── Satellite events (announcement, start_conversation, media_player)│
│  ◄── Entity state_changed (active_timers, switches, selects)        │
└──────────────────────────────────────────────────────────────────────┘
        │                                    ▲
        │ WebSocket (HA connection)          │
        ▼                                    │
┌──────────────────────────────────────────────────────────────────────┐
│                    Integration (Python)                              │
│                                                                      │
│  assist_satellite.py ──► VoiceSatelliteEntity                       │
│    ├── async_accept_pipeline_from_satellite()                       │
│    ├── async_announce() / async_start_conversation()                │
│    ├── async_internal_ask_question()                                │
│    └── Timer handler registration                                   │
│                                                                      │
│  media_player.py ──► VoiceSatelliteMediaPlayer                      │
│    └── Pushes play/pause/stop/volume commands via satellite events  │
│                                                                      │
│  ws_api.py ──► 7 WebSocket command handlers                        │
│  frontend.py ──► JS bundle serving + Lovelace resource registration │
└──────────────────────────────────────────────────────────────────────┘
        │                                    ▲
        │ HA internal APIs                   │
        ▼                                    │
┌──────────────────────────────────────────────────────────────────────┐
│                    Home Assistant Core                               │
│                                                                      │
│  Assist Pipeline (wake word → STT → intent → TTS)                   │
│  Timer Manager (intent-based timers)                                │
│  Entity Registry, State Machine, Event Bus                          │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 WebSocket API (Card → Integration)

#### 3.2.1 `voice_satellite/run_pipeline` (subscription)

**File:** `src/pipeline/comms.js`

Opens a persistent subscription. The integration bridges audio to HA's
Assist pipeline and streams events back.

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_id` | `string` | Satellite entity ID |
| `start_stage` | `string` | `'wake_word'`, `'stt'`, `'intent'`, or `'tts'` |
| `end_stage` | `string` | Same options as start_stage |
| `sample_rate` | `int` | Audio sample rate (typically 16000) |
| `conversation_id` | `string?` | For continue-conversation flows |
| `extra_system_prompt` | `string?` | Custom LLM system prompt (start_conversation) |

**Response events** (streamed back on subscription):

| Event | Key Data |
|-------|----------|
| `init` | `handler_id` — binary audio frame prefix byte |
| `run-start` | `tts_output.url` (streaming TTS), pipeline config |
| `wake_word-start` | — |
| `wake_word-end` | `wake_word.id` (empty = service error) |
| `stt-start` | — |
| `stt-vad-start` / `stt-vad-end` | Voice activity boundaries |
| `stt-end` | `stt_output.text` — transcribed text |
| `intent-start` | — |
| `intent-progress` | `chat_log_delta`, tool results, `tts_start_streaming` |
| `intent-end` | `intent_output`, `continue_conversation` flag |
| `tts-start` | — |
| `tts-end` | `tts_output.url` — audio URL to play |
| `run-end` | — |
| `error` | `code`, `message` |
| `displaced` | Another browser took over this entity |

#### 3.2.2 `voice_satellite/subscribe_events` (subscription)

**File:** `src/shared/satellite-subscription.js`

Persistent event subscription for notifications and media commands.
**Also drives entity availability:** the first subscriber makes the
entity available; the last unsubscribing makes it unavailable.

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_id` | `string` | Satellite entity ID |

**Event types pushed:**

| Type | Trigger | Data |
|------|---------|------|
| `announcement` | `assist_satellite.announce` service | `id`, `message`, `media_id`, `preannounce_media_id`, optional `preannounce: false`, optional `ask_question: true` |
| `start_conversation` | `assist_satellite.start_conversation` service | `id`, `message`, `media_id`, `preannounce_media_id`, `start_conversation: true`, optional `extra_system_prompt` |
| `media_player` | Media player service calls | `command` (play/pause/resume/stop/volume_set/volume_mute), command-specific fields |

#### 3.2.3 `voice_satellite/announce_finished`

**File:** `src/shared/notification-comms.js`

ACKs a notification after the card finishes playback. Unblocks the
integration's `async_announce` / `async_start_conversation` coroutine.

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_id` | `string` | Satellite entity ID |
| `announce_id` | `int` | Must match the event's `id` field |

#### 3.2.4 `voice_satellite/question_answered`

**File:** `src/ask-question/comms.js`

Submits the user's spoken answer to an ask_question prompt.

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_id` | `string` | Satellite entity ID |
| `announce_id` | `int` | Must match the ask_question event's `id` |
| `sentence` | `string` | Transcribed text (empty = no answer / timeout) |

**Response:** `{ success: true, matched: boolean, id: string|null }`

The integration runs hassil matching against the automation's answer
templates. `matched` tells the card whether to play a done or error chime.

#### 3.2.5 `voice_satellite/update_state`

**File:** `src/session/events.js`

Syncs the card's pipeline state to the integration entity.

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_id` | `string` | Satellite entity ID |
| `state` | `string` | Card state (IDLE, LISTENING, STT, etc.) |

**State mapping (card → HA satellite state):**

| Card State | HA State |
|-----------|----------|
| IDLE, CONNECTING, LISTENING, PAUSED, ERROR | `idle` |
| WAKE_WORD_DETECTED, STT | `listening` |
| INTENT | `processing` |
| TTS | `responding` |

#### 3.2.6 `voice_satellite/cancel_timer`

**File:** `src/timer/comms.js`

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_id` | `string` | Satellite entity ID |
| `timer_id` | `string` | Timer ID to cancel |

#### 3.2.7 `voice_satellite/media_player_event`

**File:** `src/media-player/index.js`

Reports browser audio playback state back to the integration's
media_player entity.

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_id` | `string` | Media player entity ID (not satellite) |
| `state` | `string` | `'playing'`, `'paused'`, or `'idle'` |
| `volume` | `float?` | Current volume level (0-1) |
| `media_id` | `string?` | Current media content ID |

### 3.3 Binary Audio Protocol

**File:** `src/audio/comms.js`

Audio frames are sent as binary WebSocket messages:

```
[handler_id: 1 byte] [PCM audio data: Int16LE]
```

The `handler_id` is received in the `init` event from `run_pipeline`.
HA's binary handler system routes by the first byte, then the
integration enqueues the PCM data into an `asyncio.Queue` that feeds
the Assist pipeline's audio stream.

### 3.4 Other HA Commands Used

| Command | File | Purpose |
|---------|------|---------|
| `auth/sign_path` | `media-player/index.js`, `tts/index.js` | Sign media URLs with auth token |
| `media_player/play_media` (service) | `tts/comms.js` | Remote TTS playback |
| `media_player/media_stop` (service) | `tts/comms.js` | Stop remote TTS |
| `state_changed` (event subscription) | `shared/entity-subscription.js` | Watch entity attribute changes |

#### 3.4.1 URL Signing Protocol (`auth/sign_path`)

HA media endpoints (TTS audio, notification audio) return relative paths
(e.g. `/api/tts_proxy/...`) that require authentication. The card signs
them before playback:

```
Request:  { type: 'auth/sign_path', path: '/api/tts_proxy/...', expires: 3600 }
Response: { path: '/api/tts_proxy/...?authSig=...' }
```

- **When used:** Only for relative paths (starting with `/`). Full
  `http://`/`https://` URLs are used as-is.
- **Expiry:** `AUTH_SIGN_EXPIRES` = 3600 seconds (1 hour)
- **Fallback:** On signing failure (e.g. connection dropped), use the
  unsigned URL — it will fail on authenticated endpoints but works for
  public URLs.
- **`buildMediaUrl(path)`:** Prepends `window.location.origin` to the
  signed path to produce a full playable URL.

### 3.5 Entity Architecture

Each integration config entry creates one device with 12 entities:

| Entity | Type | Unique ID Pattern | Card Reads |
|--------|------|-------------------|------------|
| Satellite | `assist_satellite` | `{entry_id}` | `active_timers`, `last_timer_event`, `muted`, `wake_sound`, `tts_target`, `announcement_display_duration` |
| Media Player | `media_player` | `{entry_id}_media_player` | `volume_level`, `is_volume_muted` |
| Pipeline | `select` | `{entry_id}-pipeline` | — (integration-side only) |
| VAD Sensitivity | `select` | `{entry_id}-vad_sensitivity` | — (integration-side only) |
| Screensaver | `select` | `{entry_id}_screensaver` | — (integration-side only) |
| TTS Output | `select` | `{entry_id}_tts_output` | — (integration reads, exposes via satellite `tts_target`) |
| Wake Word Detection | `select` | `{entry_id}_wake_word_detection` | Card reads via `getSelectState('wake_word_detection')` — "On Device" or "Home Assistant" |
| Wake Word Model | `select` | `{entry_id}_wake_word_model` | Card reads via `getSelectState('wake_word_model')` — primary keyword model name |
| Wake Word Model 2 | `select` | `{entry_id}_wake_word_model_2` | Card reads via `getSelectState('wake_word_model_2')` — second keyword model, or "No wake word" |
| Wake Word Sensitivity | `select` | `{entry_id}_wake_word_sensitivity` | Card reads via `getSelectState('wake_word_sensitivity')` — threshold label |
| Mute | `switch` | `{entry_id}_mute` | -- (integration reads, exposes via satellite `muted`) |
| Wake Sound | `switch` | `{entry_id}_wake_sound` | -- (integration reads, exposes via satellite `wake_sound`) |
| Noise Gate | `switch` | `{entry_id}_noise_gate` | Card reads via `getSwitchState('noise_gate')` -- energy-based wake word sleep mode |
| Display Duration | `number` | `{entry_id}_announcement_display_duration` | — (integration reads, exposes via satellite attribute) |

**Note:** The card reads switch/select/number values from the satellite
entity's `extra_state_attributes`, not from the individual entities
directly. The integration aggregates sibling entity states and publishes
them as satellite attributes.

### 3.6 Satellite Entity Attributes

The card reads these from `hass.states[satellite_entity].attributes`:

| Attribute | Type | Default | How Card Uses It |
|-----------|------|---------|-----------------|
| `active_timers` | `list[{id, name, total_seconds, started_at, ...}]` | `[]` | TimerManager syncs pills, computes `secondsLeft` client-side |
| `last_timer_event` | `string\|null` | `null` | `'finished'` triggers alert; `'cancelled'` silently removes pill |
| `muted` | `bool` | `false` | PipelineManager polls: if muted, pause mic and re-check every 2s |
| `wake_sound` | `bool` | `true` | If false, skip wake/done chimes |
| `tts_target` | `string` | `""` | Non-empty → remote TTS via `media_player/play_media` service |
| `announcement_display_duration` | `int` | `5` | Announcement linger timeout (seconds) |

#### 3.6.1 Entity Registry Reading Pattern

**File:** `src/shared/satellite-state.js`

Sibling entities (switches, selects, numbers) share a `device_id` with
the satellite entity. The card resolves them by scanning `hass.entities`:

```
getSelectEntityId(hass, satelliteId, translationKey):
  satellite = hass.entities[satelliteId]
  for (eid, entry) in hass.entities:
    if entry.device_id === satellite.device_id
       AND entry.platform === 'voice_satellite'
       AND entry.translation_key === translationKey:
      return hass.states[eid].attributes.entity_id
```

Same pattern for `getSwitchState()` (returns `state === 'on'`) and
`getNumberState()` (returns `parseFloat(state)`).

**Fallback chain:** If `hass.entities` metadata isn't ready (can happen
on HA frontends where the registry cache loads slowly):

1. Try `hass.entities` registry lookup (fresh, authoritative)
2. Fall back to `satellite.extra_state_attributes` (integration exposes
   these as a convenience, but they can be stale if the state-change
   listener wasn't set up in time)

| Helper | Looks Up | Returns |
|--------|----------|---------|
| `getSatelliteAttr(hass, entityId, name)` | Direct attribute read | `attributes[name]` |
| `getSwitchState(hass, entityId, translationKey)` | Switch entity by device + translation_key | `boolean\|undefined` |
| `getNumberState(hass, entityId, translationKey, default)` | Number entity by device + translation_key | `number` |
| `getSelectEntityId(hass, entityId, translationKey)` | Select entity by device + translation_key | `string` (entity_id attribute) |

### 3.7 Notification Protocol (Sequence)

```
                Card                          Integration
                 │                                 │
                 │  subscribe_events               │
                 │ ──────────────────────────────► │
                 │                                 │
                 │  (automation triggers announce) │
                 │                                 │
                 │  ◄──── announcement event ───── │  async_announce() blocks
                 │        {id, message, media_id}  │
                 │                                 │
                 │  [play chime + media]           │
                 │  [display message bubble]       │
                 │  [wait linger duration]         │
                 │                                 │
                 │  announce_finished              │
                 │  {announce_id} ──────────────► │  async_announce() unblocks
                 │                                 │
```

For `ask_question`, the flow has two phases:

```
Phase 1: Same as announcement (with ask_question: true flag)
         Card plays prompt, sends ACK → async_announce() returns

Phase 2: Card enters STT-only mode
         Card captures speech via pipeline (start_stage: 'stt', end_stage: 'stt')
         Card sends question_answered {announce_id, sentence}
         Integration runs hassil matching against answer templates
         Integration returns {matched, id} → Card plays done/error chime
```

For `start_conversation`, the card plays the prompt, sends ACK, then
enters a full pipeline via `restartContinue()` (skips wake word).

---

## 4. File Map

```
src/
├── index.js                  Entry point: registers custom elements, calls initEngine()
├── constants.js              State enum, timing, default config (incl. auto_start)
├── logger.js                 Debug logger with domain prefixes
│
├── engine/
│   └── index.js              Global engine bootstrap: session init, hass observer, auto-start
│
├── panel/
│   └── index.js              Sidebar panel: entity picker, settings, preview, engine controls
│
├── session/
│   ├── index.js              VoiceSatelliteSession singleton
│   ├── events.js             setState, startListening, onTTSComplete, handlePipelineMessage
│   ├── ui-proxy.js           UIBroadcastProxy
│   └── chat-proxy.js         ChatBroadcastProxy
│
├── card/
│   ├── index.js              VoiceSatelliteCard (full card element)
│   └── ui.js                 UIManager (global overlay DOM)
│
├── mini/
│   ├── index.js              VoiceSatelliteMiniCard element
│   ├── ui.js                 MiniUIManager (in-card DOM)
│   └── constants.js          Grid row sizing for compact/tall
│
├── pipeline/
│   ├── index.js              PipelineManager
│   ├── comms.js              subscribePipelineRun, setupReconnectListener
│   └── events.js             Pipeline event handlers (run-start through error)
│
├── audio/
│   ├── index.js              AudioManager (mic acquisition, AudioContext)
│   ├── analyser.js           AnalyserManager (dual-analyser for reactive bar)
│   ├── processing.js         AudioWorklet setup and sample rate conversion
│   ├── chime.js              Pre-rendered MP3 chime playback (wake, done, error, alert)
│   ├── media-playback.js     HTML5 Audio playback helper (buildMediaUrl, playMediaUrl)
│   └── comms.js              Binary audio frame encoding
│
├── tts/
│   ├── index.js              TtsManager (browser + remote playback, chimes)
│   └── comms.js              Remote media player service calls
│
├── announcement/
│   └── index.js              AnnouncementManager (passive notification + linger)
│
├── ask-question/
│   ├── index.js              AskQuestionManager (prompt → STT → answer → feedback)
│   └── comms.js              sendAnswer WS command
│
├── start-conversation/
│   └── index.js              StartConversationManager (prompt → full pipeline)
│
├── timer/
│   ├── index.js              TimerManager (entity subscription, sync, cancel)
│   ├── events.js             processStateChange (detect add/remove/finish)
│   ├── comms.js              sendCancelTimer WS command
│   └── ui.js                 Timer pills, ticking, finished-alert lifecycle
│
├── media-player/
│   └── index.js              MediaPlayerManager (play/pause/stop/volume, state reporting)
│
├── wake-word/                   (lazy-loaded via webpack code splitting)
│   ├── index.js              WakeWordManager (orchestrator, detection + stop model lifecycle)
│   ├── micro-models.js       TFLite WASM runtime + model/manifest loading/caching
│   ├── micro-inference.js    MicroWakeWordInference (keyword classifier + energy sleep)
│   └── micro-frontend.js    MicroFrontend (Hann → FFT → mel → sqrt → NR → PCAN → log₂ → int8)
│
├── shared/
│   ├── chat.js               ChatManager (streaming text with 24-char fade)
│   ├── double-tap.js         DoubleTapHandler (cancel interactions)
│   ├── visibility.js         VisibilityManager (tab pause/resume)
│   ├── satellite-notification.js  Dispatch, queue, playback flow for notifications
│   ├── satellite-subscription.js  WS subscription to satellite events
│   ├── satellite-state.js    Read entity attributes/switch states from HA cache
│   ├── entity-subscription.js     Generic HA entity state subscription
│   ├── entity-picker.js      Entity persistence + validation via localStorage (no auto-select)
│   ├── notification-comms.js ACK WS command for notifications
│   └── format.js             Time/price/number formatting helpers
│
├── editor/
│   ├── index.js              Full card config form schema
│   ├── behavior.js           Behavior section schema
│   ├── skin.js               Skin/appearance section schema
│   ├── preview.js            Full card editor preview renderer
│   └── preview.css            Preview styles
│
├── mini-editor/
│   ├── index.js              Mini card config form schema
│   ├── preview.js            Mini card editor preview renderer
│   └── preview.css            Preview styles
│
├── i18n/
│   ├── index.js              Translation lookup with HA locale integration
│   └── en.js                 English translations (default)
│
└── skins/
    ├── index.js              Skin registry (lazy-loaded, getSkin/loadSkin/getSkinOptions)
    ├── default.js + .css     Default skin (bundled in main)
    ├── default-preview.css   Default skin preview styles (bundled)
    ├── alexa.js + .css       Alexa skin (lazy-loaded chunk)
    ├── google-home.js + .css Google Home skin (lazy-loaded chunk)
    ├── home-assistant.js + .css  Home Assistant skin (lazy-loaded chunk)
    ├── siri.js + .css        Siri skin (lazy-loaded chunk)
    └── retro-terminal.js + .css  Retro Terminal skin (lazy-loaded chunk)
```

---

## 5. Entry Point & Engine Bootstrap

### 5.1 Entry Point

**File:** `src/index.js`

```javascript
customElements.define('voice-satellite-card', VoiceSatelliteCard)
customElements.define('voice-satellite-mini-card', VoiceSatelliteMiniCard)

// Only the mini card is registered for dashboard use
window.customCards.push({ type: 'voice-satellite-mini-card', ... })

// Start the global engine (runs on every page, not just dashboards)
initEngine()
```

The main JS bundle is loaded globally via `add_extra_js_url` in the
integration's `frontend.py`. The full card is **not** registered in
`window.customCards` — it is deprecated as a dashboard card. If a user
still has one on their dashboard, it shows a deprecation message
directing them to the sidebar panel.

### 5.2 Engine Bootstrap

**File:** `src/engine/index.js`

The engine runs on every page load. It creates the session singleton,
starts a continuous hass observer, and auto-starts the pipeline.

```
initEngine()
├── Guard: window.__vsEngine already set? → return
├── Log styled banner: [VOICE-SATELLITE-ENGINE v6.0.0]
└── bootstrapEngine()
    ├── waitForHass()  → poll for home-assistant element with hass.connection
    ├── VoiceSatelliteSession.getInstance()
    ├── startHassObserver(ha, session)
    │   └── setInterval(1000ms): feed hass updates, re-attempt start if not running
    └── attemptStart(hass, session)
        ├── Guard: isStarted, _starting, _userStopped → return
        ├── Guard: auto_start === false (from localStorage) → return
        ├── resolveEntity(hass) → look up satellite entity from localStorage (no auto-select)
        ├── Merge config: DEFAULT_CONFIG + localStorage + entity
        ├── ensureEngineCard(hass, session, config)
        │   └── If no cards registered: create hidden voice-satellite-card
        │       element in document.body (_engineOwned = true)
        └── requestAnimationFrame → session.start()
```

**Key design decisions:**

- **`auto_start` check:** Reads `vs-panel-config` from localStorage. When
  `auto_start === false`, the engine does not start automatically. The
  user must click the Start button in the panel.
- **`_userStopped` flag:** Set when the user explicitly stops the engine
  (via panel Stop button or toggling auto_start off). Prevents the hass
  observer from re-starting the engine.
- **Engine card:** A hidden `voice-satellite-card` element is created in
  `document.body` so the global UI overlay (rainbow bar, start button,
  chat bubbles) renders even without any dashboard card. The card is
  marked `_engineOwned = true` and has `display: none`.
- **`waitForHass()`:** Polls every 200ms for the `home-assistant` element
  with a valid `hass.connection`. Waits for `DOMContentLoaded` first if
  still loading.
- **Hass observer:** A 1-second `setInterval` that feeds hass updates to
  the session and re-attempts entity resolution if the session hasn't
  started yet (covers the case where the integration was just added).

---

## 6. Sidebar Panel

**File:** `src/panel/index.js`

The panel is a separate webpack entry point (`voice-satellite-panel.js`)
registered as a sidebar panel via `async_register_built_in_panel` in
`frontend.py`. It uses the `ha-panel-custom` pattern.

### 6.1 Panel Registration (Integration Side)

```python
async_register_built_in_panel(
    hass,
    component_name="custom",
    sidebar_title="Voice Satellite",
    sidebar_icon="mdi:microphone-message",
    frontend_url_path="voice-satellite",
    require_admin=False,
    config={
        "_panel_custom": {
            "name": "voice-satellite-panel",
            "js_url": f"/voice_satellite/voice-satellite-panel.js?v={VERSION}",
        }
    },
)
```

### 6.2 Panel Element

```javascript
class VoiceSatellitePanel extends HTMLElement {
  set hass(hass)   { /* renders on first hass, updates forms */ }
  set narrow(n)    { /* unused */ }
  set route(r)     { /* unused */ }
  set panel(p)     { /* unused */ }
}
customElements.define('voice-satellite-panel', VoiceSatellitePanel)
```

**Light DOM:** The panel uses light DOM (no shadow root) because
`ha-panel-custom` renders panels in light DOM and HA components like
`ha-form` break inside nested shadow roots.

### 6.3 Config Persistence

Config is stored in `localStorage` under the key `vs-panel-config`:

```javascript
const CONFIG_KEY = 'vs-panel-config';
function getStoredConfig() { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; }
function setStoredConfig(config) { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }
```

Both the engine and panel read from the same key. Changes in the panel
are immediately propagated to the running session via
`session.updateConfig()`.

### 6.4 Panel Structure

The panel renders a toolbar + content area:

```
┌─────────────────────────────────────────────┐
│  [icon] Voice Satellite       v6.0.0  [?]   │  ← toolbar (HA-native style)
├─────────────────────────────────────────────┤
│  Engine Status Card                          │  ← running/dormant + Start/Stop
│  Satellite Entity Card                       │  ← ha-form entity picker
│  Preview Card                                │  ← shadow DOM skin preview
│  Settings Card                               │  ← ha-form with all schemas
└─────────────────────────────────────────────┘
```

**Toolbar:** Matches the standard HA toolbar pattern (like Browser Mod):
- Uses `--header-height`, `--app-header-background-color`,
  `--app-header-text-color` CSS variables
- Brand icon (`/voice_satellite/brand/icon.png`) + title + version + help link

### 6.5 Engine Controls

The panel provides Start/Stop buttons that directly control the session:

**Start button:**
```javascript
startBtn.addEventListener('click', () => {
  const session = window.__vsSession;
  if (session && !session.isStarted && config.satellite_entity) {
    // Ensure an engine card exists for UI rendering
    if (session._cards.size === 0) {
      const card = document.createElement('voice-satellite-card');
      card._engineOwned = true;
      card.setConfig(config);
      card.style.display = 'none';
      document.body.appendChild(card);
      card.hass = this._hass;
    }
    session._userStopped = false;
    session._startAttempted = false;
    requestAnimationFrame(() => { if (!session.isStarted) session.start(); });
  }
});
```

**Stop button:** Sets `session._userStopped = true`, calls
`session.teardown()`.

### 6.6 Config Change Handler

`_onConfigChange(newData)` handles all settings changes:

1. Merge with `DEFAULT_CONFIG`, save to localStorage
2. Sync entity to dedicated storage (`setStoredEntity`)
3. Update running session (`session.updateConfig()`)
4. If entity configured + `auto_start !== false` + not started → create
   engine card + start session
5. If entity cleared or `auto_start === false` + started → stop session
   (sets `_userStopped` when auto_start toggled off)
6. Sync both ha-form instances with updated data
7. Re-render preview

### 6.7 Settings Schema

The panel assembles its form schema from the same editor modules used
by the card editors:

```javascript
const panelSchema = [
  ...behaviorSchema,    // browser_satellite_override, debug
  ...autoStartSchema,   // auto_start toggle
  ...skinSchema,        // skin, reactive_bar, text_scale, opacity, custom_css
  ...microphoneSchema,  // noise_suppression, echo_cancellation, etc.
  ...debugSchema,       // debug toggle
];
```

### 6.8 Engine Status Display

The panel polls session state every 1 second to update:
- **Engine status:** "Engine running" (green) or "Engine dormant" (orange)
- **Pipeline state:** Colored dot + label (Idle, Listening, Speaking, etc.)
- **Start/Stop button visibility:** Based on `isStarted` and entity config

### 6.9 HA Component Loading

The panel needs `ha-form` and `ha-entity-picker`, which are lazy-loaded
by HA. `ensureHaComponents()` triggers their loading:

```
ensureHaComponents()
├── customElements.get('ha-form') exists? → done
├── Resolve partial-panel-resolver → load lovelace route
├── loadCardHelpers() → triggers ha-form import side-effect
└── Fallback: iterate card types until ha-form is defined
```

### 6.10 Logger

**File:** `src/logger.js`

A single `Logger` instance lives on the session. All managers receive it
via `card.logger`.

```
logger.debug = config.debug;     // Toggle via card config

logger.log(category, msg, data); // No-op when debug=false
logger.error(category, msg, data); // Always logs (console.error)
```

Output format: `[VS][category] message` + optional data object.

Categories used throughout the codebase:

| Category | Used By |
|----------|---------|
| `state` | setState transitions |
| `pipeline` | Pipeline lifecycle, start/stop/restart |
| `tts` | TTS playback, streaming, chimes |
| `error` | Pipeline errors, intent errors |
| `recovery` | Service unavailable recovery |
| `mic` | Microphone access errors |
| `media-player` | Media playback, volume, state reporting |
| `analyser` | Reactive bar tick loop, perf stats |
| `visibility` | Tab hide/show, pause/resume |
| `event` | Pipeline event dispatch (when debug=true) |
| `lifecycle` | Session start/stop |
| `session` | Card registration, config changes |
| `ui` | UI cleanup, bar state, linger |
| `timer` | Timer sync, cancellation |
| `announcement` | Notification playback |
| `wake-word` | On-device wake word detection, model loading, inference |

---

## 7. Session Singleton

**File:** `src/session/index.js`

The `VoiceSatelliteSession` is stored at `window.__vsSession`. Multiple
bundle loads (e.g. HACS + custom) share the same instance. Created lazily
on first `getInstance()` call.

### 7.1 Construction

The constructor instantiates all 11 core managers, passing `this` as the
`card` argument. The `WakeWordManager` is **lazy-loaded** — its chunk is
only fetched when on-device wake word detection is enabled.

```
this._audio       = new AudioManager(this)
this._analyser    = new AnalyserManager(this)
this._tts         = new TtsManager(this)
this._pipeline    = new PipelineManager(this)
this._doubleTap   = new DoubleTapHandler(this)
this._visibility  = new VisibilityManager(this)
this._timer       = new TimerManager(this)
this._announcement = new AnnouncementManager(this)
this._askQuestion  = new AskQuestionManager(this)
this._startConversation = new StartConversationManager(this)
this._mediaPlayer  = new MediaPlayerManager(this)

this._wakeWord    = null          // lazy-loaded on demand
this._wakeWordLoading = false

this._uiProxy     = new UIBroadcastProxy(this)
this._chatProxy   = new ChatBroadcastProxy(this)
```

**Lazy loading:** `_loadWakeWordModule()` uses `import(/* webpackChunkName:
"wake-word" */ '../wake-word')` to load the entire wake-word chunk on first
activation. The chunk includes the WakeWordManager, inference pipeline, and
model-loading code. The TFLite WASM runtime is loaded separately at
runtime from `/voice_satellite/tflite/` (not bundled in any chunk).

### 7.2 Card Interface

The session exposes the same getters/methods that managers expect from a
card instance:

| Getter | Returns |
|--------|---------|
| `logger` | Session-level Logger |
| `audio`, `analyser`, `tts`, `pipeline`, ... | Manager instances |
| `ui` | UIBroadcastProxy (not a real UIManager) |
| `chat` | ChatBroadcastProxy (not a real ChatManager) |
| `config` | Merged session-relevant config |
| `hass` | Latest HA frontend object |
| `connection` | HA WebSocket connection |
| `currentState` | Pipeline state enum value |
| `isOwner` | Always `true` |
| `isReactiveBarEnabled` | `true` if ANY registered card wants it |
| `ttsTarget` | Remote TTS entity ID (from select entity) |
| `announcementDisplayDuration` | Seconds (from number entity) |

### 7.3 Card Registration

```
register(card)
├── Guard: already registered? editor preview? → skip
├── Evict stale full card (only one full card allowed)
├── card.ensureUI() → creates DOM
├── _cards.add(card)
├── If session running: sync state to new card
│   ├── hideStartButton()
│   ├── updateForState(current state)
│   └── If reactive bar now enabled + mic active → attachMic()
├── _syncFullCardSuppression()
└── Deferred rAF: re-check isEditorPreview (guard false negatives)
```

```
unregister(card)
├── WARNING trace if card is full type
├── _cards.delete(card)
└── _syncFullCardSuppression()
```

### 7.4 Session Startup

```
start()  or  registerAndStart(card)
└── startListening(session)     [session/events.js]
    ├── setState(CONNECTING)
    ├── audio.startMicrophone()     → getUserMedia + AudioWorklet
    ├── pipeline.start()            → WS subscribe + binary handler
    ├── ui.hideStartButton()
    ├── visibility.setup()          → tab pause/resume listener
    ├── timer.update()              → entity subscription
    ├── subscribeSatelliteEvents()  → notification subscription
    └── doubleTap.setup()           → document-level listeners
```

### 7.5 Session Teardown

```
teardown()
├── pipeline.stop()
├── audio.stopMicrophone()
├── tts.stop()
├── timer.destroy()
├── teardownSatelliteSubscription()
├── visibility.teardown()
└── Reset flags (_hasStarted, _starting, _startAttempted)
```

### 7.6 Config Merging

`updateConfig(config)` copies only session-relevant keys:

```
satellite_entity, debug, browser_satellite_override,
echo_cancellation, noise_suppression, auto_gain_control,
voice_isolation, reactive_bar, reactive_bar_update_interval_ms
```

Card-specific keys (skin, mini_mode, text_scale, custom_css, etc.)
stay on the card instance. If `satellite_entity` changes while the
session is running, the session tears down for a fresh start.

### 7.7 setState Broadcast Chain

**File:** `src/session/events.js`

`setState()` is the central state propagation mechanism:

```
setState(session, newState)
├── session.currentState = newState
├── logger.log('state', 'OLD -> NEW')
├── session.ui.updateForState(newState, serviceUnavailable, ttsPlaying)
│   └── UIBroadcastProxy → calls updateForState() on every registered card UI
│       ├── Full card UIManager: bar animation, blur overlay, start button
│       └── Mini card MiniUIManager: dot color, status text, start button
├── TTS guard: if TTS is playing AND newState is LISTENING or IDLE → skip sync
│   (prevents premature idle sync during barge-in restart)
└── syncSatelliteState(session, newState)
    ├── Dedup: skip if state === lastSyncedSatelliteState
    └── WS fire-and-forget: voice_satellite/update_state { entity_id, state }
```

Key design decisions:
- Broadcasts are **fire-and-forget** — no return value, no feedback loop
- The TTS guard prevents the pipeline from syncing IDLE/LISTENING back to
  HA while TTS is still playing (barge-in creates a new pipeline before
  TTS finishes — syncing would confuse the integration)
- `lastSyncedSatelliteState` prevents duplicate WS messages when multiple
  events trigger the same logical state

---

## 8. Card Types

### 8.1 Full Card — `VoiceSatelliteCard`

**Files:** `src/card/index.js`, `src/card/ui.js`

- **DOM:** Injects a `#voice-satellite-ui` div into `document.body`.
  Exact HTML structure:
  ```html
  <div id="voice-satellite-ui">
    <div class="vs-blur-overlay"></div>
    <button class="vs-start-btn">
      <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 ..."/></svg>
    </button>
    <div class="vs-chat-container"></div>
    <div class="vs-image-panel">
      <div class="vs-panel-scroll"></div>
    </div>
    <div class="vs-lightbox">
      <img class="vs-lightbox-img" />
      <iframe class="vs-lightbox-iframe" ...></iframe>
    </div>
    <div class="vs-rainbow-bar"></div>
  </div>
  ```
  Z-index stacking: blur=9999, bar=10000, btn/chat/panel=10001,
  lightbox=10002. Timer container and timer alerts are injected
  dynamically into `document.body` (not inside `#voice-satellite-ui`).
- **`cardType`:** `'full'`
- **`isReactiveBarEnabled`:** `true` if the active skin has
  `reactiveBar: true` AND config `reactive_bar !== false`.
- **`getCardSize()`:** Returns `0` (overlay, no grid space).
- **Lifecycle:**
  - `connectedCallback`: Calls `_render()`, then rAF checks for editor
    preview. If not preview, resolves entity and calls
    `session.registerAndStart()`.
  - `disconnectedCallback`: Does **NOT** unregister. The full card's DOM
    persists in `document.body` across HA dashboard navigations. Stale
    instances are evicted by `session.register()` when a new full card
    joins.
  - `set hass(h)`: Forwards to `session.updateHass()`. Registers with
    session if running but not yet registered.
  - `setConfig(c)`: Full config propagation chain:
    1. Merge with `DEFAULT_CONFIG`
    2. Resolve skin (`getSkin()`)
    3. Set `logger.debug`
    4. Apply browser override (localStorage entity lookup)
    5. Re-apply UI styles (skin CSS, custom CSS, text scale, opacity)
    6. Re-evaluate reactive bar (attach/detach mic analyser)
    7. Re-sync `updateForState()` with current state
    8. Render editor preview if in editor
    9. Forward session-relevant keys to `session.updateConfig()`
    10. If entity was just configured + session not running → start

### 8.2 Mini Card — `VoiceSatelliteMiniCard`

**Files:** `src/mini/index.js`, `src/mini/ui.js`, `src/mini/constants.js`

- **DOM:** Renders inside its own Shadow DOM. Exact template:
  ```html
  <style id="vs-mini-style">${MINI_CSS}</style>
  <style id="vs-mini-custom-style"></style>
  <ha-card class="vs-mini-card-shell">
    <div class="vs-mini-root compact|tall">
      <div class="vs-mini-surface">
        <div class="vs-mini-blur"></div>
        <div class="vs-mini-header">
          <span class="vs-mini-dot"></span>
          <div class="vs-mini-status">Idle</div>
        </div>
        <div class="vs-mini-body">
          <div class="vs-mini-timers"></div>
          <div class="vs-mini-line">             <!-- compact mode -->
            <span class="vs-mini-line-inner"></span>
          </div>
          <button class="vs-mini-start">Start</button>
          <div class="vs-mini-bar"></div>         <!-- notification bar -->
          <div class="vs-mini-transcript"></div>  <!-- tall mode -->
        </div>
      </div>
    </div>
  </ha-card>
  ```
  Element references are cached: `_root`, `_shellEl`, `_surface`,
  `_statusEl`, `_dotEl`, `_lineEl`, `_lineTrackEl`, `_transcriptEl`,
  `_timersEl`, `_startBtn`, `_barEl`.
- **`cardType`:** `'mini'`
- **`isReactiveBarEnabled`:** Always `false`.
- **`getCardSize()`:** Returns grid row count based on `mini_mode`.
- **Lifecycle:**
  - `connectedCallback`: Clears disconnect timeout, renders, rAF checks
    for preview, registers with session.
  - `disconnectedCallback`: Tears down picker/preview, then sets a
    `DISCONNECT_GRACE` (100ms) timeout. If still disconnected when it
    fires, calls `session.unregister(this)`.
  - `set hass(h)`: Same entity resolution + registration logic as full.
  - `setConfig(c)`: Same config + session forwarding as full.

### 8.3 Common Card Structure

Both cards follow the same delegation pattern:

```javascript
// Session access
get _session() { return VoiceSatelliteSession.getInstance(); }

// Card-local managers (rendering only)
get ui()   { return this._ui; }    // UIManager or MiniUIManager
get chat() { return this._chat; }  // ChatManager

// Session-delegating getters
get audio()    { return this._session?.audio; }
get pipeline() { return this._session?.pipeline; }
get ttsTarget(){ return this._session?.ttsTarget ?? ''; }
// ... all 11 managers + ttsTarget

// State delegation
get currentState()  { return this._session?.currentState ?? State.IDLE; }
set currentState(v) { if (this._session) this._session.currentState = v; }

// Event callbacks (UI click handlers → session)
setState(s)              { this._session.setState(s); }
onStartClick()           { this._session.onStartClick(); }
onPipelineMessage(msg)   { this._session.onPipelineMessage(msg); }
onTTSComplete(failed)    { this._session.onTTSComplete(failed); }
```

---

## 9. Broadcast Proxies

### 9.1 UIBroadcastProxy

**File:** `src/session/ui-proxy.js`

The session's `ui` property returns this proxy. Every method iterates
`session._cards` and calls `card.ui.methodName(args)` on each.

**Broadcast methods** (fire on ALL card UIs):

```
updateForState          showBlurOverlay       hideBlurOverlay
showServiceError        clearServiceError     hideBar
showStartButton         hideStartButton       stopReactive
startReactive           setAnnouncementMode   clearAnnouncementBubbles
clearNotificationStatusOverride   onNotificationStart
onNotificationDismiss   addChatMessage        updateChatText
clearChat               showImagePanel        showVideoPanel
showWeatherPanel        showFinancialPanel    showLightbox
showVideoLightbox       hideLightbox
ensureTimerContainer    removeTimerContainer  syncTimerPills
updateTimerPill         expireTimerPill       showTimerAlert
clearTimerAlert         _scrollTranscriptToEnd
```

**Query methods** (aggregate across cards):

| Method | Aggregation |
|--------|-------------|
| `isLightboxVisible()` | Any card returns `true` |
| `hasVisibleImages()` | Any card returns `true` |
| `getTtsLingerTimeoutMs()` | Maximum across all cards |
| `element` | First card's UI element |

**Special handling:**

- `syncTimerPills`: Each UI creates its own pill elements. Per-UI
  references are stored in `timer._uiEls` (a Map keyed by card) so
  `updateTimerPill` works independently for each card's DOM.
- `onNotificationStart`: Returns `true` if ANY card's bar was visible.
- `showTimerAlert`: Skips full card when `_fullCardSuppressed` is true
  (timer alerts render in `document.body` outside `#voice-satellite-ui`).

### 9.2 ChatBroadcastProxy

**File:** `src/session/chat-proxy.js`

The session's `chat` property returns this proxy.

**Shared state:**
- `streamedResponse`: Accumulated streaming text, stored on the proxy
  (not per-card). Pipeline events read/write `session.chat.streamedResponse`.

**streamEl getter/setter:**
- Getter: returns the first card's `chat.streamEl` that is truthy.
- Setter: when set to `null`, clears ALL card ChatManagers' `streamEl`.
  Non-null values are not set from session level (each card manages its
  own via `addAssistant`).

**Broadcast methods:**

```
showTranscription   showResponse   updateResponse
addUser   addAssistant   addImages   addVideos
addWeather   addFinancial   clear
```

---

## 10. Manager Inventory

All managers are constructed in the session with `this` (session) as
their `card` argument. They access the pipeline/audio/TTS/UI through
`this._card.X`, which resolves to session properties.

| # | Manager | File | Responsibility |
|---|---------|------|----------------|
| 1 | `AudioManager` | `audio/index.js` | Mic acquisition, AudioContext, AudioWorklet, send interval |
| 2 | `AnalyserManager` | `audio/analyser.js` | Dual-analyser for reactive bar (mic + audio) |
| 3 | `TtsManager` | `tts/index.js` | Browser/remote TTS playback, chimes, streaming URL |
| 4 | `PipelineManager` | `pipeline/index.js` | WS pipeline subscription, restart, retry, mute polling |
| 5 | `DoubleTapHandler` | `shared/double-tap.js` | Document-level double-tap/escape to cancel interactions |
| 6 | `VisibilityManager` | `shared/visibility.js` | Tab pause/resume, AudioContext suspend/resume |
| 7 | `TimerManager` | `timer/index.js` | Entity subscription, countdown sync, pill DOM, alerts |
| 8 | `AnnouncementManager` | `announcement/index.js` | Passive notification: play → linger → cleanup |
| 9 | `AskQuestionManager` | `ask-question/index.js` | Interactive: play prompt → STT → answer → feedback |
| 10 | `StartConversationManager` | `start-conversation/index.js` | Play prompt → enter full pipeline conversation |
| 11 | `MediaPlayerManager` | `media-player/index.js` | Browser media playback + unified audio-state reporting |
| 12 | `WakeWordManager` | `wake-word/index.js` | On-device wake word detection via TFLite (lazy-loaded) |

---

## 11. Pipeline Lifecycle

### 11.1 Pipeline Flow Diagram

```
pipeline.start()
│
├── Check mute state → if muted, poll every 2s
├── subscribePipelineRun(connection, entity, config, onMessage)
│   └── WS: voice_satellite/run_pipeline
│       Returns init event with binary handler ID
├── Wait for init event (handler_id)
├── Discard stale audio buffer
├── audio.startSending(() => this._binaryHandlerId)
│
│   ┌──── Pipeline Events (onMessage → session.onPipelineMessage) ────┐
│   │                                                                  │
│   │  run-start ──► Store streaming TTS URL                          │
│   │             ──► setState(LISTENING or STT if continue)          │
│   │                                                                  │
│   │  wake_word-start ──► Service recovery check                     │
│   │                                                                  │
│   │  wake_word-end ──► Validate output (empty = service error)      │
│   │                ──► Play wake chime (if wake_sound switch on)    │
│   │                ──► setState(WAKE_WORD_DETECTED)                 │
│   │                ──► showBlurOverlay(PIPELINE)                    │
│   │                                                                  │
│   │  stt-start ──► setState(STT)                                    │
│   │  stt-end ──► showTranscription(text)                            │
│   │           ──► invoke askQuestionCallback if present             │
│   │                                                                  │
│   │  intent-start ──► setState(INTENT)                              │
│   │  intent-progress ──► Stream response text (chat_log_delta)      │
│   │                  ──► Handle tool results (images, videos, etc.) │
│   │                  ──► Early streaming TTS start                  │
│   │  intent-end ──► Show final response text                        │
│   │             ──► Store continue_conversation state               │
│   │                                                                  │
│   │  tts-start ──► setState(TTS)                                    │
│   │  tts-end ──► Play TTS audio (browser or remote)                │
│   │           ──► pipeline.restart(0)                               │
│   │                                                                  │
│   │  run-end ──► finishRunEnd() or defer if TTS playing            │
│   │  error ──► Expected: restart immediately                       │
│   │         ──► Unexpected: show error, linear backoff retry       │
│   │  displaced ──► teardown() + show start button                  │
│   └──────────────────────────────────────────────────────────────────┘
```

### 11.2 Generation Counter

`_pipelineGen` is incremented by `stop()`. Any in-flight `start()` call
checks the generation after each `await` and aborts if it was
superseded. This prevents stale subscriptions from clobbering active
ones.

### 11.3 Restart Modes

Three distinct restart paths:

| Method | Start Stage | Use Case |
|--------|-------------|----------|
| `restart(delay)` | `wake_word` (default) | Normal cycle, error recovery, mute/unmute |
| `restartContinue(conversationId, opts)` | `stt` | Continue-conversation, ask-question STT capture |
| (fresh start via `startListening`) | `wake_word` | First boot, entity picker change, reconnect |

All restart paths guard against concurrent calls with `_isRestarting`.
The sequence is always: `stop()` → delay → `start(opts)`.

`restartContinue` sets `_continueMode = true` so that `handleRunStart`
enters STT state directly (skipping LISTENING). It optionally stores an
`askQuestionCallback` for STT-only pipelines (ask_question flow) and
supports `extra_system_prompt` for start_conversation.

### 11.4 Error Recovery

**File:** `src/pipeline/events.js`

Errors are bifurcated into two classes:

**Expected errors** (silent restart):
```
EXPECTED_ERRORS = [
  'timeout',
  'wake-word-timeout',
  'stt-no-text-recognized',
  'duplicate_wake_up_detected',
]
```

```
handleError(expected)
├── hideBlurOverlay(PIPELINE)  ← always, even if not in INTERACTING state
│     (duplicate_wake_up_detected arrives after run-start has already
│      moved state to LISTENING, but the overlay from _onDetection is still up)
├── Clean up interaction UI (if in INTERACTING state):
│   setState(IDLE), chat.clear(), play done chime
└── restart(0)   ← immediate, no backoff
```

**Unexpected errors** (error UI + backoff):
```
handleError(unexpected)
├── Play error chime (if was interacting)
├── ui.showServiceError()  ← red gradient bar
├── serviceUnavailable = true
├── chat.clear(), hideBlurOverlay
└── restart(calculateRetryDelay())
    └── Linear backoff: RETRY_BASE_DELAY * retryCount
        capped at MAX_RETRY_DELAY (30s)
        Reset on successful reconnect or valid wake word detection
```

**Service unavailable state machine** (wake word service down):
```
handleWakeWordEnd(empty output):
├── binaryHandlerId = null
├── ui.showServiceError()
├── serviceUnavailable = true
└── restart(calculateRetryDelay())

handleWakeWordStart() while serviceUnavailable:
└── Start recovery timeout (2s) — if still serviceUnavailable after
    timeout, clear error and resume (service recovered)

handleWakeWordEnd(valid output):
└── serviceUnavailable = false, retryCount = 0, clearServiceError()
```

### 11.5 Mute Polling

When `getSwitchState(mute) === true`, `start()` skips the WS subscription
and instead sets a 2s poll timer that re-calls `start()`. On unmute the
next poll succeeds and the pipeline starts normally.

### 11.6 Token Refresh

Streaming TTS tokens have a server-side TTL. The pipeline restarts
periodically (`TOKEN_REFRESH_INTERVAL` = 4 minutes) while idle in
LISTENING state to allocate a fresh token.

### 11.7 Reconnect Handling

**File:** `src/pipeline/comms.js`

```
setupReconnectListener(card, pipeline, connection, listenerRef)
├── Guard: if listenerRef.listener exists → already registered
├── Create handler:
│   ├── pipeline.resetRetryState()    ← retryCount=0, clear timeouts
│   ├── ui.clearServiceError()
│   ├── If tab paused → defer (visibility._resume will restart)
│   └── setTimeout(() => pipeline.restart(0), RECONNECT_DELAY=2000ms)
└── connection.addEventListener('ready', handler)
```

The `'ready'` event is fired by the HA WebSocket client after a
successful reconnection. The 2s delay (`RECONNECT_DELAY`) gives HA
time to finish re-initializing before the pipeline subscribes.

### 11.8 Stale Event Filtering

Multiple guards prevent stale events from corrupting state:

- **Generation counter** (`_pipelineGen`): Stale `start()` calls abort
- **`_runStartReceived`**: Events before `run-start` are ignored
- **`_wakeWordPhase`**: `run-end` during wake word phase → restart
  (server-side pipeline ended unexpectedly)
- **`visibility.isPaused`**: All events blocked while tab is hidden
- **`isRestarting`**: Events blocked during restart sequence

---

## 12. Audio Architecture

### 12.1 AudioManager

**File:** `src/audio/index.js`

```
startMicrophone()
├── _ensureAudioContextRunning()
│   ├── new AudioContext({ sampleRate: 16000 })
│   └── resume() with 800ms timeout (browser gesture requirement)
├── getUserMedia({ audio: constraints })
│   └── sampleRate, channelCount=1, echoCancellation, noiseSuppression,
│       autoGainControl, voiceIsolation (advanced constraint)
├── createMediaStreamSource(stream)
├── If isReactiveBarEnabled: analyser.attachMic(sourceNode, audioContext)
└── setupAudioWorklet(this, sourceNode)
    └── AudioWorkletProcessor → buffers PCM frames
```

```
startSending(binaryHandlerIdGetter)
└── setInterval(100ms): encode + send audio buffer via WS binary

stopMicrophone()
├── stopSending()
├── workletNode.disconnect()
├── analyser.detachMic(sourceNode)
├── sourceNode.disconnect()
└── mediaStream.getTracks().forEach(stop)

pause()  → disable tracks + stop sending
resume() → flush stale buffer, re-enable tracks, resume AudioContext
```

### 12.2 AnalyserManager (Dual-Analyser)

**File:** `src/audio/analyser.js`

Two separate `AnalyserNode` instances prevent mic audio from ever being
routed to speakers:

```
Mic Path (analysis only, NO destination):
  sourceNode ──► _micAnalyser   (getByteTimeDomainData for bar)

Audio Path (playback + analysis):
  mediaElementSource ──► _audioAnalyser ──► audioContext.destination

_activeAnalyser: points to whichever node _tick() reads from
```

**Key methods:**

| Method | Effect |
|--------|--------|
| `attachMic(source, ctx)` | Creates `_micAnalyser`, connects source. Sets as active if no audio playing. |
| `detachMic(source)` | Disconnects source from mic analyser. Clears active if it was mic. |
| `attachAudio(audioEl, ctx)` | Creates `_audioAnalyser`, routes through destination. Switches active. Auto-starts deferred tick. |
| `detachAudio()` | Disconnects audio path. Sets active to `null` (NOT mic). |
| `reconnectMic()` | Switches active back to mic analyser. No-op if `_mediaSourceNode` exists (audio still playing). |
| `start(barEl, {deferred})` | Stores bar element, starts rAF tick loop. If `deferred`, waits for `attachAudio()` to auto-start. |
| `stop()` | Cancels rAF, resets CSS variable `--vs-audio-level`, clears bar ref. |

**Tick loop (`_tick`):**
- Capped at configurable FPS (default ~30fps via `reactive_bar_update_interval_ms`).
- Reads `getByteTimeDomainData`, computes mean absolute amplitude.
- Quantizes to 0.05 steps, writes `--vs-audio-level` CSS variable.
- Performance logging every 1 second (debug mode).

### 12.3 Audio Processing

**File:** `src/audio/processing.js`

#### 11.3.1 AudioWorklet Processor (Inline Blob)

The processor is defined as an inline string, compiled into a Blob URL,
and loaded via `audioWorklet.addModule()`:

```javascript
class VoiceSatelliteProcessor extends AudioWorkletProcessor {
  process(inputs) {
    if (inputs[0]?.[0]) {
      this.port.postMessage(new Float32Array(inputs[0][0]));
    }
    return true;
  }
}
registerProcessor("voice-satellite-processor", VoiceSatelliteProcessor);
```

Each `process()` call posts a `Float32Array` chunk (~128 samples) to the
main thread via `port.postMessage`.

#### 11.3.2 Silent Gain Node Pattern

```
sourceNode → workletNode → silentGain (gain=0) → destination
```

The silent gain node keeps the audio graph alive (browsers garbage-collect
disconnected nodes) without routing mic audio to the speakers. The
worklet only taps audio for analysis — it never produces output.

#### 11.3.3 Buffer, Resample, Convert

`sendAudioBuffer()` runs on a periodic schedule:

1. **Combine** all queued `Float32Array` chunks into a single buffer
2. **Resample** via linear interpolation if native rate ≠ 16kHz:
   `ratio = fromRate / 16000`, output[i] = lerp(input, i * ratio)
3. **Convert** Float32 → Int16 PCM with clipping:
   `s < 0 ? s * 0x8000 : s * 0x7FFF` (clamps to [-1, 1] first)
4. **Send** via `sendBinaryAudio(card, pcmData, handlerId)`

### 12.4 Audio Binary Encoding

**File:** `src/audio/comms.js`

Audio frames are packed into a binary WebSocket message:
`[handlerId (1 byte)] [PCM data (Int16)]`

### 12.5 Media Playback Helper

**File:** `src/audio/media-playback.js`

- `buildMediaUrl(path)`: Prepends `window.location.origin` to relative
  paths.
- `playMediaUrl(url, volume, callbacks)`: Creates an `Audio` element,
  sets volume, attaches `onended`/`onerror`/`canplaythrough` handlers.
  Returns the Audio element.

---

## 13. Reactive Bar & AnalyserManager

The reactive bar is the primary visual feedback element of the full card.
It is a rainbow gradient strip (`.vs-rainbow-bar`) positioned at the bottom
of the viewport (or as a full-screen border glow in the Siri skin). When
reactive mode is enabled, the bar physically responds to real-time audio
levels — growing, glowing, and pulsing in sync with mic input and TTS
playback.

### 13.1 State-Driven Animation Classes

`UIManager.updateForState()` maps each pipeline state to a bar
configuration:

| State | `barVisible` | Animation Class | Reactive | Notes |
|-------|-------------|-----------------|----------|-------|
| IDLE | no | — | — | Bar hidden |
| CONNECTING | no | — | — | Bar hidden |
| LISTENING | no | — | — | Bar hidden (wake word listening is silent) |
| PAUSED | no | — | — | Bar hidden |
| WAKE_WORD_DETECTED | yes | `listening` | yes | Detected, waiting for STT |
| STT | yes | `listening` | yes | Actively transcribing speech |
| INTENT | yes | `processing` | no | Waiting for HA to process intent |
| TTS | yes | `speaking` | yes* | Playing response audio |
| ERROR | no | — | — | Bar hidden (service error uses `error-mode` class separately) |

*\*TTS is reactive only for browser playback. When `ttsTarget` is set
(remote media player), there is no local audio to analyse, so the bar
enters the `speaking` animation class but `reactive` is NOT applied and
the analyser is stopped.*

Guard logic prevents the bar from hiding when:
- A notification is playing (notifications manage their own bar state)
- An image linger timeout is active
- A video or lightbox is visible

### 13.2 Reactive Mode

Skins opt in to reactive mode via `reactiveBar: true` in their skin
definition. The user can disable it per-card with `reactive_bar: false` in
the card config. The effective check is:

```
get isReactiveBarEnabled() {
  return !!this._activeSkin?.reactiveBar && this._config.reactive_bar !== false;
}
```

When reactive mode is active and the bar enters a reactive-eligible state:
1. Bar gets classes `visible`, the animation class (e.g. `listening`), and `reactive`
2. The global UI container gets `reactive-mode` (used to push chat container upward)
3. `analyser.reconnectMic()` ensures the active analyser points at the mic
4. `analyser.start(barEl)` starts the tick loop

When the bar is visible but NOT reactive (INTENT, or TTS with remote
target), the `reactive` class and `reactive-mode` are removed and
`analyser.stop()` is called to halt the tick loop. This prevents the bar
from showing mic levels during processing or remote TTS playback.

**`startReactive()`** — Bypasses `updateForState()` to force-enable
reactive mode. Used by `AskQuestionManager` when entering STT answer
capture: `updateForState` is blocked by the `notifPlaying` guard (the
manager's `playing` flag is still `true`), so `startReactive()` directly
adds the `reactive` class, reconnects the mic analyser, and starts the
tick loop.

### 13.3 AnalyserManager — Dual-Analyser Architecture

**File:** `src/audio/analyser.js`

The analyser uses **two separate AnalyserNodes** to prevent audio feedback:

```
Microphone                     TTS / Notification Audio
    │                                    │
    ▼                                    ▼
MediaStreamSource              createMediaElementSource(audioEl)
    │                                    │
    ▼                                    ▼
_micAnalyser ← AnalyserNode    _audioAnalyser ← AnalyserNode
    │    (no destination)                │
    ×                                    ▼
                                   destination (speakers)
```

**Key invariant:** The mic analyser is **never** connected to
`AudioContext.destination`. It is a dead-end tap that only provides FFT
data. This makes feedback structurally impossible.

`_activeAnalyser` is a pointer that tells `_tick()` which analyser to read:
- Default: `_micAnalyser` — bar reacts to the user's voice
- During TTS/notification playback: `_audioAnalyser` — bar reacts to the
  output audio
- On detach: `null` — tick loop stops

### 13.4 Source Lifecycle

| Method | When Called | What It Does |
|--------|-----------|--------------|
| `attachMic(sourceNode, ctx)` | Pipeline start, audio resume | Connects mic stream → `_micAnalyser`. Sets as active if no audio playing. |
| `detachMic(sourceNode)` | Pipeline stop, audio pause | Disconnects mic → micAnalyser. Clears active if it was mic. |
| `attachAudio(audioEl, ctx)` | TTS play, notification play | Creates `MediaElementSource` → `_audioAnalyser` → `destination`. Switches active to audio. Auto-starts tick loop if bar was deferred. |
| `detachAudio()` | TTS end, notification end | Disconnects audio graph. Sets active to `null` (does NOT auto-revert to mic — `reconnectMic()` must be called explicitly). |
| `reconnectMic()` | `updateForState()` for mic-reactive states | Switches active back to mic analyser. No-op if audio is still attached (prevents bar from showing mic levels during TTS). |

### 13.5 The Tick Loop

`start(barEl, { deferred })` begins the animation loop:

1. Stores `barEl` reference and registers a `visibilitychange` handler
   (pauses RAF when tab is hidden, resumes when visible)
2. Unless `deferred`, calls `_tick()` immediately

Each `_tick()` frame:
1. **Rate limiting:** Checks `performance.now()` against the configured
   interval (`reactive_bar_update_interval_ms`, default 33ms ≈ 30fps).
   Skips computation if called too soon (RAF fires at 60fps; this halves
   the work on low-end devices).
2. **Time-domain analysis:** Calls `getByteTimeDomainData()` on the active
   analyser — cheaper than frequency-domain FFT, sufficient for a level
   meter.
3. **Level computation:** Calculates mean absolute amplitude normalized to
   0–1, then multiplied by 3.5 for visual boost, quantized to 20 steps
   (0.05 increments) to skip redundant CSS updates.
4. **CSS variable update:** Sets `--vs-audio-level` on the bar element only
   when the quantized level changes.
5. **Performance logging:** Tracks per-second stats — effective FPS, compute
   time (avg/max), tick gap (avg/max), and late-gap count. Logged every
   1000ms under the `analyser` channel.

`stop()` cancels the RAF, removes the visibility handler, resets the CSS
variable, and clears perf counters.

### 13.6 AnalyserNode Configuration

```
fftSize: 128          // Smallest useful window — 64 frequency bins
smoothingTimeConstant: 0.6   // Moderate smoothing for visual stability
```

Each analyser gets its own `Uint8Array` buffer cached in a `WeakMap` keyed
by the analyser node, so switching between mic/audio analysers reuses
existing buffers without allocation.

### 13.7 Deferred Start for Notifications

When a notification starts playing, the bar enters `speaking` + `reactive`
mode immediately (via `onNotificationStart()`), but the tick loop is started
with `{ deferred: true }`. This means:
- The bar element is stored
- The visibility handler is registered
- But `_tick()` is NOT called

The tick loop auto-starts when `attachAudio()` is called (the notification's
audio element gets routed through the audio analyser). This prevents the bar
from reacting to mic input during the pre-announce chime.

### 13.8 CSS: How Skins Use `--vs-audio-level`

Each skin defines how `--vs-audio-level` (0.00–1.00) drives visual effects:

**Default / Google Home / Alexa / Home Assistant:** Height scaling + glow pseudo-element

```css
.vs-rainbow-bar.reactive {
  transform: scaleY(calc(1 + N * var(--vs-audio-level, 0)));  /* grows vertically */
}
.vs-rainbow-bar.reactive::after {
  filter: blur(calc(Apx + Bpx * var(--vs-audio-level, 0)));   /* glow expands */
  opacity: calc(var(--vs-audio-level, 0) * 2.5);              /* glow brightens */
}
```

The `::after` pseudo-element is a blurred, scaled-up copy of the gradient
that acts as a soft glow behind the bar. Its blur radius and opacity are
both driven by the audio level.

**Siri:** Drop-shadow intensity on border glow

```css
.vs-rainbow-bar.reactive {
  filter: drop-shadow(0 0 calc(4px + 12px * var(--vs-audio-level, 0)) ...);
}
```

Siri's bar is a full-screen `border-image: conic-gradient(...)` frame. The
reactive effect modulates the `drop-shadow` blur radius and opacity — the
edge glow brightens with louder audio instead of growing in height.

### 13.9 Gradient Animation Sync

The bar gradient flows horizontally via `background-position` animation.
In non-reactive mode, a simple `@keyframes vs-gradient-flow` animates
`background-position: 0% → 200%`.

In reactive mode, the bar uses `@property --vs-gp` (a CSS Houdini
registered property) to animate the gradient position. Both the bar and
its `::after` glow reference `background-position: var(--vs-gp) 50%`,
ensuring they scroll in perfect sync. The `@keyframes vs-gradient-flow-sync`
animates the custom property:

```css
@property --vs-gp {
  syntax: '<percentage>';
  inherits: true;
  initial-value: 0%;
}
@keyframes vs-gradient-flow-sync {
  0%   { --vs-gp: 0%; }
  100% { --vs-gp: 200%; }
}
```

Without `@property`, CSS cannot animate custom properties — the transition
would snap between values instead of interpolating smoothly.

### 13.10 Layout Impact

When reactive mode is active, the bar can grow significantly in height
(up to 2× default for Default skin, up to 4× for Google Home). The
`.reactive-mode` class on the global UI container pushes the chat container
upward to prevent overlap:

```css
#voice-satellite-ui.reactive-mode .vs-chat-container {
  bottom: 100px;  /* vs normal 56px */
}
```

### 13.11 Editor Configuration

Two editor fields in the Skin section control the reactive bar:

| Config Key | Type | Default | Description |
|-----------|------|---------|-------------|
| `reactive_bar` | boolean | `true` | Enable/disable reactive mode |
| `reactive_bar_update_interval_ms` | number | 33 | Tick interval. Min 17ms (≈60fps). Higher values save CPU. |

### 13.12 Mini Card

The mini card always returns `isReactiveBarEnabled = false`. It has no
rainbow bar element and no analyser integration. The `AnalyserManager`
still exists on the session singleton (since the full card may be
co-registered), but the mini card never triggers it.

---

## 14. TTS & Chimes

### 14.1 TtsManager

**File:** `src/tts/index.js`

**Browser playback:**
```
play(url)
├── buildMediaUrl(url)
├── playMediaUrl(url, volume, { onStart, onEnd, onError })
│   onStart: notifyAudioStart('tts'), attachAudio() for reactive bar
│   onEnd:   _onComplete()
│   onError: retry once with tts-end URL, else _onComplete(true)
├── Start playback watchdog (30s interval)
└── _playing = true
```

**Remote playback** (tts_output select entity set to a media_player):
```
play(url)
├── playRemote(card, url)  → hass.callService('media_player', 'play_media')
├── Safety timeout (120s)
└── Monitor entity state via checkRemotePlayback(hass)
    ├── Phase 1: detect 'playing' + content_id change → sawPlaying = true
    ├── Phase 2: detect 'idle'/'paused' or content_id revert → _onComplete()
    └── Duration-based fallback (Sonos): tts-audio-duration event replaces
        safety timeout with (duration + 2s) timer for devices that don't
        provide reliable state transitions
```

**`_onComplete(playbackFailed)`:**
```
├── analyser.detachAudio()
├── notifyAudioEnd('tts')
└── card.onTTSComplete(playbackFailed)
    └── session/events.js → onTTSComplete()
        ├── If new interaction started → skip cleanup
        ├── If continue_conversation → restartContinue()
        ├── Play done chime (if not failed)
        ├── Image linger (30s) or TTS-failed linger (5s)
        └── cleanup: chat.clear(), hideBlurOverlay, playQueued
```

**Streaming TTS:**
- `storeStreamingUrl(eventData)`: Extracts pre-allocated streaming URL
  from `run-start` event's `tts_output.url` when `stream_response` is
  true.
- `intent-progress` with `tts_start_streaming`: triggers early playback
  via `tts.play(streamingUrl)` before `tts-end` arrives.
- `tts-end`: if already playing (streaming), stores URL as retry
  fallback. Otherwise starts normal playback.

### 14.2 Chimes

**File:** `src/audio/chime.js`

Chimes are pre-rendered MP3 files served from `/voice_satellite/sounds/`.
Each chime is defined as an object with `url` and `duration` properties.
The MP3 files are preloaded (wake + done) at engine bootstrap via
`preloadChimes()` and cached in a `Map` for instant cloned playback.

| Chime | File | Used When |
|-------|------|-----------|
| `CHIME_WAKE` | `wake.mp3` | Wake word detected |
| `CHIME_DONE` | `done.mp3` | Interaction complete |
| `CHIME_ERROR` | `error.mp3` | Pipeline error |
| `CHIME_ALERT` | `alert.mp3` | Timer finished (looped) |
| `CHIME_ANNOUNCE_URL` | `announce.mp3` | Before notification media |

All chimes use the MediaPlayer's volume (perceptual curve).

**Remote routing:** When `card.ttsTarget` is set, `playChime()` routes
audio to the remote media player via `media_player.play_media` with
`announce: true` instead of playing locally. This ensures chimes are
heard on the configured external device (e.g. Sonos).

---

## 15. Notification System

### 15.1 Event Routing

**File:** `src/shared/satellite-notification.js`

Satellite events arrive via `voice_satellite/subscribe_events` WS
subscription. The `dispatchSatelliteEvent` function routes them:

```
dispatchSatelliteEvent(card, event)
├── type === 'media_player' → mediaPlayer.handleCommand()
├── type === 'tts-audio-duration' → tts.setAudioDuration() + _setNotificationAudioDuration()
├── Tab hidden? → queue event, replay on visibility change
├── ann.ask_question? → AskQuestionManager
├── type === 'start_conversation'? → StartConversationManager
└── else → AnnouncementManager
```

**`tts-audio-duration` routing:** The integration measures TTS audio
file duration server-side (via mutagen) and pushes it as a satellite
event. `dispatchSatelliteEvent` routes it to both:
- `tts.setAudioDuration()` — for pipeline TTS remote playback
- `_setNotificationAudioDuration()` — for notification remote playback
  (finds the active notification manager with `_remotePlayback` set and
  replaces the 30s safety timeout with a `(duration + 2s)` timer)

### 15.2 Delivery & Queueing

```
_deliverToManager(mgr, ann, logPrefix)
├── Dedup: ann.id <= _lastAnnounceId → skip
├── mgr.playing → queue (mgr.queued = ann)
├── Pipeline busy (STT/INTENT/TTS states or TTS playing) → queue
└── Else: playNotification(mgr, ann, onComplete, logPrefix)
```

### 15.3 Playback Flow

```
playNotification(mgr, ann, onComplete, logPrefix)
├── Interrupt media player
├── mgr.playing = true
├── UI: showBlurOverlay(ANNOUNCEMENT), onNotificationStart()
├── Passive? → setAnnouncementMode(true)
├── Pre-announce:
│   ├── Custom preannounce_media_id → playMediaFor() (routes to remote if configured)
│   └── Default → CHIME_ANNOUNCE_URL via playMediaFor() (routes to local or remote)
└── _playMain(mgr, ann, onComplete, logPrefix)
    ├── Show message bubble (announcement or assistant type)
    ├── Media URL? → playMediaFor() → onComplete
    └── No media → setTimeout(NO_MEDIA_DISPLAY) → onComplete
```

**`playMediaFor()` remote routing:** When `card.ttsTarget` is set,
`playMediaFor()` calls `playRemote(card, url)` instead of browser
`playMediaUrl()`. This routes notification audio to the configured
external media player (e.g. Sonos). Remote playback uses:
- `mgr._remotePlayback` — tracking state (`target`, `sawPlaying`,
  `initialState`, `initialContentId`, `onDone`)
- `mgr._remoteTimeout` — 30s safety timeout (replaced by duration-based
  timer when `tts-audio-duration` event arrives)
- `checkRemoteNotificationPlayback(mgr, hass)` — called from
  `session.updateHass()` to monitor entity state transitions

**Pre-announce chime always plays:** Both the default announce chime and
custom pre-announce media are routed through `playMediaFor()`, which
handles local or remote playback automatically based on `card.ttsTarget`.

### 15.4 AnnouncementManager

**File:** `src/announcement/index.js`

After media playback completes (`_onComplete`):
1. ACK the event via WS
2. Start linger timeout (`announcementDisplayDuration` seconds)
3. During linger: `playing` stays `true` (blocks `updateForState`)
4. Play done chime
5. When linger expires:
   - `playing = false`
   - Re-sync `updateForState` (catches up with state changes that were
     blocked during linger)
   - Clear UI or play next queued notification

### 15.5 AskQuestionManager

**File:** `src/ask-question/index.js`

After prompt playback:
1. ACK the event
2. Enter STT-only mode:
   - Switch from announcement mode to interactive mode
   - Play wake chime + delay (`CHIME_SETTLE` = 500ms)
   - `ui.startReactive()` for reactive bar (bypasses `notifPlaying`
     guard since `playing` is still `true` during STT capture)
   - `pipeline.restartContinue(null, { end_stage: 'stt', onSttEnd })`
3. STT callback receives transcribed text
4. `sendAnswer(card, announceId, text)` → WS command
5. Play done/error chime based on `matched` result
6. Safety timeout (30s): sends empty answer if STT never produces result
7. Cleanup: clear UI, hide blur, restart pipeline or play next queued

### 15.6 StartConversationManager

**File:** `src/start-conversation/index.js`

After prompt playback:
1. ACK the event
2. Clear announcement UI (no linger — transitions straight to conversation)
3. `playing = false`
4. Show pipeline blur
5. `pipeline.restartContinue(null, { extra_system_prompt })`

---

## 16. Timer System

### 16.1 Overview

**Files:** `src/timer/index.js`, `events.js`, `comms.js`, `ui.js`

Timers are tracked via the satellite entity's `active_timers` attribute.
The `TimerManager` subscribes to entity state changes and maintains a
local timer list with 1-second tick updates.

### 16.2 Lifecycle

```
1. Entity state_changed → active_timers gets new entry
   └── syncTimers() → create pill DOM, start 1s tick interval

2. Tick interval (1s):
   └── For each timer: compute secondsLeft, updateTimerPill()

3. Entity state_changed → timer removed from active_timers
   └── processStateChange() detects removal
       ├── last_timer_event === 'finished' → showAlert()
       │   ├── showBlurOverlay(TIMER)
       │   ├── Play alert chime (looped every 3s)
       │   └── Auto-dismiss after 60s
       └── last_timer_event === 'cancelled' → silently remove pill

4. Alert dismissed (double-tap, auto-dismiss, or single tap on mini)
   └── clearAlert() → stop chime, hide blur, remove pills if empty
```

### 16.3 Timer Cancellation

Double-tap on a timer pill calls `cancelTimer(timerId)`:
1. `sendCancelTimer` → WS command `voice_satellite/cancel_timer`
2. Play done chime
3. Animate pill removal
4. Remove from local timer list + known IDs
5. If no timers remain, stop tick + remove container

---

## 17. Media Player

**File:** `src/media-player/index.js`

The `MediaPlayerManager` has two roles:

### 17.1 Browser Media Playback

Handles `media_player` commands from the integration via satellite events:
- `play`: Sign relative URLs, create Audio element, play
- `pause` / `resume` / `stop`: Control Audio element
- `volume_set` / `volume_mute`: Adjust volume with perceptual curve (v²)

Volume applies globally — `_applyVolumeToExternalAudio` propagates to
any active TTS or notification Audio elements.

### 17.2 Unified Audio-State Reporter

All audio sources (TTS, chimes, notifications, media playback) call
`notifyAudioStart(source)` / `notifyAudioEnd(source)`.

The manager tracks `_activeSources` (Set) and reports state back to HA
via `voice_satellite/media_player_event`:
- Any source active → report `'playing'`
- All sources ended → debounced (200ms) report `'idle'`

This keeps the HA media_player entity in sync with all browser audio.

### 17.3 Volume Sync

On first volume access after page load, syncs from the HA entity's
`volume_level` and `is_volume_muted` attributes. Subsequent changes
come from `volume_set` / `volume_mute` commands.

---

## 18. Visibility Management

**File:** `src/shared/visibility.js`

### Tab Hidden

```
_handleChange() [document.visibilityState === 'hidden']
├── Guard: nothing active to pause? → skip
├── _isPaused = true
├── Cancel in-progress ask_question
├── Clean up UI if interacting or lingering
│   └── Clear image linger, chat, blur, continue state, stop TTS
└── Debounce (500ms): _pause()
    ├── setState(PAUSED)
    └── audio.pause() (disable tracks, NOT pipeline.stop)
```

### Tab Visible

```
_resume()
├── pipeline.resetForResume() → cancel pending restart timeout
├── await audio.resume() → AudioContext.resume(), flush stale buffer
├── _isPaused = false
├── If pending satellite event → defer restart (event flow manages pipeline)
├── refreshSatelliteSubscription() → tear down + re-subscribe
└── pipeline.restart(0)
```

**Key design decision:** `_pause()` does NOT call `pipeline.stop()`.
The unawaited `stop()` creates a race with `_resume()`'s `restart()`.
The sequenced `restart(0)` (which calls `stop()` internally before
`start()`) handles the proper shutdown.

---

## 19. Double-Tap / Escape Handler

**File:** `src/shared/double-tap.js`

Document-level listeners for `touchstart`, `click`, and `keydown`
(Escape). Touch/click deduplication prevents synthetic click-after-touch.

**Cancellation priorities:**

```
1. Timer alert active → timer.dismissAlert() (done chime)
2. Notification playing (any of 3 managers) →
   ├── ACK notification
   ├── Pause/clear audio
   ├── playing = false, queued = null
   ├── clearNotificationUI()
   ├── askQuestion.cancel() (release server _question_event)
   ├── Play done chime
   └── pipeline.restart(0)
3. Active interaction (INTERACTING_STATES or TTS playing or image linger) →
   ├── Clear image linger timeout
   ├── tts.stop()
   ├── askQuestion.cancel()
   ├── clearContinueState()
   ├── setState(IDLE)
   ├── chat.clear(), hideBlurOverlay
   ├── Play done chime
   └── pipeline.restart(0)
```

---

## 20. Entity Resolution & Browser Override

**File:** `src/shared/entity-picker.js`

### 20.1 Resolution Logic

`resolveEntity(hass)` looks up the satellite entity from browser-local
storage. No auto-selection is performed -- the user must explicitly pick
a satellite entity in the sidebar panel before the engine will start.

1. **Check `vs-satellite-entity`** in localStorage.
2. **Fall back** to `satellite_entity` inside the `vs-panel-config`
   localStorage object (legacy migration path).
3. **Validate** the stored entity still exists in `hass.entities`.
   If it was deleted from HA, clear stale storage and return `null`.
4. **Return `null`** if nothing is stored -- the panel shows the entity
   picker and the engine remains dormant until the user selects one.

### 20.2 Entity Subscription

**File:** `src/shared/entity-subscription.js`

Generic entity state subscription wrapper. Used by TimerManager to watch
`active_timers` attribute changes.

---

## 21. Editor & Preview System

### 21.1 Config Forms

- **Full card:** `src/editor/index.js`, `behavior.js`, `skin.js`
  - Uses HA's native form schema system.
  - Sections: entity, behavior toggles, skin selector, text scale,
    background opacity, custom CSS, debug toggle.

- **Mini card:** `src/mini-editor/index.js`
  - Mini mode selector (compact/tall), entity, browser override,
    suppress_full_card toggle, text scale, custom CSS, debug.

### 21.2 Editor Preview Detection

**File:** `src/editor/preview.js`

`isEditorPreview(card)` walks the DOM tree upward looking for:
- Parent `hui-card` with `preview` property
- `hui-card-preview` or `hui-card-options` ancestors
- Card editor panel ancestors

When detected, the card renders a static preview image instead of
starting the live pipeline. This prevents:
- Duplicate pipeline subscriptions
- Microphone acquisition in the editor
- Entity picker showing during editing

### 21.3 Preview Renderers

- Full: `src/editor/preview.js` + `preview.css`
- Mini: `src/mini-editor/preview.js` + `preview.css`

Both render a mock UI with skin/mode preview. No managers are
instantiated.

---

## 22. Skins & Styling

### 22.1 Skin Registry (Lazy-Loaded)

**File:** `src/skins/index.js`

Only the default skin is bundled in the main JS file. The remaining 5 skins
are lazy-loaded via webpack code splitting when selected — each loads as a
separate ~20KB chunk on demand.

```javascript
import { defaultSkin } from './default.js';

const SKIN_META = [
  { value: 'default', label: 'Default' },
  { value: 'alexa', label: 'Alexa' },
  { value: 'google-home', label: 'Google Home' },
  { value: 'home-assistant', label: 'Home Assistant' },
  { value: 'retro-terminal', label: 'Retro Terminal' },
  { value: 'siri', label: 'Siri' },
];

const SKIN_LOADERS = {
  alexa: () => import(/* webpackChunkName: "skin-alexa" */ './alexa.js'),
  'google-home': () => import(/* webpackChunkName: "skin-google-home" */ './google-home.js'),
  'home-assistant': () => import(/* webpackChunkName: "skin-home-assistant" */ './home-assistant.js'),
  'retro-terminal': () => import(/* webpackChunkName: "skin-retro-terminal" */ './retro-terminal.js'),
  siri: () => import(/* webpackChunkName: "skin-siri" */ './siri.js'),
};

const _cache = { default: defaultSkin };
```

**Two accessors:**

- `getSkin(id)` — **Synchronous.** Returns cached skin or default fallback.
  Used in hot paths (render, preview).
- `loadSkin(id)` — **Async.** Dynamically imports the skin chunk, caches it,
  returns the loaded skin. Callers re-render when the async load resolves.
- `getSkinOptions()` — Returns `SKIN_META` for the editor dropdown (no skin
  CSS imported).

**Loading pattern** (used in both `card/index.js` and `editor/preview.js`):

```javascript
const skin = getSkin(skinId);       // sync — immediate fallback to default
loadSkin(skinId).then((loaded) => {
  if (loaded !== skin) reRender();  // re-render once async skin arrives
});
```

Each skin exports:
`{ id, name, css, reactiveBar, overlayColor, defaultOpacity, previewCSS }`

- `css`: Injected into `<style id="voice-satellite-styles">` in
  `document.head`.
- `reactiveBar`: Enables the reactive bar feature for the full card.
- `overlayColor`: `[r, g, b]` for the blur overlay background, or `null` to
  let the skin's CSS handle the overlay (e.g. Home Assistant skin uses
  `var(--card-background-color)` so it adapts to the active HA theme).
- `defaultOpacity`: Default blur overlay opacity (0-1).
- `previewCSS`: Additional CSS injected into the editor preview renderer.

### 22.2 Style Application

Full card (`UIManager.applyStyles()`):
1. Inject skin CSS into `document.head`
2. Apply custom CSS to `document.head`
3. Set `--vs-text-scale` on `document.documentElement`
4. Set blur overlay `rgba()` from skin's `overlayColor` + config opacity

Mini card (`MiniUIManager.applyStyles()`):
1. Apply text scale via `--vs-mini-text-scale` CSS variable
2. Apply custom CSS into shadow DOM `<style>` element
3. Re-sync state presentation

### 22.3 Z-Index Stacking

Full card UI layers (all skins use identical values):

| Z-Index | Element | Purpose |
|---------|---------|---------|
| 9999 | `.vs-blur-overlay` | Backdrop blur behind all interactive elements |
| 10000 | `.vs-rainbow-bar` | Animated bar — above blur, below interactive elements |
| 10001 | `.vs-start-btn` | Mic start button |
| 10001 | `.vs-chat-container` | Chat bubbles |
| 10001 | `.vs-image-panel` | Image/video/weather/financial panels |
| 10001 | `.vs-timer-container` | Timer pills (injected into `document.body`) |
| 10002 | `.vs-lightbox` | Fullscreen image/video viewer — highest layer |
| 10002 | `.vs-timer-alert` | Timer finished alert (injected into `document.body`) |

Values start at 9999 to avoid collision with HA's own UI layers (sidebar,
header, modals, etc.). Timer container and timer alerts are injected
directly into `document.body` (outside `#voice-satellite-ui`) so they
remain visible even when full card suppression hides the main UI element.

---

## 23. Rich Media

The full card supports rich media panels. Mini card no-ops all these.

### 23.1 Image Panel

`showImagePanel(results, autoDisplay, featured)`:
- Creates 2-column image grid in `.vs-image-panel`.
- Click on image → `showLightbox(src)`.
- `autoDisplay`: auto-opens lightbox with first image.
- `featured`: narrower panel for Wikipedia/web search featured images.
- Scroll handler cancels image linger timeout (user is browsing).

### 23.2 Video Panel

`showVideoPanel(results, autoPlay)`:
- Creates video cards with thumbnails, duration badges, titles.
- Click → `showVideoLightbox(videoId)` (YouTube nocookie embed).
- `autoPlay`: auto-opens first video.
- Video lightbox stops TTS, sets `_videoPlaying = true`.

### 23.3 Weather Panel

`showWeatherPanel(data)`:
- Renders current conditions (icon, temp, humidity) + forecast rows.
- Supports hourly, daily, and twice_daily forecast types.
- Uses featured panel mode (narrower, no linger timeout).

### 23.4 Financial Panel

`showFinancialPanel(data)`:
- Stock/crypto: header (logo, name, exchange badge) + price + change
  indicator + detail row (open/high/low or 24h stats).
- Currency: conversion display + exchange rate.
- Uses featured panel mode.

### 23.5 Lightbox

Full-screen overlay for enlarged images or embedded YouTube videos.
- Click to close (returns to panel).
- Cancels image linger timeout while open.
- `isLightboxVisible()` prevents auto-dismiss while user is viewing.

---

## 24. Chat & Streaming Text

**File:** `src/shared/chat.js`

Each card owns its own `ChatManager` instance. The session's
`ChatBroadcastProxy` broadcasts operations to all.

### 24.1 Message Types

| Method | Chat Bubble Type | Visual |
|--------|-----------------|--------|
| `showTranscription(text)` | `'user'` | Secondary text color |
| `showResponse(text)` | `'assistant'` | Primary text color |
| `addChatMessage(text, 'announcement')` | `'announcement'` | Centered (full card) |

### 24.2 Streaming Text

During `intent-progress` events, text arrives as `chat_log_delta.content`
chunks. The flow:

```
pipeline/events.js:
  chat.streamedResponse += chunk
  chat.updateResponse(chat.streamedResponse)

ChatManager.updateResponse():
  └── _scheduleStreaming(text)
      └── RAF coalescing: one DOM write per frame

_updateStreaming(text):
  ├── Short text (≤24 chars): plain textContent update
  └── Long text: 24-character fade effect
      ├── Solid text node for completed characters
      └── 24 reusable <span> elements with decreasing opacity
          (pooled — created once, text updated in-place)
```

### 24.3 Mini Card Specifics

**Compact mode:** Messages appear as inline `<span>` elements in a
single-line marquee track. Separator dots (`·`) between messages.
Marquee auto-scrolls, synced to TTS duration.

**Tall mode:** Messages are `<div>` elements in a scrollable transcript
container. Vertical auto-scroll synced to TTS audio duration.

Both modes estimate TTS duration from word count for scroll speed
when the Audio element's real duration isn't available yet.

---

## 25. Full Card Suppression

When any registered mini card has `config.suppress_full_card === true`,
the session hides the full card's UI:

```
_syncFullCardSuppression()
├── Iterate _cards: any mini card with suppress_full_card?
├── Set #voice-satellite-ui display: none/''
├── Set #voice-satellite-timers display: none/''
└── If suppressed: hide all .vs-timer-alert elements
```

Called on: `register()`, `unregister()`, `updateConfig()`.

The UIBroadcastProxy continues calling all card UIs normally — the full
card's UIManager just manipulates hidden DOM (no layout cost). When
suppression lifts, the full card's UI is already in the correct state.

Timer alerts get special handling in `showTimerAlert()`: full card
alerts are skipped when suppressed because they render directly in
`document.body` outside `#voice-satellite-ui`.

---

## 26. Internationalization

**Files:** `src/i18n/index.js`, `src/i18n/en.js`

- `t(hass, key, fallback, vars)`: Looks up translation key in HA's
  locale system, falls back to the English default.
- Variable interpolation: `{value}` placeholders replaced with provided
  values.
- Used throughout UI managers and editor schemas.

---

## 27. Constants & Configuration

**File:** `src/constants.js`

### 27.1 State Enum

```
IDLE → CONNECTING → LISTENING → WAKE_WORD_DETECTED → STT → INTENT → TTS
                                                                      │
PAUSED (tab hidden)                                              ERROR ←
```

`INTERACTING_STATES = [WAKE_WORD_DETECTED, STT, INTENT, TTS]`

### 27.2 Expected Errors

Pipeline errors that are normal and should restart silently:
```
timeout, wake-word-timeout, stt-no-text-recognized, duplicate_wake_up_detected
```

### 27.3 Blur Reasons

Reference-counted blur overlay:
```
PIPELINE    — active voice interaction
TIMER       — timer finished alert
ANNOUNCEMENT — notification playback
```

### 27.4 Timing Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DOUBLE_TAP_THRESHOLD` | 400ms | Double-tap detection window |
| `TIMER_CHIME_INTERVAL` | 3000ms | Alert chime loop interval |
| `PILL_EXPIRE_ANIMATION` | 400ms | Timer pill removal animation |
| `PLAYBACK_WATCHDOG` | 30000ms | TTS stall detection interval |
| `RECONNECT_DELAY` | 2000ms | Post-reconnect restart delay |
| `INTENT_ERROR_DISPLAY` | 3000ms | Error bar visibility duration |
| `TTS_FAILED_LINGER` | 5000ms | Text display when TTS fails |
| `NO_MEDIA_DISPLAY` | 3000ms | Notification display without media |
| `ASK_QUESTION_CLEANUP` | 2000ms | Answer submission safety timeout |
| `ASK_QUESTION_STT_SAFETY` | 30000ms | STT timeout for ask_question |
| `TOKEN_REFRESH_INTERVAL` | 240000ms | Streaming TTS token refresh |
| `MAX_RETRY_DELAY` | 30000ms | Maximum retry backoff |
| `RETRY_BASE_DELAY` | 5000ms | Base retry interval (linear) |
| `VISIBILITY_DEBOUNCE` | 500ms | Tab hide debounce |
| `DISCONNECT_GRACE` | 100ms | Card disconnect grace period |
| `CHIME_SETTLE` | 500ms | Delay after chime before STT |
| `IMAGE_LINGER` | 30000ms | Image panel display duration |
| `IDLE_DEBOUNCE` | 200ms | Media player idle state debounce |
| `AUTH_SIGN_EXPIRES` | 3600s | Signed URL expiration |

### 27.5 Default Config

```javascript
{
  satellite_entity: '',
  auto_start: true,
  debug: false,
  noise_suppression: true,
  echo_cancellation: true,
  auto_gain_control: true,
  voice_isolation: false,
  skin: 'default',
  custom_css: '',
  text_scale: 100,
  reactive_bar: true,
  reactive_bar_update_interval_ms: 33,
}
```

**`auto_start`:** When `false`, the engine does not automatically start the
pipeline on page load. The user must click the Start button in the panel
or on the full card's start overlay. The panel toggles this setting, and
the engine reads it from `localStorage` on boot.

---

## 28. Build & Versioning

### 28.1 Build System

- **Webpack** bundles JS with code splitting into two entry points + on-demand chunks.
- `npm run dev`: Development build (unminified + source map) + xcopy to
  `\\hassio\config\custom_components\voice_satellite\`.
- `npm run build`: Production build (minified, no source map) — CI only.

**Two entry points** in `webpack.config.js`:

```javascript
entry: {
  'voice-satellite-card': './src/index.js',    // Main bundle (card + engine)
  'voice-satellite-panel': './src/panel/index.js', // Sidebar panel (separate)
}
```

### 28.2 Code Splitting

Webpack splits the bundle into a main file and several lazy-loaded chunks
using dynamic `import()` with `webpackChunkName` hints:

| Chunk | Trigger | Contents |
|-------|---------|----------|
| `voice-satellite-card.js` | Every page (via `add_extra_js_url`) | Engine, card, session, pipeline, audio, TTS, all managers |
| `voice-satellite-panel.js` | Sidebar panel navigation | Panel element, settings forms, preview renderer |
| `voice-satellite-wake-word.js` | On-device wake word enabled | WakeWordManager, inference pipeline, model loader |
| `voice-satellite-skin-alexa.js` | Alexa skin selected | Alexa CSS + skin definition |
| `voice-satellite-skin-google-home.js` | Google Home skin selected | Google Home CSS + skin definition |
| `voice-satellite-skin-retro-terminal.js` | Retro Terminal skin selected | Retro Terminal CSS + skin definition |
| `voice-satellite-skin-home-assistant.js` | Home Assistant skin selected | Home Assistant CSS + skin definition |
| `voice-satellite-skin-siri.js` | Siri skin selected | Siri CSS + skin definition |

Webpack config:
```javascript
output: {
  publicPath: '/voice_satellite/',
  chunkFilename: 'voice-satellite-[name].js',
}
```

At runtime, webpack injects a `<script>` tag to load each chunk from
`/voice_satellite/voice-satellite-<name>.js`. The integration's `frontend.py`
serves all files in the `frontend/` directory via HA's static path.

**TFLite WASM** is NOT bundled in any chunk. It's loaded at runtime via
a `<script>` tag pointing to `/voice_satellite/tflite/tflite_web_api_client.js`.
The TFLite files are copied from `node_modules` to the `tflite/` directory
by `scripts/copy-tflite.js` during the build.

### 28.3 Versioning

- `package.json` is the single source of truth for the version.
- `scripts/sync-version.js` propagates to `manifest.json` + `const.py`.
- Webpack `DefinePlugin` injects `__VERSION__` into JS as a compile-time
  constant. Accessed via `constants.js` → `export const VERSION = __VERSION__`.

### 28.4 Output

Built JS: `custom_components/voice_satellite/frontend/voice-satellite-card.js`
+ chunk files (gitignored — CI builds for releases).

---

## 29. On-Device Wake Word Detection

The frontend supports on-device wake word detection using microWakeWord TFLite
models running entirely in the browser via TensorFlow Lite WASM. This
eliminates the need for a server-side wake word add-on. Supports dual
wake words — two keyword classifiers can run concurrently on the same
shared feature extraction pipeline with minimal overhead. Also supports
a **stop model** that can interrupt TTS playback, notifications, and
timer alerts via voice command.

### 29.1 Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  Browser                                                  │
│                                                           │
│  AudioWorklet ──16kHz float32──► WakeWordManager          │
│                                  │                        │
│                                  ├── feedAudio(chunk)     │
│                                  │   accumulate 1280      │
│                                  │   samples per frame    │
│                                  │                        │
│                                  └── MicroWakeWordInference│
│                                       │                   │
│  ┌────────────────────────────────────┘                   │
│  │ microWakeWord TFLite Pipeline:                         │
│  │                                                        │
│  │  1. MicroFrontend (160-sample hop, 480-sample window)  │
│  │     Hann window → FFT → mel filterbank → sqrt          │
│  │     → noise floor → noise reduction → PCAN → log₂     │
│  │     → int8 quantize                                    │
│  │                                                        │
│  │  2. Keyword classifier(s) (TFLite stateful models)     │
│  │     Input: [1, N, 40] int8 feature frames              │
│  │     Output: uint8 probability [0–255]                  │
│  │     └── Runs 1-2 classifiers + optional stop model     │
│  │                                                        │
│  │  3. Sliding window detection (mean of last N probs)    │
│  │  4. Energy-based sleep mode (RMS silence gating        │
│  │     with feature buffering for onset replay)           │
│  └────────────────────────────────────────────────────────┘
│                                                           │
│  On wake word detection:                                  │
│    → Check mute state (ignore if muted)                   │
│    → Interrupt media player                               │
│    → Unpause tab if paused                                │
│    → Play wake chime (if enabled)                         │
│    → Start pipeline with start_stage: "stt"               │
│      (skips server-side wake word)                        │
│                                                           │
│  On stop word detection:                                  │
│    → Priority chain: timer alert > notification > TTS     │
│    → Dismiss/cancel the active interruptible state        │
│    → Play done chime (if enabled)                         │
└──────────────────────────────────────────────────────────┘
        │
        │  TFLite models loaded from /voice_satellite/models/
        │  TFLite WASM loaded from /voice_satellite/tflite/
        │
┌───────┴──────────────────────────────────────────────────┐
│  Integration (static files)                               │
│                                                           │
│  models/                                                  │
│    ├── ok_nabu.tflite          (keyword — default)        │
│    ├── hey_jarvis.tflite       (keyword)                  │
│    ├── alexa.tflite            (keyword)                  │
│    ├── hey_mycroft.tflite      (keyword)                  │
│    ├── hey_home_assistant.tflite (keyword)                │
│    ├── hey_luna.tflite         (keyword)                  │
│    ├── okay_computer.tflite    (keyword)                  │
│    ├── stop.tflite             (stop word — managed separately) │
│    └── my_custom_word.tflite   (user-provided keyword)    │
│                                                           │
│  tflite/                                                  │
│    ├── tflite_web_api_client.js (TFLite WASM entry)      │
│    └── tflite_web_api_cc_*.wasm (WASM binaries)          │
└──────────────────────────────────────────────────────────┘
```

### 29.2 File Structure

| File | Responsibility |
|------|----------------|
| `wake-word/index.js` | `WakeWordManager` — orchestrator, dual-model lifecycle, stop model, settings, detection/stop handlers |
| `wake-word/micro-models.js` | TFLite WASM runtime loading, per-name model caching, companion JSON manifest loading, unused model cleanup |
| `wake-word/micro-inference.js` | `MicroWakeWordInference` -- stateful TFLite pipeline, multi-keyword support, opt-in energy-based sleep with ring buffer feature replay |
| `wake-word/micro-frontend.js` | `MicroFrontend` — audio feature extraction (Hann, FFT, mel, sqrt, noise floor, NR, PCAN, log₂, int8) |

### 29.3 Audio Feature Extraction

**File:** `src/wake-word/micro-frontend.js`

Implements the TensorFlow micro_frontend audio preprocessing in pure JS,
matching the reference ESPHome micro_wake_word component. Key browser
adaptation: browser mic + WebRTC AGC produces ~10× the amplitude of ESP32's
I2S ADC, so the audio is scaled down (`AUDIO_SCALE = 2500`) and a synthetic
noise floor is injected to match ESP32's analog noise profile.

Pipeline (9 steps, matching `_processWindow()` method):

1. **Hann window + amplitude scaling** — 480-coefficient window applied per
   frame, samples scaled by `AUDIO_SCALE` (2500) instead of full int16 range
   (32767), zero-padded to 512
2. **512-point FFT** — Radix-2 Cooley-Tukey inline implementation (no library)
3. **Power spectrum** — `|FFT[k]|²` for k = 0..256 (257 bins)
4. **40-channel mel filterbank** — Triangular filters spanning 125–7500 Hz,
   weighted sum of power spectrum
5. **FilterbankSqrt** — `sqrt(melEnergy)` to reduce dynamic range (matches
   FilterbankSqrt in the C reference code), floored to 1.0
6. **Noise floor injection** — Adds `NOISE_FLOOR = 1000` to each channel.
   Browser mic silence is ~10-100 sqrt_mel (vs ESP32's ~500-1000 from
   ADC/preamp noise). Without this, the noise reduction stage has nothing
   to subtract and features are flat.
7. **Noise reduction** — Per-channel asymmetric exponential smoothing.
   Upward tracking is 40× slower than C default (`NR_UP_MULT = 0.025`) so
   features persist for the full ~0.5s duration of a wake word. Downward
   tracking is 2× faster (`NR_DOWN_MULT = 2.0`) for quick recovery.
   Minimum signal floor: `NR_MIN_SIGNAL = 0.05`.
8. **PCAN gain control** — Per-channel automatic gain from noise estimate:
   `gain = (offset/noise)^strength` with `PcanShrink` compression
   (strength=0.95, offset=80.0)
9. **Log₂ scale** — `log₂(1 + energy) × 64` (`scale_shift = 6`)
10. **Int8 quantization** — `round(val × 256 / 666) − 128`, clamped to
    [-128, 127]

Parameters: 480-sample window, 160-sample hop (10ms step), producing ~8
feature frames per 1280-sample (80ms) audio chunk. A ring buffer maintains
overlap between frames.

### 29.4 Inference Pipeline

**File:** `src/wake-word/micro-inference.js`

Each keyword model is a stateful TFLite model with internal ring buffers
(VarHandleOp). The input tensor shape (auto-detected at init) determines
how many feature frames are batched per inference call.

1. **Feature accumulation** — Feature frames from MicroFrontend are collected
   until `framesPerInfer` frames are ready (auto-detected from input tensor
   size: `inputBuffer.length / 40`)
2. **Model inference** — Feature frames copied into input tensor, `infer()`
   called, output uint8 probability read and normalized to [0, 1]
3. **Sliding window detection** — Circular buffer of last N probabilities
   (N from model params, typically 3). Detection triggers when
   `mean(buffer) > cutoff`. Buffer must be full before detection is checked.
4. **Warmup** — First `WARMUP_FRAMES = 100` feature frames (~1s) after
   init/reset are ignored — probabilities are not stored during this period
   to let model state stabilize
5. **Cooldown** — `COOLDOWN_MS = 2000` after each detection prevents
   re-triggers. `_lastDetectionTime` is preserved across `reset()` calls
   since VarHandle ring buffers in the model persist.

**Dynamic keyword management:**

Keywords can be added (`addKeyword(config)`) or removed
(`removeKeyword(name)`) at runtime without recreating the inference engine.
This is used by the stop model system (§29.10).

**Energy-based sleep mode (opt-in via "Wake word noise gate" switch):**

Disabled by default. When enabled via the integration's noise gate switch
(`switch.*_wake_word_noise_gate`), TFLite inference is paused during silence
and resumes when audio exceeds the wake level. Feature extraction continues
to keep the noise estimate warm for immediate wake-up. This matches the
behavior of physical ESPHome satellites, which run inference continuously
without energy gating.

The card reads the switch state directly via
`getSwitchState(hass, entityId, 'noise_gate')` and passes it to
`MicroWakeWordInference` at construction. Changes are applied live via
`setEnergyGateEnabled(boolean)` without restarting the wake word pipeline.

RMS thresholds are tied to the **Wake Word Sensitivity** setting:

| Sensitivity | Sleep RMS | Wake RMS |
|---|---|---|
| Slightly sensitive | 0.12 | 0.15 |
| Moderately sensitive (default) | 0.07 | 0.09 |
| Very sensitive | 0.035 | 0.045 |

```
processChunk(samples)
├── 1. If energy gate enabled: compute RMS energy of 1280-sample chunk
├── 2. Sleep/wake state machine (thresholds from ENERGY_THRESHOLDS):
│     ├── rms < sleepRms → increment _silentChunks
│     │   └── _silentChunks >= 30 (~2.4s) → _sleeping = true
│     └── rms >= wakeRms → _silentChunks = 0, _sleeping = false
├── 3. Always run MicroFrontend.feed() (keeps noise estimate warm)
├── 4. If sleeping:
│     ├── Buffer features in _sleepFeatureBuffer (rolling window)
│     │   └── max SLEEP_BUFFER_CHUNKS × 8 = 40 frames (~400ms)
│     └── return early (skip TFLite inference)
└── 5. When awake:
      ├── Prepend any buffered sleep features (onset replay)
      └── Run keyword classifiers on each feature frame
```

**Sleep buffer replay:** During sleep, features are buffered in a ring buffer
of `SLEEP_BUFFER_CHUNKS = 8` chunks (~640ms). When the energy gate wakes up,
these buffered features are drained oldest-first and prepended to the current
chunk's features before running inference. This captures the onset of the wake
word utterance that triggered the energy gate wake-up.

Hysteresis (sleep < wake) prevents flapping near the threshold.
Energy thresholds update live via `updateEnergyThresholds()` when
the sensitivity setting changes. The energy gate itself can be toggled
at runtime via `setEnergyGateEnabled(boolean)` -- disabling it immediately
clears any active sleep state. Neither operation requires a restart.

### 29.5 Model Loading

**File:** `src/wake-word/micro-models.js`

- **TFLite WASM runtime**: Loaded once via `<script>` tag from
  `/voice_satellite/tflite/tflite_web_api_client.js`. Sets `window.tfweb`.
  The script has a CommonJS epilogue that needs a `window.exports = {}` stub.
  WASM binary path configured via `tfweb.tflite_web_api.setWasmPath()`.
- **Keyword models**: Loaded per-name into `_modelCache` (name → runner map).
  `loadMicroModel(tfweb, name)` creates a `TFLiteWebModelRunner` from the
  `.tflite` file. Filename mapped via `TFLITE_KEYWORD_FILES[name] || name` —
  built-in models use known filenames, custom models use their name directly.
  When both wake word slots select the same model, only one runner is loaded.
- **Companion JSON manifests**: Each model can have a `.json` file alongside
  its `.tflite` file (e.g. `ok_nabu.json`). The manifest is fetched in
  parallel with model loading via `_loadModelManifest()` and cached in
  `_jsonParamsCache`. The JSON structure is:
  ```json
  { "micro": { "probability_cutoff": 0.97, "sliding_window_size": 3, "feature_step_size": 10 } }
  ```
  This allows model parameters to be updated without code changes.
- **Model parameters**: `getMicroModelParams(name)` resolves parameters in
  priority order:
  1. Companion JSON manifest (`_jsonParamsCache[filename]`)
  2. Hardcoded `MICRO_MODEL_PARAMS` (built-in models)
  3. V2 fallback defaults (`cutoff: 0.90, slidingWindow: 3, stepSize: 10`)
- **Hardcoded `MICRO_MODEL_PARAMS`**:
  | Model | cutoff | slidingWindow | stepSize |
  |-------|--------|---------------|----------|
  | ok_nabu | 0.97 | 3 | 10 |
  | hey_jarvis | 0.97 | 3 | 10 |
  | hey_mycroft | 0.95 | 3 | 10 |
  | alexa | 0.90 | 3 | 10 |
  | hey_home_assistant | 0.97 | 5 | 10 |
  | hey_luna | 0.97 | 5 | 10 |
  | okay_computer | 0.97 | 5 | 10 |
  | stop | 0.50 | 3 | 10 |

  Note: these cutoffs are the model's native thresholds from their manifests.
  At runtime, `WakeWordManager.getThresholdForModel()` overrides the cutoff
  with browser-calibrated `MODEL_THRESHOLDS` based on sensitivity (§29.6).
  The `slidingWindow` and `stepSize` values are still used from the params.
- **Cleanup**: `releaseUnusedMicroModels(activeNames)` disposes runners no
  longer in use (skips the stop model). `releaseMicroModels()` disposes all.

### 29.6 Sensitivity Thresholds

**File:** `src/wake-word/index.js` (`MODEL_THRESHOLDS`, `DEFAULT_THRESHOLDS`)

Browser audio (WebRTC AGC/NS) produces different feature profiles than ESP32,
so these cutoffs are lower than the model manifests' native values. These
override the `cutoff` from `MICRO_MODEL_PARAMS` / JSON manifests at runtime.

| Model | Slightly | Moderately | Very |
|-------|----------|------------|------|
| ok_nabu | 0.65 | 0.50 | 0.35 |
| hey_jarvis | 0.55 | 0.40 | 0.30 |
| hey_mycroft | 0.55 | 0.40 | 0.30 |
| alexa | 0.55 | 0.40 | 0.30 |
| stop | 0.50 | 0.40 | 0.30 |
| *(other built-in / custom)* | 0.60 | 0.45 | 0.30 |

Default sensitivity: **Moderately sensitive**.

Custom models (not in `MODEL_THRESHOLDS`) use `DEFAULT_THRESHOLDS`:
`{ 'Slightly sensitive': 0.60, 'Moderately sensitive': 0.45, 'Very sensitive': 0.30 }`.

### 29.7 Settings Change Handling

`WakeWordManager.checkSettingsChanged()` is called from `session.updateHass()`
on every HA state change. It tracks four cached values:

| Setting | Change Effect |
|---------|--------------|
| Detection mode (On Device ↔ HA) | Stops/starts wake word or pipeline. Switches during LISTENING/IDLE/PAUSED. |
| Model name (primary) | Stops detection, reloads keyword models, restarts. |
| Model name (second) | Same as primary — stops, reloads, restarts. |
| Sensitivity threshold | Live update — sets per-model thresholds without restart. |

**Deferred cache update:** The enabled/model/model2 cache values are only updated
after the change is successfully applied inside `_applyModeOrModelChange()`. If the
change is deferred (e.g., during an active interaction), the stale cache ensures
the change is re-detected on the next `checkSettingsChanged()` call.

**PAUSED state:** When the tab is hidden (state = PAUSED), model changes are accepted
— `stop()` is called to invalidate old state, but `start()` is deferred. On tab resume,
`restart()` detects the stale `_loadedModelsKey` and performs a full `start()` to load
the new models.

### 29.8 Custom Wake Word Models

Users can drop custom microWakeWord `.tflite` keyword models into either:
- **`/config/voice_satellite/models/`** (persistent — survives HACS updates)
- `custom_components/voice_satellite/models/` (integration dir — wiped on update)

**Persistence:** `_sync_custom_models()` in `__init__.py` runs on every startup
(via `async_add_executor_job`) before entity setup. It performs bidirectional sync:
1. Saves custom models from integration dir → persistent dir (backs up models
   placed directly in the integration dir)
2. Restores custom models from persistent dir → integration dir (recovers models
   after a HACS update)
Built-in models (`ok_nabu`, `hey_jarvis`, `alexa`, `hey_mycroft`,
`hey_home_assistant`, `hey_luna`, `okay_computer`, `stop`) are never
overwritten in either direction.

**Discovery:** `discover_wake_word_models()` scans the integration's `models/`
directory (which now includes restored custom models):
1. Filters out the `stop` model (infrastructure, not a wake word)
2. Adds all remaining `.tflite` files as options using the filename stem

The JS model loader handles unknown models via fallback:
`TFLITE_KEYWORD_FILES[modelName] || modelName` — so a custom model `my_word` loads
from `/voice_satellite/models/my_word.tflite`.

**Parameter resolution for custom models:**
1. If a companion `my_word.json` manifest exists alongside the `.tflite` file,
   parameters are loaded from it (see §29.5)
2. Otherwise, V2 fallback defaults: `cutoff: 0.90, slidingWindow: 3, stepSize: 10`
3. Detection threshold is overridden by `DEFAULT_THRESHOLDS` (see §29.6)

### 29.9 Cross-Satellite Duplicate Suppression

When on-device wake word detection triggers, the card starts the pipeline with
`start_stage: 'stt'`, bypassing HA core's server-side wake word stage. To
participate in HA core's cross-satellite dedup (`DATA_LAST_WAKE_UP` dictionary),
the card passes `wake_word_phrase` through the pipeline chain.

**Phrase format:** HA core uses human-friendly phrases (`"Okay Nabu"`, not
`"ok_nabu"`) as dedup keys — matching microWakeWord conventions.
`WAKE_WORD_PHRASES` maps model names to the correct phrases; custom models fall
back to underscore→space + title case transformation.

```
WAKE_WORD_PHRASES = {
  ok_nabu:              'Okay Nabu',
  hey_jarvis:           'Hey Jarvis',
  alexa:                'Alexa',
  hey_mycroft:          'Hey Mycroft',
  hey_home_assistant:   'Hey Home Assistant',
  hey_luna:             'Hey Luna',
  okay_computer:        'Okay Computer',
}
```

**Flow:**
```
_onDetection(modelName)
├── 1. Stop listening (_active = false)
├── 2. Unpause tab if paused (visibility._isPaused → false, audio.resume())
├── 3. Check mute — if muted, silently re-enable listening and return
├── 4. Interrupt media player (mediaPlayer.interrupt())
├── 5. Stop TTS if playing
├── 6. Clear previous interaction state (timeouts, chat, continue state)
├── 7. setState(WAKE_WORD_DETECTED), showBlurOverlay(PIPELINE)
├── 8. Play wake chime if enabled (stopSending → playChime → wait duration + 50ms → discard buffered audio)
└── 9. pipeline.start({ start_stage: 'stt', wake_word_phrase: getWakeWordPhrase(modelName) })
      └── runConfig includes wake_word_phrase → spread into WS message
            └── ws_run_pipeline extracts wake_word_phrase → async_run_pipeline
                  └── async_accept_pipeline_from_satellite(wake_word_phrase=...)
                        └── HA core checks DATA_LAST_WAKE_UP[phrase]
                              ├── Not within 2s cooldown → record + proceed
                              └── Within cooldown → DuplicateWakeUpDetectedError
                                    └── error event: "duplicate_wake_up_detected"
                                          └── handleError → hideBlurOverlay → restart(0) → ww.restart()
```

This is the same infrastructure Voice PE satellites use — fully unified. No
custom dedup logic. Works for card↔card and card↔Voice PE suppression.

### 29.10 Stop Model

**File:** `src/wake-word/index.js` (`enableStopModel`, `disableStopModel`,
`_onStopDetection`)

The `stop.tflite` model enables voice-based interruption of interruptible
states (TTS playback, notifications, timer alerts). It runs through the same
TFLite inference pipeline as wake word models.

**Pre-loading:** The stop model is loaded in the background via
`_preloadStopModel()` immediately after wake word detection starts. This
avoids a loading delay when stop is first needed.

**Two modes:**

| Mode | Trigger | Active Keywords | Use Case |
|------|---------|-----------------|----------|
| Stop-only | `enableStopModel(true)` | Only `stop` (wake words suspended) | TTS playback, notification playback |
| Alongside | `enableStopModel(false)` | Wake words + `stop` | Timer alerts |

**Stop-only mode mechanics:**
1. Current wake word keywords are saved to `_suspendedKeywords`
2. All keywords except `stop` are removed from the inference engine
3. `_stopOnlyMode = true`, inference state reset
4. On `disableStopModel()`: stop keyword removed, suspended keywords restored

**Integration points:**
- **Notifications** (`satellite-notification.js`): Enables stop-only mode
  after 1s delay (skip false triggers during chime), disables on completion
- **Timer alerts** (`timer/ui.js`): Enables stop alongside wake words when
  alert is showing, disables when dismissed
- **Audio processing** (`audio/processing.js`): Feeds audio to wake word
  when `wakeWord?.active` or `wakeWord?.stopOnlyMode`

**`_onStopDetection()` priority chain** (matches `DoubleTapHandler._cancel()`):

```
_onStopDetection()
├── disableStopModel()
├── 1. Timer alert (highest priority)
│     └── timer.dismissAlert()
├── 2. Notification (announcement / ask-question / start-conversation)
│     ├── Send ACK for each active notification
│     ├── Pause audio, clear state, cancel askQuestion
│     ├── Clear notification status override
│     ├── Play done chime (if wake_sound enabled)
│     └── pipeline.restart(0)
└── 3. TTS / active interaction (lowest priority)
      ├── Stop TTS, clear image linger timeout
      ├── Cancel askQuestion, clear continue state
      ├── setState(IDLE), clear chat, hide blur overlay
      ├── Play done chime (if wake_sound enabled)
      └── pipeline.restart(0)
```

---

## 30. Implementation Checklist

A step-by-step guide to recreate the frontend from scratch:

### Phase 1: Foundation

- [ ] Set up Webpack with two entry points (`voice-satellite-card`, `voice-satellite-panel`) and DefinePlugin for `__VERSION__`
- [ ] Create `constants.js` with State enum, timing, default config (including `auto_start`)
- [ ] Create `logger.js` with domain-prefixed debug logging
- [ ] Create `index.js` entry point registering both custom elements + calling `initEngine()`

### Phase 2: Engine Bootstrap

- [ ] Create `engine/index.js` with `initEngine()`, `bootstrapEngine()`, `waitForHass()`
- [ ] Implement `attemptStart()` with `auto_start` check from `vs-panel-config` localStorage
- [ ] Implement `ensureEngineCard()` — create hidden `voice-satellite-card` for UI overlay
- [ ] Implement `startHassObserver()` — 1s interval feeding hass to session, re-attempting start
- [ ] Guard against double-init via `window.__vsEngine`
- [ ] Handle `_userStopped` flag to prevent auto-restart after explicit stop

### Phase 3: Sidebar Panel

- [ ] Create `panel/index.js` as separate webpack entry point
- [ ] Implement `VoiceSatellitePanel` custom element with light DOM
- [ ] HA-native toolbar: brand icon, title, version (`v${VERSION}`), help link
- [ ] Engine status card: running/dormant indicator, state dot, Start/Stop buttons
- [ ] Entity picker card: `ha-form` with `entitySchema`
- [ ] Settings card: `ha-form` with `panelSchema` (behavior + autoStart + skin + mic + debug)
- [ ] Live preview card: shadow DOM with `renderPreview()`
- [ ] Config persistence: read/write `vs-panel-config` in localStorage
- [ ] `_onConfigChange()`: update session, manage engine start/stop, sync forms
- [ ] `ensureHaComponents()`: lazy-load `ha-form` and `ha-entity-picker`
- [ ] Start button: create engine card if needed, clear `_userStopped`, rAF start
- [ ] Stop button: set `_userStopped`, call `session.teardown()`

### Phase 4: Session Singleton

- [ ] Create `VoiceSatelliteSession` class with `window.__vsSession`
- [ ] Implement card interface (all getters managers expect)
- [ ] Implement `register()`, `unregister()`, editor preview guard
- [ ] Implement `start()`, `teardown()`, `updateHass()`, `updateConfig()`

### Phase 5: Audio Pipeline

- [ ] `AudioManager`: getUserMedia, AudioContext, AudioWorklet
- [ ] `audio/processing.js`: AudioWorkletProcessor + sample rate conversion
- [ ] `audio/comms.js`: Binary frame encoding for WS
- [ ] `PipelineManager`: WS subscribe, generation counter, restart logic
- [ ] `pipeline/comms.js`: subscribePipelineRun, reconnect listener
- [ ] `pipeline/events.js`: All event handlers (run-start through error)
- [ ] Session events: setState, startListening, handlePipelineMessage

### Phase 6: TTS & Audio Output

- [ ] `audio/chime.js`: Pre-rendered MP3 chime playback + remote routing
- [ ] `audio/media-playback.js`: HTML5 Audio helper
- [ ] `TtsManager`: Browser + remote playback, streaming, watchdog
- [ ] `tts/comms.js`: Remote media player service calls
- [ ] Session events: onTTSComplete with continue-conversation

### Phase 7: Reactive Bar

- [ ] `AnalyserManager`: Dual-analyser architecture
- [ ] Mic analyser path (no destination)
- [ ] Audio analyser path (through destination)
- [ ] rAF tick loop with FPS cap and `--vs-audio-level` CSS variable
- [ ] Deferred start for notification playback

### Phase 8: Full Card UI

- [ ] `UIManager`: Global overlay in document.body
- [ ] Rainbow bar with state-driven animations
- [ ] Reference-counted blur overlay
- [ ] Start button with error reason display
- [ ] Chat bubbles (user/assistant/announcement)
- [ ] Rich media panels (images, videos, weather, financial)
- [ ] Lightbox (image + YouTube video embed)
- [ ] Timer pill DOM + finished-alert overlay

### Phase 9: Mini Card UI

- [ ] `MiniUIManager`: Shadow DOM with ha-card shell
- [ ] Compact mode: single-line marquee with TTS-synced scroll
- [ ] Tall mode: scrollable transcript with TTS-synced vertical scroll
- [ ] Status dot + label with state-driven styling
- [ ] Inline timer pills (compact: nearest only; tall: all)
- [ ] Timer alert overlay within card bounds
- [ ] Notification status override (Announcement/Question/Conversation)

### Phase 10: Broadcast Proxies

- [ ] `UIBroadcastProxy`: Forward all UI calls to all registered cards
- [ ] Query method aggregation (isLightboxVisible, hasVisibleImages, etc.)
- [ ] Timer pill per-UI reference tracking (`_uiEls` Map)
- [ ] `ChatBroadcastProxy`: Forward chat calls, shared streamedResponse

### Phase 11: Notification System

- [ ] `satellite-notification.js`: dispatch, queue, playback flow
- [ ] `satellite-subscription.js`: WS event subscription with retry
- [ ] `AnnouncementManager`: Play → linger → cleanup → re-sync state
- [ ] `AskQuestionManager`: Play → STT capture → answer → feedback
- [ ] `StartConversationManager`: Play → full pipeline continuation
- [ ] Pre-announce chime + custom preannounce media support
- [ ] Tab-hidden event queuing with visibility replay

### Phase 12: Timer System

- [ ] `TimerManager`: Entity subscription, timer sync, 1s tick
- [ ] `timer/events.js`: Detect add/remove/finish from state changes
- [ ] `timer/ui.js`: Pill DOM, finished alert, chime loop
- [ ] `timer/comms.js`: Cancel timer WS command
- [ ] Double-tap pill cancellation

### Phase 13: Supporting Systems

- [ ] `MediaPlayerManager`: Play/pause/stop, volume, state reporting
- [ ] `VisibilityManager`: Pause/resume with debounce
- [ ] `DoubleTapHandler`: Document-level cancel with priority system
- [ ] `entity-picker.js`: localStorage persistence + validation (no auto-select)
- [ ] `satellite-state.js`: Read switch/select/number entity states
- [ ] `ChatManager`: Streaming text with 24-char fade + RAF coalescing

### Phase 14: Skins & Editor

- [ ] Skin registry with lazy-loaded chunks (default bundled, 5 others on demand)
- [ ] `getSkin()` sync accessor + `loadSkin()` async loader with cache
- [ ] Skin CSS injection into document.head
- [ ] Custom CSS support
- [ ] Full card config form (HA native schema)
- [ ] Mini card config form
- [ ] Editor preview detection and static preview rendering
- [ ] Full card suppression toggle

### Phase 15: On-Device Wake Word Detection

- [ ] `WakeWordManager`: Lazy-loaded via webpack code splitting
- [ ] `micro-models.js`: TFLite WASM runtime loading from `/voice_satellite/tflite/` (script tag + `window.exports` stub)
- [ ] `micro-models.js`: Keyword model loading with `_modelCache`, `TFLITE_KEYWORD_FILES` mapping + custom fallback
- [ ] `micro-models.js`: Companion JSON manifest loading (`_loadModelManifest()`) with `_jsonParamsCache`
- [ ] `micro-models.js`: `getMicroModelParams()` priority chain: JSON → hardcoded → V2 fallback
- [ ] `micro-models.js`: `releaseUnusedMicroModels()` to dispose runners no longer active (skip stop)
- [ ] `micro-frontend.js`: `MicroFrontend` — Hann window, 512-pt FFT, 40-ch mel filterbank
- [ ] `micro-frontend.js`: FilterbankSqrt + noise floor injection (NOISE_FLOOR=1000, AUDIO_SCALE=2500)
- [ ] `micro-frontend.js`: Noise reduction (asymmetric smoothing, NR_UP_MULT=0.025, NR_DOWN_MULT=2.0)
- [ ] `micro-frontend.js`: PCAN gain control + log₂ scale + int8 quantization
- [ ] `micro-frontend.js`: Ring buffer for overlapping windows (hop=160, window=480)
- [ ] `micro-inference.js`: `MicroWakeWordInference` — feature extraction + keyword classifier pipeline
- [ ] `micro-inference.js`: Auto-detect input tensor shape for framesPerInfer
- [ ] `micro-inference.js`: Sliding window detection (circular probability buffer)
- [ ] `micro-inference.js`: Energy-based sleep mode (opt-in via noise gate switch) with ring buffer (SLEEP_BUFFER_CHUNKS=8, onset replay)
- [ ] `micro-inference.js`: Warmup period (WARMUP_FRAMES=100) + cooldown (COOLDOWN_MS=2000)
- [ ] `micro-inference.js`: Dynamic keyword add/remove (`addKeyword()`, `removeKeyword()`)
- [ ] `micro-inference.js`: `updateThresholds()` for live per-model threshold changes
- [ ] `micro-inference.js`: `updateEnergyThresholds()` for live energy gate changes
- [ ] `index.js`: feedAudio → chunk accumulation → serial drain queue
- [ ] `index.js`: `getActiveModels()` deduplication, `getModelName2()`, `getThresholdForModel()`
- [ ] `index.js`: `_onDetection(modelName)` — mute check, tab unpause, media interrupt, chime, pipeline start
- [ ] `index.js`: `WAKE_WORD_PHRASES` for cross-satellite dedup + custom model fallback (underscore→space+titleCase)
- [ ] `index.js`: Settings change tracking (mode, model, model2, threshold, noiseGate) with deferred cache update
- [ ] `index.js`: Live threshold and noise gate toggle updates without restart
- [ ] `index.js`: PAUSED state handling — accept changes, reload models on resume via `restart()`
- [ ] `index.js`: Stop model — `_preloadStopModel()` background loading on start
- [ ] `index.js`: Stop model — `enableStopModel(stopOnly)` with keyword suspend/restore
- [ ] `index.js`: Stop model — `disableStopModel()` with keyword restore
- [ ] `index.js`: Stop model — `_onStopDetection()` priority chain (timer > notification > TTS)
- [ ] Session integration: `_checkWakeWordActivation()`, `_loadWakeWordModule()`
- [ ] Per-model `MODEL_THRESHOLDS` + `DEFAULT_THRESHOLDS` calibrated for browser TFLite inference

### Phase 16: Polish

- [ ] i18n system with HA locale integration
- [ ] Version sync script (package.json → manifest.json → const.py)
- [ ] Token refresh timer for streaming TTS
- [ ] Playback watchdog for stalled TTS
- [ ] `resetForResume` to prevent tab-resume race conditions
- [ ] Displaced event handling (another browser took over)
