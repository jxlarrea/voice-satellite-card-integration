# Integration

The integration creates a virtual Assist Satellite device for each browser, enabling timers, announcements, conversations, media player, and per-device configuration.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/integration.png" alt="Integration" width="650"/>
</p>

## Contents

- [Device Settings](#device-settings)
- [Satellite State Sync](#satellite-state-sync)
- [Entity Attributes](#entity-attributes)
- [Voice Interaction Events](#voice-interaction-events)

## Device Settings

Each satellite device exposes configuration entities on its device page (**Settings -> Devices & Services -> Voice Satellite -> [device]**):

| Entity | Type | Description |
|--------|------|-------------|
| **Announcement display duration** | Number | How long (1-60 seconds) to show the announcement text on screen after playback completes |
| **Pipeline 1** | Select | Assist pipeline used when Wake word 1 fires. This is the device's default pipeline and the one used by every non-wake-word entry point (announcements, `start_conversation`, `voice_satellite.wake`) |
| **Pipeline 2** | Select | Assist pipeline used when Wake word 2 fires. Only shown when Wake word 2 is enabled (not "Disabled"). "Preferred" falls back to Pipeline 1 |
| **Finish delay** | Number | How long (0-15 seconds) to keep the overlay visible after TTS finishes so you can continue reading the response. 0 dismisses immediately (default) |
| **Finished speaking detection** | Select | VAD sensitivity - how aggressively to detect end of speech |
| **Session duration** | Select | Controls how long conversation context is retained between wake word activations. After the selected duration elapses without interaction, the next wake word starts a fresh conversation. Options: "Persistent" (default - never expires, matching physical Voice PE satellite behavior), 5 minutes, 10 minutes, 15 minutes, 30 minutes, 1 hour, 3 hours, 6 hours, or "Isolated" (every wake word activation starts completely fresh). Multi-turn exchanges within a single session always share context regardless of this setting |
| **Mute** | Switch | Mute/unmute the satellite - when muted, wake word detection is paused |
| **Screensaver active** | Binary sensor | Sensor showing whether the screensaver overlay is currently displayed. (Screensaver settings live in the sidebar panel - see [configuration.md](configuration.md#screensaver)) |
| **TTS Output** | Select | Where to play TTS audio: "Browser" (default) plays audio locally, or select any `media_player` entity to route TTS to an external speaker |
| **Wake sound** | Switch | Enable/disable chime sounds (wake, done, error) |
| **Stop word interruption** | Switch | Opt-in on-device `stop` keyword detection for interruptible states such as timer alerts, TTS playback, and announcements. Disabled by default to avoid extra CPU/memory use on slower devices |
| **Wake word 1** | Select | Primary wake word model. Built-in models: ok_nabu, hey_jarvis, alexa, hey_mycroft, hey_home_assistant, hey_luna, hey_baby, okay_computer. Custom `.tflite` models are auto-discovered from the `models/` directory |
| **Wake word 2** | Select | Optional second wake word model, routed to Pipeline 2. Defaults to "Disabled". When a non-"Disabled" model is picked, both models run in parallel on the shared feature extractor. See [dual wake words](wake-word.md#dual-wake-words-and-pipelines) |
| **Wake word detection** | Select | "On Device" (default) runs wake word inference locally in the browser. "Home Assistant" uses server-side detection via the pipeline's configured wake word engine. Server-side detection is single-slot only |
| **Wake word noise gate** | Switch | When enabled, wake word inference is paused during silence and resumes when sound is detected. Reduces CPU usage but may miss soft-spoken wake words. Disabled by default |
| **Wake word sensitivity** | Select | Detection sensitivity for on-device wake word: "Slightly sensitive", "Moderately sensitive" (default), or "Very sensitive". Shared across both wake word slots |

All settings persist across restarts.

## Satellite State Sync

The engine syncs its pipeline state back to the entity in real time. This means the entity accurately reflects what the satellite is doing:

| Entity State | Meaning |
|-------------|---------|
| `idle` | Waiting for wake word, or inactive |
| `listening` | Actively capturing a voice command |
| `processing` | Processing the user's intent |
| `responding` | Speaking a TTS response |

You can use this in automations - for example, muting a TV when the nearby satellite starts listening:

```yaml
trigger:
  - platform: state
    entity_id: assist_satellite.living_room_tablet
    to: "listening"
action:
  - action: media_player.volume_mute
    target:
      entity_id: media_player.living_room_tv
    data:
      is_volume_muted: true
```

## Entity Attributes

The satellite entity exposes the following attributes for use in templates and automations:

| Attribute | Type | Description |
|-----------|------|-------------|
| `active_timers` | list | Active timer objects, each with `id`, `name`, `total_seconds`, `started_at` |
| `last_timer_event` | string | Last timer event type: `started`, `updated`, `cancelled`, or `finished` |
| `muted` | boolean | Current mute switch state |
| `wake_sound` | boolean | Current wake sound switch state |
| `stop_word` | boolean | Whether opt-in stop word interruption is enabled |
| `tts_target` | string | Entity ID of the selected TTS output media player (empty string when set to "Browser") |
| `announcement_display_duration` | integer | Configured announcement display duration in seconds |
| `wake_word_detection` | string | Current wake word detection mode: "On Device" or "Home Assistant" |
| `wake_word_model` | string | Wake word 1 model name (e.g., `ok_nabu`) |
| `wake_word_model_2` | string | Wake word 2 model name, or `Disabled` when slot 2 is off |
| `pipeline` | string | Pipeline 1 display name |
| `pipeline_2` | string | Pipeline 2 display name, or `Preferred` when slot 2 is set to fall back to Pipeline 1 |

Example template to check for active timers:

```yaml
{{ state_attr('assist_satellite.kitchen_tablet', 'active_timers') | length > 0 }}
```

## Voice Interaction Events

After every voice interaction the integration fires a `voice_satellite_chat` event on the Home Assistant bus, exposing the full turn payload. This lets automations react to *what* was said by the user and the assistant, not just *that* something was said.

**Event payload:**

```yaml
event_type: voice_satellite_chat
data:
  entity_id: assist_satellite.kitchen_tablet
  stt_text: "what's the weather and turn on the kitchen lights"
  tts_text: "It's 75 and sunny. The kitchen lights are on."
  tool_calls:
    - name: "voice-satellite-card-weather-forecast__get_weather_forecast"
      display_name: "Get weather forecast"
    - name: "HassTurnOn"
      display_name: "Turn on"
  conversation_id: "01HV..."
  is_continuation: false
  continue_conversation: false
  language: "en"
```

**Field reference:**

| Field | Type | Description |
|-------|------|-------------|
| `entity_id` | string | The satellite entity that handled the interaction |
| `stt_text` | string | What the user said (speech-to-text result) |
| `tts_text` | string | What the assistant said back (full response, no truncation) |
| `tool_calls` | list | Tools the LLM invoked during this turn. Each item has `name` (raw tool identifier, stable for matching) and `display_name` (humanized for display) |
| `conversation_id` | string | Shared across turns of the same multi-turn conversation - use to correlate related events |
| `is_continuation` | boolean | `true` if this turn followed a previous turn in the same conversation |
| `continue_conversation` | boolean | `true` if the assistant requested another turn after this one |
| `language` | string | Pipeline language for this interaction (e.g. `en`, `es`) |

**Example: react to every voice response**

```yaml
- alias: Notify on assistant response
  trigger:
    - platform: event
      event_type: voice_satellite_chat
  condition:
    - "{{ trigger.event.data.tts_text | length > 0 }}"
  action:
    - service: notify.phone
      data:
        message: "Assist replied: {{ trigger.event.data.tts_text }}"
```

**Example: only react to the final turn of multi-turn conversations**

```yaml
trigger:
  - platform: event
    event_type: voice_satellite_chat
condition:
  - "{{ trigger.event.data.continue_conversation == false }}"
```

**Example: only fire when a specific tool was used**

```yaml
trigger:
  - platform: event
    event_type: voice_satellite_chat
condition:
  - "{{ trigger.event.data.tool_calls | selectattr('name', 'search', 'weather') | list | length > 0 }}"
```

**How to test:**

1. Open Developer Tools -> Events
2. Type `voice_satellite_chat` in the **Listen to events** field at the bottom (it will not appear in the "Available Events" list at the top - that section only shows events with active subscribers)
3. Click START LISTENING
4. Trigger a voice interaction on your tablet

The event should fire immediately with the full payload.
