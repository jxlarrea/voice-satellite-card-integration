# Voice Satellite Card Integration — Design Document

## 1. Overview

This integration creates virtual Assist Satellite entities in Home Assistant for browsers running the [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant). Each config entry produces one `assist_satellite.*` entity backed by a device in the device registry, along with supporting select, switch, number, and media player entities.

**Critical dependency:** The card **requires** this integration. There is no standalone mode. The card routes all voice pipeline traffic through the integration's `voice_satellite/run_pipeline` WebSocket command.

### What the integration provides

| Capability | Mechanism |
|---|---|
| Timer support | `intent.async_register_timer_handler` → LLM sees `HassStartTimer` |
| Announcements | `assist_satellite.announce` action → pushed to card via WS subscription |
| Start conversation | `assist_satellite.start_conversation` action → prompt + listen |
| Ask question | `assist_satellite.ask_question` action → prompt + STT + hassil matching |
| Media player | `media_player` entity → volume control, `tts.speak` / `play_media` targeting, media browsing |
| Entity availability | Entity is `unavailable` when no card is connected; becomes available on `subscribe_events` |
| Pipeline state sync | Card → integration state updates → entity reflects `idle`/`listening`/`processing`/`responding` |
| Bridged pipeline | Card audio → integration → HA pipeline → events back to card |
| Per-device automations | Entity state changes trigger automations |

### Cross-repo relationship

This integration and the card are tightly coupled. The card reads entity attributes (`active_timers`, `muted`, `wake_sound`, `tts_target`, `announcement_display_duration`) and sends WebSocket commands. The integration pushes notification events (announcements, start_conversation, ask_question) directly to the card via a persistent WS subscription. Changes to event formats, WebSocket command schemas, or async flow timing affect both repos.

See the card's [DESIGN.md](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/blob/master/DESIGN.md) for the card-side implementation.

## 2. Project Structure

```
voice-satellite-card-integration/
├── custom_components/
│   └── voice_satellite/
│       ├── __init__.py          # Entry setup, 7 WebSocket command registrations
│       ├── assist_satellite.py  # VoiceSatelliteEntity (core entity)
│       ├── config_flow.py       # Single-step config flow
│       ├── const.py             # DOMAIN, SCREENSAVER_INTERVAL constants
│       ├── media_player.py      # VoiceSatelliteMediaPlayer (media player entity)
│       ├── number.py            # Announcement display duration number entity
│       ├── select.py            # Pipeline, VAD sensitivity, screensaver, TTS output selects
│       ├── switch.py            # Wake sound, mute switches
│       ├── manifest.json        # Integration manifest
│       ├── strings.json         # UI strings for config flow + entity names
│       ├── translations/
│       │   └── en.json          # English translations (mirrors strings.json)
│       ├── icon.png             # Integration branding (256×256)
│       └── logo.png             # Integration branding (same as icon)
├── .github/
│   ├── workflows/
│   │   └── hacs.yml             # HACS validation + hassfest
│   └── FUNDING.yml              # GitHub Sponsors + Buy Me a Coffee
├── hacs.json                    # HACS metadata
├── README.md
├── DESIGN.md                    # This file
└── LICENSE                      # MIT
```

## 3. Integration Lifecycle

### 3.1 Config Flow (`config_flow.py`)

Single-step flow. The user provides a name (e.g., "Kitchen Tablet"). The flow:

1. Strips whitespace from the name
2. Generates a unique ID by lowercasing and replacing spaces with underscores (`kitchen_tablet`)
3. Calls `self._abort_if_unique_id_configured()` to prevent duplicates
4. Creates a config entry with `data={"name": name}`

The resulting entity ID will be `assist_satellite.<slugified_name>`.

### 3.2 Entry Setup (`__init__.py`)

`async_setup_entry` does two things:

1. **Forward platform setup** — Calls `async_forward_entry_setups(entry, PLATFORMS)` where `PLATFORMS = [Platform.ASSIST_SATELLITE, Platform.MEDIA_PLAYER, Platform.NUMBER, Platform.SELECT, Platform.SWITCH]`. This triggers setup in `assist_satellite.py`, `media_player.py`, `number.py`, `select.py`, and `switch.py`.
2. **Register WebSocket commands** — Registers all 7 WS commands. Uses try/except around each registration because multiple config entries share the same command types (only the first registration succeeds, subsequent ones raise `ValueError`).

The 7 WebSocket commands:
- `voice_satellite/announce_finished`
- `voice_satellite/update_state`
- `voice_satellite/question_answered`
- `voice_satellite/run_pipeline`
- `voice_satellite/subscribe_events`
- `voice_satellite/cancel_timer`
- `voice_satellite/media_player_event`

### 3.3 Entry Unload

Unloads platforms and removes entity references from `hass.data[DOMAIN]`:

```python
async def async_unload_entry(hass, entry):
    result = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if result:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop(f"{entry.entry_id}_media_player", None)
    return result
```

### 3.4 Entity Storage

Satellite entities are stored in `hass.data[DOMAIN][entry.entry_id]`. Media player entities are stored in `hass.data[DOMAIN][f"{entry.entry_id}_media_player"]`. All WebSocket handlers iterate this dict to find entities by `entity_id`. This lookup is necessary because WS commands are global (not per-entity), so the handler must locate the correct entity instance.

```python
entity = None
for entry_id, ent in hass.data.get(DOMAIN, {}).items():
    if ent.entity_id == entity_id:
        entity = ent
        break
```

## 4. Entity (`assist_satellite.py`)

### 4.1 Class Hierarchy

`VoiceSatelliteEntity` extends `AssistSatelliteEntity` from `homeassistant.components.assist_satellite`. The base class provides:

- Registration as an Assist Satellite device
- The `assist_satellite.announce` action (resolves TTS, calls `async_announce`)
- The `assist_satellite.start_conversation` action (resolves TTS, calls `async_start_conversation`)
- Pipeline event routing (calls `on_pipeline_event`)
- Pipeline acceptance (`async_accept_pipeline_from_satellite`)
- Wake word configuration (calls `async_get_configuration`)

The entity declares supported features:

```python
_attr_supported_features = (
    AssistSatelliteEntityFeature.ANNOUNCE
    | AssistSatelliteEntityFeature.START_CONVERSATION
)
```

Note: `ask_question` does not have a separate feature flag — the entity implements it via `async_internal_ask_question`.

### 4.2 Device Info

Each entity creates a device registry entry:

```python
@property
def device_info(self):
    return {
        "identifiers": {(DOMAIN, self._entry.entry_id)},
        "name": self._satellite_name,
        "manufacturer": "Voice Satellite Card Integration",
        "model": "Browser Satellite",
        "sw_version": "<version>",
    }
```

The `identifiers` tuple uses the config entry ID as the unique key. Each config entry = one device = 9 entities (1 assist_satellite, 1 media_player, 4 selects, 2 switches, 1 number), all sharing the same device identifiers.

### 4.3 Entity Naming

- `_attr_has_entity_name = True` — entity uses the device name
- `_attr_name = None` — no additional suffix; the entity name IS the device name
- `_attr_unique_id = entry.entry_id` — uses the config entry UUID

### 4.4 Extra State Attributes

The entity exposes attributes for the card to read:

```python
@property
def extra_state_attributes(self):
    attrs = {
        "active_timers": self._active_timers,
        "last_timer_event": self._last_timer_event,
    }
    # Expose mute and wake sound switch states
    registry = er.async_get(self.hass)
    mute_eid = registry.async_get_entity_id("switch", DOMAIN, f"{self._entry.entry_id}_mute")
    if mute_eid:
        s = self.hass.states.get(mute_eid)
        attrs["muted"] = s.state == "on" if s else False
    wake_eid = registry.async_get_entity_id("switch", DOMAIN, f"{self._entry.entry_id}_wake_sound")
    if wake_eid:
        s = self.hass.states.get(wake_eid)
        attrs["wake_sound"] = s.state == "on" if s else True

    # Expose TTS output select entity_id for the card
    tts_select_eid = registry.async_get_entity_id("select", DOMAIN, f"{self._entry.entry_id}_tts_output")
    if tts_select_eid:
        s = self.hass.states.get(tts_select_eid)
        if s and s.state not in ("Browser", "unknown", "unavailable"):
            attrs["tts_target"] = s.attributes.get("entity_id", "")
        else:
            attrs["tts_target"] = ""

    # Expose announcement display duration for the card
    ann_dur_eid = registry.async_get_entity_id("number", DOMAIN,
        f"{self._entry.entry_id}_announcement_display_duration")
    if ann_dur_eid:
        s = self.hass.states.get(ann_dur_eid)
        if s and s.state not in ("unknown", "unavailable"):
            try:
                attrs["announcement_display_duration"] = int(float(s.state))
            except (ValueError, TypeError):
                pass

    return attrs
```

| Attribute | Type | Description |
|---|---|---|
| `active_timers` | `list[dict]` | Active timers with countdown data (always present, empty list when none) |
| `last_timer_event` | `string \| null` | Last timer event type: `started`, `updated`, `cancelled`, `finished` |
| `muted` | `bool` | Whether the mute switch is on (default `False`) |
| `wake_sound` | `bool` | Whether the wake sound switch is on (default `True`) |
| `tts_target` | `string` | Entity ID of the media player for remote TTS, or `""` if set to "Browser" (default) |
| `announcement_display_duration` | `int` | Seconds to display announcement bubbles (default `5`, range 1–60) |

**Important:** Announcements are NOT in entity attributes. They are pushed directly to the card via the satellite event subscription (§10).

### 4.5 Entity Availability

The entity overrides the `available` property to reflect whether a card is actually connected:

```python
@property
def available(self) -> bool:
    if self.hass.is_stopping:
        return True  # Save full attributes during shutdown
    return len(self._satellite_subscribers) > 0
```

**Shutdown guard:** During HA shutdown, the entity reports as available so `RestoreEntity` saves state with full attributes (volume, timers, etc.) instead of an empty "unavailable" state.

When no browser has an active `subscribe_events` subscription, the entity shows as **unavailable** in HA. This means:

- The entity state becomes `unavailable` in the UI and state machine
- Automations targeting the entity (announce, start_conversation, etc.) fail immediately instead of hanging until timeout
- The media_player entity on the same device also becomes unavailable (it delegates to the satellite's `available` property)

Availability updates are triggered in `register_satellite_subscription` (first subscriber → available) and `unregister_satellite_subscription` (last subscriber removed → unavailable). Both also call `_update_media_player_availability()` to propagate the change to the child media_player entity.

### 4.6 Pipeline/VAD Entity ID Properties

The entity provides lookup properties for the related select entities:

```python
@property
def pipeline_entity_id(self):
    registry = er.async_get(self.hass)
    return registry.async_get_entity_id("select", DOMAIN, f"{self._entry.entry_id}-pipeline")

@property
def vad_sensitivity_entity_id(self):
    registry = er.async_get(self.hass)
    return registry.async_get_entity_id("select", DOMAIN, f"{self._entry.entry_id}-vad_sensitivity")
```

These are used by the `AssistSatelliteEntity` base class to resolve the pipeline and VAD settings when running a pipeline via `async_accept_pipeline_from_satellite`.

### 4.6 Entity Lifecycle

#### `async_added_to_hass`

1. Registers the device as a timer handler via `intent.async_register_timer_handler`
2. Subscribes to sibling entity state changes (mute/wake_sound switches, TTS output select, announcement duration number) so `extra_state_attributes` are re-evaluated when any change
3. Wraps all unregister callbacks with `async_on_remove()` for cleanup

```python
async def async_added_to_hass(self):
    await super().async_added_to_hass()
    assert self.device_entry is not None

    # Timer handler
    self.async_on_remove(
        intent.async_register_timer_handler(
            self.hass, self.device_entry.id, self._handle_timer_event,
        )
    )

    # Track sibling entity state changes
    registry = er.async_get(self.hass)
    tracked_eids = []
    for suffix in ("_mute", "_wake_sound"):
        eid = registry.async_get_entity_id("switch", DOMAIN, f"{self._entry.entry_id}{suffix}")
        if eid:
            tracked_eids.append(eid)
    tts_eid = registry.async_get_entity_id("select", DOMAIN, f"{self._entry.entry_id}_tts_output")
    if tts_eid:
        tracked_eids.append(tts_eid)
    ann_dur_eid = registry.async_get_entity_id("number", DOMAIN,
        f"{self._entry.entry_id}_announcement_display_duration")
    if ann_dur_eid:
        tracked_eids.append(ann_dur_eid)
    if tracked_eids:
        self.async_on_remove(
            async_track_state_change_event(self.hass, tracked_eids, self._on_switch_state_change)
        )
```

**Gotcha:** `self.device_entry` is only available after `async_added_to_hass()`. Timer handler registration must happen here, not in `__init__`.

#### `async_will_remove_from_hass`

Cleanup on entity removal (HA restart, config entry unload):

1. **Pipeline stop**: Send empty bytes to audio queue → wait up to 5s for natural exit → force cancel on timeout
2. **Release blocking events**: Set `_announce_event` and `_question_event` so `async_announce`/`async_internal_ask_question` don't hang forever
3. **Clear subscribers**: Empty the satellite subscriber list
4. **Stop screensaver**: Cancel the keep-alive timer

### 4.7 Wake Word Configuration

```python
@callback
def async_get_configuration(self):
    return AssistSatelliteConfiguration(
        available_wake_words=[], active_wake_words=[], max_active_wake_words=0,
    )

async def async_set_configuration(self, config):
    pass  # No-op for browser satellites
```

Wake word detection happens on the HA pipeline server side, not on the card. The card sends audio starting from the wake word stage.

## 5. Timer System

### 5.1 Timer Handler Registration

On `async_added_to_hass`, the entity registers itself as a timer handler using `intent.async_register_timer_handler(hass, device_id, callback)`. This tells HA's intent system that this device supports timers, causing the LLM to receive timer intents (`HassStartTimer`, `HassUpdateTimer`, `HassCancelTimer`).

### 5.2 Timer Event Handler

The `_handle_timer_event` callback receives `(event_type: intent.TimerEventType, timer_info: intent.TimerInfo)`.

| Event | Behavior |
|---|---|
| `STARTED` | Append new timer dict to `_active_timers` |
| `UPDATED` | Find timer by ID, overwrite duration + `started_at` |
| `CANCELLED` / `FINISHED` | Remove timer by ID |

All events set `_last_timer_event = event_type.value` and call `async_write_ha_state()`.

### 5.3 Immutable List Pattern (Critical Gotcha)

Timer list mutations **must create a new list**, not modify in-place:

```python
# CORRECT — new list, HA detects the change
self._active_timers = [*self._active_timers, new_timer]

# WRONG — in-place mutation, HA suppresses state_changed event
self._active_timers.append(new_timer)
```

**Why:** HA's state machine compares old and new attribute values by reference. If the list is mutated in-place, the previously-written state's attribute reference points to the same list object, making `old == new` → HA suppresses the `state_changed` event → the card never sees the update.

The same pattern applies to UPDATED (create new list with modified timer) and CANCELLED/FINISHED (create new filtered list).

### 5.4 Timer Attribute Contract

Each timer in `active_timers` is a dict:

```json
{
    "id": "timer_id_string",
    "name": "pizza timer",
    "total_seconds": 600,
    "started_at": 1708000000.0,
    "start_hours": 0,
    "start_minutes": 10,
    "start_seconds": 0
}
```

- `id` — Opaque string from HA's timer system
- `name` — User-specified name, may be empty string
- `total_seconds` — Total duration in seconds (computed from h/m/s components)
- `started_at` — Unix timestamp (`time.time()`) when the timer started or was last updated
- `start_hours/minutes/seconds` — Original duration components from the intent

The card computes remaining time client-side: `started_at + total_seconds - Date.now()/1000`.

### 5.5 Timer Cancellation

The `voice_satellite/cancel_timer` WS command allows the card to cancel timers by ID. The handler imports `TimerManager` and `TIMER_DATA` from `homeassistant.components.intent` at call time (lazy import) and calls `timer_manager.cancel_timer(timer_id)`.

### 5.6 `TimerInfo` API Notes

- `timer_info.start_hours`, `start_minutes`, `start_seconds` — Optional integers, can be `None` (default to 0)
- There is no `total_seconds` field on `TimerInfo` — must be computed: `h * 3600 + m * 60 + s`
- `timer_info.name` can be `None` (default to empty string)

## 6. Announcement System

### 6.1 Event Push Model (Phase 2 Architecture)

Announcements are **pushed directly** to the card via the satellite event WS subscription (§10), not via entity attributes. The flow:

1. An automation calls `assist_satellite.announce` targeting this entity
2. HA base class resolves TTS and calls `async_announce(announcement)` on the entity
3. The entity builds an announcement data dict and pushes it to all satellite subscribers via `_push_satellite_event("announcement", data)`
4. The entity blocks on an `asyncio.Event` until the card ACKs
5. The card plays the announcement (chime + TTS audio)
6. The card sends `voice_satellite/announce_finished` via WebSocket
7. The WS handler calls `entity.announce_finished(announce_id)` → sets the event
8. `async_announce` unblocks and returns

### 6.2 `async_internal_announce` Override

The base class's `async_internal_announce` consumes the `preannounce` boolean internally (deciding whether to resolve a default preannounce URL) but does NOT pass it through to the `AssistSatelliteAnnouncement` object. We override it to capture the flag before delegating:

```python
async def async_internal_announce(self, message=None, media_id=None,
                                   preannounce=True, preannounce_media_id=None):
    self._preannounce_pending = preannounce
    await super().async_internal_announce(...)
```

### 6.3 `async_announce` Implementation

```python
async def async_announce(self, announcement):
    self._start_screensaver_keepalive()
    self._announce_id += 1
    announce_id = self._announce_id

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

    self._announce_event = asyncio.Event()
    self._push_satellite_event("announcement", announcement_data)

    try:
        await asyncio.wait_for(self._announce_event.wait(), timeout=ANNOUNCE_TIMEOUT)
    except asyncio.TimeoutError:
        _LOGGER.warning(...)
    finally:
        self._announce_event = None
        self._preannounce_pending = True
        # Stop keep-alive unless satellite is still active
        current = self.hass.states.get(self.entity_id)
        if not current or current.state == "idle":
            self._stop_screensaver_keepalive()
```

Key design decisions:
- `_announce_id` is monotonically increasing — prevents stale ACKs from previous announcements
- `ANNOUNCE_TIMEOUT = 120` seconds — if the card never ACKs, the method unblocks after 2 minutes
- `finally` block resets `_preannounce_pending` and conditionally stops screensaver keepalive
- `media_id` is the resolved TTS URL (e.g., `/api/tts_proxy/xxxxx.mp3`), not a `media-source://` reference
- `"preannounce": false` is only included when the chime should be suppressed (absent means `true`)
- `"ask_question": true` is injected when `async_internal_ask_question` is driving the announce flow

### 6.4 Announcement Data Contract

When pushed via satellite subscription, the announcement data contains:

```json
{
    "id": 1,
    "message": "Dinner is ready!",
    "media_id": "/api/tts_proxy/xxxxx.mp3",
    "preannounce_media_id": ""
}
```

Optional fields (only present when applicable):
- `"preannounce": false` — suppress the chime
- `"ask_question": true` — enter STT-only mode after playback
- `"start_conversation": true` — enter full pipeline after playback (see §7)
- `"extra_system_prompt": "..."` — custom LLM system prompt (see §7)

### 6.5 `announce_finished` Callback

Validates the `announce_id` matches the current pending announcement before setting the event:

```python
@callback
def announce_finished(self, announce_id):
    if self._announce_event is not None and self._announce_id == announce_id:
        self._announce_event.set()
```

Stale ACKs (wrong `announce_id`) are silently ignored with a debug log.

## 7. Start Conversation

### 7.1 Flow

1. An automation calls `assist_satellite.start_conversation` targeting this entity
2. HA calls `async_internal_start_conversation(preannounce=..., extra_system_prompt=..., ...)` — our override captures both values then delegates to the base class
3. The base class resolves TTS and calls `async_start_conversation(announcement)`
4. The entity pushes a `start_conversation` event with the announcement data (including `"start_conversation": true` and optionally `"extra_system_prompt"`)
5. The card plays the announcement, sends ACK
6. After ACK: entity sets state to `listening`, card enters STT mode (skipping wake word)
7. Pipeline state sync takes over from here

### 7.2 `async_internal_start_conversation` Override

Captures two values before delegating to the base class:

```python
async def async_internal_start_conversation(self, start_message=None, start_media_id=None,
                                              preannounce=True, preannounce_media_id=None,
                                              extra_system_prompt=None):
    self._preannounce_pending = preannounce
    self._pending_extra_system_prompt = extra_system_prompt
    await super().async_internal_start_conversation(...)
```

### 7.3 `async_start_conversation` Implementation

```python
async def async_start_conversation(self, announcement):
    self._start_screensaver_keepalive()
    self._announce_id += 1
    announce_id = self._announce_id

    announcement_data = {
        "id": announce_id,
        "message": announcement.message or "",
        "media_id": announcement.media_id or "",
        "preannounce_media_id": getattr(announcement, "preannounce_media_id", None) or "",
        "start_conversation": True,
    }

    if not self._preannounce_pending:
        announcement_data["preannounce"] = False
    if self._pending_extra_system_prompt:
        announcement_data["extra_system_prompt"] = self._pending_extra_system_prompt

    self._announce_event = asyncio.Event()
    self._push_satellite_event("start_conversation", announcement_data)

    try:
        await asyncio.wait_for(self._announce_event.wait(), timeout=ANNOUNCE_TIMEOUT)
        # ACK succeeded — set entity state to listening
        self.hass.states.async_set(self.entity_id, "listening", self.extra_state_attributes)
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

Key differences from `async_announce`:
- Includes `"start_conversation": True` in the data
- Includes `"extra_system_prompt"` when provided
- After ACK, explicitly sets entity state to `listening` via `hass.states.async_set()` so the entity reflects the correct state before the card's pipeline state sync kicks in
- Clears `_pending_extra_system_prompt` in the `finally` block

### 7.4 Card-Side Behavior

When the card receives a `start_conversation` event:
1. Plays the chime and TTS normally (unless `preannounce === false`)
2. On completion: sends ACK, clears UI immediately (no display delay)
3. Shows pipeline overlay, calls `pipeline.restartContinue(null)` to enter STT mode with a fresh conversation (or with `extra_system_prompt` if provided)

## 8. Ask Question

### 8.1 Overview

`assist_satellite.ask_question` (HA 2025.7+) speaks a question, captures the user's voice response via STT, and matches it against predefined answer templates using [hassil](https://github.com/home-assistant/hassil) sentence matching.

### 8.2 Flow

1. Automation calls `ask_question` with `question`, optional `question_media_id`, and `answers` list
2. `async_internal_ask_question` sets `_ask_question_pending = True` and creates coordination events
3. **Phase 1:** Delegates TTS to `self.async_internal_announce(message=question, ...)` which resolves media and calls our `async_announce`. Because `_ask_question_pending` is set, `async_announce` adds `"ask_question": True` to the event data
4. Card plays announcement, sends ACK → `async_announce` returns
5. **Phase 2:** Re-starts screensaver keepalive, sets state to `listening`, waits for `_question_event`
6. Card enters STT-only mode, transcribes user speech, sends `voice_satellite/question_answered`
7. WS handler calls `entity.question_answered(announce_id, sentence)` → sets `_question_event`
8. `async_internal_ask_question` wakes up, runs hassil matching, stores result, signals `_question_match_event`
9. WS handler reads result, returns `{success, matched, id}` to card
10. Entity returns `AssistSatelliteAnswer(id, sentence, slots)` to the calling automation

### 8.3 TTS Resolution via Base Class Delegation

The key architectural decision: `async_internal_ask_question` does NOT do its own TTS resolution. It delegates to `self.async_internal_announce()`, which the base class already handles. The `_ask_question_pending` flag tells our `async_announce` override to include the `ask_question: true` flag.

### 8.4 State Coordination

Six state variables coordinate the async flow:

| Variable | Type | Purpose |
|---|---|---|
| `_ask_question_pending` | `bool` | Tells `async_announce` to add `ask_question: true` flag |
| `_question_event` | `asyncio.Event` | Signaled when card sends transcribed text |
| `_question_answer_text` | `str` | The transcribed text from the card |
| `_question_match_event` | `asyncio.Event` | Signaled when hassil matching completes |
| `_question_match_result` | `dict` | `{matched: bool, id: str|null}` for the WS handler |
| `_preannounce_pending` | `bool` | Shared — captured from `async_internal_announce` override |

### 8.5 Hassil Matching (`_match_answer`)

Builds a hassil `Intents` structure from the answer list and calls `recognize(sentence, intents)`:

- Each answer's `id` becomes an intent name
- Each answer's `sentences` become the intent data sentences
- On match: returns `AssistSatelliteAnswer(id=matched_id, sentence=sentence, slots={name: value})`
- On no match or error: returns `AssistSatelliteAnswer(id=None, sentence=sentence, slots={})`

### 8.6 WS Handler Coordination

The `ws_question_answered` handler has a specific ordering requirement:

```python
# 1. Grab match event BEFORE triggering the answer (avoids race)
match_event = entity._question_match_event

# 2. Trigger the answer
entity.question_answered(announce_id, sentence)

# 3. Wait for hassil matching to complete
await asyncio.wait_for(match_event.wait(), timeout=10.0)

# 4. Read result immediately (before finally block clears it)
result = entity._question_match_result or result
```

See §16.1–16.3 for the race conditions this ordering prevents.

### 8.7 Hassil Import Pattern

```python
try:
    from hassil.intents import Intents
    from hassil.recognize import recognize
    HAS_HASSIL = True
except ImportError:
    HAS_HASSIL = False

try:
    from homeassistant.components.assist_satellite import AssistSatelliteAnswer
except ImportError:
    AssistSatelliteAnswer = None
```

Both are conditionally imported. `AssistSatelliteAnswer` requires HA 2025.7+. Without hassil, raw sentences are returned. Without `AssistSatelliteAnswer`, the method raises `NotImplementedError`.

## 9. Pipeline State Synchronization

### 9.1 State Mapping

The card sends its internal pipeline state to the integration via `voice_satellite/update_state`. The entity maps card states to HA satellite states:

| Card State | HA Satellite State |
|---|---|
| `IDLE` | `idle` |
| `CONNECTING` | `idle` |
| `LISTENING` | `idle` |
| `PAUSED` | `idle` |
| `WAKE_WORD_DETECTED` | `listening` |
| `STT` | `listening` |
| `INTENT` | `processing` |
| `TTS` | `responding` |
| `ERROR` | `idle` |

### 9.2 State Update Mechanism

```python
@callback
def set_pipeline_state(self, state):
    mapped = self._STATE_MAP.get(state)
    if mapped is None:
        return

    # Screensaver keep-alive: active when satellite is non-idle
    if mapped != "idle":
        self._start_screensaver_keepalive()
    else:
        self._stop_screensaver_keepalive()

    if self.state == mapped:
        return  # Dedup: don't write same state

    # Update base class internal state via name mangling
    self._AssistSatelliteEntity__assist_satellite_state = mapped
    self.async_write_ha_state()
```

**Why name mangling?** `AssistSatelliteEntity` stores state in a private attribute `__assist_satellite_state` but provides no public setter. Since our entity is a virtual proxy (the actual pipeline runs in the browser), we need to force the state externally. Python's name mangling transforms `__assist_satellite_state` to `_AssistSatelliteEntity__assist_satellite_state`, giving us access to update it. This approach is preferred over `hass.states.async_set()` because it keeps the base class's internal state consistent with what's published — subsequent `async_write_ha_state()` calls (e.g., from switch changes) will publish the correct state instead of reverting to a stale value.

### 9.3 Deduplication

The method checks `self.state == mapped` before writing. The card may send rapid state updates during pipeline transitions, and this prevents unnecessary state change events.

### 9.4 Screensaver Integration

`set_pipeline_state` also drives the screensaver keep-alive system. Any non-idle state starts the keepalive; transition back to idle stops it.

## 10. Satellite Event Subscription

### 10.1 Overview

The card maintains a persistent WS subscription via `voice_satellite/subscribe_events`. The integration pushes notification events (announcements, start_conversation, ask_question) and media player commands directly to the card through this subscription, rather than writing to entity attributes.

### 10.2 Subscriber Management

```python
# Registration
@callback
def register_satellite_subscription(self, connection, msg_id):
    was_empty = not self._satellite_subscribers
    self._satellite_subscribers.append((connection, msg_id))
    if was_empty:
        self.async_write_ha_state()          # satellite → available
        self._update_media_player_availability()  # media_player → available

# Unregistration
@callback
def unregister_satellite_subscription(self, connection, msg_id):
    self._satellite_subscribers = [
        (c, m) for c, m in self._satellite_subscribers
        if not (c is connection and m == msg_id)
    ]
    if not self._satellite_subscribers:
        self.async_write_ha_state()          # satellite → unavailable
        self._update_media_player_availability()  # media_player → unavailable
```

Subscribers are stored as `list[tuple[ActiveConnection, int]]`. The first subscriber arriving makes the entity available; the last one leaving makes it unavailable (see §4.5).

### 10.3 Event Push

```python
@callback
def _push_satellite_event(self, event_type, data):
    if not self._satellite_subscribers:
        _LOGGER.warning("No satellite subscribers — cannot push event")
        return

    dead = []
    for connection, msg_id in self._satellite_subscribers:
        try:
            connection.send_event(msg_id, {"type": event_type, "data": data})
        except Exception:
            dead.append((connection, msg_id))

    # Clean up dead subscribers
    if dead:
        self._satellite_subscribers = [s for s in self._satellite_subscribers if s not in dead]
```

Dead subscriber detection: if `send_event` raises (e.g., connection closed), the subscriber is removed from the list.

### 10.4 Unsubscribe Releases Blocking Events

When all subscribers disconnect (e.g., tab closed, page navigated away), the entity releases any pending blocking events so `async_announce` and `async_internal_ask_question` don't hang forever:

```python
def unregister_satellite_subscription(self, connection, msg_id):
    # ... remove subscriber ...

    if not self._satellite_subscribers:
        if self._announce_event is not None:
            self._announce_event.set()  # Release pending announce
        if self._question_event is not None:
            self._question_event.set()  # Release pending question
```

## 11. Bridged Pipeline

### 11.1 Architecture

All voice pipeline traffic routes through the integration. The card subscribes to `voice_satellite/run_pipeline`, sends binary audio, and receives pipeline events back through the same WS subscription.

```
Card                          Integration                      HA Pipeline
 │                               │                                │
 │─ ws: run_pipeline ───────────>│                                │
 │<──── result (subscription) ───│                                │
 │<──── event: init (handler_id)─│                                │
 │                               │── async_accept_pipeline ──────>│
 │─ binary audio (handler_id) ──>│── audio_queue ────────────────>│
 │                               │<── on_pipeline_event ──────────│
 │<──── event: run-start ────────│                                │
 │<──── event: wake-word-end ────│                                │
 │<──── event: stt-end ──────────│                                │
 │<──── event: intent-end ───────│                                │
 │<──── event: tts-end ──────────│                                │
 │<──── event: run-end ──────────│                                │
```

### 11.2 `ws_run_pipeline` Handler

The WS handler orchestrates the pipeline lifecycle:

1. **Stop old pipeline**: If an existing pipeline is running, send empty bytes to its audio queue (stop signal), wait up to 3s for natural exit, force-cancel on timeout
2. **Create audio queue**: `asyncio.Queue[bytes]` for incoming audio frames
3. **Register binary handler**: `connection.async_register_binary_handler(_on_binary)` → receives `handler_id`
4. **Send subscription result**: `connection.send_result(msg["id"])` resolves the card's JS promise
5. **Send init event**: `connection.send_event(msg["id"], {"type": "init", "handler_id": handler_id})` tells the card which handler ID to prefix on binary audio frames
6. **Create background task**: `hass.async_create_background_task(entity.async_run_pipeline(...))` — must be a background task so wake word detection doesn't block HA startup
7. **Register unsubscribe callback**: Sends stop signal and unregisters the binary handler

### 11.3 Pipeline Stop Protocol (Critical)

Stopping a running pipeline is a two-phase process:

```python
# Phase 1: Send stop signal (empty bytes)
entity._pipeline_audio_queue.put_nowait(b"")

# Phase 2: Wait for natural exit, force-cancel on timeout
old_task = entity._pipeline_task
if old_task and not old_task.done():
    done, _ = await asyncio.wait({old_task}, timeout=3.0)
    if not done:
        old_task.cancel()
```

**Why not just cancel?** HA's internal pipeline tasks (wake word, STT) `await audio_queue.get()` in a loop. If we cancel the task, `CancelledError` and the stop signal race on `await audio_queue.get()`. `CancelledError` always wins (asyncio cancellation is immediate), leaving the internal HA tasks as orphans that never clean up. Sending the stop signal first lets the audio stream generator (`async def audio_stream()`) yield nothing and exit, causing the HA pipeline to finish naturally.

### 11.4 `async_run_pipeline` Method

```python
async def async_run_pipeline(self, audio_queue, connection, msg_id,
                              start_stage, end_stage,
                              conversation_id=None, extra_system_prompt=None):
    self._pipeline_gen += 1
    my_gen = self._pipeline_gen
    self._pipeline_connection = connection
    self._pipeline_msg_id = msg_id
    self._pipeline_audio_queue = audio_queue
    self._pipeline_run_started = False

    if conversation_id:
        self._conversation_id = conversation_id
    if extra_system_prompt:
        self._extra_system_prompt = extra_system_prompt

    async def audio_stream():
        while True:
            chunk = await audio_queue.get()
            if not chunk:  # empty bytes = stop
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

### 11.5 Generation Counter

`_pipeline_gen` is incremented at the start of each pipeline run. The `finally` block only clears pipeline state if `self._pipeline_gen == my_gen` — a newer run may have already claimed these fields. Without this guard, a new pipeline's connection/queue references would be cleared by the old pipeline's `finally` block.

### 11.6 Base Class Integration

- `self._conversation_id` — Set on the base class to enable continue conversation support
- `self._extra_system_prompt` — Set right before the pipeline call so `async_accept_pipeline_from_satellite` picks it up (avoids race conditions with intermediate restarts)
- `self.pipeline_entity_id` / `self.vad_sensitivity_entity_id` — Properties that resolve the select entities via the entity registry (§4.5)

### 11.7 Stale Event Filtering (`on_pipeline_event`)

```python
@callback
def on_pipeline_event(self, event):
    event_type_str = str(getattr(event, "type", str(event)))

    if event_type_str == "run-start":
        self._pipeline_run_started = True
    elif not self._pipeline_run_started:
        return  # Filter stale pre-run-start events

    if self._pipeline_connection and self._pipeline_msg_id:
        self._pipeline_connection.send_event(self._pipeline_msg_id, {
            "type": event_type_str,
            "data": getattr(event, "data", None) or {},
        })
```

**Why filter stale events?** When a pipeline is restarted (old task cancelled, new one started), HA's internal pipeline tasks from the old run may still fire events through the shared `on_pipeline_event` callback. `_pipeline_run_started` is reset to `False` at the start of each new run, so events from the old run (which arrive before the new `run-start`) are silently dropped.

### 11.8 Audio Stream Protocol

Binary audio frames are prefixed with a 1-byte handler ID by the card:

```
[handler_id: 1 byte][PCM audio data: Int16Array]
```

HA's binary handler system routes the frame to the correct handler based on the first byte, then passes the remaining data to the `_on_binary` callback which enqueues it.

## 12. Select Entities (`select.py`)

### 12.1 Platform Setup

Four select entities are created per config entry:

```python
entities = [
    VoiceSatellitePipelineSelect(hass, entry),
    VoiceSatelliteVadSensitivitySelect(hass, entry),
    VoiceSatelliteScreensaverSelect(hass, entry),
    VoiceSatelliteTTSOutputSelect(hass, entry),
]
```

After creation, stale select entities from older integration versions are cleaned up by comparing expected unique IDs against the entity registry.

### 12.2 Pipeline Select

`VoiceSatellitePipelineSelect` extends `AssistPipelineSelect` from `homeassistant.components.assist_pipeline`. This framework entity:

- Lists all configured Assist pipelines as options
- Stores the selected pipeline for the device
- Registers the device in `pipeline_devices` so it appears in Voice Assistants settings

Constructor: `super().__init__(hass, DOMAIN, entry.entry_id)` — **3 arguments** (hass, domain, config_entry_id).

The entity uses `_attr_has_entity_name = True` and inherits its name from the translation key in `strings.json` ("Assistant").

### 12.3 VAD Sensitivity Select

`VoiceSatelliteVadSensitivitySelect` extends `VadSensitivitySelect` from `homeassistant.components.assist_pipeline`. This framework entity:

- Lists VAD sensitivity options (Default, Relaxed, Aggressive)
- Controls the finished speaking detection threshold for STT

Constructor: `super().__init__(hass, entry.entry_id)` — **2 arguments** (hass, config_entry_id). **No domain parameter** — unlike `AssistPipelineSelect`, this base class doesn't take a domain.

**Gotcha — Constructor signature mismatch:** Getting the argument count wrong causes a crash. `AssistPipelineSelect` takes 3 args (hass, DOMAIN, entry_id), `VadSensitivitySelect` takes 2 args (hass, entry_id). This difference comes from the HA framework, not our code.

### 12.4 Screensaver Select

`VoiceSatelliteScreensaverSelect` extends `SelectEntity` + `RestoreEntity`. This custom select lets the user choose a switch or input_boolean entity to keep turned off during voice interactions (preventing screensavers from activating while the satellite is in use).

**Implementation details:**

- Scans all `switch.*` and `input_boolean.*` entities (excluding the integration's own entities)
- Displays friendly names in the dropdown but stores `entity_id` internally
- Exposes `entity_id` via `extra_state_attributes` for service call lookups
- Uses a 30-second mapping cache (`_build_mapping`) to avoid rebuilding on every options request
- Cache is disabled during HA startup (entities still loading)
- "Disabled" is always the first option
- Restores previous selection on startup via `RestoreEntity`
- `EntityCategory.CONFIG` — appears in the device's configuration section

**Name collision handling:** If two entities share the same friendly name, the duplicate gets `(entity_id)` appended.

### 12.5 TTS Output Select

`VoiceSatelliteTTSOutputSelect` extends `SelectEntity` + `RestoreEntity`. This custom select lets the user route TTS audio to an external media player instead of the browser's Web Audio API.

**Implementation details:**

- Scans all `media_player.*` entities (excluding the integration's own media player entity)
- Displays friendly names in the dropdown but stores `entity_id` internally
- Exposes `entity_id` via `extra_state_attributes` for the card to read
- Uses a 30-second mapping cache (`_build_mapping`) identical to the screensaver select pattern
- Cache is disabled during HA startup (entities still loading)
- "Browser" is always the first option (default — card plays audio locally via Web Audio)
- Restores previous selection on startup via `RestoreEntity`
- `EntityCategory.CONFIG` — appears in the device's configuration section
- `translation_key = "tts_output"`

The satellite entity reads this select's state in `extra_state_attributes` (§4.4) and exposes it as `tts_target`. When set to "Browser" or not configured, `tts_target` is `""`. Otherwise it contains the selected media_player's `entity_id`.

**Name collision handling:** Same as screensaver — duplicate friendly names get `(entity_id)` appended.

### 12.6 Unique ID Format (Critical Gotcha)

The entities use **inconsistent separators** in their unique IDs. This is NOT a bug — the framework-inherited selects generate their own unique IDs internally using dashes, while our custom entities use underscores:

| Entity | Unique ID Format | Separator | Source |
|--------|-----------------|-----------|--------|
| Pipeline select | `{entry_id}-pipeline` | **dash** | Generated by `AssistPipelineSelect` base class |
| VAD sensitivity select | `{entry_id}-vad_sensitivity` | **dash** | Generated by `VadSensitivitySelect` base class |
| Screensaver select | `{entry_id}_screensaver` | **underscore** | Set explicitly in our code |
| TTS output select | `{entry_id}_tts_output` | **underscore** | Set explicitly in our code |
| Wake sound switch | `{entry_id}_wake_sound` | **underscore** | Set explicitly in our code |
| Mute switch | `{entry_id}_mute` | **underscore** | Set explicitly in our code |
| Announcement duration | `{entry_id}_announcement_display_duration` | **underscore** | Set explicitly in our code |

The satellite entity's `pipeline_entity_id` and `vad_sensitivity_entity_id` properties (§4.5) use **dashes** to match the framework format. All custom entities (`_get_screensaver_entity_id`, TTS output, announcement duration) use **underscores**. Getting the separator wrong breaks entity registry lookups silently (returns `None`).

### 12.7 Stale Entity Cleanup

After creating entities, `async_setup_entry` cleans up stale select entities from older integration versions:

```python
expected_uids = {e.unique_id for e in entities}
registry = er.async_get(hass)
for reg_entry in er.async_entries_for_config_entry(registry, entry.entry_id):
    if reg_entry.domain == "select" and reg_entry.unique_id not in expected_uids:
        registry.async_remove(reg_entry.entity_id)
```

This is needed because older versions may have used different unique_id patterns or had different entity sets. Without cleanup, updating the integration would leave orphaned entities in the registry.

## 13. Switch Entities (`switch.py`)

### 13.1 Wake Sound Switch

`VoiceSatelliteWakeSoundSwitch` — controls whether the card plays a chime when the wake word is detected.

- Default: **on** (chime enabled)
- `EntityCategory.CONFIG`
- `RestoreEntity` — restores previous state on HA restart
- The card reads this value from `extra_state_attributes.wake_sound` on the satellite entity

### 13.2 Mute Switch

`VoiceSatelliteMuteSwitch` — mutes/unmutes the satellite microphone.

- Default: **off** (not muted)
- `EntityCategory.CONFIG`
- `RestoreEntity`
- The card reads this value from `extra_state_attributes.muted` on the satellite entity
- When muted, the card's pipeline manager polls this attribute and blocks pipeline starts

### 13.3 Switch → Satellite Attribute Propagation

When a switch changes state, the satellite entity must re-evaluate `extra_state_attributes` so the card sees the updated `muted`/`wake_sound` values. This is handled by `async_track_state_change_event` registered in `async_added_to_hass`:

```python
# When mute or wake_sound switch changes → re-write satellite state
self.async_on_remove(
    async_track_state_change_event(self.hass, switch_eids, self._on_switch_state_change)
)

@callback
def _on_switch_state_change(self, _event):
    self.async_write_ha_state()
```

## 13A. Number Entity (`number.py`)

### 13A.1 Announcement Display Duration

`VoiceSatelliteAnnouncementDurationNumber` extends `NumberEntity` + `RestoreEntity`. This config entity controls how long announcement bubbles remain visible on the card.

**Attributes:**

| Attribute | Value |
|-----------|-------|
| `_attr_entity_category` | `EntityCategory.CONFIG` |
| `_attr_translation_key` | `"announcement_display_duration"` |
| `_attr_icon` | `"mdi:message-text-clock"` |
| `_attr_native_min_value` | `1` |
| `_attr_native_max_value` | `60` |
| `_attr_native_step` | `1` |
| `_attr_native_unit_of_measurement` | `UnitOfTime.SECONDS` |
| `_attr_mode` | `NumberMode.SLIDER` |
| Default value | `5` seconds |

**Unique ID:** `f"{entry.entry_id}_announcement_display_duration"`

**State persistence:** Extends `RestoreEntity` and restores the previous value on startup via `async_get_last_state()`. Invalid states (`unknown`, `unavailable`) are ignored.

**How the card reads it:** The satellite entity's `extra_state_attributes` (§4.4) looks up this number entity via the entity registry and exposes its value as `announcement_display_duration`. The card reads this attribute and uses it for announcement bubble display timing.

## 13B. Media Player Entity (`media_player.py`)

### 13B.1 Overview

`VoiceSatelliteMediaPlayer` extends `MediaPlayerEntity` and provides a media player entity for each satellite device. This enables volume control, `tts.speak` targeting, `media_player.play_media` from automations, and media library browsing — matching the Voice PE's media player capabilities.

### 13B.2 Features & State

```python
_attr_supported_features = (
    MediaPlayerEntityFeature.PLAY_MEDIA
    | MediaPlayerEntityFeature.PLAY
    | MediaPlayerEntityFeature.PAUSE
    | MediaPlayerEntityFeature.STOP
    | MediaPlayerEntityFeature.VOLUME_SET
    | MediaPlayerEntityFeature.VOLUME_MUTE
    | MediaPlayerEntityFeature.BROWSE_MEDIA
    | MediaPlayerEntityFeature.MEDIA_ANNOUNCE
)
```

States: `MediaPlayerState.IDLE`, `PLAYING`, `PAUSED`.

Volume: `_attr_volume_level` (0–1 float, default 1.0), `_attr_is_volume_muted` (bool, default False).

### 13B.2.1 Volume Persistence via `ExtraStoredData`

The entity extends `RestoreEntity` and uses `ExtraStoredData` to persist volume and mute state across HA reboots.

**Why not `async_get_last_state().attributes`?** During HA shutdown, the WebSocket connection drops before `RestoreEntity` saves state. This makes the entity go unavailable, and HA saves the state as `"unavailable"` with empty attributes — losing the volume level. `ExtraStoredData` is stored independently of entity state, using a separate storage mechanism that reads from the Python object's properties rather than the HA state machine.

**Implementation:**

```python
class MediaPlayerExtraData(ExtraStoredData):
    def __init__(self, volume_level: float, is_volume_muted: bool):
        self.volume_level = volume_level
        self.is_volume_muted = is_volume_muted

    def as_dict(self) -> dict:
        return {"volume_level": self.volume_level, "is_volume_muted": self.is_volume_muted}

    @classmethod
    def from_dict(cls, data: dict) -> MediaPlayerExtraData:
        return cls(volume_level=data.get("volume_level", 1.0),
                   is_volume_muted=data.get("is_volume_muted", False))
```

The entity provides `extra_restore_state_data` (read at save time from the entity's Python attributes) and restores via `async_get_last_extra_data()` in `async_added_to_hass`:

```python
@property
def extra_restore_state_data(self) -> MediaPlayerExtraData:
    return MediaPlayerExtraData(self._attr_volume_level, self._attr_is_volume_muted)

async def async_added_to_hass(self):
    await super().async_added_to_hass()
    extra_data = await self.async_get_last_extra_data()
    if extra_data:
        data = MediaPlayerExtraData.from_dict(extra_data.as_dict())
        self._attr_volume_level = data.volume_level
        self._attr_is_volume_muted = data.is_volume_muted
```

### 13B.3 Service Methods

All methods push commands to the card via the satellite entity's `_push_satellite_event("media_player", payload)`:

| Method | Command pushed | Extra fields |
|--------|---------------|-------------|
| `async_play_media(media_type, media_id, **kwargs)` | `play` | `media_id`, `media_type`, `announce`, `volume` |
| `async_media_pause()` | `pause` | — |
| `async_media_play()` | `resume` | — |
| `async_media_stop()` | `stop` | — |
| `async_set_volume_level(volume)` | `volume_set` | `volume` |
| `async_mute_volume(mute)` | `volume_mute` | `mute` |

**Media source resolution:** `async_play_media` resolves `media-source://` URIs to playable paths using `async_resolve_media()` from `homeassistant.components.media_source`. This handles local media, TTS proxy URLs, and other HA media sources.

**Announce flag:** When `kwargs[ATTR_MEDIA_ANNOUNCE]` is true, the command includes `announce: true`.

### 13B.4 Media Library Browsing

`async_browse_media()` delegates to `async_browse_media()` from `homeassistant.components.media_source` to provide the HA media library browser. This allows users to browse local media, TTS samples, etc. from the media player's UI.

### 13B.5 State Callback

`update_playback_state(state, volume=None, media_id=None)` is called by the `ws_media_player_event` WS handler when the card reports state changes:

```python
@callback
def update_playback_state(self, state, volume=None, media_id=None):
    self._state = STATE_MAP.get(state, MediaPlayerState.IDLE)
    if volume is not None:
        self._volume_level = volume
    if media_id:
        self._media_id = media_id
    self.async_write_ha_state()
```

### 13B.6 Satellite Entity Lookup

The media player uses a lazy-lookup pattern to find the satellite entity for pushing commands:

```python
def _get_satellite(self):
    return self.hass.data.get(DOMAIN, {}).get(self._entry.entry_id)
```

If no satellite entity is found (not yet loaded, or disconnected), the method logs a warning and returns without pushing the command.

This same lookup is used for the `available` property — the media player delegates availability to the satellite entity:

```python
@property
def available(self) -> bool:
    satellite = self._get_satellite_entity()
    return satellite.available if satellite else False
```

### 13B.7 Entity Registration

- **Unique ID:** `f"{entry.entry_id}_media_player"`
- **Translation key:** `_attr_translation_key = "media_player"`
- **Device:** Same `device_info` identifiers as other entities (`(DOMAIN, entry.entry_id)`)
- **Storage:** `hass.data[DOMAIN][f"{entry.entry_id}_media_player"]` for WS handler lookup

## 14. Screensaver Keep-Alive System

### 14.1 Purpose

Prevents screensaver entities (e.g., a switch controlling display dimming) from activating while the satellite is in use. The system periodically calls `homeassistant.turn_off` on the configured screensaver entity.

### 14.2 Start/Stop

- **Start:** Called by `set_pipeline_state` (non-idle), `async_announce`, `async_start_conversation`, `async_internal_ask_question`
- **Stop:** Called by `set_pipeline_state` (idle), and conditionally in `finally` blocks of announcement methods (only if entity is idle)

```python
@callback
def _start_screensaver_keepalive(self):
    entity_id = self._get_screensaver_entity_id()
    if not entity_id or self._screensaver_unsub is not None:
        return  # No screensaver configured or already running

    # Turn off immediately
    self.hass.async_create_task(
        self.hass.services.async_call("homeassistant", "turn_off", {"entity_id": entity_id})
    )

    # Set up periodic keep-alive
    self._screensaver_unsub = async_track_time_interval(
        self.hass, _tick, timedelta(seconds=SCREENSAVER_INTERVAL),
    )
```

`SCREENSAVER_INTERVAL = 5` seconds.

### 14.3 Screensaver Entity Resolution

`_get_screensaver_entity_id()` looks up the screensaver select entity via the entity registry, reads its state, and extracts the `entity_id` attribute. Returns `None` if the select is set to "Disabled".

## 15. WebSocket Commands

All 7 WebSocket commands follow the same patterns:
- Decorated with `@websocket_api.websocket_command(schema)` and `@websocket_api.async_response`
- Entity lookup iterates `hass.data[DOMAIN]` by `entity_id`
- Returns error if entity not found
- Registration wrapped in try/except for idempotency

### 15.1 `voice_satellite/announce_finished`

**Direction:** Card → Integration

| Field | Type | Description |
|---|---|---|
| `entity_id` | `str` | Satellite entity ID |
| `announce_id` | `int` | Must match the ID from the announcement event |

**Response:** `{"success": true}`

### 15.2 `voice_satellite/update_state`

**Direction:** Card → Integration

| Field | Type | Description |
|---|---|---|
| `entity_id` | `str` | Satellite entity ID |
| `state` | `str` | Card state string: `IDLE`, `LISTENING`, `STT`, etc. |

**Response:** `{"success": true}`

### 15.3 `voice_satellite/question_answered`

**Direction:** Card → Integration

| Field | Type | Description |
|---|---|---|
| `entity_id` | `str` | Satellite entity ID |
| `announce_id` | `int` | Must match the current announcement ID |
| `sentence` | `str` | Transcribed text from STT |

**Response:** `{"success": true, "matched": bool, "id": string|null}`

The handler coordinates with the entity's hassil matching via `_question_match_event` (see §8.6).

### 15.4 `voice_satellite/run_pipeline`

**Direction:** Card → Integration (subscription)

| Field | Type | Description |
|---|---|---|
| `entity_id` | `str` | Satellite entity ID |
| `start_stage` | `str` | Pipeline start stage: `wake_word`, `stt`, `intent`, `tts` |
| `end_stage` | `str` | Pipeline end stage: `wake_word`, `stt`, `intent`, `tts` |
| `sample_rate` | `int` | Audio sample rate (e.g., 16000) |
| `conversation_id` | `str?` | Optional conversation ID for continue conversation |
| `extra_system_prompt` | `str?` | Optional custom LLM system prompt |

**Events sent back:**
- `{"type": "init", "handler_id": int}` — synthetic init event with binary handler ID
- `{"type": "run-start", "data": {...}}` — pipeline started
- `{"type": "wake-word-end", "data": {...}}` — wake word detected
- `{"type": "stt-end", "data": {...}}` — speech-to-text complete
- `{"type": "intent-end", "data": {...}}` — intent processing complete
- `{"type": "tts-end", "data": {...}}` — text-to-speech complete
- `{"type": "run-end", "data": {...}}` — pipeline finished
- `{"type": "error", "data": {...}}` — pipeline error

### 15.5 `voice_satellite/subscribe_events`

**Direction:** Card → Integration (subscription)

| Field | Type | Description |
|---|---|---|
| `entity_id` | `str` | Satellite entity ID |

**Events sent back:**
- `{"type": "announcement", "data": {...}}` — play announcement
- `{"type": "start_conversation", "data": {...}}` — play prompt, then listen
- `{"type": "media_player", "data": {...}}` — media player command (play, pause, stop, volume, etc.)

The subscription remains active until the card disconnects or explicitly unsubscribes.

### 15.6 `voice_satellite/cancel_timer`

**Direction:** Card → Integration

| Field | Type | Description |
|---|---|---|
| `entity_id` | `str` | Satellite entity ID |
| `timer_id` | `str` | Timer ID to cancel |

**Response:** `{"success": true}` or error if timer manager unavailable or cancel fails.

Uses `TimerManager.cancel_timer(timer_id)` from `homeassistant.components.intent`. Imports are lazy (at call time) to avoid circular imports.

### 15.7 `voice_satellite/media_player_event`

**Direction:** Card → Integration

| Field | Type | Description |
|---|---|---|
| `entity_id` | `str` | Media player entity ID |
| `state` | `str` | Playback state: `"playing"`, `"paused"`, `"idle"` |
| `volume` | `float?` | Optional current volume level (0–1) |
| `media_id` | `str?` | Optional current media ID |

**Response:** `{"success": true}`

The handler looks up the media player entity via `hass.data[DOMAIN]` (checking for `update_playback_state` attribute) and calls `entity.update_playback_state(state, volume, media_id)`.

**Volume validation:** Uses `vol.Coerce(float)` instead of `float` for the volume field because JSON has no float type — JavaScript may send `1` (integer) instead of `1.0`.

## 16. Known Gotchas & Non-Obvious Traps

### 16.1 `_question_match_result` Must Survive the `finally` Block

After `_question_match_event.set()`, both the WS handler (awaiting the event) and the `finally` block of `async_internal_ask_question` are ready to run. The asyncio scheduler may run `finally` first, clearing `_question_match_result` before the WS handler reads it. Solution: `_question_match_result` is intentionally NOT cleared in `finally`. It's overwritten on the next `ask_question` call.

### 16.2 WS Handler Must Grab `_question_match_event` Before Triggering Answer

The WS handler stores a local reference to `entity._question_match_event` BEFORE calling `entity.question_answered()`. This prevents a race where: `question_answered` → `_question_event.set()` → `async_internal_ask_question` resumes → `finally` clears `_question_match_event` to `None` → WS handler tries to await `None`.

### 16.3 Empty Sentence Handling

When the card sends an empty sentence (STT timeout, no speech), the integration must still signal `_question_match_event` with `matched: False` so the WS handler doesn't hang.

### 16.4 `preannounce` Boolean Is NOT in `AssistSatelliteAnnouncement`

The base class consumes `preannounce` internally to decide whether to resolve a default preannounce URL, but does NOT pass it through to the announcement object. That's why we override `async_internal_announce` and `async_internal_start_conversation` to capture it in `_preannounce_pending`.

### 16.5 `ask_question` Piggybacks on `async_announce`

`async_internal_ask_question` does NOT have its own TTS resolution. It calls `self.async_internal_announce()` which the base class resolves. The `_ask_question_pending` flag tells our `async_announce` override to add `"ask_question": True` to the event data.

### 16.6 Base Class State Manipulation via Name Mangling

`AssistSatelliteEntity` has no public state setter. We use Python name mangling (`self._AssistSatelliteEntity__assist_satellite_state = mapped`) to update the private attribute directly. This is necessary because `hass.states.async_set()` doesn't update the base class's internal state, causing subsequent `async_write_ha_state()` calls to publish a stale value.

### 16.7 `announce_id` Prevents Stale ACKs

All announcement types (announce, start_conversation, ask_question) share the same monotonically increasing `_announce_id`. If a previous announcement times out and the card sends a late ACK, the `announce_id` check silently ignores it.

### 16.8 `device_entry` Not Available in `__init__`

`self.device_entry` is only populated after `async_added_to_hass()`. Timer handler registration must happen there, not in the constructor.

### 16.9 Immutable Timer Lists

Timer list mutations must create new lists (see §5.3). In-place mutation makes HA suppress `state_changed` events because old and new attribute references point to the same object.

### 16.10 Pipeline Stop Protocol — Cancel vs Stop Signal

Never `cancel()` a pipeline task without first sending the empty-bytes stop signal and waiting for natural exit. `CancelledError` races with `await audio_queue.get()` and leaves orphaned HA internal pipeline tasks. See §11.3.

### 16.11 Generation Counter Prevents Cross-Run Cleanup

Without `_pipeline_gen`, a new pipeline run's connection/queue fields would be cleared by the old run's `finally` block. The generation counter ensures only the current run clears its own state. See §11.5.

### 16.12 Stale Pipeline Events from Orphaned HA Tasks

HA's internal pipeline tasks (wake word, STT) may continue running briefly after cancellation and fire events through the shared `on_pipeline_event` callback. `_pipeline_run_started` gates event forwarding so stale events from old runs are dropped. See §11.7.

### 16.13 Screensaver Keep-Alive Conditional Stop

The `finally` blocks of `async_announce` and `async_start_conversation` only stop the screensaver keepalive if the entity state is idle. This prevents premature stop when `start_conversation` sets state to `listening` after the ACK — the keepalive should continue until the voice interaction completes.

### 16.14 Ask Question Re-Starts Keepalive for Phase 2

`async_announce`'s `finally` block may stop the screensaver keepalive (if entity is idle between phases). `async_internal_ask_question` calls `_start_screensaver_keepalive()` again before entering Phase 2 (STT capture).

### 16.15 Unsubscribe Releases Blocking Events

When the last satellite subscriber disconnects, pending `async_announce` and `async_internal_ask_question` calls are unblocked by setting their events. Without this, the entity would wait the full `ANNOUNCE_TIMEOUT` (120s) for a card that's already gone.

### 16.16 Cross-Repo Version Bumping

The integration version appears in two places: `manifest.json` (`version`) and `assist_satellite.py` (`sw_version` in `device_info`). Both must be updated together. The card version is in `package.json` only.

### 16.17 No `homeassistant` Key in `manifest.json`

HACS validation rejects it for custom integrations. Use `hacs.json` for the minimum HA version instead.

### 16.18 Background Task for Pipeline

Pipeline runs use `hass.async_create_background_task()`, not `hass.async_create_task()`. Pipeline tasks are long-running (wake word detection can block indefinitely). If created as a normal task, they would prevent HA from completing startup.

### 16.19 `extra_system_prompt` Is NOT in `AssistSatelliteAnnouncement`

Similar to `preannounce`, the `extra_system_prompt` parameter is consumed by the base class's `async_internal_start_conversation` but not passed to the announcement object. We override `async_internal_start_conversation` to capture it in `_pending_extra_system_prompt` before delegating.

### 16.20 Two State-Setting Patterns Coexist

The entity uses two different mechanisms to update state, each for a different scenario:

1. **Name mangling** (`self._AssistSatelliteEntity__assist_satellite_state = mapped` + `async_write_ha_state()`) — Used in `set_pipeline_state()` for continuous external state sync from the card. Keeps the base class internal state consistent so that any subsequent `async_write_ha_state()` call (e.g., from a switch change) publishes the correct state.

2. **Direct `hass.states.async_set()`** — Used in `async_start_conversation` (after ACK) and `async_internal_ask_question` (before Phase 2) to immediately set state to `listening`. These are one-shot state transitions during async operations where the base class state will be overwritten shortly by the card's pipeline state sync anyway.

**Rule:** Use name mangling for state that must persist across multiple `async_write_ha_state()` calls. Use `async_set` for transient state transitions during async flows.

### 16.21 Unique ID Separator Mismatch Between Framework and Custom Entities

Framework-inherited select entities use **dashes** in their unique IDs while custom entities use **underscores** (see §12.5). Entity registry lookups in the satellite entity (`pipeline_entity_id`, `vad_sensitivity_entity_id`, `_get_screensaver_entity_id`) must use the correct separator for each. Getting this wrong returns `None` silently.

### 16.22 JSON Integer/Float Ambiguity in WS Volume

JSON has no distinct float type — `1` and `1.0` are identical. When JavaScript sends volume `1` (integer), Python receives `int(1)`, which fails Voluptuous `float` validation. The `media_player_event` WS schema uses `vol.Coerce(float)` instead of `float` to handle this.

### 16.23 Media Player Entity Lookup in WS Handler

The `ws_media_player_event` handler iterates `hass.data[DOMAIN]` and uses `hasattr(ent, 'update_playback_state')` to identify media player entities (as opposed to satellite entities). This avoids needing a separate lookup dict and works because only `VoiceSatelliteMediaPlayer` has this method.

### 16.24 Media Player Volume Requires `ExtraStoredData`, Not `RestoreEntity` Attributes

During HA shutdown, the WebSocket connection drops before `RestoreEntity` saves final state. The entity becomes unavailable, and HA persists `"unavailable"` state with empty attributes — losing volume/mute data. `ExtraStoredData` stores volume and mute state independently via `extra_restore_state_data` (reads from Python attributes, not the HA state machine), so the values survive regardless of availability state at shutdown time. See §13A.2.1.

### 16.25 Availability Is Driven by `subscribe_events`, Not `run_pipeline`

The entity's `available` property checks `_satellite_subscribers` (from `subscribe_events`), not the `run_pipeline` connection. The `subscribe_events` subscription is the persistent control channel maintained for the card's entire lifetime, while `run_pipeline` is transient and recreated on each wake word cycle. Using the pipeline connection would cause rapid available/unavailable flapping between pipeline runs.

### 16.26 Media Player Availability Propagation

When the satellite's subscriber list changes, `_update_media_player_availability()` directly calls `async_write_ha_state()` on the media player entity. Without this, the media player would only re-evaluate its `available` property on its next state write, leaving it stale (showing available when the satellite is actually unavailable).

## 17. HA API Dependencies

### 17.1 `assist_satellite` Component

- `AssistSatelliteEntity` — Base class for satellite entities
- `AssistSatelliteEntityFeature.ANNOUNCE` — Feature flag for `assist_satellite.announce`
- `AssistSatelliteEntityFeature.START_CONVERSATION` — Feature flag for `assist_satellite.start_conversation`
- `AssistSatelliteConfiguration` — Returned by `async_get_configuration()` (wake word config)
- `AssistSatelliteAnnouncement` — Passed to `async_announce()`/`async_start_conversation()` with `.message`, `.media_id`, optionally `.preannounce_media_id`
- `AssistSatelliteAnswer` (HA 2025.7+) — Returned by `async_internal_ask_question()` with `.id`, `.sentence`, `.slots`
- `AssistPipelineSelect` — Base class for pipeline select entity
- `VadSensitivitySelect` — Base class for VAD sensitivity select entity

### 17.2 `assist_pipeline` Component

- `PipelineStage` — Enum: `WAKE_WORD`, `STT`, `INTENT`, `TTS`

### 17.3 `hassil` (bundled with HA)

- `hassil.intents.Intents` — Sentence template collection
- `hassil.recognize.recognize(sentence, intents)` — Sentence matching
- Conditionally imported (`HAS_HASSIL` flag)

### 17.4 `intent` Component

- `intent.async_register_timer_handler(hass, device_id, callback)` — Registers timer handler. Returns unregister callback
- `intent.TimerEventType` — Enum: `STARTED`, `UPDATED`, `CANCELLED`, `FINISHED`
- `intent.TimerInfo` — `.id`, `.name`, `.start_hours`, `.start_minutes`, `.start_seconds`
- `TimerManager.cancel_timer(timer_id)` — Cancel a specific timer (lazy import)

### 17.5 `websocket_api`

- `websocket_api.async_register_command(hass, handler)` — Register WS command
- `connection.send_result(msg_id, data)` — Success response
- `connection.send_error(msg_id, code, message)` — Error response
- `connection.send_event(msg_id, data)` — Push subscription event
- `connection.async_register_binary_handler(callback)` — Register binary audio handler, returns `(handler_id, unregister)`
- `connection.subscriptions[msg_id] = unsub` — Register unsubscribe callback

### 17.6 `media_player` / `media_source` Components

- `MediaPlayerEntity` — Base class for media player entities
- `MediaPlayerEntityFeature` — Feature flags (PLAY_MEDIA, PLAY, PAUSE, STOP, VOLUME_SET, VOLUME_MUTE, BROWSE_MEDIA, MEDIA_ANNOUNCE)
- `MediaPlayerState` — State enum (IDLE, PLAYING, PAUSED)
- `MediaType` — Media type constants
- `async_resolve_media(hass, media_content_id, entity_id)` — Resolve `media-source://` URIs to playable paths
- `async_browse_media(hass, media_content_type, media_content_id)` — Browse HA media library
- `BrowseMedia` — Media browsing response object

### 17.7 Event Helpers

- `async_track_state_change_event(hass, entity_ids, callback)` — Track state changes for switch → satellite propagation
- `async_track_time_interval(hass, callback, interval)` — Periodic screensaver keep-alive

## 18. Card Interface Contract

### 18.1 Card → Integration (WebSocket)

| Command | Payload | Purpose |
|---|---|---|
| `voice_satellite/run_pipeline` | `{entity_id, start_stage, end_stage, sample_rate, conversation_id?, extra_system_prompt?}` | Start bridged pipeline |
| `voice_satellite/subscribe_events` | `{entity_id}` | Subscribe to notification events |
| `voice_satellite/announce_finished` | `{entity_id, announce_id}` | ACK announcement playback |
| `voice_satellite/update_state` | `{entity_id, state}` | Sync pipeline state |
| `voice_satellite/question_answered` | `{entity_id, announce_id, sentence}` | Send ask_question STT result |
| `voice_satellite/cancel_timer` | `{entity_id, timer_id}` | Cancel a timer |
| `voice_satellite/media_player_event` | `{entity_id, state, volume?, media_id?}` | Report media player playback state |
| Binary frames | `[handler_id][PCM data]` | Audio for pipeline |

### 18.2 Integration → Card (WS Events)

| Event Type | Data | Channel |
|---|---|---|
| `init` | `{handler_id}` | `run_pipeline` subscription |
| `run-start` | `{...}` | `run_pipeline` subscription |
| `wake-word-end` | `{...}` | `run_pipeline` subscription |
| `stt-end` | `{...}` | `run_pipeline` subscription |
| `intent-end` | `{...}` | `run_pipeline` subscription |
| `tts-end` | `{...}` | `run_pipeline` subscription |
| `run-end` | `{...}` | `run_pipeline` subscription |
| `error` | `{...}` | `run_pipeline` subscription |
| `announcement` | `{id, message, media_id, preannounce_media_id, preannounce?, ask_question?}` | `subscribe_events` subscription |
| `start_conversation` | `{id, message, media_id, preannounce_media_id, start_conversation, preannounce?, extra_system_prompt?}` | `subscribe_events` subscription |
| `media_player` | `{command, media_id?, volume?, mute?, ...}` | `subscribe_events` subscription |

### 18.3 Integration → Card (Entity Attributes)

| Attribute | Type | Description |
|---|---|---|
| `active_timers` | `list[dict]` | Active timers with countdown data |
| `last_timer_event` | `string \| null` | Last event type |
| `muted` | `bool` | Whether mute switch is on |
| `wake_sound` | `bool` | Whether wake sound switch is on |
| `tts_target` | `string` | Media player entity ID for remote TTS, or `""` for browser |
| `announcement_display_duration` | `int` | Seconds to display announcement bubbles |

## 19. Strings and Localization (`strings.json`)

HA uses this file for config flow UI and entity names:

- Config flow: title, description, input labels, description text, abort messages
- Entity names: Translation keys for select entities ("Assistant", "Finished speaking detection", "Screensaver entity", "TTS output"), switch entities ("Wake sound", "Mute"), number entities ("Announcement display duration"), and media player entity ("Media Player")
- Select states: Translation keys for pipeline select ("Preferred") and VAD sensitivity ("Default", "Relaxed", "Aggressive")

A `translations/en.json` file mirrors the contents of `strings.json` for English locale support.

## 20. Configuration Files

### 20.1 `manifest.json`

```json
{
    "domain": "voice_satellite",
    "name": "Voice Satellite Card Integration",
    "codeowners": ["@jxlarrea"],
    "config_flow": true,
    "dependencies": ["assist_pipeline", "assist_satellite", "intent"],
    "documentation": "...",
    "iot_class": "local_push",
    "issue_tracker": "...",
    "version": "<version>"
}
```

- `dependencies` — `assist_pipeline` (pipeline selects), `assist_satellite` (entity base class), `intent` (timer handlers). HA loads these before our integration.
- `iot_class: "local_push"` — card pushes state via WebSocket; no polling.
- **No `homeassistant` key** — HACS validation rejects it for custom integrations.

### 20.2 `hacs.json`

```json
{
    "name": "Voice Satellite Card Integration",
    "homeassistant": "2025.1.2",
    "render_readme": true
}
```

### 20.3 `const.py`

```python
DOMAIN = "voice_satellite"
SCREENSAVER_INTERVAL = 5  # seconds
```

---

## 21. Implementation Checklist

### Config Flow
- [ ] Single-step flow asking for satellite name
- [ ] Unique ID from lowercased, underscore-separated name
- [ ] Duplicate detection via `_abort_if_unique_id_configured()`
- [ ] `strings.json` with config flow strings and entity name translations (mirrored in `translations/en.json`)

### Entity
- [ ] Extends `AssistSatelliteEntity`
- [ ] `_attr_supported_features = ANNOUNCE | START_CONVERSATION`
- [ ] `_attr_has_entity_name = True`, `_attr_name = None`
- [ ] `_attr_unique_id = entry.entry_id`
- [ ] `device_info` with identifiers, name, manufacturer, model, sw_version
- [ ] `extra_state_attributes`: `active_timers`, `last_timer_event`, `muted`, `wake_sound`, `tts_target`, `announcement_display_duration`
- [ ] `pipeline_entity_id` and `vad_sensitivity_entity_id` properties
- [ ] Timer handler registered in `async_added_to_hass` via `intent.async_register_timer_handler`
- [ ] Timer handler wrapped in `async_on_remove()`
- [ ] Sibling entity state tracking (switches, TTS output select, announcement duration number) via `async_track_state_change_event`
- [ ] `available` property returns `True` only when `_satellite_subscribers` is non-empty
- [ ] `async_get_configuration` returns empty wake word config
- [ ] `async_set_configuration` is a no-op
- [ ] `async_will_remove_from_hass`: pipeline stop, release blocking events, clear subscribers, stop keepalive

### Timers
- [ ] `_handle_timer_event` handles STARTED, UPDATED, CANCELLED, FINISHED
- [ ] **Immutable list pattern** — new list on every mutation (no in-place append/remove)
- [ ] STARTED appends timer dict with `id`, `name`, `total_seconds`, `started_at`, `start_hours/minutes/seconds`
- [ ] UPDATED creates new list with modified timer
- [ ] CANCELLED/FINISHED creates new filtered list
- [ ] All events set `_last_timer_event` and call `async_write_ha_state()`

### Announcements
- [ ] `async_internal_announce` override captures `preannounce` in `_preannounce_pending`
- [ ] `async_announce` pushes via `_push_satellite_event("announcement", data)` (NOT entity attributes)
- [ ] Monotonic `_announce_id` prevents stale ACKs
- [ ] `"preannounce": false` only when chime should be suppressed
- [ ] `"ask_question": true` when `_ask_question_pending` is set
- [ ] `asyncio.Event` with 120s timeout
- [ ] `finally` resets `_preannounce_pending`, conditionally stops keepalive

### Start Conversation
- [ ] `async_internal_start_conversation` captures `preannounce` and `extra_system_prompt`
- [ ] Pushes via `_push_satellite_event("start_conversation", data)` with `"start_conversation": True`
- [ ] Includes `"extra_system_prompt"` when provided
- [ ] After ACK: sets entity state to `listening` via `hass.states.async_set()`
- [ ] `finally` clears `_pending_extra_system_prompt`, conditionally stops keepalive

### Ask Question
- [ ] `async_internal_ask_question` delegates TTS to `self.async_internal_announce()`
- [ ] `_ask_question_pending` causes `async_announce` to add `ask_question: true`
- [ ] Phase 1 (TTS) → Phase 2 (STT capture) → Phase 3 (hassil matching)
- [ ] Re-starts keepalive between phases (announce's finally may have stopped it)
- [ ] `_question_event` + `_question_answer_text` for card → entity text transfer
- [ ] `_question_match_event` + `_question_match_result` for entity → WS handler result transfer
- [ ] `_question_match_result` intentionally NOT cleared in `finally` (WS handler race)
- [ ] WS handler grabs `_question_match_event` before triggering answer
- [ ] Returns `AssistSatelliteAnswer(id, sentence, slots)` — `id=None` on no match

### Pipeline State Sync
- [ ] `_STATE_MAP` maps all card states to HA satellite states
- [ ] `set_pipeline_state` deduplicates (skips if unchanged)
- [ ] Uses name mangling (`_AssistSatelliteEntity__assist_satellite_state`) for base class state update
- [ ] Drives screensaver keep-alive (non-idle starts, idle stops)

### Bridged Pipeline
- [ ] `ws_run_pipeline`: stop old pipeline → create queue → register binary handler → send init → background task
- [ ] Pipeline stop protocol: empty bytes → wait → force cancel
- [ ] `async_run_pipeline`: generation counter, audio stream generator, `async_accept_pipeline_from_satellite`
- [ ] `on_pipeline_event`: stale event filtering via `_pipeline_run_started` gate
- [ ] Generation counter prevents cross-run `finally` cleanup

### Satellite Event Subscription
- [ ] `ws_subscribe_satellite_events`: register subscriber, send result, unsub callback
- [ ] `register_satellite_subscription` / `unregister_satellite_subscription`
- [ ] `_push_satellite_event`: push to all subscribers, remove dead ones
- [ ] Unsubscribe releases blocking events when no subscribers remain
- [ ] First subscriber triggers `async_write_ha_state()` + `_update_media_player_availability()` (entity → available)
- [ ] Last subscriber removed triggers `async_write_ha_state()` + `_update_media_player_availability()` (entity → unavailable)

### Select Entities
- [ ] Pipeline select (extends `AssistPipelineSelect`) — constructor takes 3 args: `(hass, DOMAIN, entry_id)`
- [ ] VAD sensitivity select (extends `VadSensitivitySelect`) — constructor takes 2 args: `(hass, entry_id)` — **no domain**
- [ ] Screensaver select (extends `SelectEntity` + `RestoreEntity`)
- [ ] Screensaver: entity scanning (switch + input_boolean), friendly name mapping, 30s cache, "Disabled" default
- [ ] TTS output select (extends `SelectEntity` + `RestoreEntity`)
- [ ] TTS output: entity scanning (media_player, excludes own integration), friendly name mapping, 30s cache, "Browser" default
- [ ] TTS output: exposes `entity_id` via `extra_state_attributes` for the card
- [ ] Unique ID separators: framework selects use **dashes**, custom entities use **underscores**
- [ ] Stale entity cleanup after setup

### Number Entity
- [ ] Announcement display duration (extends `NumberEntity` + `RestoreEntity`)
- [ ] `EntityCategory.CONFIG`, `translation_key = "announcement_display_duration"`
- [ ] Range 1–60 seconds, step 1, slider mode, default 5 seconds
- [ ] `RestoreEntity` restores previous value on startup
- [ ] Unique ID: `f"{entry.entry_id}_announcement_display_duration"`
- [ ] Same `device_info` identifiers as other entities

### Switch Entities
- [ ] Wake sound switch (default on, `RestoreEntity`)
- [ ] Mute switch (default off, `RestoreEntity`)
- [ ] Both use `EntityCategory.CONFIG`

### Media Player Entity
- [ ] `VoiceSatelliteMediaPlayer` extends `MediaPlayerEntity` + `RestoreEntity`
- [ ] Supported features: PLAY_MEDIA, PLAY, PAUSE, STOP, VOLUME_SET, VOLUME_MUTE, BROWSE_MEDIA, MEDIA_ANNOUNCE
- [ ] Service methods push commands to card via `_push_satellite_event("media_player", ...)`
- [ ] `async_play_media` resolves `media-source://` URIs via `async_resolve_media()`
- [ ] `async_browse_media` delegates to HA media source browser
- [ ] `update_playback_state` callback for WS handler state updates
- [ ] Unique ID: `f"{entry.entry_id}_media_player"`
- [ ] Stored in `hass.data[DOMAIN][f"{entry.entry_id}_media_player"]`
- [ ] `available` property delegates to satellite entity's `available`
- [ ] Same `device_info` identifiers as other entities
- [ ] Default volume 1.0 (100%), default mute False
- [ ] `ExtraStoredData` (`MediaPlayerExtraData`) persists volume/mute across reboots
- [ ] `extra_restore_state_data` property returns current volume/mute for save
- [ ] `async_added_to_hass` restores volume/mute via `async_get_last_extra_data()`

### Screensaver Keep-Alive
- [ ] `_start_screensaver_keepalive`: immediate turn_off + periodic interval
- [ ] `_stop_screensaver_keepalive`: cancel interval
- [ ] `_get_screensaver_entity_id`: resolve from screensaver select entity
- [ ] Conditional stop in announcement `finally` blocks (only if idle)
- [ ] Re-start in ask_question between phases

### WebSocket Commands
- [ ] 7 commands: announce_finished, update_state, question_answered, run_pipeline, subscribe_events, cancel_timer, media_player_event
- [ ] Entity lookup iterates `hass.data[DOMAIN]` by `entity_id`
- [ ] Registration wrapped in try/except for idempotency
- [ ] `media_player_event` uses `vol.Coerce(float)` for volume field (JSON integer/float ambiguity)

### Integration Setup
- [ ] `async_setup_entry` forwards to ASSIST_SATELLITE + MEDIA_PLAYER + NUMBER + SELECT + SWITCH platforms
- [ ] `async_setup_entry` registers all 7 WebSocket commands
- [ ] `async_unload_entry` unloads platforms and removes entity + media_player from `hass.data`
- [ ] Satellite entity stored in `hass.data[DOMAIN][entry.entry_id]`
- [ ] Media player entity stored in `hass.data[DOMAIN][f"{entry.entry_id}_media_player"]`

### Infrastructure
- [ ] `manifest.json` with 3 dependencies: `assist_pipeline`, `assist_satellite`, `intent`
- [ ] No `homeassistant` key in `manifest.json`
- [ ] `hacs.json` with minimum HA version
- [ ] Integration version in 2 places: `manifest.json`, `assist_satellite.py` (`sw_version`)
