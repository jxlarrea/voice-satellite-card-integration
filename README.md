# <img width="48" height="48" alt="icon" src="https://github.com/user-attachments/assets/31b4a789-bae3-4428-a543-85063f17109c" /> Voice Satellite Card for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-blue.svg?style=for-the-badge)](https://www.hacs.xyz/docs/faq/custom_repositories/)
[![Downloads](https://img.shields.io/github/downloads/jxlarrea/voice-satellite-card-integration/total?style=for-the-badge&label=Downloads&color=red)](https://github.com/jxlarrea/voice-satellite-card-integration/releases)
[![version](https://shields.io/github/v/release/jxlarrea/voice-satellite-card-integration?style=for-the-badge&color=orange)](https://github.com/jxlarrea/voice-satellite-card-integration/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/jxlarrea/voice-satellite-card-integration/release.yml?style=for-the-badge&label=Build)](https://github.com/jxlarrea/voice-satellite-card-integration/actions/workflows/release.yml)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jxlarrea)

Transform any browser into a full-featured voice satellite for Home Assistant's Assist. This single package includes both a **Lovelace card** and a **custom integration** that work together to give your browser-based devices true satellite identity — with feature parity with physical voice assistants like the [Home Assistant Voice Preview Edition](https://www.home-assistant.io/voice-pe/), including wake word detection, timers, announcements, conversations, and more.

## Screenshots
<p align="center">
 <img src="https://github.com/user-attachments/assets/4a6ca843-af42-4854-8d42-daa84c469855" alt="Assist" width="49%"/>
 <img src="https://github.com/user-attachments/assets/64a59c56-a2e8-434f-a814-ad36248b624b" alt="Video Search" width="49%"/>
    <img src="https://github.com/user-attachments/assets/bf7ad673-2aec-4c26-9a5f-5ff5f254c33a" alt="Weather" width="49%"/>
  <img src="https://github.com/user-attachments/assets/88eb4d51-ba64-453d-875b-0ed8f02f644c" alt="Stocks" width="49%"/>
</p>

## Table of Contents

- [Why This Card?](#why-this-card)
- [Important: Browser Requirements](#important-browser-requirements)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Setup](#setup)
- [Integration](#integration)
- [Usage](#usage)
- [Skins](#skins)
- [Experimental: LLM Tools](#experimental-llm-tools)
- [Troubleshooting](#troubleshooting)
- [Requirements](#requirements)
- [Contributing](#contributing)
- [License](#license)

## Why This Card?

Home Assistant's built-in voice features require dedicated hardware like ESPHome devices or the Home Assistant Voice Preview Edition. But what if you already have a tablet mounted on your wall running the Home Assistant dashboard?

**Voice Satellite Card** solves this by:

- **Turning your browser into a real satellite** - Registered as a proper `assist_satellite` device in Home Assistant, with the same capabilities as hardware satellites.
- **Using your browser's microphone** - No additional hardware needed.
- **Supporting wake words** - Say "OK Nabu" or your custom wake word to activate.
- **Playing TTS responses** - Hear responses directly from your device or a remote media player.
- **Media player entity** - Each satellite exposes a media player in HA for volume control, `tts.speak` targeting, and `media_player.play_media` from automations.
- **Providing voice-activated timers** - Set, update, and cancel timers with on-screen countdown pills.
- **Receiving announcements** - Push TTS messages to specific devices from automations.
- **Supporting interactive conversations** - Automations can proactively ask questions and listen for responses.
- **Providing visual feedback** - Themed gradient bar shows current state, with transcription and response text.
- **Skin system** - Choose between built-in skins (Default, Alexa, Google Home, Retro Terminal) that theme the entire UI.
- **Working on any device** - Tablets, phones, computers, kiosks.

Perfect for wall-mounted tablets, kiosk displays, or any browser-based Home Assistant setup.

Check out this quick demo of the Voice Satellite Card! (Make sure your volume is up):

https://github.com/user-attachments/assets/77dda388-330c-4544-84ea-0ead6cdaad17

## Important: Browser Requirements

**Warning:** This card requires microphone access and works best when:

1. **The browser has microphone permissions granted** - You will be prompted on first use.
2. **The page is served over HTTPS** - Required for microphone access in modern browsers.
3. **The screen stays on** - If the device screen turns off completely, the microphone will stop working. Use a screensaver instead of screen-off to keep the mic active.

For kiosk setups like [Fully Kiosk Browser](https://play.google.com/store/apps/details?id=de.ozerov.fully), make sure to enable microphone permissions and use the screensaver feature (not screen off) to keep the microphone active while dimming the display.

For the **Home Assistant Companion App**, enable **Autoplay videos** in Settings → Companion App → Other settings. Without this, the WebView will block TTS audio playback.

## Features

- **Wake Word Detection** - Uses Home Assistant's configured wake word detection (like Wyoming openWakeWord or microWakeWord) for server-side processing.
- **Works Across Views** - Pipeline stays active when switching dashboard views.
- **Auto-Start** - Automatically begins listening on page load (with fallback button).
- **Visual Feedback** - Themed gradient activity bar shows listening/processing/speaking states with optional reactive audio-level animation.
- **Skins** - Built-in skins (Default, Alexa, Google Home, Retro Terminal, Siri) that theme the activity bar, text display, timers, and overlay. Customizable with CSS overrides.
- **Transcription & Response Display** - Shows what was understood and the assistant's response with real-time streaming.
- **Continue Conversation** - When the assistant asks a follow-up question, the card automatically listens for a response without requiring the wake word again. Conversation history is displayed on screen.
- **Timers** - Voice-activated timers with on-screen countdown pills, alert chimes, and cancel via double-tap or voice.
- **Announcements** - Receive `assist_satellite.announce` service calls with pre-announcement chimes and TTS playback. Queues behind active conversations.
- **Start Conversation** - Receive `assist_satellite.start_conversation` calls that speak a prompt then automatically listen for the user's response.
- **Ask Question** - Receive `assist_satellite.ask_question` calls that speak a question, capture the user's voice response, and match it against predefined answers using hassil sentence templates. Returns structured results to the calling automation.
- **Screensaver Control** - Automatically dismisses a configured screensaver entity when a voice interaction begins.
- **Media Player Entity** - Each satellite exposes a `media_player` entity. Volume is controlled via the entity's volume slider in HA and applies to all audio (chimes, TTS, announcements). Supports `tts.speak` and `media_player.play_media` targeting from automations.
- **LLM Tools** *(Experimental)* - Enhance your voice assistant with visual tools: search for images and YouTube videos displayed in a media panel, get web search results with featured images, look up Wikipedia articles with summaries and images, view weather forecasts with current conditions and scrollable daily/hourly rows, and check stock prices, crypto prices, and currency conversions with color-coded change indicators. Requires the [Voice Satellite Card - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools) integration.

## Prerequisites

Set up an [Assist Pipeline](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/) with:
   - Wake word detection (e.g., [openWakeWord](https://www.home-assistant.io/voice_control/install_wake_word_add_on/), [microWakeWord](https://www.home-assistant.io/integrations/micro_wake_word/))
   - Speech-to-Text ([Whisper](https://www.home-assistant.io/integrations/whisper/), OpenAI, etc.)
   - Conversation agent ([Home Assistant](https://www.home-assistant.io/integrations/conversation/), OpenAI, Qwen, etc.)
   - Text-to-Speech ([Piper](https://www.home-assistant.io/integrations/piper/), Kokoro, etc.)

> **Important:** Your wake word service must be **available to Home Assistant as a Wyoming integration** (either as an add-on or an external Wyoming instance) AND **enabled in your Assist pipeline**. The wake word option is hidden by default in the pipeline settings — go to **Settings → Voice assistants**, select your pipeline, click the **⋮ three-dot menu** at the top right of the pipeline settings to reveal the wake word configuration dropdown. If no wake word option appears, your wake word service is not installed or not detected by Home Assistant.

## Installation

### HACS (Recommended)

1. Add this repository as a custom repository in HACS (type: Integration)
2. Search for `Voice Satellite Card` and install
3. Restart Home Assistant

### Manual

1. Download the [latest release ZIP file](https://github.com/jxlarrea/voice-satellite-card-integration/releases/latest).
1. Copy the `custom_components/voice_satellite` folder to your `config/custom_components/` directory
2. Restart Home Assistant

## Setup

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **Voice Satellite Card**
3. Enter a name for the device (e.g., "Kitchen Tablet")
4. Repeat for each browser device that will act as a satellite

Each entry creates a full satellite device. Then add the card to any dashboard view and select your satellite entity:

```yaml
type: custom:voice-satellite-card
satellite_entity: assist_satellite.kitchen_tablet
```

The card will start listening automatically using your configured pipeline.

### Per-Device Satellite Override

If you share a single dashboard across multiple wall-mounted tablets, each device needs to use a different satellite entity. Normally this requires a separate dashboard or view per device. The **Per-device satellite override** option solves this by letting each browser pick its own satellite at runtime.

When enabled, a popup appears on each device asking the user to select which satellite to use. The selection is saved in the browser's local storage, so it persists across page reloads and only needs to be set once per device. This overrides whatever `satellite_entity` is configured in the card YAML.

```yaml
type: custom:voice-satellite-card
satellite_entity: assist_satellite.kitchen_tablet
browser_satellite_override: true
```

If only one satellite entity exists, it is auto-selected without showing the popup.

The popup also includes a **Disable on this device** option for devices where you don't want the satellite to activate at all (e.g., phones, desktop browsers). Disabled devices will not prompt for microphone access or start any voice pipeline.

To change the selected satellite or re-enable a disabled device, toggle the option off and on again in the card editor.

### Visual Editor

All options are available in the visual card editor with a live preview that updates as you change settings.

### Full Configuration Reference

```yaml
type: custom:voice-satellite-card

# Behavior
satellite_entity: ''               # (Required) assist_satellite entity from the integration
browser_satellite_override: false  # Per-device satellite selection via browser popup
debug: false                       # Show debug info in browser console

# Appearance
skin: default                      # 'default', 'alexa', 'google-home', 'retro-terminal', or 'siri'
reactive_bar: true                 # Activity bar reacts to audio levels
text_scale: 100                    # Scale all text 50-200%
background_opacity: 100            # Override skin's default overlay opacity (0-100%)
custom_css: ''                     # CSS overrides applied on top of the selected skin

# Microphone Processing
noise_suppression: true            # Enable noise suppression
echo_cancellation: true            # Enable echo cancellation
auto_gain_control: true            # Enable automatic gain control
voice_isolation: false             # AI-based voice isolation (Chrome only)
```

> **Note:** Settings like TTS output, screensaver entity, and announcement display duration are configured per-device in the integration's device page (**Settings → Devices & Services → Voice Satellite Card → [device]**).

## Integration

The integration creates a virtual Assist Satellite device for each browser, enabling timers, announcements, conversations, media player, and per-device configuration. This section covers the integration-specific features.

![Screenshot](https://github.com/user-attachments/assets/03c80c6e-7c21-473b-9975-c012212d8251)

### Device Settings

Each satellite device exposes configuration entities on its device page (**Settings → Devices & Services → Voice Satellite Card → [device]**):

| Entity | Type | Description |
|--------|------|-------------|
| **Assist pipeline** | Select | Choose which Assist pipeline to use for this satellite |
| **Finished speaking detection** | Select | VAD sensitivity — how aggressively to detect end of speech |
| **TTS Output** | Select | Where to play TTS audio: "Browser" (default) plays audio locally, or select any `media_player` entity to route TTS to an external speaker |
| **Screensaver** | Select | A `switch` or `input_boolean` entity to automatically turn off when a voice interaction begins (e.g., a Fully Kiosk screensaver toggle). Set to "Disabled" to skip |
| **Announcement display duration** | Number | How long (1–60 seconds) to show the announcement text on screen after playback completes |
| **Mute** | Switch | Mute/unmute the satellite — when muted, wake word detection is paused |
| **Wake sound** | Switch | Enable/disable chime sounds (wake, done, error) |

All settings persist across restarts.

### Satellite State Sync

The card syncs its pipeline state back to the entity in real time. This means the entity accurately reflects what the satellite is doing:

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

### Entity Attributes

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

## Usage

### Starting the Satellite

The card will automatically request microphone access and begin listening when loaded. If the browser blocks auto-start due to restrictions, a floating microphone button will appear — click it to start.

### Voice Interaction

Once running, the satellite continuously listens for your configured wake word. When detected:

1. A **wake chime** plays (if enabled) and the activity bar appears
2. **Speak your command** — the card streams audio to your STT engine and displays the transcription in real time
3. The assistant **processes your intent** and the bar animates while thinking
4. The **TTS response plays** and the response text appears on screen
5. The bar fades and the satellite returns to **wake word listening**

If the assistant asks a follow-up question or you want to continue the conversation, the card automatically re-enters listening mode without requiring the wake word again, allowing a natural back-and-forth exchange. This requires a conversation agent that supports multi-turn conversations, such as OpenAI, Google Generative AI, Anthropic, or Ollama. The built-in Home Assistant conversation agent does not support follow-up conversations.

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

Announcements include a pre-announcement chime (ding-dong), play the TTS message, and show the text on screen. If a voice interaction is in progress, the announcement queues and plays after the conversation ends. The announcement blocks until the card confirms playback is complete (or a 120-second timeout expires), so you can chain actions that depend on the user hearing the message.

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

After the announcement plays, the card automatically enters listening mode (skipping wake word detection) so the user can respond immediately. The response is processed through the configured conversation agent as a normal voice interaction.

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

After the question plays, a wake chime signals the user to speak. The card enters STT-only mode to capture the response, then matches it against the provided sentence templates using [hassil](https://github.com/home-assistant/hassil). The result is returned to the automation via `response_variable`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string \| null` | Matched answer ID (e.g., `"positive"`), or `null` if no match |
| `sentence` | `string` | Raw transcribed text from STT |
| `slots` | `dict` | Captured wildcard values from `{placeholder}` syntax |

Sentence templates use [hassil](https://github.com/home-assistant/hassil) syntax: `[optional words]` and `{wildcard}` placeholders. For example, `"play {genre} music"` captures the genre value in `answer.slots.genre`.

The card provides audio and visual feedback: a done chime on successful match, or an error chime with a flashing red gradient bar when the response doesn't match any answer.

### Media Player

Each satellite automatically exposes a `media_player` entity in Home Assistant. This entity:

- **Controls volume** for all satellite audio (chimes, TTS, announcements) via the HA volume slider
- **Reflects playback state** — shows "Playing" whenever any sound is active on the satellite
- **Supports `tts.speak`** — target the satellite as a TTS device in automations
- **Supports `media_player.play_media`** — play arbitrary audio files on the satellite
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

The entity supports play, pause, resume, stop, volume set, and volume mute — all controllable from the HA UI or automations.

## Skins

The card includes a skin system that themes the entire UI — activity bar, text display, timers, and background overlay. Select a skin in the card editor under **Appearance**.

![skins](https://github.com/user-attachments/assets/436029a8-c199-4773-b50f-428598e66ff4)

### Built-in Skins

| Skin | Description |
|------|-------------|
| **Default** | Rainbow gradient bar with enhanced glow, floating text with colored fading borders, white overlay |
| **Alexa** | Cyan glow bar, dark overlay, centered bold text, Echo-inspired design |
| **Google Home** | Four-color Google gradient bar, left-aligned text, light overlay, Nest-inspired design |
| **Retro Terminal** | Green phosphor CRT aesthetic with scanlines, bezel frame, monospace font, and screen-edge glow |
| **Siri** | Full-screen gradient border glow (purple → blue → teal → pink), dark frosted overlay, centered clean text, Apple-inspired design |

### Appearance Options

| Option | Description |
|--------|-------------|
| **Skin** | Select a built-in skin |
| **Reactive activity bar** | Bar animates in response to mic and audio levels. Disable on slow devices to save resources |
| **Text Scale** | Scale all text (transcriptions, responses, timers) from 50% to 200% |
| **Background Opacity** | Override the skin's default overlay opacity (0–100%) |
| **Custom CSS** | Advanced: CSS rules applied on top of the selected skin for fine-tuning colors, fonts, sizes, etc. |

### Custom CSS

Each skin defines CSS classes for all UI elements. Use the **Custom CSS** field to override any skin style. For example, to change the font family across all elements:

```css
#voice-satellite-ui {
  font-family: "Comic Sans MS", cursive;
}
```

## Experimental: LLM Tools

The card supports displaying rich visual results from LLM tool calls inline during voice interactions. These features require the **[Voice Satellite Card - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)** integration, which provides the tools to your conversation agent.

> **Requirements:**
> - Install the **[Voice Satellite Card - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)** integration, which provides the search tools to your conversation agent.
> - Your Assist pipeline must use a **conversational AI agent** (e.g., OpenAI, Google Generative AI, Anthropic, Ollama, etc.). The built-in Home Assistant conversation agent does not support tool calling and cannot use these features.

### Image Search

![Screenshot_20260223_202424_Fully Kiosk Browser](https://github.com/user-attachments/assets/bad9d374-4ecb-4572-86da-1993a400b368)

Ask your assistant to search for images:

- *"Show me images of golden retrievers"*
- *"Search for pictures of the Eiffel Tower"*

Results appear as a thumbnail grid in the media panel. Tap any image to view it fullscreen in a lightbox. The panel stays visible for 30 seconds after TTS completes, and can be dismissed at any time with a double-tap, double-click, or the Escape key.

### Video Search

![Screenshot_20260223_202336_Fully Kiosk Browser](https://github.com/user-attachments/assets/010f9501-e637-470a-97be-3ecf1585d884)

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

![Weather](https://github.com/user-attachments/assets/f0e0766e-f570-4892-b0bc-e532c0ce80c9)

Ask your assistant about the weather:

- *"What's the weather today?"*
- *"What's the forecast for this week?"*

The assistant responds with a spoken summary while displaying a weather card in the media panel showing the current temperature, condition, humidity, and a scrollable forecast (hourly, daily, or twice-daily depending on the range requested). The weather icon is sourced from Google Weather SVGs via Home Assistant. The weather card uses the same featured panel layout as web search and Wikipedia — it appears alongside the chat response and dismisses immediately after TTS completes (no 30-second linger).

### Financial Data

![Stocks](https://github.com/user-attachments/assets/e3e25cde-fe6b-4c21-9131-582fa7db3a5e)

Ask your assistant about stocks, crypto, or currency conversions:

- *"What's Apple's stock price?"*
- *"How much is Bitcoin right now?"*
- *"Convert 100 USD to EUR"*

**Stocks and crypto** display a financial card showing the company or coin name, exchange badge, current price, color-coded change indicator (green with up arrow for gains, red with down arrow for losses), and key details like open/high/low prices or market cap. If available, a logo is displayed alongside the name.

**Currency conversions** display the converted amount prominently with the exchange rate below.

The financial card uses the same featured panel layout as weather — it appears alongside the chat response and dismisses immediately after TTS completes.

## Troubleshooting

### Nothing happens when I tap the microphone

1. **Check HTTPS:** Browsers require HTTPS for microphone access. If you're using HTTP, the microphone permission prompt won't appear. Use HTTPS or access via `localhost`.
2. **Check browser permissions:** Make sure the browser has microphone permission for your HA URL. Look for a microphone icon in the address bar.
3. **Check Fully Kiosk settings:** If using Fully Kiosk, ensure **Web Content Settings → Enable Microphone Access** and **Autoplay Audio** are enabled.
4. **Try the manual start:** If auto-start fails, tap the blue microphone button to start manually. Check the browser console (F12) for errors.

### Wake word not detected

1. **Verify your wake word service is running:** Check that your wake word engine (e.g., openWakeWord, microWakeWord) is available to Home Assistant — either as an add-on (**Settings → Add-ons**) or as a Wyoming integration (**Settings → Devices & Services**).
2. **Verify wake word detection is enabled in your pipeline:** Go to **Settings → Voice assistants**, select your pipeline, and check that a wake word is selected. **This setting is hidden by default** — click the **⋮ three-dot menu** at the top right of the pipeline settings to reveal the wake word configuration dropdown.
3. Enable `debug: true` in the card config to see pipeline events in the browser console (F12).

### No audio response

1. Check that TTS is configured in your Assist pipeline.
2. Check browser audio permissions.
3. If **using Fully Kiosk**, ensure that **Web Content Settings** → **Autoplay Audio** is enabled.
4. The **Home Assistant Companion App** may block audio autoplay by default, ensure that **Settings** → **Companion App** → **Other settings** → **Autoplay videos** is enabled.

Without these settings, the card will still function (wake word detection, speech-to-text, and visual feedback all work normally) but TTS audio won't play. The UI will clean up gracefully after the interaction completes.

### Card not visible

This is intentional. The card itself is invisible and only shows the gradient bar and transcription text when active. Add it to any view and it will work in the background.

## Requirements

- Home Assistant 2025.2.1 or later

## Contributing

Contributions are welcome. Please feel free to submit issues or pull requests.

## License

MIT License - see [LICENSE](LICENSE) for details.
