<h1 align="center" style="border-bottom: none">
   <img alt="Voice Satellite for Home Assistant" src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/banner.png" width="650" />
</h1>

<p align="center">
<a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=jxlarrea&repository=voice-satellite-card-integration"><img src="https://img.shields.io/badge/HACS-Default-orange.svg?style=for-the-badge" alt="hacs_badge"></a>
<img src="https://img.shields.io/github/stars/jxlarrea/voice-satellite-card-integration?style=for-the-badge&label=Stars&color=yellow" alt="Stars">
<a href="https://github.com/jxlarrea/voice-satellite-card-integration/releases"><img src="https://img.shields.io/github/downloads/jxlarrea/voice-satellite-card-integration/total?style=for-the-badge&label=Downloads&color=blue" alt="Downloads"></a>
<a href="https://github.com/jxlarrea/voice-satellite-card-integration/releases"><img src="https://shields.io/github/v/release/jxlarrea/voice-satellite-card-integration?style=for-the-badge&color=purple" alt="version"></a>
<a href="https://github.com/jxlarrea/voice-satellite-card-integration/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/jxlarrea/voice-satellite-card-integration/release.yml?style=for-the-badge&label=Build" alt="Build"></a>
</p>

<p align="center">
<a href="https://buymeacoffee.com/jxlarrea"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>
</p>

Turn any tablet, phone, or browser into a hands-free voice assistant for [Home Assistant](https://www.home-assistant.io) - like Alexa, Siri, or Google Home, but fully private and running on your own hardware. Just say the wake word and go: ask questions, control devices, set timers, get announcements, and see rich visual results - all without touching the screen.

Voice Satellite works as a drop-in integration that transforms any web browser into a full [Assist satellite](https://www.home-assistant.io/voice-pe/) with wake word detection, media playback, and visual feedback.

### Demo Video (**Make sure your volume is up**)

https://github.com/user-attachments/assets/af3956a8-3f58-420a-85ef-872ab9e33e8f

## Table of Contents

- [How It Works](#how-it-works)
- [Important: Browser Requirements](#important-browser-requirements)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Setup](#setup)
- [Sidebar Panel](#sidebar-panel)
- [Integration](#integration)
- [Usage](#usage)
- [Mini Card](#mini-card)
- [On-Device Wake Word Detection](#on-device-wake-word-detection)
- [Skins](#skins)
- [Experimental: LLM Tools](#experimental-llm-tools)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## How It Works

Voice Satellite runs as a **global engine** that loads on every page of Home Assistant - no dashboard card required. Once you assign a satellite entity in the sidebar panel, the engine starts automatically and listens for wake words across all page navigations.

- **Turns your browser into a real satellite** - registered as a proper `assist_satellite` device in HA with full feature parity with physical voice assistants
- **On-device wake word detection** - runs microWakeWord locally via TFLite WASM with custom model support and optional voice-activated stop interruption. Falls back to server-side detection when preferred
- **Timers, announcements, conversations** - voice-activated timers with countdown pills, `assist_satellite.announce` / `start_conversation` / `ask_question` from automations
- **Media player entity** - volume control, `tts.speak` targeting, and `media_player.play_media` from automations. TTS can route to browser or a remote speaker
- **Skins** - 7 built-in skins (Default, Alexa, Google Home, Home Assistant, Retro Terminal, Siri, Waveform) with CSS overrides. Reactive audio-level animation on the activity bar
- **Mini card** - optional `voice-satellite-mini-card` for in-dashboard text display without the fullscreen overlay
- **LLM tools** *(experimental)* - image/video/web/Wikipedia search, weather, stocks/crypto with visual panels. Requires [Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)
- **Works on any device** - tablets, phones, computers, kiosks

## Screenshots
<p align="center">
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/locks.jpg" alt="Assist" width="49%"/>
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/videos.jpg" alt="Video Search" width="49%"/>
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/weather.jpg" alt="Weather" width="49%"/>
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/currency-waveform.jpg" alt="Stocks" width="49%"/>
</p>

## Important: Browser Requirements

**Warning:** Voice Satellite requires microphone access and works best when:

1. **The browser has microphone permissions granted** - you will be prompted on first use.
2. **The page is served over HTTPS** - required for microphone access in modern browsers.
3. **The screen stays on** - if the device screen turns off completely, the microphone will stop working. Use a screensaver instead of screen-off to keep the mic active.

For kiosk setups like [Fully Kiosk Browser](https://play.google.com/store/apps/details?id=de.ozerov.fully), make sure to enable microphone permissions and use the screensaver feature (not screen off) to keep the microphone active while dimming the display.

For the **Home Assistant Companion App**, enable **Autoplay videos** in Settings -> Companion App -> Other settings. Without this, the WebView will block TTS audio playback.

## Prerequisites

- **Home Assistant 2025.2.1** or later
- An [Assist Pipeline](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/) with:
- Speech-to-Text ([Whisper](https://www.home-assistant.io/integrations/whisper/), OpenAI, etc.)
- Conversation agent ([Home Assistant](https://www.home-assistant.io/integrations/conversation/), OpenAI, Qwen, etc.)
- Text-to-Speech ([Piper](https://www.home-assistant.io/integrations/piper/), Kokoro, etc.)

## Installation

### HACS (Recommended)

Voice Satellite is available in [HACS](https://hacs.xyz/). Use the link below to open the HACS repository in Home Assistant.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=jxlarrea&repository=voice-satellite-card-integration)

Or search for `Voice Satellite` in the HACS default repository.

### Manual

1. Download the [latest release ZIP file](https://github.com/jxlarrea/voice-satellite-card-integration/releases/latest)
2. Copy the `custom_components/voice_satellite` folder to your `config/custom_components/` directory
3. Restart Home Assistant

## Setup

1. Go to **Settings -> Devices & Services -> Add Integration**
2. Search for **Voice Satellite**
3. Enter a name for the device (e.g., "Kitchen Tablet")
4. Repeat for each browser/tablet that will act as a satellite
5. On each browser/tablet, open the **Voice Satellite** sidebar panel
6. Select the satellite entity you created for this device
7. Configure wake word, audio, and appearance settings as needed
8. The engine starts automatically once an entity is assigned - if the browser blocks auto-start due to a missing user gesture, a floating microphone button will appear; tap it to start

## Sidebar Panel

The sidebar panel is the central configuration hub for Voice Satellite.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/sidepanel.png" alt="Sidebar Panel" width="650"/>
</p>

### Engine Status

The top of the panel shows the current engine state (running/dormant) and pipeline status (idle, listening, processing, etc.). **Start** and **Stop** buttons let you manually control the engine.

### Satellite Entity

Select which satellite device this browser should use. Each browser must explicitly select a satellite entity before the engine will start. Create one entity per device in **Settings -> Devices & Services -> Voice Satellite**.

### Settings

All settings are stored per-browser in local storage and persist across sessions:

| Setting | Description |
|---------|-------------|
| **Auto start** | Start the engine automatically on page load. When off, use the Start button to activate manually |
| **Skin** | Select a built-in skin for the overlay UI |
| **Text Scale** | Scale all text 50-200% |
| **Background Opacity** | Override the skin's default overlay opacity (0-100%) |
| **Reactive activity bar** | Bar animates in response to mic and audio levels. Disable on slow devices |
| **Reactive bar update interval** | Controls animation smoothness (default 33ms / ~30fps) |
| **Custom CSS** | Advanced CSS overrides applied on top of the selected skin |
| **Noise suppression** | Browser-level noise suppression on the microphone input |
| **Echo cancellation** | Browser-level echo cancellation |
| **Auto gain control** | Browser-level automatic gain control |
| **Voice isolation** | AI-based voice isolation (Chrome only) |
| **Debug logging** | Show debug info in the browser console |

### Preview

A live preview of the selected skin updates as you change appearance settings.

## Integration

The integration creates a virtual Assist Satellite device for each browser, enabling timers, announcements, conversations, media player, and per-device configuration. This section covers the integration-specific features.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/integration.png" alt="Integration" width="650"/>
</p>

### Device Settings

Each satellite device exposes configuration entities on its device page (**Settings -> Devices & Services -> Voice Satellite -> [device]**):

| Entity | Type | Description |
|--------|------|-------------|
| **Announcement display duration** | Number | How long (1-60 seconds) to show the announcement text on screen after playback completes |
| **Assist pipeline** | Select | Choose which Assist pipeline to use for this satellite |
| **External screensaver** | Select | A `switch` or `input_boolean` entity to automatically turn off when a voice interaction begins (e.g., a Fully Kiosk screensaver toggle). Set to "Disabled" to skip |
| **Finished speaking detection** | Select | VAD sensitivity - how aggressively to detect end of speech |
| **Session duration** | Select | Controls how long conversation context is retained between wake word activations. After the selected duration elapses without interaction, the next wake word starts a fresh conversation. Options: "Persistent" (default — never expires, matching physical Voice PE satellite behavior), 5 minutes, 10 minutes, 15 minutes, 30 minutes, 1 hour, 3 hours, 6 hours, or "Isolated" (every wake word activation starts completely fresh). Multi-turn exchanges within a single session always share context regardless of this setting |
| **Mute** | Switch | Mute/unmute the satellite - when muted, wake word detection is paused |
| **Screensaver** | Switch | Enable/disable the built-in screensaver. When enabled, a black overlay covers the screen after the idle timeout. Dismissed on voice interaction, tap, or motion detection. On Fully Kiosk Browser with the JavaScript Interface enabled (**Advanced Web Settings -> Enable JavaScript Interface**): the backlight is dimmed to 0 on activation and restored on dismiss, and FK's camera-based motion detection automatically wakes the screen when someone approaches the device |
| **Screensaver active** | Binary sensor | Sensor showing whether the screensaver overlay is currently displayed.|
| **Screensaver timer** | Number | Idle timeout (30-600 seconds, default 60) before the screensaver activates |
| **TTS Output** | Select | Where to play TTS audio: "Browser" (default) plays audio locally, or select any `media_player` entity to route TTS to an external speaker |
| **Wake sound** | Switch | Enable/disable chime sounds (wake, done, error) |
| **Stop word interruption** | Switch | Opt-in on-device `stop` keyword detection for interruptible states such as timer alerts, TTS playback, and announcements. Disabled by default to avoid extra CPU/memory use on slower devices |
| **Wake word** | Select | Wake word to listen for when using on-device detection. Built-in models: ok_nabu, hey_jarvis, alexa, hey_mycroft, hey_home_assistant, hey_luna, okay_computer. Custom `.tflite` models are auto-discovered from the `models/` directory |
| **Wake word detection** | Select | "On Device" (default) runs wake word inference locally in the browser. "Home Assistant" uses server-side detection via the pipeline's configured wake word engine |
| **Wake word noise gate** | Switch | When enabled, wake word inference is paused during silence and resumes when sound is detected. Reduces CPU usage but may miss soft-spoken wake words. Disabled by default |
| **Wake word sensitivity** | Select | Detection sensitivity for on-device wake word: "Slightly sensitive", "Moderately sensitive" (default), or "Very sensitive" |

All settings persist across restarts.

### Satellite State Sync

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

### Entity Attributes

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
| `wake_word_model` | string | Selected primary on-device wake word model name (e.g., "ok_nabu") |
| `wake_word_model_2` | string | Selected second on-device wake word model name, or "No wake word" if disabled |
| `screensaver_enabled` | boolean | Whether the built-in screensaver is enabled |
| `screensaver_timer` | integer | Screensaver idle timeout in seconds |

Example template to check for active timers:

```yaml
{{ state_attr('assist_satellite.kitchen_tablet', 'active_timers') | length > 0 }}
```

### Voice Interaction Events

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

1. Open Developer Tools → Events
2. Type `voice_satellite_chat` in the **Listen to events** field at the bottom (it will not appear in the "Available Events" list at the top - that section only shows events with active subscribers)
3. Click START LISTENING
4. Trigger a voice interaction on your tablet

The event should fire immediately with the full payload.

## Usage

### Starting the Satellite

Once you assign a satellite entity in the sidebar panel, the engine starts automatically and begins listening for wake words. If the browser blocks auto-start due to restrictions, a floating microphone button will appear - tap it to start.

If **Auto start** is disabled in the panel settings, the engine won't start on page load. Use the **Start** button in the sidebar panel to activate it manually.

### Voice Interaction

Once running, the satellite continuously listens for your configured wake word. When detected:

1. A **wake chime** plays (if enabled) and the activity bar appears
2. **Speak your command** - the engine streams audio to your STT engine and displays the transcription in real time
3. The assistant **processes your intent** and the bar animates while thinking
4. The **TTS response plays** and the response text appears on screen
5. The bar fades and the satellite returns to **wake word listening**

If the assistant asks a follow-up question or you want to continue the conversation, the engine automatically re-enters listening mode without requiring the wake word again, allowing a natural back-and-forth exchange. This requires a conversation agent that supports multi-turn conversations, such as OpenAI, Google Generative AI, Anthropic, or Ollama. The built-in Home Assistant conversation agent does not support follow-up conversations.

### Visual States

The activity bar (styled by the selected skin) indicates the current pipeline state:

| State | Activity Bar |
|-------|-------------|
| **Listening** | Hidden (waiting for wake word) |
| **Wake Word Detected** | Visible, slow animation |
| **Processing** | Visible, fast animation |
| **Speaking** | Visible, medium animation |

When **Reactive activity bar** is enabled, the bar also responds to real-time mic input and audio output levels.

### Timers

Voice-activated timers work out of the box:

- **Start**: "Set a 5 minute timer" or "Set a pizza timer for 10 minutes"
- **Display**: Timer pills appear on screen with a live countdown
- **Alert**: When a timer finishes, an alert chime plays and the pill flashes
- **Cancel**: Double-tap the timer pill to cancel, or say "Cancel the timer"

Timer appearance is controlled by the selected skin.

### Announcements

Push TTS announcements to specific devices from automations:

```yaml
action: assist_satellite.announce
target:
  entity_id: assist_satellite.living_room_tablet
data:
  message: "Dinner is ready!"
```

Announcements include a pre-announcement chime (ding-dong), play the TTS message, and show the text on screen. If a voice interaction is in progress, the announcement queues and plays after the conversation ends. The announcement blocks until the browser confirms playback is complete (or a 120-second timeout expires), so you can chain actions that depend on the user hearing the message.

The display duration is configurable in the integration's device settings.

### Start Conversation

Automations can proactively speak a prompt and listen for the user's response:

```yaml
action: assist_satellite.start_conversation
target:
  entity_id: assist_satellite.living_room_tablet
data:
  start_message: "The garage door has been open for 30 minutes. Should I close it?"
  extra_system_prompt: "The user was asked about the garage door. If they confirm, call the close_cover service on cover.garage_door."
```

After the announcement plays, the engine automatically enters listening mode (skipping wake word detection) so the user can respond immediately. The response is processed through the configured conversation agent as a normal voice interaction.

### Ask Question

Automations can ask a question, capture the user's voice response, and match it against predefined answers:

```yaml
action: assist_satellite.ask_question
target:
  entity_id: assist_satellite.living_room_tablet
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

After the question plays, a wake chime signals the user to speak. The engine enters STT-only mode to capture the response, then matches it against the provided sentence templates using [hassil](https://github.com/home-assistant/hassil). The result is returned to the automation via `response_variable`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string \| null` | Matched answer ID (e.g., `"positive"`), or `null` if no match |
| `sentence` | `string` | Raw transcribed text from STT |
| `slots` | `dict` | Captured wildcard values from `{placeholder}` syntax |

Sentence templates use [hassil](https://github.com/home-assistant/hassil) syntax: `[optional words]` and `{wildcard}` placeholders. For example, `"play {genre} music"` captures the genre value in `answer.slots.genre`.

The engine provides audio and visual feedback: a done chime on successful match, or an error chime with a flashing red gradient bar when the response doesn't match any answer.

### Media Player

Each satellite automatically exposes a `media_player` entity in Home Assistant. This entity:

- **Controls volume** for all satellite audio (chimes, TTS, announcements) via the HA volume slider
- **Reflects playback state** - shows "Playing" whenever any sound is active on the satellite
- **Supports `tts.speak`** - target the satellite as a TTS device in automations
- **Supports `media_player.play_media`** - play arbitrary audio files on the satellite
- **Supports browsing** the HA media library

```yaml
# Play audio on the satellite
action: media_player.play_media
target:
  entity_id: media_player.kitchen_tablet_media_player
data:
  media_content_id: media-source://media_source/local/doorbell.mp3
  media_content_type: music

# Use the satellite as a TTS target
action: tts.speak
target:
  entity_id: tts.piper
data:
  media_player_entity_id: media_player.kitchen_tablet_media_player
  message: "The laundry is done!"
```

The entity supports play, pause, resume, stop, volume set, and volume mute - all controllable from the HA UI or automations.

## Mini Card

`voice-satellite-mini-card` is a text-first dashboard card that shows conversation status and transcripts inline. It shares the global engine - no separate entity or microphone configuration needed.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/minicard.png" alt="Mini card" width="650"/>
</p>

### Modes

- **Compact** - single-line status + conversation text with marquee scrolling when content overflows
- **Tall** - status row + scrolling transcript + timer badges inside the card. Occupies 3 grid rows by default in Sections dashboards (min 2, max 12)

### Mini Card Features

- Home Assistant theme colors, radius, and typography variables
- `text_scale` support plus `custom_css` override
- Timers, announcements, `ask_question`, and `start_conversation` status/text feedback
- **Suppress overlay** option hides the fullscreen voice UI while the mini card is on screen
- Works in Sections and Masonry dashboards

### Mini Card Configuration Reference

```yaml
type: custom:voice-satellite-mini-card

# Layout
mini_mode: compact                 # 'compact' or 'tall'
text_scale: 100                    # Scale text 50-200%
suppress_full_card: true           # Hide the fullscreen overlay when this mini card is active
custom_css: ''                     # CSS overrides inside the mini card shadow DOM
```

> **Note:** Entity selection, microphone settings, and debug logging are configured globally in the sidebar panel - not in the mini card editor.

## On-Device Wake Word Detection

Voice Satellite includes built-in wake word detection that runs entirely in the browser - no server-side wake word service required.

### How It Works

On-device detection uses [microWakeWord](https://github.com/kahrendt/microWakeWord) TFLite models running via TensorFlow Lite WebAssembly. The browser continuously processes audio and runs lightweight keyword classifiers to detect the wake word. Audio is only streamed to Home Assistant after detection. This means:

- **Lower latency** - detection happens instantly on the device, no network round-trip
- **Reduced server load** - audio is only sent to HA for STT after the wake word is detected
- **No wake word add-on required** - works without openWakeWord or microWakeWord installed on HA
- **Energy-efficient** - optional noise gate pauses inference during silence and resumes instantly when sound is detected (enable via the "Wake word noise gate" switch)
- **Optional stop-word interruption** - enable the "Stop word interruption" switch if you want the browser to listen for `stop` during timer alerts, TTS, and announcement playback

### Built-in Wake Words

| Model | Wake Phrase |
|-------|-------------|
| **ok_nabu** (default) | "OK Nabu" |
| **hey_jarvis** | "Hey Jarvis" |
| **alexa** | "Alexa" |
| **hey_mycroft** | "Hey Mycroft" |
| **hey_home_assistant** | "Hey Home Assistant" |
| **hey_luna** | "Hey Luna" |
| **okay_computer** | "Okay Computer" |

### Custom Wake Words

You can add your own microWakeWord TFLite models:

1. Train a custom wake word model using [microWakeWord](https://github.com/kahrendt/microWakeWord), or download a community model from the [esphome/micro-wake-word-models](https://github.com/esphome/micro-wake-word-models) repository
2. Place the `.tflite` file in one of these directories:
   - **`config/voice_satellite/models/`** (recommended) - persists across HACS updates
   - `custom_components/voice_satellite/models/` - works but files are lost on integration updates
3. Restart Home Assistant
4. The custom model will appear in the "Wake word model" dropdown on the satellite's device page

The filename (without `.tflite`) becomes the option name in the dropdown. For example, `hey_computer.tflite` appears as "hey_computer".

> **Note:** Custom models placed directly in the integration's `models/` directory are automatically backed up to `config/voice_satellite/models/` on startup and restored after updates.

### Configuration

All wake word settings are configured per-device on the satellite's device page (**Settings -> Devices & Services -> Voice Satellite -> [device]**):

- **Wake word detection** - "On Device" (default) or "Home Assistant" (server-side)
- **Wake word** - select the wake word to listen for
- **Stop word interruption** - optional on-device `stop` keyword that can cancel timer alerts, TTS, and announcement playback. Disabled by default
- **Wake word sensitivity** - "Slightly sensitive", "Moderately sensitive" (default), or "Very sensitive"

To use server-side detection instead, set "Wake word detection" to "Home Assistant". This requires a wake word service (openWakeWord or microWakeWord) configured in your Assist pipeline.

## Custom Sounds

Voice Satellite's built-in sound files live in `custom_components/voice_satellite/sounds/` as MP3s:

- `wake.mp3`
- `done.mp3`
- `error.mp3`
- `alert.mp3`
- `announce.mp3`

If you want custom sounds to survive HACS upgrades, place them in:

- **`config/voice_satellite/sounds/`** (recommended) - persists across updates

On startup, the integration restores `.mp3` files from `config/voice_satellite/sounds/` into the integration's `sounds/` folder. If a file uses a built-in filename such as `wake.mp3` or `alert.mp3`, it replaces the shipped version on startup. If you manually drop a non-built-in MP3 directly into `custom_components/voice_satellite/sounds/`, it is also backed up to `config/voice_satellite/sounds/` on the next startup.

## Skins

Voice Satellite includes a skin system that themes the entire overlay UI - activity bar, text display, timers, and background. Select a skin in the sidebar panel under **Settings**.

<img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/skins.jpg" alt="Skins" width="100%"/>

### Built-in Skins

| Skin | Description |
|------|-------------|
| **Default** | Rainbow gradient bar with enhanced glow, floating text with colored fading borders, white overlay |
| **Alexa** | Cyan glow bar, dark overlay, centered bold text, Echo-inspired design |
| **Google Home** | Four-color Google gradient bar, left-aligned text, Nest-inspired design. Supports light and dark mode which automatically follows your HA theme or can be forced via the Theme Mode setting |
| **Home Assistant** | Matches your HA theme natively in both light and dark mode. All colors derived from your theme's primary color and card background via CSS custom properties — automatically adapts to any HA theme. Monochromatic four-tone activity bar with flowing gradient animation |
| **Retro Terminal** | Green phosphor CRT aesthetic with scanlines, bezel frame, monospace font, and screen-edge glow |
| **Siri** | Full-screen gradient border glow (purple -> blue -> teal -> pink), dark frosted overlay, centered clean text, Apple-inspired design |
| **Waveform** | Animated flowing neon waveform with strands that react to audio in real time. Automatically adapts to light and dark modes based on your Home Assistant theme settings. **GPU-intensive! Not recommended for low-end devices** |

### Custom CSS

Each skin defines CSS classes for all UI elements. Use the **Custom CSS** field in the sidebar panel to override any skin style. For example, to change the font family across all elements:

```css
#voice-satellite-ui {
  font-family: "Comic Sans MS", cursive;
}
```

### Waveform Skin CSS Variables

The Waveform skin exposes CSS variables for full color customization of strands, background, and UI elements. Override them in the **Custom CSS** field. Dark and light themes have independent variables — set them separately to customize each mode.

#### Available Variables

| Variable | Description |
|----------|-------------|
| `--wf-overlay` | Full-screen background behind everything |
| `--wf-surface` | Background of elevated UI elements (panels, timers) |
| `--wf-surface-glass` | Transparent panel background over the waveform |
| `--wf-text` | Primary text color |
| `--wf-text-dim` | Secondary/dimmed text color |
| `--wf-text-muted` | Muted text color |
| `--wf-accent` | Accent color (progress bars, highlights) |
| `--wf-strand-1` through `--wf-strand-7` | Strand colors (1 = outermost glow, 7 = innermost core) |
| `--wf-strand-error-1` through `--wf-strand-error-7` | Strand colors during error state |

#### Example: Monochrome Theme

<p align="center">
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/waveform_mono_light.jpg" alt="Waveform Skin Light Monochrome" width="49%"/>
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/waveform_mono_dark.jpg" alt="Waveform Skin Dark Monochrome" width="49%"/>
</p>

```css
/* Monochrome dark */
#voice-satellite-ui.vs-dark {
  --wf-overlay: #000000;
  --wf-surface: #1a1a1a;
  --wf-surface-glass: rgba(26, 26, 26, 0.40);
  --wf-text: #e0e0e0;
  --wf-text-dim: rgba(224, 224, 224, 0.5);
  --wf-text-muted: #888888;
  --wf-accent: #aaaaaa;
  --wf-strand-1: #1a1a1a;
  --wf-strand-2: #333333;
  --wf-strand-3: #555555;
  --wf-strand-4: #666666;
  --wf-strand-5: #888888;
  --wf-strand-6: #aaaaaa;
  --wf-strand-7: #cccccc;
}

/* Monochrome light */
#voice-satellite-ui.vs-light {
  --wf-overlay: #f0f0f0;
  --wf-surface: #ffffff;
  --wf-surface-glass: rgba(255, 255, 255, 0.35);
  --wf-text: #1a1a1a;
  --wf-text-dim: rgba(26, 26, 26, 0.45);
  --wf-text-muted: #777777;
  --wf-accent: #555555;
  --wf-strand-1: #cccccc;
  --wf-strand-2: #aaaaaa;
  --wf-strand-3: #888888;
  --wf-strand-4: #777777;
  --wf-strand-5: #555555;
  --wf-strand-6: #333333;
  --wf-strand-7: #1a1a1a;
}
```

## Experimental: LLM Tools

Voice Satellite supports displaying rich visual results from LLM tool calls inline during voice interactions. These features require the **[Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)** integration, which provides the tools to your conversation agent.

> **Requirements:**
> - Install the **[Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)** integration, which provides the search tools to your conversation agent.
> - Your Assist pipeline must use a **conversational AI agent** (e.g., OpenAI, Google Generative AI, Anthropic, Ollama, etc.). The built-in Home Assistant conversation agent does not support tool calling and cannot use these features.

### Image Search

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/cats.jpg" alt="Image Search" width="650"/>
</p>

Ask your assistant to search for images:

- *"Show me images of golden retrievers"*
- *"Search for pictures of the Eiffel Tower"*

Results appear as a thumbnail grid in the media panel. Tap any image to view it fullscreen in a lightbox. The panel stays visible for 30 seconds after TTS completes, and can be dismissed at any time with a double-tap, double-click, or the Escape key.

### Video Search

<p align="center">
   <img src="https://github.com/jxlarrea/voice-satellite-card-integration/blob/main/assets/screenshots/mrbeast.jpg" alt="Video Search" width="650"/>
</p>

Ask your assistant to search for videos:

- *"Search for cooking videos"*
- *"Find YouTube videos about woodworking"*

Results appear as video cards showing the thumbnail, duration, title, and channel name. Tap any video to play it in the lightbox via YouTube embed. When a video is playing, TTS audio is automatically suppressed.

### Web Search

Ask your assistant to search the web:

- *"Search the web for Home Assistant 2025 new features"*
- *"Look up the latest SpaceX launch"*

The assistant responds with a summary of the search results. If the search returns a relevant featured image, it is displayed alongside the response.

### Wikipedia Search

Ask your assistant to look up topics on Wikipedia:

- *"Tell me about the James Webb Space Telescope"*
- *"Look up the history of the Roman Empire"*

The assistant responds with a summary from the Wikipedia article. If the article includes a main image, it is displayed alongside the response.

### Weather Forecast

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/weather2.jpg" alt="Weather" width="650"/>
</p>

Ask your assistant about the weather:

- *"What's the weather today?"*
- *"What's the forecast for this week?"*

The assistant responds with a spoken summary while displaying a weather card in the media panel showing the current temperature, condition, humidity, and a scrollable forecast (hourly, daily, or twice-daily depending on the range requested). The weather icon is sourced from Google Weather SVGs via Home Assistant. The weather card uses the same featured panel layout as web search and Wikipedia — it appears alongside the chat response and dismisses immediately after TTS completes (no 30-second linger).

### Financial Data

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/currency2.jpg" alt="Stocks" width="650"/>
</p>

Ask your assistant about stocks, crypto, or currency conversions:

- *"What's Apple's stock price?"*
- *"How much is Bitcoin right now?"*
- *"Convert 100 USD to EUR"*

**Stocks and crypto** display a financial card showing the company or coin name, exchange badge, current price, color-coded change indicator (green with up arrow for gains, red with down arrow for losses), and key details like open/high/low prices or market cap. If available, a logo is displayed alongside the name.

**Currency conversions** display the converted amount prominently with the exchange rate below.

The financial card uses the same featured panel layout as weather — it appears alongside the chat response and dismisses immediately after TTS completes.

## Troubleshooting

### Nothing happens when I tap Start

1. **Check HTTPS:** Browsers require HTTPS for microphone access. If you're using HTTP, the microphone permission prompt won't appear. Use HTTPS or access via `localhost`.
2. **Check browser permissions:** Make sure the browser has microphone permission for your HA URL. Look for a microphone icon in the address bar.
3. **Check Fully Kiosk settings:** If using Fully Kiosk, ensure **Web Content Settings -> Enable Microphone Access** and **Autoplay Audio** are enabled.
4. **Check the browser console:** Open the developer tools (F12) and look for errors.

### Wake word not detected

**On-device mode (default):**

1. **Check the device settings:** Go to the satellite's device page and verify "Wake word detection" is set to "On Device" and a wake word model is selected.
2. **Try adjusting sensitivity:** Change "Wake word sensitivity" to "Very sensitive" to see if detection improves.
3. **Check browser compatibility:** On-device detection uses WebAssembly (TFLite). Ensure your browser supports WASM - all modern browsers do, but very old versions may not.
4. Enable **Debug logging** in the sidebar panel to see wake word scores in the browser console (F12).

**Server-side mode ("Home Assistant"):**

1. **Verify your wake word service is running:** Check that your wake word engine (e.g., openWakeWord, microWakeWord) is available to Home Assistant — either as an add-on (**Settings -> Add-ons**) or as a Wyoming integration (**Settings -> Devices & Services**).
2. **Verify wake word detection is enabled in your pipeline:** Go to **Settings -> Voice assistants**, select your pipeline, and check that a wake word is selected. **This setting is hidden by default** — click the **⋮ three-dot menu** at the top right of the pipeline settings to reveal the wake word configuration dropdown.
3. Enable **Debug logging** in the sidebar panel to see pipeline events in the browser console (F12).

### No audio response

1. Check that TTS is configured in your Assist pipeline.
2. Check browser audio permissions.
3. If **using Fully Kiosk**, ensure that **Web Content Settings** -> **Autoplay Audio** is enabled.
4. The **Home Assistant Companion App** may block audio autoplay by default, ensure that **Settings** -> **Companion App** -> **Other settings** -> **Autoplay videos** is enabled.

Without these settings, Voice Satellite will still function (wake word detection, speech-to-text, and visual feedback all work normally) but TTS audio won't play. The UI will clean up gracefully after the interaction completes.

## Contributing

Contributions are welcome. Please feel free to submit issues or pull requests.

## License

MIT License - see [LICENSE](LICENSE) for details.
