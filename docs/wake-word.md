# On-Device Wake Word Detection

Voice Satellite includes built-in wake word detection that runs entirely in the browser - no server-side wake word service required.

## Contents

- [How It Works](#how-it-works)
- [Built-in Wake Words](#built-in-wake-words)
- [Custom Wake Words](#custom-wake-words)
- [Configuration](#configuration)
- [Disabled Mode](#disabled-mode)

## How It Works

On-device detection uses [microWakeWord](https://github.com/kahrendt/microWakeWord) TFLite models running entirely in pure JavaScript - a hand-rolled interpreter for the streaming model plus a bit-exact port of the TFLM audio frontend (windowing, KISS FFT, mel filterbank, noise reduction, PCAN, log-scale). The browser continuously processes audio and runs lightweight keyword classifiers to detect the wake word. Audio is only streamed to Home Assistant after detection. This means:

- **Lower latency** - detection happens instantly on the device, no network round-trip
- **Reduced server load** - audio is only sent to HA for STT after the wake word is detected
- **No wake word add-on required** - works without openWakeWord or microWakeWord installed on HA
- **Energy-efficient** - optional noise gate pauses inference during silence and resumes instantly when sound is detected (enable via the "Wake word noise gate" switch)
- **Optional stop-word interruption** - enable the "Stop word interruption" switch if you want the browser to listen for `stop` during timer alerts, TTS, and announcement playback

## Built-in Wake Words

| Model | Wake Phrase |
|-------|-------------|
| **ok_nabu** (default) | "OK Nabu" |
| **hey_jarvis** | "Hey Jarvis" |
| **alexa** | "Alexa" |
| **hey_mycroft** | "Hey Mycroft" |
| **hey_home_assistant** | "Hey Home Assistant" |
| **hey_luna** | "Hey Luna" |
| **okay_computer** | "Okay Computer" |

## Custom Wake Words

You can add your own microWakeWord TFLite models:

1. Train a custom wake word model using [microWakeWord](https://github.com/kahrendt/microWakeWord), or download a community model from the [esphome/micro-wake-word-models](https://github.com/esphome/micro-wake-word-models) repository
2. Place the `.tflite` file in one of these directories:
   - **`config/voice_satellite/models/`** (recommended) - persists across HACS updates
   - `custom_components/voice_satellite/models/` - works but files are lost on integration updates
3. Restart Home Assistant
4. The custom model will appear in the "Wake word model" dropdown on the satellite's device page

The filename (without `.tflite`) becomes the option name in the dropdown. For example, `hey_computer.tflite` appears as "hey_computer".

> **Note:** Custom models placed directly in the integration's `models/` directory are automatically backed up to `config/voice_satellite/models/` on startup and restored after updates.

## Configuration

All wake word settings are configured per-device on the satellite's device page (**Settings -> Devices & Services -> Voice Satellite -> [device]**):

- **Wake word detection** - "On Device" (default), "Home Assistant" (server-side), or "Disabled" (no automatic listening)
- **Wake word** - select the wake word to listen for
- **Stop word interruption** - optional on-device `stop` keyword that can cancel timer alerts, TTS, and announcement playback. Disabled by default
- **Wake word sensitivity** - "Slightly sensitive", "Moderately sensitive" (default), or "Very sensitive"

To use server-side detection instead, set "Wake word detection" to "Home Assistant". This requires a wake word service (openWakeWord or microWakeWord) configured in your Assist pipeline.

## Disabled Mode

Set "Wake word detection" to **Disabled** when you want full manual control over when the satellite listens. The microphone stream is **not activated at all** until you explicitly trigger a wake. Useful for older or low-powered devices (e.g. Android 7-9 tablets where always-on detection is unreliable), shared spaces where passive listening isn't wanted, or fully automation-driven workflows.

In Disabled mode:

- The mic stays off and no audio is streamed to Home Assistant
- Announcements, `start_conversation`, and `ask_question` from automations still work normally - they bring the mic up only for the brief STT phase, then release it
- Trigger listening via the [`voice_satellite.wake`](usage.md#voice-satellite-wake-action) action from a dashboard button, automation, or the mini card's mic icon

The mini card keeps its small mic-dot icon visible so users can tap to talk. The full card stays clean - wake it via the action.
