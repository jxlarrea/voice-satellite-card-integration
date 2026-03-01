# Voice Satellite Card Integration — Design Document

> Comprehensive design reference for the Python integration component.
> Companion document to DESIGN-CARD.md which covers the JavaScript card.
> A future implementer should be able to recreate the entire integration
> from this document alone.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Card Interface](#3-card-interface)
4. [File Map](#4-file-map)
5. [Integration Lifecycle](#5-integration-lifecycle)
6. [Config Flow](#6-config-flow)
7. [Frontend Registration](#7-frontend-registration)
8. [Device & Entity Architecture](#8-device--entity-architecture)
9. [Satellite Entity](#9-satellite-entity)
10. [Pipeline State Synchronization](#10-pipeline-state-synchronization)
11. [Bridged Pipeline](#11-bridged-pipeline)
12. [Satellite Event Subscription](#12-satellite-event-subscription)
13. [Announcement System](#13-announcement-system)
14. [Start Conversation](#14-start-conversation)
15. [Ask Question](#15-ask-question)
16. [Timer System](#16-timer-system)
17. [Screensaver Keep-Alive](#17-screensaver-keep-alive)
18. [Media Player Entity](#18-media-player-entity)
19. [Select Entities](#19-select-entities)
20. [Switch Entities](#20-switch-entities)
21. [Number Entity](#21-number-entity)
22. [WebSocket API](#22-websocket-api)
23. [Error Handling & Concurrency](#23-error-handling--concurrency)
24. [HA API Dependencies](#24-ha-api-dependencies)
25. [Strings & Localization](#25-strings--localization)
26. [Implementation Checklist](#26-implementation-checklist)

---

## 1. Overview

Voice Satellite Card is a custom Home Assistant integration that registers browser
tablets as virtual Assist Satellite devices. This gives the JavaScript card
(documented in DESIGN-CARD.md) a proper device identity in HA, unlocking:

- **Timers** — LLM-triggered `HassStartTimer` routed to the correct device
- **Announcements** — `assist_satellite.announce` service targets the browser
- **Start conversation** — `assist_satellite.start_conversation` prompts the user
- **Ask question** — `assist_satellite.ask_question` with hassil answer matching
- **Media playback** — `media_player.play_media` / `tts.speak` to browser audio
- **Per-device configuration** — Pipeline, VAD, wake sound, mute, screensaver, TTS output, wake word detection/model/sensitivity
- **Per-device automations** — Automations can target specific browser satellites

### 1.1 Relationship to HA Core

The integration extends `AssistSatelliteEntity` from `homeassistant.components.assist_satellite`.
Unlike physical satellites (e.g. ESP32-S3 running ESPHome), this satellite has no persistent
TCP connection — the card opens a WebSocket subscription to stream audio and receive events.
The integration bridges between HA's internal pipeline system and the card's WebSocket
connection.

### 1.2 Design Principles

1. **Single device per entry** — One config entry creates exactly one device with all 12 entities
2. **Push, not poll** — Events flow to the card via `connection.send_event()` subscriptions
3. **Optimistic + reactive** — Commands update state immediately; card reports back for reconciliation
4. **Blocking with timeout** — Announcement/question flows use `asyncio.Event` with 120s timeout
5. **Sequence counters** — `_announce_id` prevents stale ACKs from old interactions
6. **Generation counters** — `_pipeline_gen` filters orphaned events from old pipeline runs
7. **Immutable lists** — Timer list is replaced (not mutated) so HA detects attribute changes
8. **Availability = subscription** — Entity is `available` only when a card has an active `subscribe_events` connection

---

## 2. Architecture

### 2.1 High-Level Diagram

```
┌─────────────────────────────────────────────────────┐
│                  Home Assistant Core                  │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Assist     │  │   Intent /   │  │  Lovelace   │ │
│  │  Pipeline    │  │   Timer Mgr  │  │  Resources  │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                │                  │        │
│  ┌──────┴────────────────┴──────────────────┴──────┐ │
│  │        voice_satellite integration               │ │
│  │                                                   │ │
│  │  ┌─────────────┐  ┌────────────┐  ┌───────────┐ │ │
│  │  │ Satellite   │  │  Media     │  │  Selects  │ │ │
│  │  │ Entity      │  │  Player    │  │  Switches │ │ │
│  │  │ (assist_    │  │  Entity    │  │  Number   │ │ │
│  │  │  satellite) │  │            │  │           │ │ │
│  │  └──────┬──────┘  └─────┬──────┘  └─────┬─────┘ │ │
│  │         │               │               │        │ │
│  │  ┌──────┴───────────────┴───────────────┴──────┐ │ │
│  │  │         7 WebSocket API Handlers            │ │ │
│  │  │  run_pipeline | subscribe_events | ...      │ │ │
│  │  └─────────────────────┬───────────────────────┘ │ │
│  └────────────────────────┼─────────────────────────┘ │
│                           │                            │
└───────────────────────────┼────────────────────────────┘
                            │  WebSocket
                            │
┌───────────────────────────┼────────────────────────────┐
│  Browser                  │                             │
│                           │                             │
│  ┌────────────────────────┴──────────────────────────┐ │
│  │            Voice Satellite Card (JS)               │ │
│  │  Pipeline ↔ Audio ↔ TTS ↔ Chat ↔ UI               │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow Summary

| Direction | Channel | Content |
|---|---|---|
| Card → Integration | `voice_satellite/run_pipeline` | Pipeline subscription + binary audio frames |
| Card → Integration | `voice_satellite/update_state` | Pipeline state changes (STT, INTENT, etc.) |
| Card → Integration | `voice_satellite/announce_finished` | Announcement playback ACK |
| Card → Integration | `voice_satellite/question_answered` | STT transcription for ask_question |
| Card → Integration | `voice_satellite/cancel_timer` | Timer cancellation request |
| Card → Integration | `voice_satellite/media_player_event` | Playback state report (playing/paused/idle) |
| Integration → Card | `subscribe_events` push | Announcements, start_conversation, ask_question, timers, media commands |
| Integration → Card | `run_pipeline` events | Pipeline events (run-start, wake_word-end, stt-end, intent-progress, tts-end, etc.) |
| Integration → Card | Entity attributes | Timers, mute state, wake sound, TTS target, announcement duration |

---

## 3. Card Interface

This section documents the bidirectional protocol between the integration and the
card. See DESIGN-CARD.md §3 for the card's perspective.

### 3.1 Pipeline Subscription Protocol

The card initiates a pipeline by calling `voice_satellite/run_pipeline`. The integration:

1. Sends `send_result(msg_id)` — resolves the JS `subscribeMessage()` promise
2. Sends `send_event(msg_id, {type: "init", handler_id})` — card stores `binaryHandlerId`
3. Card starts sending binary audio frames to the `handler_id`
4. Integration feeds audio to `async_accept_pipeline_from_satellite()`
5. Pipeline events flow back via `send_event(msg_id, {type, data})`
6. On unsubscribe: card sends empty bytes `b""` as stop signal

### 3.2 Satellite Event Protocol

The card subscribes via `voice_satellite/subscribe_events`. The integration pushes events:

```
{type: "announcement",        data: {id, message, media_id, preannounce_media_id, ...}}
{type: "start_conversation",  data: {id, message, media_id, start_conversation: true, ...}}
{type: "media_player",        data: {command: "play"|"pause"|"resume"|"stop"|"volume_set"|"volume_mute", ...}}
{type: "timer",               data: {timers: [...], last_timer_event: "started"|"cancelled"|"finished"|"updated"}}
```

### 3.3 Entity Attributes Read by the Card

The card reads the satellite entity's `extra_state_attributes`:

| Attribute | Type | Source |
|---|---|---|
| `active_timers` | `list[dict]` | Timer handler events |
| `last_timer_event` | `string` | Most recent timer event type |
| `muted` | `bool` | Mute switch state |
| `wake_sound` | `bool` | Wake sound switch state |
| `tts_target` | `string` | Selected TTS output entity_id (empty = browser) |
| `announcement_display_duration` | `int` | Seconds to display announcement bubbles |

### 3.4 Sibling Entity State Propagation

The satellite entity tracks state changes from sibling entities (mute switch, wake sound
switch, TTS output select, announcement duration number) via `async_track_state_change_event`.
When any tracked entity changes, `_on_switch_state_change` calls `async_write_ha_state()`,
which re-evaluates `extra_state_attributes` and pushes the update to the card.

---

## 4. File Map

| File | Lines | Purpose |
|---|---|---|
| `__init__.py` | 418 | Integration setup, 7 WebSocket handlers, `_find_entity()` helper |
| `assist_satellite.py` | 1181 | `VoiceSatelliteEntity` — main satellite entity, pipeline bridging, announcements, ask_question, timers, screensaver |
| `media_player.py` | 263 | `VoiceSatelliteMediaPlayer` — media player entity with command push |
| `select.py` | 537 | 7 select entities: Pipeline, VAD, Screensaver, TTS Output, Wake Word Detection, Wake Word Model, Wake Word Sensitivity |
| `switch.py` | 112 | 2 switch entities: Wake Sound, Mute |
| `number.py` | 76 | 1 number entity: Announcement Display Duration |
| `frontend.py` | 135 | `JSModuleRegistration` — auto-registers card JS in Lovelace |
| `config_flow.py` | 41 | Name-based config flow with duplicate detection |
| `const.py` | 14 | Constants: `DOMAIN`, `SCREENSAVER_INTERVAL`, `INTEGRATION_VERSION`, `URL_BASE`, `JS_FILENAME` |
| `manifest.json` | 20 | Integration metadata, dependencies, version |
| `strings.json` | 62 | Entity translations and config flow strings |

**Total: ~2662 lines** across 11 files (10 Python + 1 JSON manifest + 1 JSON strings).

### 4.2 Directory Structure

```
custom_components/voice_satellite/
├── __init__.py
├── assist_satellite.py
├── config_flow.py
├── const.py
├── frontend.py
├── manifest.json
├── media_player.py
├── number.py
├── select.py
├── strings.json
├── switch.py
├── frontend/
│   ├── voice-satellite-card.js       ← Main bundle (gitignored, CI builds)
│   ├── voice-satellite-wake-word.js  ← Wake word chunk (lazy-loaded)
│   └── voice-satellite-skin-*.js     ← Skin chunks (lazy-loaded)
├── models/
│   ├── melspectrogram.onnx           ← Common: audio → mel features
│   ├── embedding_model.onnx          ← Common: mel → 96-dim embeddings
│   ├── silero_vad.onnx               ← Common: voice activity detection
│   ├── ok_nabu.onnx                  ← Keyword model (default)
│   ├── hey_jarvis_v0.1.onnx          ← Keyword model
│   ├── alexa_v0.1.onnx               ← Keyword model
│   ├── hey_mycroft_v0.1.onnx         ← Keyword model
│   ├── hey_rhasspy_v0.1.onnx         ← Keyword model
│   └── *.onnx                        ← User-provided custom keyword models
└── ort/
    ├── ort.wasm.min.mjs              ← ONNX Runtime entry point
    └── ort-wasm-*.wasm               ← WASM binaries
```

The `frontend/` subdirectory is resolved at runtime via `Path(__file__).parent / "frontend"`.
The `models/` directory is scanned by `discover_wake_word_models()` in `select.py` to
populate the wake word model select entity. The `ort/` directory contains onnxruntime-web
files copied from `node_modules` during the build.

### 4.3 Module-Level Constants

| Constant | File | Value | Purpose |
|---|---|---|---|
| `DOMAIN` | `const.py` | `"voice_satellite"` | Integration domain identifier |
| `SCREENSAVER_INTERVAL` | `const.py` | `5` (seconds) | Keep-alive periodic timer interval |
| `INTEGRATION_VERSION` | `const.py` | `"5.8.0"` | Synced from `package.json` by `scripts/sync-version.js` |
| `URL_BASE` | `const.py` | `"/voice_satellite"` | HTTP static path prefix |
| `JS_FILENAME` | `const.py` | `"voice-satellite-card.js"` | Built JS filename |
| `ANNOUNCE_TIMEOUT` | `assist_satellite.py` | `120` (seconds) | Timeout for announcement/question ACK wait |
| `SCREENSAVER_DISABLED` | `select.py` | `"Disabled"` | Default option for screensaver select |
| `TTS_OUTPUT_BROWSER` | `select.py` | `"Browser"` | Default option for TTS output select |
| `WAKE_WORD_DETECTION_HA` | `select.py` | `"Home Assistant"` | Server-side wake word option |
| `WAKE_WORD_DETECTION_LOCAL` | `select.py` | `"On Device"` | On-device wake word option (default) |
| `WAKE_WORD_SENSITIVITY_OPTIONS` | `select.py` | `["Slightly sensitive", "Moderately sensitive", "Very sensitive"]` | Wake word sensitivity levels |
| `_COMMON_MODELS` | `select.py` | `{"melspectrogram", "embedding_model", "silero_vad"}` | Infrastructure ONNX models (excluded from keyword list) |
| `_BUILTIN_FILENAME_MAP` | `select.py` | versioned filename → friendly name | Maps built-in keyword filenames |
| `_CACHE_TTL` | `select.py` (class attr) | `30` (seconds) | Entity mapping cache lifetime |
| `FRONTEND_DIR` | `frontend.py` | `Path(__file__).parent / "frontend"` | Static path to JS directory |

---

## 5. Integration Lifecycle

### 5.1 `async_setup()` — Integration-Wide Setup

Called once when HA loads the integration (not per entry). Two responsibilities:

1. **Register 7 WebSocket commands** — All WS handlers are registered here (once, not per-entry)
2. **Register frontend JS** — Creates `JSModuleRegistration` and calls `async_register()`

```python
async def async_setup(hass, config):
    # 1. WebSocket commands
    websocket_api.async_register_command(hass, ws_announce_finished)
    websocket_api.async_register_command(hass, ws_update_state)
    websocket_api.async_register_command(hass, ws_question_answered)
    websocket_api.async_register_command(hass, ws_run_pipeline)
    websocket_api.async_register_command(hass, ws_subscribe_satellite_events)
    websocket_api.async_register_command(hass, ws_cancel_timer)
    websocket_api.async_register_command(hass, ws_media_player_event)

    # 2. Frontend JS (deferred if HA not fully started)
    if hass.state is CoreState.running:
        await _register_frontend()
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _register_frontend)
```

The frontend registration is deferred to `EVENT_HOMEASSISTANT_STARTED` because the
Lovelace resources collection may not be loaded yet during early startup.

### 5.2 `async_setup_entry()` — Per-Entry Setup

Called for each config entry. Minimal — just initializes the data store and forwards
to all 5 platforms:

```python
PLATFORMS = [Platform.ASSIST_SATELLITE, Platform.MEDIA_PLAYER,
             Platform.NUMBER, Platform.SELECT, Platform.SWITCH]

async def async_setup_entry(hass, entry):
    hass.data.setdefault(DOMAIN, {})
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
```

### 5.3 `async_unload_entry()` — Entry Teardown

Unloads all platforms, cleans up data store entries, and removes the Lovelace
resource when the last entry is unloaded:

```python
async def async_unload_entry(hass, entry):
    result = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if result:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop(f"{entry.entry_id}_media_player", None)
        if not hass.data[DOMAIN]:  # Last entry removed
            registration = JSModuleRegistration(hass)
            await registration.async_unregister()
```

### 5.4 Entity Registration in `hass.data`

Each platform's `async_setup_entry` stores its entity in `hass.data[DOMAIN]` for
WebSocket handler lookup:

| Key | Entity | Stored by |
|---|---|---|
| `{entry.entry_id}` | `VoiceSatelliteEntity` | `assist_satellite.py` |
| `{entry.entry_id}_media_player` | `VoiceSatelliteMediaPlayer` | `media_player.py` |

The `_find_entity()` helper in `__init__.py` scans `hass.data[DOMAIN]` to find
entities by `entity_id`:

```python
def _find_entity(hass, entity_id, predicate=None):
    for _, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id and (predicate is None or predicate(ent)):
            return ent
    return None
```

---

## 6. Config Flow

### 6.1 Flow Structure

The config flow is a single-step user flow. The user enters a name for the satellite:

```python
class VoiceSatelliteConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        if user_input is not None:
            name = user_input["name"].strip()
            await self.async_set_unique_id(name.lower().replace(" ", "_"))
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title=name, data={"name": name})

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required("name"): str}),
        )
```

### 6.2 Unique ID Generation

The unique ID is derived from the satellite name: `name.lower().replace(" ", "_")`.

- `"Kitchen Tablet"` → unique_id `"kitchen_tablet"`
- Duplicate detection via `self._abort_if_unique_id_configured()`

### 6.3 Config Entry Data

```python
entry.data = {"name": "Kitchen Tablet"}
entry.entry_id = "auto_generated_uuid"  # HA generates this
```

The `entry.entry_id` (a UUID) is used as the base for all entity unique IDs and
device identifiers. The `name` from `entry.data` becomes the device name and
satellite display name.

---

## 7. Frontend Registration

### 7.1 `JSModuleRegistration` Class

Handles auto-registering the card's built JavaScript file as a Lovelace resource
so users don't need to manually add it.

```python
class JSModuleRegistration:
    def __init__(self, hass):
        self.hass = hass
        self.lovelace = hass.data.get("lovelace")
        # HA 2026.2 renamed lovelace.mode -> lovelace.resource_mode
        self.resource_mode = getattr(
            self.lovelace, "resource_mode",
            getattr(self.lovelace, "mode", "yaml"),
        )
```

### 7.2 Registration Flow

```
async_register()
  ├── _async_register_path()          # Static HTTP path
  │     └── hass.http.async_register_static_paths(
  │           [StaticPathConfig("/voice_satellite", FRONTEND_DIR, False)]
  │         )
  └── if MODE_STORAGE:
        └── _async_wait_for_lovelace_resources()
              └── poll until lovelace.resources.loaded (12 retries × 5s = 60s)
                    └── _async_register_module()
                          ├── Check if URL already registered
                          ├── Update version if URL changed
                          └── Create new resource if not found
```

### 7.3 Static Path

The integration serves its `frontend/` directory at `/voice_satellite`.
The directory path is computed at module level:

```python
FRONTEND_DIR = str(Path(__file__).parent / "frontend")
```

This means the built JS file must exist at:
```
custom_components/voice_satellite/frontend/voice-satellite-card.js
```

### 7.4 Versioned URL

The Lovelace resource URL includes a version query parameter for cache busting:

```
/voice_satellite/voice-satellite-card.js?v=5.7.3
```

When the integration updates, `_async_register_module()` detects the version
mismatch and updates the resource URL. URL comparison strips the query parameter
to match base paths: `resource["url"].split("?")[0] == url`. This ensures the
version-stamped URL (`?v=5.7.3`) still matches the base URL for update detection.

### 7.5 YAML Mode Fallback

If Lovelace is in YAML mode (`resource_mode != MODE_STORAGE`), auto-registration
is not possible. The integration logs a message instructing the user:

```
Lovelace is in YAML mode - add this resource manually:
url: /voice_satellite/voice-satellite-card.js, type: module
```

### 7.6 Unregistration

When the last config entry is removed, `async_unregister()` removes the Lovelace
resource entry:

```python
async def async_unregister(self):
    if self.lovelace is None or self.resource_mode != MODE_STORAGE:
        return
    if not self.lovelace.resources.loaded:
        await self.lovelace.resources.async_load()
    url = f"{URL_BASE}/{JS_FILENAME}"
    for resource in self.lovelace.resources.async_items():
        if resource["url"].split("?")[0] == url:
            await self.lovelace.resources.async_delete_item(resource["id"])
            break
```

### 7.7 HA 2026.2 Compatibility

HA 2026.2 renamed `lovelace.mode` to `lovelace.resource_mode`. The constructor
uses `getattr` with fallback to handle both versions:

```python
self.resource_mode = getattr(
    self.lovelace, "resource_mode",
    getattr(self.lovelace, "mode", "yaml"),
)
```

---

## 8. Device & Entity Architecture

### 8.1 Single Device Per Entry

Each config entry creates exactly one device in the device registry. All 12 entities
share this device via identical `device_info`:

```python
@property
def device_info(self):
    return {
        "identifiers": {(DOMAIN, self._entry.entry_id)},
    }
```

The satellite entity additionally provides full device metadata:

```python
@property
def device_info(self):
    return {
        "identifiers": {(DOMAIN, self._entry.entry_id)},
        "name": self._satellite_name,
        "manufacturer": "Voice Satellite Card Integration",
        "model": "Browser Satellite",
        "sw_version": INTEGRATION_VERSION,
    }
```

### 8.2 Entity Summary Table

| # | Platform | Class | Translation Key | Unique ID Pattern | Entity Category | Restore |
|---|---|---|---|---|---|---|
| 1 | `assist_satellite` | `VoiceSatelliteEntity` | *(uses device name)* | `{entry_id}` | — | No |
| 2 | `media_player` | `VoiceSatelliteMediaPlayer` | `media_player` | `{entry_id}_media_player` | — | Yes (volume) |
| 3 | `select` | `VoiceSatellitePipelineSelect` | *(from framework)* | `{entry_id}-pipeline` | — | Yes (framework) |
| 4 | `select` | `VoiceSatelliteVadSensitivitySelect` | *(from framework)* | `{entry_id}-vad_sensitivity` | — | Yes (framework) |
| 5 | `select` | `VoiceSatelliteScreensaverSelect` | `screensaver` | `{entry_id}_screensaver` | CONFIG | Yes |
| 6 | `select` | `VoiceSatelliteTTSOutputSelect` | `tts_output` | `{entry_id}_tts_output` | CONFIG | Yes |
| 7 | `select` | `VoiceSatelliteWakeWordDetectionSelect` | `wake_word_detection` | `{entry_id}_wake_word_detection` | CONFIG | Yes |
| 8 | `select` | `VoiceSatelliteWakeWordModelSelect` | `wake_word_model` | `{entry_id}_wake_word_model` | CONFIG | Yes |
| 9 | `select` | `VoiceSatelliteWakeWordSensitivitySelect` | `wake_word_sensitivity` | `{entry_id}_wake_word_sensitivity` | CONFIG | Yes |
| 10 | `switch` | `VoiceSatelliteWakeSoundSwitch` | `wake_sound` | `{entry_id}_wake_sound` | CONFIG | Yes |
| 11 | `switch` | `VoiceSatelliteMuteSwitch` | `mute` | `{entry_id}_mute` | CONFIG | Yes |
| 12 | `number` | `VoiceSatelliteAnnouncementDurationNumber` | `announcement_display_duration` | `{entry_id}_announcement_display_duration` | CONFIG | Yes |

### 8.3 Unique ID Patterns

Two patterns are used for unique IDs:

- **Framework entities** (Pipeline, VAD): `{entry_id}-{suffix}` (hyphen separator, set by base class)
- **Custom entities**: `{entry_id}_{suffix}` (underscore separator)

This is because `AssistPipelineSelect` and `VadSensitivitySelect` construct their
own unique IDs internally using `{entry_id}-pipeline` and `{entry_id}-vad_sensitivity`.

### 8.4 Entity Registry Lookup Pattern

The satellite entity frequently looks up sibling entity IDs via the entity registry:

```python
registry = er.async_get(self.hass)
eid = registry.async_get_entity_id("switch", DOMAIN, f"{self._entry.entry_id}_mute")
if eid:
    state = self.hass.states.get(eid)
    # Use state...
```

This is used in `extra_state_attributes`, `pipeline_entity_id`, `vad_sensitivity_entity_id`,
and `_get_screensaver_entity_id()`.

### 8.5 Availability Model

The satellite entity's availability is subscription-based:

```python
@property
def available(self):
    if self.hass.is_stopping:
        return True  # Allow RestoreEntity to save full attributes
    return len(self._satellite_subscribers) > 0
```

**Why `True` during shutdown?** If the entity reports `unavailable`, HA's RestoreEntity
will only save the state string ("unavailable"), not the full attributes (timers,
volume, etc.). Reporting `available = True` during shutdown ensures `extra_state_attributes`
and `ExtraStoredData` are preserved for the next startup.

The media player delegates to the satellite:

```python
@property
def available(self):
    satellite = self._get_satellite_entity()
    if satellite is None:
        return False
    return satellite.available
```

All other entities (selects, switches, number) have no custom availability — they're
always available since they're local configuration entities.

---

## 9. Satellite Entity

### 9.1 Class Hierarchy

```python
class VoiceSatelliteEntity(AssistSatelliteEntity):
    _attr_has_entity_name = True
    _attr_name = None  # Use device name
    _attr_supported_features = (
        AssistSatelliteEntityFeature.ANNOUNCE
        | AssistSatelliteEntityFeature.START_CONVERSATION
    )
```

The entity extends HA's `AssistSatelliteEntity`, inheriting:
- Pipeline integration via `async_accept_pipeline_from_satellite()`
- Event callback via `on_pipeline_event()`
- Announcement dispatch via `async_internal_announce()` → `async_announce()`
- Start conversation via `async_internal_start_conversation()` → `async_start_conversation()`
- Ask question via `async_internal_ask_question()` (HA 2025.7+)
- Configuration via `async_get_configuration()` / `async_set_configuration()`

### 9.2 Instance State

```python
def __init__(self, entry):
    # Identity
    self._entry = entry
    self._satellite_name = entry.data["name"]
    self._attr_unique_id = entry.entry_id

    # Active timers (extra_state_attributes)
    self._active_timers: list[dict] = []
    self._last_timer_event: str | None = None

    # Announcement blocking state
    self._announce_event: asyncio.Event | None = None
    self._announce_id: int = 0   # Sequence counter

    # Ask question state
    self._question_event: asyncio.Event | None = None
    self._question_answer_text: str | None = None
    self._ask_question_pending: bool = False
    self._question_match_event: asyncio.Event | None = None
    self._question_match_result: dict | None = None

    # Preannounce flag (captured before base class consumes it)
    self._preannounce_pending: bool = True

    # Extra system prompt (captured from start_conversation)
    self._pending_extra_system_prompt: str | None = None
    self._extra_system_prompt: str | None = None

    # Bridged pipeline state
    self._pipeline_connection = None      # ActiveConnection for relay
    self._pipeline_msg_id: int | None = None
    self._pipeline_task: asyncio.Task | None = None
    self._pipeline_audio_queue: asyncio.Queue | None = None
    self._pipeline_gen: int = 0           # Generation counter
    self._pipeline_run_started: bool = False
    self._conversation_id: str | None = None

    # Satellite event subscribers
    self._satellite_subscribers: list[tuple] = []

    # Screensaver keep-alive
    self._screensaver_unsub = None
```

### 9.3 `async_added_to_hass()`

Called when the entity is registered. Performs three setup tasks:

1. **Timer handler registration** — Registers this device with HA's intent timer system.
   Wrapped in `self.async_on_remove()` so the handler is automatically unregistered
   when the entity is removed (prevents memory leaks and orphaned callbacks).
2. **Sibling entity tracking** — Subscribes to state changes on mute, wake_sound,
   tts_output, and announcement_duration entities. Also wrapped in `async_on_remove()`.
   The tracking list is only registered if non-empty (all entity lookups may fail during
   first setup before sibling entities exist).
3. **Logging** — Reports successful registration with device_id

```python
async def async_added_to_hass(self):
    await super().async_added_to_hass()

    # 1. Timer handler
    self.async_on_remove(
        intent.async_register_timer_handler(
            self.hass, self.device_entry.id, self._handle_timer_event,
        )
    )

    # 2. Track sibling entities for attribute propagation
    registry = er.async_get(self.hass)
    tracked_eids = []
    for suffix in ("_mute", "_wake_sound"):
        eid = registry.async_get_entity_id("switch", DOMAIN, f"{self._entry.entry_id}{suffix}")
        if eid: tracked_eids.append(eid)
    tts_eid = registry.async_get_entity_id("select", DOMAIN, f"{self._entry.entry_id}_tts_output")
    if tts_eid: tracked_eids.append(tts_eid)
    ann_dur_eid = registry.async_get_entity_id("number", DOMAIN, f"{self._entry.entry_id}_announcement_display_duration")
    if ann_dur_eid: tracked_eids.append(ann_dur_eid)
    if tracked_eids:
        self.async_on_remove(
            async_track_state_change_event(self.hass, tracked_eids, self._on_switch_state_change)
        )
```

### 9.4 `async_will_remove_from_hass()`

Cleanup on entity removal:

1. Send stop signal to audio queue (`b""`)
2. Wait up to 5s for pipeline task to complete naturally
3. Force-cancel if still running
4. Release any pending announcement/question blocking events
5. Clear all satellite subscribers
6. Stop screensaver keep-alive

### 9.5 `async_get_configuration()` / `async_set_configuration()`

Returns an empty configuration (browser satellites don't have configurable wake words).
`async_set_configuration()` is intentionally a no-op (`pass`) — browser satellites
cannot configure wake words through the HA UI:

```python
def async_get_configuration(self):
    return AssistSatelliteConfiguration(
        available_wake_words=[],
        active_wake_words=[],
        max_active_wake_words=0,
    )

async def async_set_configuration(self, config):
    pass  # No-op for browser satellites
```

### 9.6 `extra_state_attributes`

Exposes configuration and timer state to the card:

```python
@property
def extra_state_attributes(self):
    attrs = {
        "active_timers": self._active_timers,
        "last_timer_event": self._last_timer_event,
    }
    registry = er.async_get(self.hass)

    # Mute switch → attrs["muted"]  (default: False if switch not found)
    mute_eid = registry.async_get_entity_id("switch", DOMAIN, f"{entry_id}_mute")
    if mute_eid:
        s = self.hass.states.get(mute_eid)
        attrs["muted"] = s.state == "on" if s else False

    # Wake sound switch → attrs["wake_sound"]  (default: True if switch not found)
    wake_eid = registry.async_get_entity_id("switch", DOMAIN, f"{entry_id}_wake_sound")
    if wake_eid:
        s = self.hass.states.get(wake_eid)
        attrs["wake_sound"] = s.state == "on" if s else True

    # TTS output select → attrs["tts_target"]  (empty string = Browser)
    tts_select_eid = registry.async_get_entity_id("select", DOMAIN, f"{entry_id}_tts_output")
    if tts_select_eid:
        s = self.hass.states.get(tts_select_eid)
        if s and s.state not in ("Browser", "unknown", "unavailable"):
            attrs["tts_target"] = s.attributes.get("entity_id", "")
        else:
            attrs["tts_target"] = ""

    # Announcement duration number → attrs["announcement_display_duration"]
    # (omitted entirely if entity not found or state is unknown/unavailable)
    ann_dur_eid = registry.async_get_entity_id("number", DOMAIN, f"{entry_id}_announcement_display_duration")
    if ann_dur_eid:
        s = self.hass.states.get(ann_dur_eid)
        if s and s.state not in ("unknown", "unavailable"):
            try:
                attrs["announcement_display_duration"] = int(float(s.state))
            except (ValueError, TypeError):
                pass

    return attrs
```

Each sibling is looked up via `registry.async_get_entity_id()`, then its current
state is read from `hass.states.get()`.

**Default values are critical:**
- `muted` defaults to `False` (not muted) if switch entity not found
- `wake_sound` defaults to `True` (enabled) if switch entity not found — **not False!**
- `tts_target` defaults to `""` (empty string means Browser)
- `announcement_display_duration` is **omitted entirely** if entity unavailable

---

## 10. Pipeline State Synchronization

### 10.1 State Mapping

The card reports pipeline state changes via `voice_satellite/update_state`.
The integration maps card states to HA satellite states:

| Card State | HA Satellite State | Meaning |
|---|---|---|
| `IDLE` | `idle` | No active interaction |
| `CONNECTING` | `idle` | Card connecting to pipeline (not user-facing) |
| `LISTENING` | `idle` | Listening for wake word (passive) |
| `PAUSED` | `idle` | Tab paused (not interacting) |
| `WAKE_WORD_DETECTED` | `listening` | Wake word detected, entering STT |
| `STT` | `listening` | Speech-to-text in progress |
| `INTENT` | `processing` | Intent processing / LLM reasoning |
| `TTS` | `responding` | Text-to-speech playback |
| `ERROR` | `idle` | Error state (maps to idle) |

### 10.2 `set_pipeline_state()`

```python
@callback
def set_pipeline_state(self, state):
    mapped = self._STATE_MAP.get(state)
    if mapped is None:
        return

    # Screensaver lifecycle: active during non-idle states
    if mapped != "idle":
        self._start_screensaver_keepalive()
    else:
        self._stop_screensaver_keepalive()

    self._set_satellite_state(mapped)
```

### 10.3 Name-Mangled State Setting

HA's `AssistSatelliteEntity` stores its state in a private attribute
`__assist_satellite_state` (Python name-mangled to `_AssistSatelliteEntity__assist_satellite_state`).
Direct state setting through `hass.states.async_set()` would bypass the entity
framework. Instead, the integration sets the mangled attribute directly:

```python
def _set_satellite_state(self, state_value):
    if self.state == state_value:
        return
    attr = "_AssistSatelliteEntity__assist_satellite_state"
    if not hasattr(self, attr):
        _LOGGER.warning("Cannot set satellite state: base class attribute not found")
        return
    setattr(self, attr, state_value)
    self.async_write_ha_state()
```

The `hasattr` check provides forward-compatibility — if HA renames the internal
attribute in a future version, the integration logs a warning instead of crashing.

---

## 11. Bridged Pipeline

### 11.1 Overview

The integration bridges between the card's WebSocket audio stream and HA's internal
pipeline system. Unlike physical satellites that have a persistent connection, the
card's pipeline is initiated per-run via the `voice_satellite/run_pipeline` WS command.

### 11.2 Pipeline Setup (in `__init__.py`)

The `ws_run_pipeline` handler orchestrates the full setup:

```
ws_run_pipeline() called
  │
  ├── 1. Find satellite entity via _find_entity()
  │
  ├── 2. Stop old pipeline (if running)
  │     ├── Send stop signal: audio_queue.put_nowait(b"")
  │     ├── If different connection: send "displaced" event to old connection
  │     ├── Wait up to 3s for old task to complete
  │     └── Force-cancel if still running
  │
  ├── 3. Create new audio queue
  │     └── audio_queue = asyncio.Queue[bytes]()
  │
  ├── 4. Register binary handler
  │     ├── handler_id, unregister = connection.async_register_binary_handler(_on_binary)
  │     ├── _on_binary signature: (_hass, _connection, data: bytes) → None
  │     │     (hass and connection args are required by the API but unused)
  │     └── _on_binary puts raw bytes into audio_queue
  │
  ├── 5. Send subscription result + init event
  │     ├── connection.send_result(msg_id)     # Resolves JS promise
  │     └── connection.send_event(msg_id, {type: "init", handler_id: N})
  │           (card stores handler_id and sends binary audio to it)
  │
  ├── 6. Create background task
  │     └── hass.async_create_background_task(
  │           entity.async_run_pipeline(audio_queue, connection, msg_id, ...),
  │           name=f"voice_satellite.{entity.satellite_name}_pipeline",
  │         )
  │         (named for debugging — shows in asyncio task dumps)
  │
  └── 7. Register unsubscribe handler
        └── connection.subscriptions[msg_id] = unsub
              └── unsub() does TWO things:
                    1. audio_queue.put_nowait(b"")  — stop signal
                    2. unregister()                  — remove binary handler
```

### 11.3 `async_run_pipeline()` (in `assist_satellite.py`)

```python
async def async_run_pipeline(self, audio_queue, connection, msg_id,
                              start_stage, end_stage, conversation_id=None,
                              extra_system_prompt=None):
    self._pipeline_gen += 1
    my_gen = self._pipeline_gen
    self._pipeline_connection = connection
    self._pipeline_msg_id = msg_id
    self._pipeline_audio_queue = audio_queue
    self._pipeline_run_started = False  # CRITICAL: reset gate for each new run

    # Store conversation_id for continue-conversation support.
    # The base class uses self._conversation_id when constructing
    # the pipeline context, allowing multi-turn conversations to
    # share the same conversation thread.
    if conversation_id:
        self._conversation_id = conversation_id

    # Set extra_system_prompt RIGHT BEFORE the pipeline call.
    # Setting it too early would cause a race condition: an intermediate
    # pipeline restart could consume it before the intended run.
    if extra_system_prompt:
        self._extra_system_prompt = extra_system_prompt

    stage_map = {
        "wake_word": PipelineStage.WAKE_WORD,
        "stt": PipelineStage.STT,
        "intent": PipelineStage.INTENT,
        "tts": PipelineStage.TTS,
    }

    async def audio_stream():
        while True:
            chunk = await audio_queue.get()
            if not chunk:  # empty bytes = stop signal
                break
            yield chunk

    try:
        await self.async_accept_pipeline_from_satellite(
            audio_stream(),
            start_stage=stage_map.get(start_stage, PipelineStage.WAKE_WORD),
            end_stage=stage_map.get(end_stage, PipelineStage.TTS),
        )
    finally:
        if self._pipeline_gen == my_gen:
            self._pipeline_connection = None
            self._pipeline_msg_id = None
            self._pipeline_audio_queue = None
```

### 11.4 Generation Counter

The `_pipeline_gen` counter prevents orphaned events from old pipeline runs
from being relayed to the card:

```
Run 1 starts: _pipeline_gen = 1, my_gen = 1
Run 2 starts: _pipeline_gen = 2, my_gen = 2
Run 1 finally block:
  if self._pipeline_gen == my_gen:  # 2 == 1 → False
    # Skip cleanup — Run 2 owns the fields now
```

Without this, the `finally` block of an old run could clear the connection/queue
that the new run is actively using.

### 11.5 Audio Queue Protocol

| Bytes | Meaning |
|---|---|
| Non-empty `bytes` | Raw 16-bit PCM audio frame from the card's mic |
| Empty `b""` | Stop signal — ends the `audio_stream()` generator |

The audio generator yields chunks until it receives empty bytes, at which point
it breaks and the pipeline's audio input closes naturally.

### 11.6 Event Relay — `on_pipeline_event()`

```python
@callback
def on_pipeline_event(self, event):
    event_type_str = str(getattr(event, "type", str(event)))

    # Gate: block all events until run-start
    if event_type_str == "run-start":
        self._pipeline_run_started = True
    elif not self._pipeline_run_started:
        return  # Filter stale pre-run-start events

    if self._pipeline_connection and self._pipeline_msg_id:
        self._pipeline_connection.send_event(
            self._pipeline_msg_id,
            {"type": event_type_str, "data": getattr(event, "data", None) or {}},
        )
```

### 11.7 Stale Event Filtering

Two mechanisms filter stale events:

1. **Generation counter** (`_pipeline_gen`) — Prevents the `finally` block of an
   old run from clearing fields owned by a newer run

2. **Run-start gate** (`_pipeline_run_started`) — Blocks all events until `run-start`
   is received. **Critically**, this flag is reset to `False` at the start of each
   new pipeline run in `async_run_pipeline()`. This reset is essential: without it,
   a leftover `True` from the previous run would allow stale events through.

   The gate prevents leftover events from an old pipeline's internal tasks
   (e.g. a trailing `wake_word-end` from a cancelled wake word detector) from
   leaking into a new run. Since `on_pipeline_event()` is a shared callback on
   the entity instance, events from old HA internal tasks can arrive after a new
   run has started.

### 11.8 Displaced Pipeline

When a new browser connects while an old browser is still running:

1. The old connection receives a `displaced` event
2. The old audio queue gets a stop signal
3. The old pipeline task is waited on (3s timeout) then cancelled
4. A warning is logged: each browser must use its own satellite entity

```python
if old_conn is not None and old_conn is not connection:
    _LOGGER.warning(
        "Pipeline for '%s' displaced by a different browser connection",
        entity.satellite_name,
    )
    try:
        old_conn.send_event(old_msg_id, {"type": "displaced"})
    except Exception:
        pass  # old connection may already be dead
```

### 11.9 Pipeline Teardown Strategy

The teardown follows a "graceful first, force second" pattern:

```
1. Send stop signal: audio_queue.put_nowait(b"")
   ↓ The audio_stream() generator breaks, pipeline input closes
   ↓ HA internal tasks (wake word, STT) unblock naturally
2. Wait: asyncio.wait({old_task}, timeout=3.0)  [or 5.0 for entity removal]
3. If still running: old_task.cancel()
```

**Why not cancel immediately?** Cancellation and the stop signal race on
`await audio_queue.get()`. `CancelledError` always wins, leaving orphaned
HA pipeline input tasks. The stop signal ensures a clean exit.

---

## 12. Satellite Event Subscription

### 12.1 Subscription Lifecycle

```
Card sends: voice_satellite/subscribe_events {entity_id}
  │
  ├── entity.register_satellite_subscription(connection, msg_id)
  │     ├── Append (connection, msg_id) to _satellite_subscribers
  │     ├── If first subscriber: async_write_ha_state() → entity becomes available
  │     └── _update_media_player_availability()
  │
  └── connection.subscriptions[msg_id] = unsub
        └── unsub: entity.unregister_satellite_subscription(connection, msg_id)
```

### 12.2 Push Mechanism

```python
@callback
def _push_satellite_event(self, event_type, data):
    if not self._satellite_subscribers:
        _LOGGER.warning("No satellite subscribers - cannot push %s event", event_type)
        return
    if self.hass.is_stopping:
        return

    dead = []
    for connection, msg_id in list(self._satellite_subscribers):
        try:
            connection.send_event(msg_id, {"type": event_type, "data": data})
        except Exception:
            dead.append((connection, msg_id))

    if dead:
        self._satellite_subscribers = [
            s for s in self._satellite_subscribers if s not in dead
        ]
```

### 12.3 Dead Connection Cleanup

When `send_event()` raises an exception (connection closed/broken), the subscriber
is added to a `dead` list and removed after iteration. This prevents memory leaks
from abandoned browser tabs.

### 12.4 Availability Cascade

When subscriber count changes:
1. Satellite entity calls `async_write_ha_state()` → `available` property re-evaluates
2. `_update_media_player_availability()` finds the media player entity and calls
   `mp.async_write_ha_state()` → media player re-evaluates its own `available`

### 12.5 Disconnection Release

When all subscribers disconnect, pending blocking events are released:

```python
if not self._satellite_subscribers:
    if self._announce_event is not None:
        self._announce_event.set()  # Unblock async_announce()
    if self._question_event is not None:
        self._question_event.set()  # Unblock ask_question()
```

This prevents the entity from being stuck in an `asyncio.Event.wait()` forever
when the card disconnects mid-announcement.

---

## 13. Announcement System

### 13.1 Service Call Flow

```
HA service: assist_satellite.announce(entity_id, message)
  │
  └── AssistSatelliteEntity base class
        ├── Resolve text → TTS media_id (if message provided)
        └── async_internal_announce(message, media_id, preannounce, ...)
              │
              └── VoiceSatelliteEntity override
                    ├── Store preannounce flag: self._preannounce_pending = preannounce
                    └── super().async_internal_announce(...)
                          │
                          └── async_announce(announcement: AssistSatelliteAnnouncement)
```

### 13.2 `async_announce()` Implementation

```python
async def async_announce(self, announcement):
    self._start_screensaver_keepalive()

    # Increment sequence counter
    self._announce_id += 1
    announce_id = self._announce_id

    # Build announcement payload
    announcement_data = {
        "id": announce_id,
        "message": announcement.message or "",
        "media_id": announcement.media_id or "",
        "preannounce_media_id": getattr(announcement, "preannounce_media_id", None) or "",
    }

    if not self._preannounce_pending:
        announcement_data["preannounce"] = False

    if self._ask_question_pending:
        announcement_data["ask_question"] = True

    # Create blocking event
    self._announce_event = asyncio.Event()

    # Push to card
    self._push_satellite_event("announcement", announcement_data)

    # Block until card ACKs or timeout
    try:
        await asyncio.wait_for(self._announce_event.wait(), timeout=120)
    except asyncio.TimeoutError:
        _LOGGER.warning("Announcement #%d timed out after 120s", announce_id)
    finally:
        self._announce_event = None
        self._preannounce_pending = True
        current = self.hass.states.get(self.entity_id)
        if not current or current.state == "idle":
            self._stop_screensaver_keepalive()
```

### 13.3 Sequence Counter

The `_announce_id` counter prevents stale ACKs:

```python
def announce_finished(self, announce_id):
    if self._announce_event is not None and self._announce_id == announce_id:
        self._announce_event.set()
    else:
        _LOGGER.debug("Ignoring stale announce ACK #%d (current: #%d)", ...)
```

Scenario: Announcement #5 times out. Card sends ACK for #5 after timeout.
The entity is now on announcement #6. The ACK is ignored because `5 != 6`.

### 13.4 Preannounce Flag Capture

The base class's `async_internal_announce()` consumes the `preannounce` boolean
internally (it plays its own preannounce sound) and doesn't pass it to the
`AssistSatelliteAnnouncement` object. The integration overrides
`async_internal_announce()` to capture the flag before delegation:

```python
async def async_internal_announce(self, message=None, media_id=None,
                                   preannounce=True, ...):
    self._preannounce_pending = preannounce
    await super().async_internal_announce(message=message, media_id=media_id,
                                          preannounce=preannounce, ...)
```

### 13.5 Announcement Payload

```json
{
  "id": 5,
  "message": "The timer is done",
  "media_id": "/api/tts_proxy/abc123.mp3",
  "preannounce_media_id": "/api/tts_proxy/chime.mp3",
  "preannounce": false,
  "ask_question": true
}
```

- `preannounce` is only included when `false` (default is `true`)
- `ask_question` is only included when `true` (for the ask_question flow)

---

## 14. Start Conversation

### 14.1 Service Call Flow

```
HA service: assist_satellite.start_conversation(entity_id, start_message, extra_system_prompt)
  │
  └── AssistSatelliteEntity base class
        └── async_internal_start_conversation(start_message, ..., extra_system_prompt)
              │
              └── VoiceSatelliteEntity override
                    ├── self._preannounce_pending = preannounce
                    ├── self._pending_extra_system_prompt = extra_system_prompt
                    └── super().async_internal_start_conversation(...)
                          │
                          └── async_start_conversation(announcement)
```

### 14.2 `async_start_conversation()` Implementation

Nearly identical to `async_announce()` with key differences:

1. **Event type** is `"start_conversation"` instead of `"announcement"`
2. **Payload includes** `"start_conversation": True`
3. **Payload may include** `"extra_system_prompt"` for LLM context
4. **After ACK**: Sets satellite state to `"listening"` — the card enters STT mode

```python
async def async_start_conversation(self, announcement):
    self._start_screensaver_keepalive()
    self._announce_id += 1
    announce_id = self._announce_id

    announcement_data = {
        "id": announce_id,
        "message": announcement.message or "",
        "media_id": announcement.media_id or "",
        "preannounce_media_id": ...,
        "start_conversation": True,
    }

    if self._pending_extra_system_prompt:
        announcement_data["extra_system_prompt"] = self._pending_extra_system_prompt

    self._announce_event = asyncio.Event()
    self._push_satellite_event("start_conversation", announcement_data)

    try:
        await asyncio.wait_for(self._announce_event.wait(), timeout=120)
        self._set_satellite_state("listening")
    except asyncio.TimeoutError:
        ...
    finally:
        self._announce_event = None
        self._preannounce_pending = True
        self._pending_extra_system_prompt = None
        current = self.hass.states.get(self.entity_id)
        if not current or current.state == "idle":
            self._stop_screensaver_keepalive()
```

### 14.3 Extra System Prompt

The `extra_system_prompt` allows automations to inject contextual instructions
for the LLM. It flows through:

1. Service call → `async_internal_start_conversation()` → stored in `_pending_extra_system_prompt`
2. Pushed to card in announcement payload
3. Card reads it and includes it in the next pipeline's `run_pipeline` WS call
4. `async_run_pipeline()` stores it in `_extra_system_prompt`
5. `async_accept_pipeline_from_satellite()` (base class) reads it during pipeline setup

---

## 15. Ask Question

### 15.1 Overview

Ask question is a three-phase flow that combines TTS playback, STT capture, and
optional answer matching. Requires HA 2025.7+ (`AssistSatelliteAnswer`).

### 15.2 Conditional Import & Version Guard

```python
try:
    from homeassistant.components.assist_satellite import AssistSatelliteAnswer
except ImportError:
    AssistSatelliteAnswer = None

try:
    from hassil.recognize import recognize
    from hassil.intents import Intents
    HAS_HASSIL = True
except ImportError:
    HAS_HASSIL = False
```

If `AssistSatelliteAnswer is None` (HA < 2025.7), `async_internal_ask_question()`
raises `NotImplementedError` immediately. The base class handles this gracefully —
the service call returns an error to the caller:

```python
if AssistSatelliteAnswer is None:
    raise NotImplementedError("ask_question requires Home Assistant 2025.7 or later")
```

### 15.3 Three-Phase Flow

```
assist_satellite.ask_question(entity_id, question, answers)
  │
  └── async_internal_ask_question(question, answers, ...)
        │
        ├── Phase 1: TTS Playback
        │     ├── Set _ask_question_pending = True
        │     ├── Set _question_event = asyncio.Event()
        │     ├── Set _question_match_event = asyncio.Event()
        │     └── async_internal_announce(message=question, ...)
        │           └── async_announce() includes ask_question=True in payload
        │           └── Card plays TTS, sends ACK, enters STT-only mode
        │
        ├── Phase 2: STT Capture
        │     ├── Re-start screensaver keep-alive
        │     ├── Set satellite state to "listening"
        │     └── await _question_event.wait() (timeout=120s)
        │           └── Card captures speech, calls question_answered WS
        │           └── question_answered() sets _question_answer_text and _question_event
        │
        └── Phase 3: Answer Matching (hassil)
              ├── If sentence is empty → return None
              ├── If answers provided and HAS_HASSIL:
              │     └── _match_answer(sentence, answers)
              │           └── Build hassil Intents from answer list
              │           └── recognize(sentence, intents)
              │           └── Return AssistSatelliteAnswer(id, sentence, slots)
              └── Else: return AssistSatelliteAnswer(id=None, sentence, slots={})
```

### 15.4 `_match_answer()` Algorithm

Converts the answer list into a hassil `Intents` structure and uses the
`recognize()` function to match the transcribed sentence:

```python
def _match_answer(self, sentence, answers):
    intents_dict = {"language": "en", "intents": {}}
    for answer in answers:
        answer_id = answer["id"]
        sentences = answer.get("sentences", [])
        intents_dict["intents"][answer_id] = {
            "data": [{"sentences": sentences}]
        }

    try:
        intents = Intents.from_dict(intents_dict)
        result = recognize(sentence, intents)
    except Exception:
        return AssistSatelliteAnswer(id=None, sentence=sentence, slots={})

    if result is None:
        return AssistSatelliteAnswer(id=None, sentence=sentence, slots={})

    matched_id = result.intent.name
    slots = {name: slot.value for name, slot in result.entities.items()}
    return AssistSatelliteAnswer(id=matched_id, sentence=sentence, slots=slots)
```

### 15.5 WebSocket Handler Coordination

The `ws_question_answered` handler in `__init__.py` coordinates between the card's
answer and the hassil matching:

```python
async def ws_question_answered(hass, connection, msg):
    entity = _find_entity(hass, msg["entity_id"])
    match_event = entity.question_match_event

    entity.question_answered(msg["announce_id"], msg["sentence"])

    result = {"matched": False, "id": None}
    if match_event is not None:
        try:
            await asyncio.wait_for(match_event.wait(), timeout=10.0)
            result = entity.question_match_result or result
        except asyncio.TimeoutError:
            pass

    connection.send_result(msg["id"], {
        "success": True,
        "matched": result.get("matched", False),
        "id": result.get("id"),
    })
```

The handler:
1. Grabs a reference to `question_match_event` **before** triggering the answer
2. Calls `entity.question_answered()` which unblocks Phase 2
3. Waits for `question_match_event` (set after Phase 3 matching completes)
4. Returns the match result to the card

### 15.6 Race Condition Handling

The `_question_match_result` is intentionally **not** cleared in the `finally` block
of `async_internal_ask_question()`. The WS handler may still need to read it after
`_question_match_event` fires but before the `finally` block runs. It's overwritten
on the next `ask_question` call.

**Detailed sequence:**

```
t=0: WS handler grabs reference: match_event = entity.question_match_event
t=1: WS handler calls entity.question_answered() → _question_event.set()
     → Phase 2 unblocks
t=2: Phase 3 runs _match_answer() → sets _question_match_result
     → _question_match_event.set()
t=3: WS handler's match_event.wait() returns
     → reads _question_match_result ← MUST NOT be cleared yet
t=4: async_internal_ask_question() finally block runs
     → clears _question_event, _question_answer_text, _question_match_event
     → does NOT clear _question_match_result (would race with t=3)
```

The `finally` block also:
- Sets `_ask_question_pending = False`
- Calls `async_write_ha_state()` to push attribute updates
- Stops screensaver keep-alive if entity is idle

---

## 16. Timer System

### 16.1 Timer Handler Registration

Registered in `async_added_to_hass()` via the intent system:

```python
self.async_on_remove(
    intent.async_register_timer_handler(
        self.hass, self.device_entry.id, self._handle_timer_event,
    )
)
```

This makes the device eligible for `HassStartTimer` LLM tool calls, which HA routes
to the correct device based on `device_id`. The `async_on_remove()` wrapper ensures
the timer handler is automatically deregistered when the entity is removed, preventing
orphaned callbacks and memory leaks.

### 16.2 Timer Event Types

Events use `intent.TimerEventType` enum values:

| Event | Enum | Action |
|---|---|---|
| Started | `intent.TimerEventType.STARTED` | Add new timer to `_active_timers`, compute total_seconds |
| Updated | `intent.TimerEventType.UPDATED` | Replace timer entry with updated duration, reset `started_at` |
| Cancelled | `intent.TimerEventType.CANCELLED` | Remove timer from `_active_timers` |
| Finished | `intent.TimerEventType.FINISHED` | Remove timer from `_active_timers` |

The `_last_timer_event` stores `event_type.value` (the string form).

### 16.3 Immutable List Pattern

Timer updates create a **new list** rather than mutating in place:

Duration values are extracted with `or 0` defaults since `TimerInfo` attributes
may be `None`:

```python
h = timer_info.start_hours or 0
m = timer_info.start_minutes or 0
s = timer_info.start_seconds or 0
total = h * 3600 + m * 60 + s

# STARTED - spread + append (new list, not mutation)
self._active_timers = [*self._active_timers, {
    "id": timer_id,
    "name": timer_info.name or "",
    "total_seconds": total,
    "started_at": time.time(),
    "start_hours": h, "start_minutes": m, "start_seconds": s,
}]

# CANCELLED / FINISHED - filter
self._active_timers = [
    t for t in self._active_timers if t["id"] != timer_id
]
```

**Why?** HA compares `old_state.attributes == new_state.attributes` to detect changes.
If the list is mutated in-place, the old state's reference points to the same object,
making `old == new` always `True`. Creating a new list ensures the change is detected
and a `state_changed` event fires.

### 16.4 Timer Dict Structure

```python
{
    "id": "timer_abc123",
    "name": "Pizza timer",
    "total_seconds": 600,
    "started_at": 1709145600.0,  # time.time() epoch
    "start_hours": 0,
    "start_minutes": 10,
    "start_seconds": 0,
}
```

The card uses `started_at` + `total_seconds` to calculate remaining time client-side,
avoiding clock drift from polling.

---

## 17. Screensaver Keep-Alive

### 17.1 Purpose

Prevents a configured screensaver entity (switch/input_boolean) from activating
during voice interactions. The integration periodically calls `homeassistant.turn_off`
on the entity to keep it off.

### 17.2 Entity Resolution

```python
def _get_screensaver_entity_id(self):
    registry = er.async_get(self.hass)
    select_eid = registry.async_get_entity_id(
        "select", DOMAIN, f"{self._entry.entry_id}_screensaver"
    )
    if not select_eid:
        return None
    state = self.hass.states.get(select_eid)
    if not state or state.state in ("Disabled", "unknown", "unavailable"):
        return None
    return state.attributes.get("entity_id")
```

The screensaver select entity stores friendly names as options but exposes the
actual `entity_id` in its `extra_state_attributes`. The satellite entity reads
this attribute to get the target entity to keep off.

### 17.3 Keep-Alive Lifecycle

```
_start_screensaver_keepalive()
  ├── Get screensaver entity_id
  ├── If none configured or already running: return
  ├── Turn off IMMEDIATELY (don't wait for first tick)
  │     └── hass.async_create_task(_screensaver_turn_off(entity_id))
  └── Start periodic timer: async_track_time_interval(SCREENSAVER_INTERVAL=5s)
        └── _tick: re-resolve entity_id (may change), turn off
              └── If entity_id resolves to None: stop keep-alive

_stop_screensaver_keepalive()
  └── Cancel the periodic timer
```

### 17.4 Triggers

| Action | Effect |
|---|---|
| `set_pipeline_state(non-idle)` | Start keep-alive |
| `set_pipeline_state(idle)` | Stop keep-alive |
| `async_announce()` | Start at beginning, stop in `finally` if idle |
| `async_start_conversation()` | Start at beginning, stop in `finally` if idle |
| `async_internal_ask_question()` | Start at Phase 1, re-start at Phase 2, stop in `finally` if idle |
| `async_will_remove_from_hass()` | Stop keep-alive |

### 17.5 Turn-Off Service Call

```python
async def _screensaver_turn_off(self, entity_id):
    try:
        await self.hass.services.async_call(
            "homeassistant", "turn_off", {"entity_id": entity_id},
        )
    except Exception:
        if not self.hass.is_stopping:
            _LOGGER.debug("Failed to turn off screensaver %s", entity_id)
```

Errors are swallowed during HA shutdown to prevent log spam.

---

## 18. Media Player Entity

### 18.1 Class Hierarchy

```python
class VoiceSatelliteMediaPlayer(MediaPlayerEntity, RestoreEntity):
    _attr_has_entity_name = True
    _attr_translation_key = "media_player"
    _attr_supported_features = (
        PLAY_MEDIA | MEDIA_ANNOUNCE | BROWSE_MEDIA |
        PLAY | PAUSE | STOP | VOLUME_SET | VOLUME_MUTE
    )
```

### 18.2 Supported Features

| Feature | Service | Card Command |
|---|---|---|
| `PLAY_MEDIA` | `media_player.play_media` | `play` with media_id, media_type, announce, volume |
| `MEDIA_ANNOUNCE` | `media_player.media_announce` | Same as play_media with `announce=True` |
| `BROWSE_MEDIA` | Media browser | Delegates to `media_source`, filtered to audio |
| `PLAY` | `media_player.media_play` | `resume` |
| `PAUSE` | `media_player.media_pause` | `pause` |
| `STOP` | `media_player.media_stop` | `stop` |
| `VOLUME_SET` | `media_player.volume_set` | `volume_set` with volume |
| `VOLUME_MUTE` | `media_player.volume_mute` | `volume_mute` with mute |

### 18.3 Command Push Pattern

All commands are pushed to the card via the satellite entity's subscription:

```python
def _push_command(self, command, **kwargs):
    satellite = self._get_satellite_entity()
    payload = {"command": command, **kwargs}
    satellite._push_satellite_event("media_player", payload)
```

The satellite entity is looked up lazily from `hass.data[DOMAIN][entry_id]`.

### 18.4 Optimistic State Updates

Every command immediately updates the entity's state without waiting for
confirmation:

```python
async def async_play_media(self, media_type, media_id, **kwargs):
    # Resolve media-source:// URIs
    if media_id.startswith("media-source://"):
        result = await async_resolve_media(self.hass, media_id, self.entity_id)
        media_id = result.url
        media_type = result.mime_type

    self._push_command("play", media_id=media_id, media_type=str(media_type),
                       announce=kwargs.get("announce"), volume=self._attr_volume_level)

    # Optimistic
    self._attr_state = MediaPlayerState.PLAYING
    self._attr_media_content_id = media_id
    self._attr_media_content_type = str(media_type)
    self.async_write_ha_state()
```

### 18.5 State Reconciliation

The card reports back actual playback state via `voice_satellite/media_player_event`:

```python
@callback
def update_playback_state(self, state, volume=None, media_id=None):
    state_map = {
        "playing": MediaPlayerState.PLAYING,
        "paused": MediaPlayerState.PAUSED,
        "idle": MediaPlayerState.IDLE,
    }
    mapped = state_map.get(state)
    if mapped is not None:
        self._attr_state = mapped
    if volume is not None:
        self._attr_volume_level = volume
    if media_id is not None:
        self._attr_media_content_id = media_id
    elif mapped == MediaPlayerState.IDLE:
        # Clear media IDs when returning to idle — prevents stale
        # "now playing" info from lingering in the HA UI
        self._attr_media_content_id = None
        self._attr_media_content_type = None
    self.async_write_ha_state()
```

### 18.6 Volume Persistence

Volume and mute state persist across reboots via `ExtraStoredData`:

```python
class MediaPlayerExtraData(ExtraStoredData):
    def __init__(self, volume_level, is_volume_muted):
        self.volume_level = volume_level
        self.is_volume_muted = is_volume_muted

    def as_dict(self):
        return {"volume_level": self.volume_level, "is_volume_muted": self.is_volume_muted}

    @classmethod
    def from_dict(cls, data):
        return cls(volume_level=data.get("volume_level", 1.0),
                   is_volume_muted=data.get("is_volume_muted", False))
```

Restored in `async_added_to_hass()`:

```python
async def async_added_to_hass(self):
    await super().async_added_to_hass()
    extra_data = await self.async_get_last_extra_data()
    if extra_data:
        data = MediaPlayerExtraData.from_dict(extra_data.as_dict())
        self._attr_volume_level = data.volume_level
        self._attr_is_volume_muted = data.is_volume_muted
```

### 18.7 Media Source Resolution

`media-source://` URIs are resolved before pushing to the card:

```python
if media_id.startswith("media-source://"):
    result = await async_resolve_media(self.hass, media_id, self.entity_id)
    media_id = result.url
    media_type = result.mime_type
```

### 18.8 Browse Media

Delegates to HA's media source, filtered to audio content:

```python
async def async_browse_media(self, media_content_type=None, media_content_id=None):
    return await ms_browse(
        self.hass, media_content_id,
        content_filter=lambda item: item.media_content_type.startswith("audio/"),
    )
```

---

## 19. Select Entities

### 19.1 Pipeline Select

```python
class VoiceSatellitePipelineSelect(AssistPipelineSelect):
    _attr_has_entity_name = True
    _attr_icon = "mdi:assistant"

    def __init__(self, hass, entry):
        super().__init__(hass, DOMAIN, entry.entry_id)
```

Subclasses `AssistPipelineSelect` from `homeassistant.components.assist_pipeline`.
This framework class:
- Auto-generates the unique ID as `{entry_id}-pipeline`
- Registers the device in `pipeline_devices` for the Voice Assistants UI
- Manages pipeline option list and selection persistence
- Provides the translation key `"pipeline"` → displayed as "Assistant"

### 19.2 VAD Sensitivity Select

```python
class VoiceSatelliteVadSensitivitySelect(VadSensitivitySelect):
    _attr_has_entity_name = True
    _attr_icon = "mdi:account-voice"

    def __init__(self, hass, entry):
        super().__init__(hass, entry.entry_id)
```

Subclasses `VadSensitivitySelect` from `homeassistant.components.assist_pipeline`.
Options: Default, Relaxed, Aggressive.

### 19.3 Screensaver Select

Default option constant: `SCREENSAVER_DISABLED = "Disabled"` (module-level).

A custom `SelectEntity` + `RestoreEntity` that lists all `switch.*` and
`input_boolean.*` entities as options.

**Key design decisions:**

1. **Friendly names in dropdown** — Users see "Esphome: Screensaver" not `switch.screensaver`
2. **Entity ID in attributes** — `extra_state_attributes["entity_id"]` exposes the actual entity_id
3. **30-second mapping cache** — `_build_mapping()` caches the entity_id ↔ friendly_name
   mapping for 30s to avoid rebuilding on every state read
4. **Cache bypass during startup** — Only caches after `hass.is_running` is `True`
5. **Own entities excluded** — Filters out entities from the `voice_satellite` platform
6. **Duplicate name handling** — Appends `(entity_id)` when names collide
7. **Restore from attribute** — On startup, restores `entity_id` from `extra_state_attributes`,
   not from the state string (which is a friendly name that may change)
8. **Integration prefix** — Friendly names are prefixed with the integration platform label
   (e.g. `entry.platform.replace("_", " ").title()` → `"Esphome: Screensaver"`)
9. **Sorted alphabetically** — Options are sorted by `name.casefold()` for consistent ordering

```python
def _build_mapping(self):
    now = time.monotonic()
    if (self._mapping_cache is not None
        and self.hass and self.hass.is_running
        and (now - self._cache_time) < self._CACHE_TTL):
        return self._mapping_cache

    eid_to_name = {}
    name_to_eid = {}
    registry = er.async_get(self.hass)
    for domain in ("switch", "input_boolean"):
        for eid in self.hass.states.async_entity_ids(domain):
            entry = registry.async_get(eid)
            if entry and entry.platform == DOMAIN:
                continue  # Skip our own entities
            state = self.hass.states.get(eid)
            friendly = state.attributes.get("friendly_name", eid) if state else eid
            if entry:
                label = entry.platform.replace("_", " ").title()
                name = f"{label}: {friendly}"
            else:
                name = friendly
            ...
    self._mapping_cache = (eid_to_name, name_to_eid)
    self._cache_time = now
    return self._mapping_cache
```

### 19.4 TTS Output Select

Default option constant: `TTS_OUTPUT_BROWSER = "Browser"` (module-level).

Nearly identical structure to Screensaver Select, but:
- Lists `media_player.*` entities instead of switch/input_boolean
- Default option is `"Browser"` (card plays audio locally via Web Audio)
- Exposes `entity_id` in `extra_state_attributes` for the card to read
- Restore logic also checks against `TTS_OUTPUT_BROWSER` as a skip state

### 19.5 Wake Word Detection Select

```python
WAKE_WORD_DETECTION_HA = "Home Assistant"
WAKE_WORD_DETECTION_LOCAL = "On Device"
WAKE_WORD_DETECTION_OPTIONS = [WAKE_WORD_DETECTION_HA, WAKE_WORD_DETECTION_LOCAL]

class VoiceSatelliteWakeWordDetectionSelect(SelectEntity, RestoreEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "wake_word_detection"
```

Simple two-option select:
- **"Home Assistant"** — Server-side wake word via the Assist pipeline's openWakeWord add-on
- **"On Device"** (default) — Browser-side ONNX inference via the card's WakeWordManager

Default: `WAKE_WORD_DETECTION_LOCAL` ("On Device").

The card reads this via `getSelectState(hass, entity, 'wake_word_detection')` to decide
whether to use the WakeWordManager or start a pipeline with `start_stage: 'wake_word'`.

### 19.6 Wake Word Model Select

```python
class VoiceSatelliteWakeWordModelSelect(SelectEntity, RestoreEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "wake_word_model"

    def __init__(self, hass, entry):
        self._options = discover_wake_word_models()
        self._selected_option = self._options[0] if self._options else "ok_nabu"
```

Options are **dynamically discovered** at startup by `discover_wake_word_models()`:

1. Scans `models/` directory for `.onnx` files
2. Filters out common infrastructure models (`melspectrogram`, `embedding_model`, `silero_vad`)
3. Maps built-in versioned filenames to friendly names via `_BUILTIN_FILENAME_MAP`
   (e.g., `hey_jarvis_v0.1.onnx` → `hey_jarvis`)
4. Custom user-provided models use the filename stem as-is
   (e.g., `my_custom_word.onnx` → `my_custom_word`)
5. Falls back to `_BUILTIN_DEFAULTS` if directory is missing or empty

**Key behaviors:**
- `async_added_to_hass`: If restored state is not in current options (model file was removed),
  falls back to the first available option
- `async_select_option`: Validates against `self._options` before accepting

### 19.7 Wake Word Sensitivity Select

```python
WAKE_WORD_SENSITIVITY_OPTIONS = [
    "Slightly sensitive",
    "Moderately sensitive",
    "Very sensitive",
]

class VoiceSatelliteWakeWordSensitivitySelect(SelectEntity, RestoreEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "wake_word_sensitivity"
```

Controls the detection threshold for on-device wake word detection. The card maps
these labels to per-model floating-point thresholds (see DESIGN-CARD.md §28.5).

Default: `WAKE_WORD_SENSITIVITY_OPTIONS[1]` ("Moderately sensitive").

### 19.8 Stale Entity Cleanup

The `select.py` setup cleans up stale select entities from older integration versions.
It only targets entities in the `"select"` domain — other platforms (switch, number)
are not affected:

```python
async def async_setup_entry(hass, entry, async_add_entities):
    entities = [Pipeline, VAD, Screensaver, TTSOutput,
                WakeWordDetection, WakeWordModel, WakeWordSensitivity]
    async_add_entities(entities)

    # Collect the unique IDs of the 7 current select entities
    expected_uids = {e.unique_id for e in entities}
    registry = er.async_get(hass)
    # Scan all entities registered under this config entry
    for reg_entry in er.async_entries_for_config_entry(registry, entry.entry_id):
        # Only remove select entities with unrecognized unique IDs
        if reg_entry.domain == "select" and reg_entry.unique_id not in expected_uids:
            _LOGGER.info("Removing stale entity: %s", reg_entry.entity_id)
            registry.async_remove(reg_entry.entity_id)
```

---

## 20. Switch Entities

### 20.1 Wake Sound Switch

Controls whether the card plays a chime when wake word is detected.

```python
class VoiceSatelliteWakeSoundSwitch(SwitchEntity, RestoreEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "wake_sound"
    _attr_icon = "mdi:bullhorn"

    def __init__(self, entry):
        self._attr_unique_id = f"{entry.entry_id}_wake_sound"
        self._attr_is_on = True  # Default: enabled
```

### 20.2 Mute Switch

Controls whether the card's microphone is active.

```python
class VoiceSatelliteMuteSwitch(SwitchEntity, RestoreEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "mute"
    _attr_icon = "mdi:microphone-off"

    def __init__(self, entry):
        self._attr_unique_id = f"{entry.entry_id}_mute"
        self._attr_is_on = False  # Default: not muted
```

### 20.3 State Persistence

Both switches use `RestoreEntity` to persist state across reboots:

```python
async def async_added_to_hass(self):
    await super().async_added_to_hass()
    last_state = await self.async_get_last_state()
    if last_state is not None:
        self._attr_is_on = last_state.state == "on"
```

### 20.4 How the Card Reads Switch State

The switches don't push directly to the card. Instead:

1. Switch state changes → `_on_switch_state_change` callback on satellite entity
2. Satellite entity calls `async_write_ha_state()`
3. `extra_state_attributes` re-evaluates, looking up switch states:
   ```python
   mute_eid = registry.async_get_entity_id("switch", DOMAIN, f"{entry_id}_mute")
   s = self.hass.states.get(mute_eid)
   attrs["muted"] = s.state == "on" if s else False
   ```
4. Card receives attribute update via its entity subscription

---

## 21. Number Entity

### 21.1 Announcement Display Duration

Controls how many seconds announcement bubbles remain visible on the card.

```python
class VoiceSatelliteAnnouncementDurationNumber(NumberEntity, RestoreEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "announcement_display_duration"
    _attr_icon = "mdi:message-text-clock"
    _attr_native_min_value = 1
    _attr_native_max_value = 60
    _attr_native_step = 1
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_mode = NumberMode.SLIDER

    def __init__(self, entry):
        self._attr_unique_id = f"{entry.entry_id}_announcement_display_duration"
        self._attr_native_value = 5  # Default: 5 seconds
```

### 21.2 State Persistence

Uses `int(float(state))` to handle both integer and float string representations
(e.g. `"5"` and `"5.0"` both parse correctly):

```python
async def async_added_to_hass(self):
    await super().async_added_to_hass()
    last_state = await self.async_get_last_state()
    if last_state is not None and last_state.state not in ("unknown", "unavailable"):
        try:
            self._attr_native_value = int(float(last_state.state))
        except (ValueError, TypeError):
            pass
```

### 21.3 How the Card Reads This Value

Same pattern as switches — propagated via satellite entity's `extra_state_attributes`:

```python
ann_dur_eid = registry.async_get_entity_id(
    "number", DOMAIN, f"{self._entry.entry_id}_announcement_display_duration"
)
if ann_dur_eid:
    s = self.hass.states.get(ann_dur_eid)
    if s and s.state not in ("unknown", "unavailable"):
        attrs["announcement_display_duration"] = int(float(s.state))
```

---

## 22. WebSocket API

### 22.1 Command Summary

| Command | Schema | Purpose |
|---|---|---|
| `voice_satellite/run_pipeline` | `entity_id`, `start_stage`, `end_stage`, `sample_rate`, `conversation_id?`, `extra_system_prompt?` | Start bridged pipeline with binary audio |
| `voice_satellite/subscribe_events` | `entity_id` | Subscribe to satellite events (announcements, media, timers) |
| `voice_satellite/update_state` | `entity_id`, `state` | Report pipeline state change |
| `voice_satellite/announce_finished` | `entity_id`, `announce_id` | ACK announcement playback complete |
| `voice_satellite/question_answered` | `entity_id`, `announce_id`, `sentence` | Send STT transcription for ask_question |
| `voice_satellite/cancel_timer` | `entity_id`, `timer_id` | Cancel a specific timer |
| `voice_satellite/media_player_event` | `entity_id`, `state`, `volume?`, `media_id?` | Report media playback state |

### 22.2 `voice_satellite/run_pipeline`

**Schema:**
```python
{
    vol.Required("type"): "voice_satellite/run_pipeline",
    vol.Required("entity_id"): str,
    vol.Required("start_stage"): str,     # "wake_word" | "stt" | "intent" | "tts"
    vol.Required("end_stage"): str,       # "wake_word" | "stt" | "intent" | "tts"
    vol.Required("sample_rate"): int,     # e.g. 16000
    vol.Optional("conversation_id"): str, # For continue-conversation
    vol.Optional("extra_system_prompt"): str,
}
```

**Response flow:**
1. `send_result(msg_id)` — immediate, resolves JS promise
2. `send_event(msg_id, {type: "init", handler_id: N})` — card stores handler ID
3. Card sends binary audio to handler N
4. Pipeline events flow as `send_event(msg_id, {type, data})` messages

**Unsubscribe:** Sends `b""` stop signal to audio queue + unregisters binary handler.

### 22.3 `voice_satellite/subscribe_events`

**Schema:**
```python
{
    vol.Required("type"): "voice_satellite/subscribe_events",
    vol.Required("entity_id"): str,
}
```

**Response:** `send_result(msg_id)` immediately.

**Events pushed:** `{type: "announcement"|"start_conversation"|"media_player"|"timer", data: {...}}`

**Unsubscribe:** Calls `entity.unregister_satellite_subscription()`.

### 22.4 `voice_satellite/update_state`

**Schema:**
```python
{
    vol.Required("type"): "voice_satellite/update_state",
    vol.Required("entity_id"): str,
    vol.Required("state"): str,  # Card state: IDLE, STT, INTENT, TTS, etc.
}
```

**Response:** `{"success": True}`

### 22.5 `voice_satellite/announce_finished`

**Schema:**
```python
{
    vol.Required("type"): "voice_satellite/announce_finished",
    vol.Required("entity_id"): str,
    vol.Required("announce_id"): int,  # Must match _announce_id
}
```

**Response:** `{"success": True}`

### 22.6 `voice_satellite/question_answered`

**Schema:**
```python
{
    vol.Required("type"): "voice_satellite/question_answered",
    vol.Required("entity_id"): str,
    vol.Required("announce_id"): int,
    vol.Required("sentence"): str,  # STT transcription
}
```

**Response:**
```json
{
  "success": true,
  "matched": true,
  "id": "confirm_yes"
}
```

The handler waits up to 10s for hassil matching to complete before responding.

### 22.7 `voice_satellite/cancel_timer`

**Schema:**
```python
{
    vol.Required("type"): "voice_satellite/cancel_timer",
    vol.Required("entity_id"): str,
    vol.Required("timer_id"): str,
}
```

**Response:** `{"success": True}` or error `"cancel_failed"`.

Uses HA's `TimerManager` directly:

```python
from homeassistant.components.intent import TimerManager
from homeassistant.components.intent.const import TIMER_DATA

timer_manager = hass.data.get(TIMER_DATA)
timer_manager.cancel_timer(timer_id)
```

### 22.8 `voice_satellite/media_player_event`

**Schema:**
```python
{
    vol.Required("type"): "voice_satellite/media_player_event",
    vol.Required("entity_id"): str,
    vol.Required("state"): str,          # "playing" | "paused" | "idle"
    vol.Optional("volume"): vol.Coerce(float),
    vol.Optional("media_id"): str,
}
```

**Response:** `{"success": True}`

**Entity lookup** uses a predicate to find the media player entity specifically,
since both the satellite and media player entities are stored in `hass.data[DOMAIN]`
and may share similar entity_id patterns:

```python
entity = _find_entity(hass, entity_id, lambda e: hasattr(e, "update_playback_state"))
```

Without the predicate, `_find_entity()` could return the satellite entity instead
of the media player.

### 22.9 Common Error Response

All handlers return the same error format when entity is not found:

```python
connection.send_error(msg["id"], "not_found", f"Entity {entity_id} not found")
```

---

## 23. Error Handling & Concurrency

### 23.1 `asyncio.Event` Blocking Pattern

Used by announcements, start_conversation, and ask_question:

```python
self._announce_event = asyncio.Event()
# ... push event to card ...
try:
    await asyncio.wait_for(self._announce_event.wait(), timeout=ANNOUNCE_TIMEOUT)
except asyncio.TimeoutError:
    _LOGGER.warning("Timed out after %ds", ANNOUNCE_TIMEOUT)
finally:
    self._announce_event = None
```

**Timeout:** 120 seconds (`ANNOUNCE_TIMEOUT`). If the card doesn't ACK within this
window, the flow continues and the event is discarded.

### 23.2 Sequence Counter (Stale ACK Prevention)

```
Timeline:
  t=0:  Announcement #5 pushed
  t=121: Announcement #5 times out
  t=122: Announcement #6 pushed
  t=123: Card sends ACK for #5 (stale!)
  t=124: announce_finished(5) → _announce_id is 6 → 5 != 6 → ignored
```

### 23.3 Generation Counter (Pipeline Lifecycle)

```
Timeline:
  t=0:  Run A starts: _pipeline_gen=1, my_gen=1
  t=5:  Run B starts: _pipeline_gen=2, my_gen=2
  t=6:  Run A finally: _pipeline_gen(2) != my_gen(1) → skip cleanup
  t=10: Run B finally: _pipeline_gen(2) == my_gen(2) → clean up fields
```

### 23.4 Run-Start Gate

The `_pipeline_run_started` flag filters orphaned events:

```
Timeline:
  t=0:  Old pipeline run ends, but wake_word internal task still running
  t=1:  New pipeline run starts, on_pipeline_event registered
  t=2:  Old wake_word task fires wake_word-end → _pipeline_run_started is False → filtered
  t=3:  New pipeline fires run-start → _pipeline_run_started = True → event relayed
```

### 23.5 Pipeline Teardown Race Conditions

**Problem:** `CancelledError` and stop signal race on `await audio_queue.get()`.
`CancelledError` always wins, leaving orphaned HA pipeline tasks.

**Solution:** Send stop signal first, wait for natural exit, cancel only on timeout:

```python
# 1. Stop signal
entity.pipeline_audio_queue.put_nowait(b"")

# 2. Wait for natural exit
old_task = entity.pipeline_task
done, _ = await asyncio.wait({old_task}, timeout=3.0)

# 3. Force-cancel only if stuck
if not done:
    old_task.cancel()
    try:
        await old_task
    except (asyncio.CancelledError, Exception):
        pass
```

### 23.6 Subscriber Disconnection During Blocking

If all card connections disconnect while an announcement is blocking:

```python
def unregister_satellite_subscription(self, connection, msg_id):
    self._satellite_subscribers = [...]
    if not self._satellite_subscribers:
        if self._announce_event is not None:
            self._announce_event.set()  # Unblock
        if self._question_event is not None:
            self._question_event.set()  # Unblock
```

### 23.7 HA Shutdown Safety

- `_push_satellite_event()` returns early if `self.hass.is_stopping`
- `available` returns `True` during shutdown so `RestoreEntity` saves full attributes
- `_screensaver_turn_off()` swallows exceptions during shutdown
- `async_will_remove_from_hass()` releases all blocking events

---

## 24. HA API Dependencies

### 24.1 Framework Classes Used

| Class/Function | Module | Used By |
|---|---|---|
| `AssistSatelliteEntity` | `homeassistant.components.assist_satellite` | Satellite entity base class |
| `AssistSatelliteEntityFeature` | `homeassistant.components.assist_satellite` | Feature flags (ANNOUNCE, START_CONVERSATION) |
| `AssistSatelliteConfiguration` | `homeassistant.components.assist_satellite` | Wake word config (empty for browser) |
| `AssistSatelliteAnnouncement` | `homeassistant.components.assist_satellite` | Announcement data object |
| `AssistSatelliteAnswer` | `homeassistant.components.assist_satellite` | Ask question answer (HA 2025.7+) |
| `AssistPipelineSelect` | `homeassistant.components.assist_pipeline` | Pipeline select base class |
| `VadSensitivitySelect` | `homeassistant.components.assist_pipeline` | VAD select base class |
| `PipelineStage` | `homeassistant.components.assist_pipeline` | Enum for pipeline stages |
| `MediaPlayerEntity` | `homeassistant.components.media_player` | Media player base class |
| `MediaPlayerEntityFeature` | `homeassistant.components.media_player` | Feature flags |
| `MediaPlayerState` | `homeassistant.components.media_player` | State enum |
| `SelectEntity` | `homeassistant.components.select` | Select entity base class |
| `SwitchEntity` | `homeassistant.components.switch` | Switch entity base class |
| `NumberEntity` | `homeassistant.components.number` | Number entity base class |
| `RestoreEntity` | `homeassistant.helpers.restore_state` | State persistence mixin |
| `ExtraStoredData` | `homeassistant.helpers.restore_state` | Custom data persistence |
| `ConfigFlow` | `homeassistant.config_entries` | Config flow base class |
| `websocket_api` | `homeassistant.components` | WS command registration |
| `StaticPathConfig` | `homeassistant.components.http` | HTTP static path |
| `intent.async_register_timer_handler` | `homeassistant.components.intent` | Timer registration |
| `intent.TimerManager` | `homeassistant.components.intent` | Timer cancellation |
| `er.async_get` | `homeassistant.helpers.entity_registry` | Entity registry access |
| `async_track_state_change_event` | `homeassistant.helpers.event` | State change tracking |
| `async_track_time_interval` | `homeassistant.helpers.event` | Periodic callbacks |
| `async_call_later` | `homeassistant.helpers.event` | Delayed callbacks |
| `async_browse_media` | `homeassistant.components.media_source` | Media browsing |
| `async_resolve_media` | `homeassistant.components.media_source` | Media URI resolution |
| `MODE_STORAGE` | `homeassistant.components.lovelace` | Lovelace mode check |

### 24.2 Manifest Dependencies

```json
{
  "dependencies": [
    "assist_pipeline",
    "assist_satellite",
    "frontend",
    "http",
    "intent",
    "lovelace"
  ]
}
```

### 24.3 Optional Dependencies

| Dependency | Import Pattern | Required For |
|---|---|---|
| `AssistSatelliteAnswer` | `try/except ImportError` | `ask_question` (HA 2025.7+) |
| `hassil` | `try/except ImportError` | Answer sentence matching |

---

## 25. Strings & Localization

### 25.1 Config Flow Strings

```json
{
  "config": {
    "step": {
      "user": {
        "title": "Add Voice Satellite",
        "description": "Create a virtual Assist satellite for a browser tablet...",
        "data": { "name": "Satellite name" },
        "data_description": {
          "name": "A descriptive name for this tablet (e.g. Kitchen Tablet)."
        }
      }
    },
    "abort": {
      "already_configured": "A satellite with this name already exists."
    }
  }
}
```

### 25.2 Entity Translations

```json
{
  "entity": {
    "select": {
      "pipeline": { "name": "Assistant", "state": { "preferred": "Preferred" } },
      "vad_sensitivity": {
        "name": "Finished speaking detection",
        "state": { "default": "Default", "relaxed": "Relaxed", "aggressive": "Aggressive" }
      },
      "screensaver": { "name": "Screensaver entity" },
      "tts_output": { "name": "TTS output" }
    },
    "number": {
      "announcement_display_duration": { "name": "Announcement display duration" }
    },
    "switch": {
      "wake_sound": { "name": "Wake sound" },
      "mute": { "name": "Mute" }
    },
    "media_player": {
      "media_player": { "name": "Media Player" }
    }
  }
}
```

### 25.3 Translation Key → Entity Name Mapping

| Translation Key | Displayed Name | Entity ID Example |
|---|---|---|
| `pipeline` (select) | "Assistant" | `select.kitchen_tablet_assistant` |
| `vad_sensitivity` (select) | "Finished speaking detection" | `select.kitchen_tablet_finished_speaking_detection` |
| `screensaver` (select) | "Screensaver entity" | `select.kitchen_tablet_screensaver_entity` |
| `tts_output` (select) | "TTS output" | `select.kitchen_tablet_tts_output` |
| `wake_sound` (switch) | "Wake sound" | `switch.kitchen_tablet_wake_sound` |
| `mute` (switch) | "Mute" | `switch.kitchen_tablet_mute` |
| `announcement_display_duration` (number) | "Announcement display duration" | `number.kitchen_tablet_announcement_display_duration` |
| `media_player` (media_player) | "Media Player" | `media_player.kitchen_tablet_media_player` |

The satellite entity uses `_attr_name = None` to use the device name directly
(e.g., `assist_satellite.kitchen_tablet`).

---

## 26. Implementation Checklist

Step-by-step guide to recreate the integration from scratch.

### Phase 1: Skeleton

- [ ] Create `custom_components/voice_satellite/` directory
- [ ] Create `manifest.json` with domain `voice_satellite`, dependencies on `assist_pipeline`, `assist_satellite`, `frontend`, `http`, `intent`, `lovelace`
- [ ] Create `const.py` with `DOMAIN`, `SCREENSAVER_INTERVAL`, `INTEGRATION_VERSION`, `URL_BASE`, `JS_FILENAME`
- [ ] Create `strings.json` with config flow and entity translation strings
- [ ] Create `config_flow.py` — single-step name flow with unique ID from `name.lower().replace(" ", "_")`

### Phase 2: Frontend Registration

- [ ] Create `frontend.py` with `JSModuleRegistration` class
- [ ] Implement `_async_register_path()` — register `/voice_satellite` static path
- [ ] Implement `_async_wait_for_lovelace_resources()` — 12-retry poll with 5s intervals
- [ ] Implement `_async_register_module()` — versioned URL, create or update resource
- [ ] Implement `async_unregister()` — remove resource on last entry unload
- [ ] Handle HA 2026.2 compat: `resource_mode` vs `mode` attribute

### Phase 3: Integration Setup

- [ ] Create `__init__.py` with `async_setup()`, `async_setup_entry()`, `async_unload_entry()`
- [ ] Register 7 WebSocket commands in `async_setup()`
- [ ] Defer frontend registration to `EVENT_HOMEASSISTANT_STARTED` if HA not running
- [ ] Implement `_find_entity()` helper for WS handler entity lookup
- [ ] Forward to 5 platforms: `ASSIST_SATELLITE`, `MEDIA_PLAYER`, `NUMBER`, `SELECT`, `SWITCH`

### Phase 4: Satellite Entity

- [ ] Create `assist_satellite.py` with `VoiceSatelliteEntity(AssistSatelliteEntity)`
- [ ] Set supported features: `ANNOUNCE | START_CONVERSATION`
- [ ] Implement `device_info` with identifiers, name, manufacturer, model, sw_version
- [ ] Implement `available` — subscription-based with HA shutdown override
- [ ] Implement `extra_state_attributes` — timers, mute, wake_sound, tts_target, announcement_duration
- [ ] Implement `async_added_to_hass()` — timer handler registration + sibling entity tracking
- [ ] Implement `async_will_remove_from_hass()` — graceful pipeline shutdown + event release
- [ ] Implement `async_get_configuration()` — empty wake word config

### Phase 5: Pipeline Bridge

- [ ] Implement `async_run_pipeline()` with generation counter and audio stream generator
- [ ] Implement `on_pipeline_event()` with run-start gate
- [ ] Implement `ws_run_pipeline` handler — old pipeline teardown, audio queue, binary handler, background task
- [ ] Handle displaced pipeline scenario (different connection warning + displaced event)
- [ ] Implement graceful teardown: stop signal → wait → force cancel

### Phase 6: State Synchronization

- [ ] Implement `_STATE_MAP` dict (card states → HA satellite states)
- [ ] Implement `set_pipeline_state()` with screensaver keep-alive triggers
- [ ] Implement `_set_satellite_state()` with name-mangled attribute access
- [ ] Implement `ws_update_state` handler

### Phase 7: Satellite Event Subscription

- [ ] Implement `register_satellite_subscription()` / `unregister_satellite_subscription()`
- [ ] Implement `_push_satellite_event()` with dead connection cleanup
- [ ] Implement `_update_media_player_availability()` cascade
- [ ] Implement `ws_subscribe_satellite_events` handler
- [ ] Release blocking events on last subscriber disconnect

### Phase 8: Announcement System

- [ ] Override `async_internal_announce()` to capture `preannounce` flag
- [ ] Implement `async_announce()` — sequence counter, event push, blocking wait
- [ ] Implement `announce_finished()` callback with stale ACK filtering
- [ ] Implement `ws_announce_finished` handler

### Phase 9: Start Conversation

- [ ] Override `async_internal_start_conversation()` to capture `preannounce` + `extra_system_prompt`
- [ ] Implement `async_start_conversation()` — same blocking pattern + `start_conversation: true`
- [ ] Set satellite state to `"listening"` after ACK

### Phase 10: Ask Question

- [ ] Add conditional imports: `AssistSatelliteAnswer` (HA 2025.7+) + `hassil`
- [ ] Override `async_internal_ask_question()` — three-phase flow
- [ ] Phase 1: Set `_ask_question_pending`, delegate to announce
- [ ] Phase 2: Wait for `_question_event` (STT transcription from card)
- [ ] Phase 3: Match answer with `_match_answer()` using hassil
- [ ] Implement `question_answered()` callback
- [ ] Implement `ws_question_answered` handler — wait for match event, return result
- [ ] Handle race: don't clear `_question_match_result` in finally block

### Phase 11: Timer System

- [ ] Implement `_handle_timer_event()` — STARTED, UPDATED, CANCELLED, FINISHED
- [ ] Use immutable list pattern (create new list, don't mutate)
- [ ] Store timer dict: id, name, total_seconds, started_at, start_hours/minutes/seconds
- [ ] Implement `ws_cancel_timer` handler via HA's `TimerManager`

### Phase 12: Screensaver Keep-Alive

- [ ] Implement `_get_screensaver_entity_id()` — resolve via select entity attribute
- [ ] Implement `_start_screensaver_keepalive()` — immediate turn-off + 5s periodic
- [ ] Implement `_stop_screensaver_keepalive()` — cancel periodic timer
- [ ] Implement `_screensaver_turn_off()` — service call with shutdown error swallowing

### Phase 13: Supporting Entities

- [ ] Create `media_player.py` — `VoiceSatelliteMediaPlayer(MediaPlayerEntity, RestoreEntity)`
  - [ ] 8 supported features, command push via satellite subscription
  - [ ] Optimistic state, `update_playback_state()` for reconciliation
  - [ ] `MediaPlayerExtraData` for volume persistence
  - [ ] Media source URI resolution, browse media with audio filter
  - [ ] Availability delegates to satellite entity
- [ ] Create `select.py` — 4 select entities
  - [ ] `VoiceSatellitePipelineSelect(AssistPipelineSelect)` — framework subclass
  - [ ] `VoiceSatelliteVadSensitivitySelect(VadSensitivitySelect)` — framework subclass
  - [ ] `VoiceSatelliteScreensaverSelect` — custom with 30s mapping cache
  - [ ] `VoiceSatelliteTTSOutputSelect` — custom with 30s mapping cache
  - [ ] Stale entity cleanup for older versions
- [ ] Create `switch.py` — 2 switch entities
  - [ ] `VoiceSatelliteWakeSoundSwitch` — default on
  - [ ] `VoiceSatelliteMuteSwitch` — default off
  - [ ] Both use `RestoreEntity` for persistence
- [ ] Create `number.py` — 1 number entity
  - [ ] `VoiceSatelliteAnnouncementDurationNumber` — range 1-60, default 5, slider mode
  - [ ] `RestoreEntity` for persistence

### Phase 14: WebSocket Handlers

- [ ] `ws_run_pipeline` — Full pipeline bridge setup (see Phase 5)
- [ ] `ws_subscribe_satellite_events` — Subscription management
- [ ] `ws_update_state` — Pipeline state mapping
- [ ] `ws_announce_finished` — ACK with sequence validation
- [ ] `ws_question_answered` — Answer + match event wait
- [ ] `ws_cancel_timer` — HA TimerManager delegation
- [ ] `ws_media_player_event` — Playback state update with predicate lookup
