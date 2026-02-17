# Voice Satellite Card Integration

Companion integration for the [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant). Registers browser tablets as proper Assist Satellite devices in Home Assistant.

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![version](https://shields.io/github/v/release/jxlarrea/voice-satellite-card-integration?style=for-the-badge)](https://github.com/jxlarrea/voice-satellite-card-integration/releases)
[![Stars](https://img.shields.io/github/stars/jxlarrea/voice-satellite-card-integration?style=for-the-badge)](https://github.com/jxlarrea/voice-satellite-card-integration/stargazers)
[![Build](https://img.shields.io/github/actions/workflow/status/jxlarrea/voice-satellite-card-integration/hacs.yml?style=for-the-badge&label=Build)](https://github.com/jxlarrea/voice-satellite-card-integration/actions/workflows/hacs.yml)

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jxlarrea)

## Why?

The [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant) runs in your browser and uses HA's Assist Pipeline API to process voice commands. However, because the browser isn't a registered satellite device, Home Assistant doesn't give it a device identity. This means:

- **Timers don't work** — HA tells the LLM "this device is not able to start timers"
- **No announcements** — you can't push TTS messages to a specific tablet
- **No per-device automations** — HA doesn't know which tablet is talking

This integration solves that by creating a virtual Assist Satellite entity for each tablet.

## What it does

- Creates an `assist_satellite.*` entity per tablet
- Registers a device in HA's device registry with a proper `device_id`
- Registers as a timer handler so the LLM gets access to `HassStartTimer`
- Exposes active timer state as entity attributes for the card to display

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
3. Enter a name for the tablet (e.g. "Kitchen Tablet")
4. Repeat for each tablet that runs the Voice Satellite Card

Each entry creates an `assist_satellite.*` entity. Use this entity in your Voice Satellite Card configuration:

```yaml
type: custom:voice-satellite-card
satellite_entity: assist_satellite.kitchen_tablet
# ... other card options
```

## Timer Support

Once configured, you can say "set a timer for 5 minutes" through the Voice Satellite Card and it will work. The integration handles the timer lifecycle and exposes active timers as entity attributes that the card reads to display a countdown.

## Requirements

- Home Assistant 2024.10 or later (Assist Satellite entity support)
- [Voice Satellite Card](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant) v3.0.0 or later

## License

MIT — see [LICENSE](LICENSE) for details.