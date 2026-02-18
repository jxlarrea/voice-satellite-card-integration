# Voice Satellite Card Integration — Design Document

Current version: 1.1.0

## 1. Overview

This integration creates virtual Assist Satellite entities in Home Assistant for browsers running the [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant). Without this integration, the browser has no device identity — it uses HA's pipeline API anonymously. This means HA cannot route timers, announcements, or per-device automations to it.

Each config entry creates one `assist_satellite.*` entity backed by a device in the device registry. The entity:

- Registers as a **timer handler** so the LLM gets access to `HassStartTimer`, `HassUpdateTimer`, `HassCancelTimer`
- Implements **`assist_satellite.announce`** so automations can push TTS to specific browsers
- Implements **`assist_satellite.start_conversation`** so automations can speak a prompt and then listen for the user's voice response
- Accepts **pipeline state updates** from the card via WebSocket, reflecting real-time state (`idle`, `listening`, `processing`, `responding`) on the entity
- Exposes **entity attributes** (`active_timers`, `last_timer_event`, `announcement`) that the card reads to render timer pills and announcement bubbles

## 2. Project Structure

```
voice-satellite-card-integration/
├── custom_components/
│   └── voice_satellite/
│       ├── __init__.py          # Integration setup, WebSocket command registration
│       ├── assist_satellite.py  # VoiceSatelliteEntity (the core entity)
│       ├── config_flow.py       # Config flow (user enters a satellite name)
│       ├── const.py             # DOMAIN constant
│       ├── manifest.json        # Integration manifest
│       ├── strings.json         # UI strings for config flow
│       ├── icon.png             # Integration branding (256x256)
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

The integration uses a single-step config flow. The user provides a name (e.g., "Kitchen Tablet"). The flow:

1. Strips whitespace from the name
2. Generates a unique ID by lowercasing and replacing spaces with underscores (`kitchen_tablet`)
3. Calls `self._abort_if_unique_id_configured()` to prevent duplicates
4. Creates a config entry with `data={"name": name}`

The resulting entity ID will be `assist_satellite.<slugified_name>` (e.g., `assist_satellite.kitchen_tablet`).

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

### 3.2 Entry Setup (`__init__.py`)

`async_setup_entry` does two things:

1. **Forward platform setup** — Calls `async_forward_entry_setups(entry, [Platform.ASSIST_SATELLITE])` which triggers `assist_satellite.py:async_setup_entry()`
2. **Register WebSocket commands** — Registers `voice_satellite/announce_finished` and `voice_satellite/update_state`. Uses try/except around registration because multiple config entries share the same WebSocket commands (only the first registration succeeds, subsequent ones raise `ValueError`).

```python
PLATFORMS = [Platform.ASSIST_SATELLITE]

async def async_setup_entry(hass, entry):
    hass.data.setdefault(DOMAIN, {})
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    try:
        websocket_api.async_register_command(hass, ws_announce_finished)
    except ValueError:
        pass  # Already registered from another config entry

    try:
        websocket_api.async_register_command(hass, ws_update_state)
    except ValueError:
        pass
```

### 3.3 Entry Unload

Unloads platforms and removes the entity reference from `hass.data[DOMAIN]`:

```python
async def async_unload_entry(hass, entry):
    result = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if result:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return result
```

### 3.4 Entity Storage

Entities are stored in `hass.data[DOMAIN][entry.entry_id]`. The WebSocket handlers iterate this dict to find entities by `entity_id`. This is necessary because WebSocket commands are global (not per-entity), so the handler must look up the correct entity instance.

## 4. Entity (`assist_satellite.py`)

### 4.1 Class Hierarchy

`VoiceSatelliteEntity` extends `AssistSatelliteEntity` from `homeassistant.components.assist_satellite`. This base class provides:

- Registration as an Assist Satellite device
- The `assist_satellite.announce` action (calls `async_announce`)
- The `assist_satellite.start_conversation` action (calls `async_start_conversation`)
- Pipeline event routing (calls `on_pipeline_event`)
- Wake word configuration (calls `async_get_configuration`)

The entity declares `AssistSatelliteEntityFeature.ANNOUNCE | AssistSatelliteEntityFeature.START_CONVERSATION` as supported features (value 3).

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
        "sw_version": "1.1.0",
    }
```

The `identifiers` tuple uses the config entry ID as the unique key. This means each config entry = one device = one entity.

### 4.3 Entity Naming

- `_attr_has_entity_name = True` — Tells HA the entity uses the device name
- `_attr_name = None` — No additional suffix; the entity name IS the device name
- `_attr_unique_id = entry.entry_id` — Uses the config entry UUID as the unique ID

### 4.4 Extra State Attributes

The entity exposes three attributes for the card to read:

```python
@property
def extra_state_attributes(self):
    attrs = {
        "active_timers": self._active_timers,
        "last_timer_event": self._last_timer_event,
    }
    if self._pending_announcement is not None:
        attrs["announcement"] = self._pending_announcement
    return attrs
```

- `active_timers` — Always present (empty list when no timers active)
- `last_timer_event` — Always present (`None` initially, then `"started"`, `"updated"`, `"cancelled"`, or `"finished"`)
- `announcement` — Only present during active announcement playback; absent otherwise

### 4.5 Timer Handler Registration

On `async_added_to_hass`, the entity registers itself as a timer handler using `intent.async_register_timer_handler`:

```python
async def async_added_to_hass(self):
    await super().async_added_to_hass()
    assert self.device_entry is not None
    self.async_on_remove(
        intent.async_register_timer_handler(
            self.hass,
            self.device_entry.id,
            self._handle_timer_event,
        )
    )
```

Key points:
- Uses `self.device_entry.id` (the device registry ID), not the entity ID
- Wraps the unregister callback with `self.async_on_remove()` so it's cleaned up on entity removal
- `self.device_entry` is only available after `async_added_to_hass` (not in `__init__`)

This registration tells HA's intent system that this device supports timers, which causes the LLM to receive timer intents (`HassStartTimer`, etc.) for this device.

## 5. Timer System

### 5.1 Timer Event Handler

The `_handle_timer_event` callback receives `(event_type: intent.TimerEventType, timer_info: intent.TimerInfo)`:

**STARTED:**
```python
h = timer_info.start_hours or 0
m = timer_info.start_minutes or 0
s = timer_info.start_seconds or 0
total = h * 3600 + m * 60 + s
self._active_timers.append({
    "id": timer_id,
    "name": timer_info.name or "",
    "total_seconds": total,
    "started_at": time.time(),
    "start_hours": h,
    "start_minutes": m,
    "start_seconds": s,
})
```

**UPDATED:**
Finds the timer by ID and overwrites `total_seconds`, `started_at`, and the `start_hours/minutes/seconds` fields. Resets `started_at` to `time.time()` so the card recalculates the countdown.

**CANCELLED / FINISHED:**
Removes the timer from `_active_timers` by filtering out the matching ID.

All events:
- Set `self._last_timer_event = event_type.value` (string: `"started"`, `"updated"`, `"cancelled"`, `"finished"`)
- Call `self.async_write_ha_state()` to push the update to HA immediately

### 5.2 Timer Entity Attribute Contract

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
- `name` — User-specified name (e.g., "pizza timer"), may be empty string
- `total_seconds` — Total duration in seconds
- `started_at` — Unix timestamp (`time.time()`) when the timer started or was last updated
- `start_hours/minutes/seconds` — Original duration components from the intent

The card uses `started_at + total_seconds - now` to compute remaining time client-side.

### 5.3 TimerInfo API Notes

`intent.TimerInfo` fields:
- `id` — String timer ID
- `name` — Optional name (can be `None`)
- `start_hours`, `start_minutes`, `start_seconds` — Optional integers (can be `None`, default to 0)
- There is no `total_seconds` field on `TimerInfo` — it must be computed from the components

`intent.TimerEventType` values:
- `STARTED`, `UPDATED`, `CANCELLED`, `FINISHED`

## 6. Announcement System

### 6.1 How Announcements Work

The flow is:

1. An automation calls `assist_satellite.announce` targeting this entity
2. HA calls `async_announce(announcement)` on the entity
3. The entity stores the announcement in `_pending_announcement` and calls `async_write_ha_state()`
4. The card sees the new `announcement` attribute (via `set hass()` polling) and begins playback
5. When playback finishes, the card sends `voice_satellite/announce_finished` via WebSocket
6. The WebSocket handler calls `entity.announce_finished(announce_id)`
7. The `asyncio.Event` is set, unblocking `async_announce`
8. The entity clears `_pending_announcement` and writes state again

### 6.2 `async_announce` Implementation

```python
async def async_announce(self, announcement):
    self._announce_id += 1
    announce_id = self._announce_id

    self._pending_announcement = {
        "id": announce_id,
        "message": announcement.message or "",
        "media_id": announcement.media_id or "",
        "preannounce_media_id": getattr(announcement, "preannounce_media_id", None) or "",
    }

    self._announce_event = asyncio.Event()
    self.async_write_ha_state()

    try:
        await asyncio.wait_for(self._announce_event.wait(), timeout=ANNOUNCE_TIMEOUT)
    except asyncio.TimeoutError:
        _LOGGER.warning("Announcement #%d timed out after %ds", ...)
    finally:
        self._pending_announcement = None
        self._announce_event = None
        self.async_write_ha_state()
```

Key design decisions:
- `_announce_id` is a monotonically increasing integer — prevents stale ACKs from previous announcements
- `ANNOUNCE_TIMEOUT = 120` seconds — if the card never ACKs, the method unblocks after 2 minutes
- `finally` block always clears announcement state, even on timeout
- `media_id` is the resolved TTS URL (e.g., `/api/tts_proxy/xxxxx.mp3`), not a `media-source://` reference
- `preannounce_media_id` uses `getattr` with fallback because the field may not exist on all HA versions

### 6.3 Announcement Entity Attribute Contract

When an announcement is active, the `announcement` attribute contains:

```json
{
    "id": 1,
    "message": "Dinner is ready!",
    "media_id": "/api/tts_proxy/xxxxx.mp3",
    "preannounce_media_id": ""
}
```

When no announcement is active, the `announcement` key is absent from attributes entirely (not `null`).

### 6.4 `announce_finished` Callback

Called by the WebSocket handler. Validates the `announce_id` matches the current pending announcement before setting the event:

```python
@callback
def announce_finished(self, announce_id):
    if self._announce_event is not None and self._announce_id == announce_id:
        self._announce_event.set()
```

Stale ACKs (wrong `announce_id`) are silently ignored with a debug log.

### 6.5 Start Conversation

`assist_satellite.start_conversation` is a variant of announcements that triggers listening after playback. The base class calls `async_start_conversation(announcement)` on the entity.

#### Flow

1. An automation calls `assist_satellite.start_conversation` targeting this entity
2. HA calls `async_start_conversation(announcement)` on the entity
3. The entity stores the announcement in `_pending_announcement` with `"start_conversation": True` and calls `async_write_ha_state()`
4. The card sees the `announcement` attribute with the `start_conversation` flag and begins playback
5. When playback finishes, the card sends `voice_satellite/announce_finished` via WebSocket (same ACK as regular announcements)
6. The `asyncio.Event` is set, unblocking `async_start_conversation`
7. The entity clears `_pending_announcement`, explicitly sets entity state to `listening`, and writes state
8. Meanwhile the card has already entered STT mode (skipping wake word) — the pipeline state sync takes over from here

#### `async_start_conversation` Implementation

```python
async def async_start_conversation(self, announcement):
    self._announce_id += 1
    announce_id = self._announce_id

    self._pending_announcement = {
        "id": announce_id,
        "message": announcement.message or "",
        "media_id": announcement.media_id or "",
        "preannounce_media_id": getattr(announcement, "preannounce_media_id", None) or "",
        "start_conversation": True,
    }

    self._announce_event = asyncio.Event()
    self.async_write_ha_state()

    try:
        await asyncio.wait_for(self._announce_event.wait(), timeout=ANNOUNCE_TIMEOUT)
        # Card is now entering STT mode — set state to listening
        self.hass.states.async_set(
            self.entity_id,
            "listening",
            self.extra_state_attributes,
        )
    except asyncio.TimeoutError:
        _LOGGER.warning("Start conversation #%d timed out after %ds", ...)
    finally:
        self._pending_announcement = None
        self._announce_event = None
        self.async_write_ha_state()
```

Key differences from `async_announce`:
- The `_pending_announcement` dict includes `"start_conversation": True` — the card uses this flag to decide whether to enter STT mode after playback
- After the ACK succeeds, the entity explicitly sets state to `listening` via `hass.states.async_set()` — this ensures the entity reflects the correct state immediately rather than waiting for the card's state sync
- Uses the same `announce_finished` ACK path (§6.4) and the same `ANNOUNCE_TIMEOUT`

#### Card-Side Behavior

When the card sees `start_conversation: true` on an announcement:
1. Plays the chime and TTS announcement normally
2. On completion: sends ACK, clears announcement UI immediately (no display delay)
3. Shows the pipeline blur overlay and calls `pipeline.restartContinue(null)` to enter STT mode with a fresh conversation (no `conversation_id`)
4. Pipeline processes the user's response normally through the configured conversation agent

#### Supported Features

The entity declares both features:

```python
_attr_supported_features = (
    AssistSatelliteEntityFeature.ANNOUNCE
    | AssistSatelliteEntityFeature.START_CONVERSATION
)
# Value: 3
```

This matches the feature set of official HA voice satellites like Voice PE.

## 7. Pipeline State Synchronization

### 7.1 State Mapping

The card sends its internal pipeline state string to the integration via the `voice_satellite/update_state` WebSocket command. The entity maps these to HA satellite states:

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

### 7.2 State Update Mechanism

The entity uses `hass.states.async_set()` to directly update the state machine, bypassing the base class:

```python
@callback
def set_pipeline_state(self, state):
    mapped = self._STATE_MAP.get(state)
    if mapped is None:
        return

    current = self.hass.states.get(self.entity_id)
    if current and current.state == mapped:
        return  # Dedup: don't write same state

    self.hass.states.async_set(
        self.entity_id,
        mapped,
        current.attributes if current else {},
    )
```

**Why `hass.states.async_set()` instead of the base class?**

`AssistSatelliteEntity` stores state internally via `AssistSatelliteState` but does not expose a public setter. The state is normally set by the entity itself during pipeline execution. Since our entity is a virtual proxy (the actual pipeline runs in the browser), we need to force the state externally. `hass.states.async_set()` writes directly to the state machine, which triggers state change events for automations.

**Important:** `AssistSatelliteState` values (`idle`, `listening`, `processing`, `responding`) are not exported from `assist_satellite.__init__`, so we use plain string values that match the enum's `.value`.

### 7.3 Deduplication

The method checks `current.state == mapped` before writing. The card may send rapid state updates (especially during `STT` → `INTENT` → `TTS` transitions), and this prevents unnecessary state change events.

## 8. WebSocket Commands

### 8.1 `voice_satellite/announce_finished`

**Direction:** Card → Integration

**Schema:**
```python
{
    "type": "voice_satellite/announce_finished",
    "entity_id": str,   # e.g., "assist_satellite.kitchen_tablet"
    "announce_id": int,  # Must match the ID from the announcement attribute
}
```

**Behavior:**
1. Iterates `hass.data[DOMAIN]` to find the entity matching `entity_id`
2. Calls `entity.announce_finished(announce_id)`
3. Returns `{"success": True}` or an error if entity not found

**Card sends this as:** `connection.sendMessage({type: "voice_satellite/announce_finished", ...})` — fire-and-forget, the card doesn't wait for a response.

### 8.2 `voice_satellite/update_state`

**Direction:** Card → Integration

**Schema:**
```python
{
    "type": "voice_satellite/update_state",
    "entity_id": str,  # e.g., "assist_satellite.kitchen_tablet"
    "state": str,       # Card state string: "IDLE", "LISTENING", "STT", etc.
}
```

**Behavior:**
1. Iterates `hass.data[DOMAIN]` to find the entity matching `entity_id`
2. Calls `entity.set_pipeline_state(state)`
3. Returns `{"success": True}` or an error if entity not found

**Card sends this as:** `connection.sendMessagePromise(...)` — fire-and-forget style (uses sendMessagePromise but doesn't await the result).

### 8.3 Entity Lookup Pattern

Both WebSocket handlers use the same lookup pattern:

```python
entity = None
for entry_id, ent in hass.data.get(DOMAIN, {}).items():
    if ent.entity_id == entity_id:
        entity = ent
        break

if entity is None:
    connection.send_error(msg["id"], "not_found", f"Entity {entity_id} not found")
    return
```

This iterates all registered satellite entities to match by `entity_id`. The card knows its `entity_id` from the `satellite_entity` config option.

### 8.4 Registration Idempotency

WebSocket commands are registered in `async_setup_entry`, which runs once per config entry. Since multiple config entries share the same command types, the second registration would raise `ValueError`. The try/except pattern handles this:

```python
try:
    websocket_api.async_register_command(hass, ws_announce_finished)
except ValueError:
    pass
```

## 9. Strings and Localization

### 9.1 `strings.json`

```json
{
    "config": {
        "step": {
            "user": {
                "title": "Add Voice Satellite",
                "description": "Create a virtual Assist satellite for a browser tablet running the Voice Satellite Card.",
                "data": {
                    "name": "Satellite name"
                },
                "data_description": {
                    "name": "A descriptive name for this tablet (e.g. Kitchen Tablet, Entrance Tablet)."
                }
            }
        },
        "abort": {
            "already_configured": "A satellite with this name already exists."
        }
    }
}
```

HA uses this file for the config flow UI. The `data_description` provides helper text below the input field. The `abort` message is shown when `_abort_if_unique_id_configured()` triggers.

## 10. Configuration Files

### 10.1 `manifest.json`

```json
{
    "domain": "voice_satellite",
    "name": "Voice Satellite Card Integration",
    "codeowners": ["@jxlarrea"],
    "config_flow": true,
    "dependencies": ["assist_satellite", "intent"],
    "documentation": "https://github.com/jxlarrea/voice-satellite-card-integration",
    "iot_class": "local_push",
    "issue_tracker": "https://github.com/jxlarrea/voice-satellite-card-integration/issues",
    "version": "1.1.0"
}
```

Key fields:
- `dependencies` — Declares that this integration requires `assist_satellite` (for the entity base class) and `intent` (for timer handler registration). HA will load these before our integration.
- `iot_class: "local_push"` — The card pushes state to the integration via WebSocket; no polling.
- `config_flow: true` — Required for UI-based setup.
- **Do NOT include `homeassistant` key** — HACS validation rejects it for custom integrations. Use `hacs.json` instead.

### 10.2 `hacs.json`

```json
{
    "name": "Voice Satellite Card Integration",
    "homeassistant": "2025.1.2",
    "render_readme": true
}
```

- `homeassistant` — Minimum HA version. All APIs used (AssistSatelliteEntity, intent timer handlers) were introduced in HA 2024.10. The 2025.1.2 requirement provides comfortable headroom.
- `render_readme` — Tells HACS to render the README on the repository page.

### 10.3 `const.py`

```python
DOMAIN = "voice_satellite"
```

Single constant. The domain must match the folder name under `custom_components/` and the `domain` in `manifest.json`.

## 11. HA API Dependencies

### 11.1 `assist_satellite` Component (HA 2024.10+)

- `AssistSatelliteEntity` — Base class for satellite entities
- `AssistSatelliteEntityFeature.ANNOUNCE` — Feature flag enabling the `assist_satellite.announce` action
- `AssistSatelliteEntityFeature.START_CONVERSATION` — Feature flag enabling the `assist_satellite.start_conversation` action
- `AssistSatelliteConfiguration` — Returned by `async_get_configuration()` (wake word config)
- `AssistSatelliteAnnouncement` — Passed to `async_announce()` and `async_start_conversation()` with `.message`, `.media_id`, and optionally `.preannounce_media_id`

### 11.2 `intent` Component (HA 2024.10+)

- `intent.async_register_timer_handler(hass, device_id, callback)` — Registers a device as a timer handler. Returns an unregister callback.
- `intent.TimerEventType` — Enum: `STARTED`, `UPDATED`, `CANCELLED`, `FINISHED`
- `intent.TimerInfo` — Data class with `.id`, `.name`, `.start_hours`, `.start_minutes`, `.start_seconds`

### 11.3 `websocket_api`

- `websocket_api.async_register_command(hass, handler)` — Registers a WebSocket command. The handler is decorated with `@websocket_api.websocket_command(schema)` and `@websocket_api.async_response`.
- `connection.send_result(msg_id, data)` — Send success response
- `connection.send_error(msg_id, code, message)` — Send error response

## 12. Card Interface Contract

This section documents what the card sends and receives. See the [card's DESIGN.md](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/blob/master/DESIGN.md) for full card-side implementation details.

### 12.1 Card → Integration (WebSocket)

| Command | Payload | Purpose |
|---|---|---|
| `voice_satellite/announce_finished` | `{entity_id, announce_id}` | ACK that announcement playback completed |
| `voice_satellite/update_state` | `{entity_id, state}` | Sync pipeline state to entity |

### 12.2 Integration → Card (Entity Attributes)

The card reads entity attributes via `hass.states` (polled in `set hass()` for announcements, subscribed via `state_changed` events for timers):

| Attribute | Type | Description |
|---|---|---|
| `active_timers` | `list[dict]` | Active timers with countdown data |
| `last_timer_event` | `string \| null` | Last event type: `started`, `updated`, `cancelled`, `finished` |
| `announcement` | `dict \| absent` | Present only during active announcement; includes `start_conversation: true` for start_conversation requests |

### 12.3 Card Configuration

The card references this integration's entity via the `satellite_entity` config option:

```yaml
type: custom:voice-satellite-card
satellite_entity: assist_satellite.kitchen_tablet
```

## 13. GitHub Infrastructure

### 13.1 HACS Workflow (`.github/workflows/hacs.yml`)

Runs two jobs on push, pull request, and manual dispatch:
- **hacs** — `hacs/action@main` with `category: "integration"`. Currently ignores `brands` check until the brands repo PR is merged.
- **hassfest** — `home-assistant/actions/hassfest@master` for manifest validation.

### 13.2 Funding (`.github/FUNDING.yml`)

```yaml
buy_me_a_coffee: jxlarrea
github: jxlarrea
```

## 14. Implementation Checklist

Use this checklist to verify a complete implementation:

### Config Flow
- [ ] Single-step flow asking for satellite name
- [ ] Unique ID from lowercased, underscore-separated name
- [ ] Duplicate detection via `_abort_if_unique_id_configured()`
- [ ] `strings.json` with title, description, data labels, data_description, and abort message

### Entity
- [ ] Extends `AssistSatelliteEntity`
- [ ] `_attr_supported_features = AssistSatelliteEntityFeature.ANNOUNCE | AssistSatelliteEntityFeature.START_CONVERSATION`
- [ ] `_attr_has_entity_name = True`, `_attr_name = None`
- [ ] `_attr_unique_id = entry.entry_id`
- [ ] `device_info` with identifiers, name, manufacturer, model, sw_version
- [ ] `extra_state_attributes` returns `active_timers`, `last_timer_event`, and conditionally `announcement`
- [ ] Timer handler registered in `async_added_to_hass` via `intent.async_register_timer_handler`
- [ ] Timer handler wrapped in `self.async_on_remove()`
- [ ] `async_get_configuration` returns empty wake word config
- [ ] `async_set_configuration` is a no-op

### Timers
- [ ] `_handle_timer_event` handles STARTED, UPDATED, CANCELLED, FINISHED
- [ ] STARTED appends timer dict with `id`, `name`, `total_seconds`, `started_at`, `start_hours/minutes/seconds`
- [ ] UPDATED finds timer by ID and overwrites duration + `started_at`
- [ ] CANCELLED/FINISHED removes timer by ID
- [ ] All events set `_last_timer_event` and call `async_write_ha_state()`

### Announcements
- [ ] `async_announce` stores announcement in `_pending_announcement` with monotonic `_announce_id`
- [ ] Creates `asyncio.Event` and waits with 120s timeout
- [ ] `finally` block always clears `_pending_announcement` and `_announce_event`
- [ ] `announce_finished` validates `announce_id` before setting event

### Start Conversation
- [ ] `async_start_conversation` stores announcement with `"start_conversation": True`
- [ ] Reuses same ACK flow as `async_announce` (same `announce_finished` callback)
- [ ] On successful ACK, explicitly sets entity state to `listening` via `hass.states.async_set()`
- [ ] `finally` block clears `_pending_announcement` and `_announce_event`

### State Sync
- [ ] `_STATE_MAP` maps all card states to HA satellite states
- [ ] `set_pipeline_state` deduplicates (skips if state unchanged)
- [ ] Uses `hass.states.async_set()` to bypass base class (no public setter)
- [ ] Preserves existing attributes when writing state

### WebSocket Commands
- [ ] `voice_satellite/announce_finished` with `entity_id` + `announce_id`
- [ ] `voice_satellite/update_state` with `entity_id` + `state`
- [ ] Entity lookup iterates `hass.data[DOMAIN]` by `entity_id`
- [ ] Registration wrapped in try/except for idempotency

### Integration Setup
- [ ] `async_setup_entry` forwards to ASSIST_SATELLITE platform and registers WebSocket commands
- [ ] `async_unload_entry` unloads platforms and removes entity from `hass.data`
- [ ] Entity stored in `hass.data[DOMAIN][entry.entry_id]`

### Infrastructure
- [ ] `manifest.json` with domain, name, codeowners, config_flow, dependencies, documentation, iot_class, issue_tracker, version
- [ ] No `homeassistant` key in `manifest.json` (HACS rejects it)
- [ ] `hacs.json` with name, homeassistant version, render_readme
- [ ] HACS workflow with hacs/action and hassfest
- [ ] FUNDING.yml