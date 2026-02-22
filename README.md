# <img width="48" height="48" alt="icon" src="https://github.com/user-attachments/assets/31b4a789-bae3-4428-a543-85063f17109c" /> Voice Satellite Card Integration

Required integration for the [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant). Registers browsers as proper Assist Satellite devices in Home Assistant, giving them full feature parity with physical voice assistants like the [Home Assistant Voice Preview Edition](https://www.home-assistant.io/voice-pe/).

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![version](https://shields.io/github/v/release/jxlarrea/voice-satellite-card-integration?style=for-the-badge)](https://github.com/jxlarrea/voice-satellite-card-integration/releases)
[![Stars](https://img.shields.io/github/stars/jxlarrea/voice-satellite-card-integration?style=for-the-badge&color=yellow)](https://github.com/jxlarrea/voice-satellite-card-integration/stargazers)
[![Build](https://img.shields.io/github/actions/workflow/status/jxlarrea/voice-satellite-card-integration/hacs.yml?style=for-the-badge&label=Build)](https://github.com/jxlarrea/voice-satellite-card-integration/actions/workflows/hacs.yml)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jxlarrea)

![Screenshot](https://github.com/user-attachments/assets/03c80c6e-7c21-473b-9975-c012212d8251)

## Why?

The [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant) runs in your browser and uses Home Assistant's Assist Pipeline to process voice commands. However, without this integration the browser has no device identity in Home Assistant, which means:

- **Timers don't work** - HA tells the LLM "this device is not able to start timers"
- **No announcements** - you can't push TTS messages to a specific browser
- **No conversations** - automations can't proactively ask the user a question and listen for a response
- **No media player** - you can't target the browser with `tts.speak` or `media_player.play_media`
- **No volume control** - no way to adjust audio volume from the HA UI
- **No per-device configuration** - no way to select pipeline, VAD sensitivity, or manage mute/chime settings per device
- **No per-device automations** - HA doesn't know which browser is talking

This integration solves all of that by creating a virtual Assist Satellite device for each browser.

## Installation

### HACS (Recommended)

1. Add this repository as a custom repository in HACS (type: Integration)
2. Search for "Voice Satellite Card Integration" and install
3. Restart Home Assistant

### Manual

1. Copy the `custom_components/voice_satellite` folder to your `config/custom_components/` directory
2. Restart Home Assistant

## Setup

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **Voice Satellite Card**
3. Enter a name for the device (e.g., "Kitchen Tablet")
4. Repeat for each device that runs the [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant)

Each entry creates a full satellite device. Select the `assist_satellite.*` entity in the Voice Satellite Card editor to connect them.

## Timer Support

Once configured, you can say "set a timer for 5 minutes" through the Voice Satellite Card and it will work. The integration registers as a timer handler for the device, which tells HA's intent system (and any connected LLM) that this satellite supports timers. The integration handles the full timer lifecycle — start, update, cancel, and finish — and exposes active timers as entity attributes that the card reads to display countdown pills.

## Announcement Support

The integration implements the `assist_satellite.announce` action, allowing you to push TTS messages to specific browsers from automations and scripts. The card plays a chime before the announcement, displays the message as a chat bubble, and sends an acknowledgment back to the integration when playback completes.

Example automation:

```yaml
action: assist_satellite.announce
target:
  entity_id: assist_satellite.kitchen_tablet
data:
  message: "Dinner is ready!"
```

The announcement blocks until the card confirms playback is complete (or a 120-second timeout expires), so you can chain actions that depend on the user hearing the message.

## Start Conversation Support

The integration implements the `assist_satellite.start_conversation` action, allowing automations to speak a prompt and then listen for the user's voice response. After the announcement plays, the card automatically enters listening mode (skipping wake word detection) so the user can respond immediately.

Example automation:

```yaml
action: assist_satellite.start_conversation
target:
  entity_id: assist_satellite.kitchen_tablet
data:
  start_message: "The front door has been unlocked for 10 minutes. Should I lock it?"
  extra_system_prompt: "The user was asked about the front door. If they confirm, call the lock service on lock.front_door."
```

This enables interactive automations where Home Assistant proactively asks the user a question and acts on their response. The satellite's configured pipeline must use a conversation agent that supports conversations (e.g., OpenAI, Google Generative AI).

## Ask Question Support

The integration implements the `assist_satellite.ask_question` action, allowing automations to ask a question, capture the user's voice response, and match it against predefined answer templates. Unlike `start_conversation` (which passes the response to the conversation agent), `ask_question` returns a structured result directly to the calling automation.

Example automation:

```yaml
action: assist_satellite.ask_question
target:
  entity_id: assist_satellite.kitchen_tablet
data:
  question: "The front door has been unlocked for 10 minutes. Should I lock it?"
  answers:
    - id: positive
      sentences:
        - "yes [please]"
        - "[go ahead and] lock it [please]"
        - "sure"
    - id: negative
      sentences:
        - "no [thanks]"
        - "leave it [unlocked]"
        - "don't lock it"
response_variable: answer
```

The `answer` variable contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string \| null` | Matched answer ID (e.g., `"positive"`), or `null` if no match |
| `sentence` | `string` | Raw transcribed text from STT |
| `slots` | `dict` | Captured wildcard values from `{placeholder}` syntax |

Sentence templates use [hassil](https://github.com/home-assistant/hassil) syntax: `[optional words]` and `{wildcard}` placeholders. For example, `"play {genre} music"` captures the genre value in `answer.slots.genre`.

The card provides audio and visual feedback: a done chime on successful match, or an error chime with a flashing red gradient bar when the response doesn't match any answer.

## Media Player

Each satellite device includes a `media_player` entity that provides volume control and audio playback capabilities — matching the behavior of the [Home Assistant Voice Preview Edition](https://www.home-assistant.io/voice-pe/).

**Volume control:** The media player's volume slider controls all satellite audio — chimes, TTS responses, announcements, and media playback. Volume changes apply in real time to any currently-playing audio.

**Playback state:** The entity reflects the satellite's actual audio state. It shows "Playing" whenever any sound is active (chimes, TTS, announcements, or direct media playback), and returns to "Idle" when audio finishes.

**TTS targeting:** You can use the satellite as a `tts.speak` target in automations:

```yaml
action: tts.speak
target:
  entity_id: tts.piper
data:
  media_player_entity_id: media_player.kitchen_tablet_media_player
  message: "The laundry is done!"
```

**Media playback:** Play audio files from automations using `media_player.play_media`:

```yaml
action: media_player.play_media
target:
  entity_id: media_player.kitchen_tablet_media_player
data:
  media_content_id: media-source://media_source/local/doorbell.mp3
  media_content_type: music
```

The entity supports play, pause, resume, stop, volume set, and volume mute — all controllable from the HA UI or automations. It also supports browsing the HA media library.

## Satellite State Sync

The Voice Satellite Card syncs its pipeline state back to the entity in real time. This means the entity accurately reflects what the satellite is doing:

| Entity State | Meaning |
|-------------|---------|
| `idle` | Waiting for wake word, or inactive |
| `listening` | Actively capturing a voice command |
| `processing` | Processing the user's intent |
| `responding` | Speaking a TTS response |

You can use this in automations — for example, muting a TV when the nearby satellite starts listening:

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

Example template to check for active timers:

```yaml
{{ state_attr('assist_satellite.kitchen_tablet', 'active_timers') | length > 0 }}
```

## Requirements

- Home Assistant 2025.2.1 or later
- [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant) v4.1.0 or later

## License

MIT - see [LICENSE](LICENSE) for details.
