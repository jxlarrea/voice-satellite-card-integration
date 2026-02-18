# Voice Satellite Card Integration

Companion integration for the [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant). Registers browsers as proper Assist Satellite devices in Home Assistant.

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![version](https://shields.io/github/v/release/jxlarrea/voice-satellite-card-integration?style=for-the-badge)](https://github.com/jxlarrea/voice-satellite-card-integration/releases)
[![Stars](https://img.shields.io/github/stars/jxlarrea/voice-satellite-card-integration?style=for-the-badge&color=yellow)](https://github.com/jxlarrea/voice-satellite-card-integration/stargazers)
[![Build](https://img.shields.io/github/actions/workflow/status/jxlarrea/voice-satellite-card-integration/hacs.yml?style=for-the-badge&label=Build)](https://github.com/jxlarrea/voice-satellite-card-integration/actions/workflows/hacs.yml)

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jxlarrea)

## Why?

The [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant) runs in your browser and uses HA's Assist Pipeline API to process voice commands. However, because the browser isn't a registered satellite device, Home Assistant doesn't give it a device identity. This means:

- **Timers don't work** - HA tells the LLM "this device is not able to start timers"
- **No announcements** - you can't push TTS messages to a specific browser
- **No conversations** - automations can't proactively ask the user a question and listen for a response
- **No per-device automations** - HA doesn't know which browser is talking

This integration solves that by creating a virtual Assist Satellite entity for each browser.

## What it does

- Creates an `assist_satellite.*` entity per browser with a proper device identity
- **Timers** - Registers as a timer handler so the LLM gets access to `HassStartTimer`, and exposes active timer state as entity attributes for the card to display countdown pills
- **Announcements** - Implements `assist_satellite.announce` so you can push TTS messages to specific browsers from automations and scripts
- **Start Conversation** - Implements `assist_satellite.start_conversation` so automations can speak a prompt and then listen for the user's voice response
- **State sync** - Reflects real-time pipeline state (`idle`, `listening`, `processing`, `responding`) on the entity, enabling automations that react to voice activity

## Installation

> **Note:** This is a companion integration for the [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant). You need to install the card as well for this integration to be useful.

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
3. Enter a name for the device (e.g. "Kitchen Tablet")
4. Repeat for each device that runs the Voice Satellite Card

Each entry creates an `assist_satellite.*` entity. Use this entity in your Voice Satellite Card configuration:

```yaml
type: custom:voice-satellite-card
satellite_entity: assist_satellite.kitchen_tablet
# ... other card options
```

## Timer Support

Once configured, you can say "set a timer for 5 minutes" through the Voice Satellite Card and it will work. The integration registers as a timer handler for the device, which tells HA's intent system (and any connected LLM) that this satellite supports timers. The integration handles the full timer lifecycle - start, update, cancel, and finish - and exposes active timers as entity attributes that the card reads to display countdown pills.

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
```

This enables interactive automations where Home Assistant proactively asks the user a question and acts on their response. The satellite's configured pipeline must use a conversation agent that supports conversations (e.g., OpenAI, Google Generative AI).

## Satellite State Sync

The Voice Satellite Card syncs its pipeline state back to the entity in real time. This means the entity accurately reflects what the satellite is doing:

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
| `announcement` | dict | Present only during active announcement playback, with `id`, `message`, `media_id` |

Example template to check for active timers:

```yaml
{{ state_attr('assist_satellite.kitchen_tablet', 'active_timers') | length > 0 }}
```

## Requirements

- Home Assistant 2025.1.2 or later
- [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant) v3.0.5 or later (for start conversation support; v3.0.0+ for timers and announcements)

## License

MIT - see [LICENSE](LICENSE) for details.