# <img width="48" height="48" alt="icon" src="https://github.com/user-attachments/assets/dc2d3715-335b-4cf4-865f-31d622f8d2e7" /> Voice Satellite Card for Home Assistant

Transform any browser into a full-featured voice satellite for Home Assistant's Assist. Combined with the **required** [Voice Satellite Card Integration](https://github.com/jxlarrea/voice-satellite-card-integration), this card gives your browser-based devices true satellite identity — with feature parity with physical voice assistants like the [Home Assistant Voice Preview Edition](https://www.home-assistant.io/voice-pe/), including wake word detection, timers, announcements, conversations, and more.

[![hacs_badge](https://img.shields.io/badge/HACS-Default-orange.svg?style=for-the-badge)](https://my.home-assistant.io/redirect/hacs_repository/?owner=jxlarrea&repository=Voice-Satellite-Card-for-Home-Assistant)
[![version](https://shields.io/github/v/release/jxlarrea/Voice-Satellite-Card-for-Home-Assistant?style=for-the-badge)](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/releases)
[![Downloads](https://img.shields.io/github/downloads/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/total?style=for-the-badge&label=Downloads&color=red)](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/release.yml?style=for-the-badge&label=Build)](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/actions/workflows/release.yml)

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jxlarrea)

![Screenshot](https://github.com/user-attachments/assets/178d8639-bf05-409e-8bc7-f4283fb36593)

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
- **Skin system** - Choose between built-in skins (Default, Alexa, Google Home) that theme the entire UI.
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
- **Skins** - Built-in skins (Default, Alexa, Google Home) that theme the activity bar, text display, timers, and overlay. Customizable with CSS overrides.
- **Transcription & Response Display** - Shows what was understood and the assistant's response with real-time streaming.
- **Continue Conversation** - When the assistant asks a follow-up question, the card automatically listens for a response without requiring the wake word again. Conversation history is displayed on screen.
- **Timers** - Voice-activated timers with on-screen countdown pills, alert chimes, and cancel via double-tap or voice.
- **Announcements** - Receive `assist_satellite.announce` service calls with pre-announcement chimes and TTS playback. Queues behind active conversations.
- **Start Conversation** - Receive `assist_satellite.start_conversation` calls that speak a prompt then automatically listen for the user's response.
- **Ask Question** - Receive `assist_satellite.ask_question` calls that speak a question, capture the user's voice response, and match it against predefined answers using hassil sentence templates. Returns structured results to the calling automation.
- **Screensaver Control** - Automatically dismisses a configured screensaver entity when a voice interaction begins.
- **Media Player Entity** - Each satellite exposes a `media_player` entity. Volume is controlled via the entity's volume slider in HA and applies to all audio (chimes, TTS, announcements). Supports `tts.speak` and `media_player.play_media` targeting from automations.

## Prerequisites

Before using this card, you need:

### 1. Voice Satellite Card Integration (Required)

Install the **[Voice Satellite Card Integration](https://github.com/jxlarrea/voice-satellite-card-integration)** — a separate custom component that registers your browser as an `assist_satellite` device in Home Assistant. The card will not function without it.

### 2. Assist Pipeline

Set up an [Assist Pipeline](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/) with:
   - Wake word detection (e.g., [openWakeWord](https://www.home-assistant.io/voice_control/install_wake_word_add_on/), [microWakeWord](https://www.home-assistant.io/integrations/micro_wake_word/))
   - Speech-to-Text ([Whisper](https://www.home-assistant.io/integrations/whisper/), OpenAI, etc.)
   - Conversation agent ([Home Assistant](https://www.home-assistant.io/integrations/conversation/), OpenAI, Qwen, etc.)
   - Text-to-Speech ([Piper](https://www.home-assistant.io/integrations/piper/), Kokoro, etc.)

> **Important:** Your wake word service must be **available to Home Assistant as a Wyoming integration** (either as an add-on or an external Wyoming instance) AND **enabled in your Assist pipeline**. The wake word option is hidden by default in the pipeline settings — go to **Settings → Voice assistants**, select your pipeline, click the **⋮ three-dot menu** at the top right of the pipeline settings to reveal the wake word configuration dropdown. If no wake word option appears, your wake word service is not installed or not detected by Home Assistant.

## Installation

### HACS (Recommended)

Voice Satellite Card is available in the Home Assistant Community Store. Use this link to directly go to the repository in HACS:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=jxlarrea&repository=Voice-Satellite-Card-for-Home-Assistant)

Or you can also search it manually:

1. Install HACS if you don't have it already
2. Open HACS in Home Assistant
3. Search for "Voice Satellite Card"
4. Click the download button

### Manual Installation

1. Download `voice-satellite-card.min.js` from this repository
2. Copy it to your `config/www/` folder
3. Add the resource in Home Assistant:
   - Go to Settings, Dashboards, Resources
   - Add `/local/voice-satellite-card.min.js` as a JavaScript module

## Configuration

### Basic Setup

1. Install the [Voice Satellite Card Integration](https://github.com/jxlarrea/voice-satellite-card-integration) and set up a satellite device
2. Add the card to any dashboard view and select your satellite entity:

```yaml
type: custom:voice-satellite-card
satellite_entity: assist_satellite.living_room_tablet
```

The card will start listening automatically using your configured pipeline.

### Visual Editor

All options are available in the visual card editor with a live preview that updates as you change settings.

### Full Configuration Reference

```yaml
type: custom:voice-satellite-card

# Behavior
satellite_entity: ''               # (Required) assist_satellite entity from the integration
debug: false                       # Show debug info in browser console

# Appearance
skin: default                      # 'default', 'alexa', or 'google-home'
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

> **Note:** Settings like TTS output, screensaver entity, and announcement display duration are now configured per-device in the [Voice Satellite Card Integration](https://github.com/jxlarrea/voice-satellite-card-integration). All visual styling (bar, bubbles, timers) is handled by the selected skin.

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

Announcements include a pre-announcement chime (ding-dong), play the TTS message, and show the text on screen. If a voice interaction is in progress, the announcement queues and plays after the conversation ends.

The display duration is configurable in the integration's device settings (see [Voice Satellite Card Integration](https://github.com/jxlarrea/voice-satellite-card-integration)).

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

### Media Player

Each satellite automatically exposes a `media_player` entity in Home Assistant. This entity:

- **Controls volume** for all satellite audio (chimes, TTS, announcements) via the HA volume slider
- **Reflects playback state** — shows "Playing" whenever any sound is active on the satellite, matching Voice PE behavior
- **Supports `tts.speak`** — target the satellite as a TTS device in automations
- **Supports `media_player.play_media`** — play arbitrary audio files on the satellite

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

After the question plays, a wake chime signals the user to speak. The card enters STT-only mode to capture the response, then the integration matches it against the provided sentence templates using [hassil](https://github.com/home-assistant/hassil). The result is returned to the automation via `response_variable`:

- **Matched:** `answer.id` contains the matched answer ID (e.g., `"positive"`), `answer.sentence` has the transcribed text, and `answer.slots` contains any captured wildcard values. A done chime plays.
- **Unmatched:** `answer.id` is `null`, `answer.sentence` has the raw transcription. An error chime plays and the gradient bar flashes red.

Sentence templates support optional words in `[brackets]` and wildcards in `{braces}` for capturing variable parts of the response (e.g., `"play {genre} music"` captures the genre).

## Skins

The card includes a skin system that themes the entire UI — activity bar, text display, timers, and background overlay. Select a skin in the card editor under **Appearance**.

### Built-in Skins

| Skin | Description |
|------|-------------|
| **Default** | Rainbow gradient bar, bordered text containers, clean look |
| **Alexa** | Cyan glow bar, dark overlay, centered bold text, Echo-inspired design |
| **Google Home** | Four-color Google gradient bar, left-aligned text, light overlay, Nest-inspired design |

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

### No TTS audio on Home Assistant Companion App

The Home Assistant Companion App uses a WebView that may block audio autoplay by default. To enable TTS playback:

1. Open the Companion App
2. Go to Settings → Companion App → Other settings
3. Enable **Autoplay videos**

Without this setting, the card will still function (wake word detection, speech-to-text, and visual feedback all work normally) but TTS audio won't play. The UI will clean up gracefully after the interaction completes.

### Card not visible

This is intentional. The card itself is invisible and only shows the gradient bar and transcription text when active. Add it to any view and it will work in the background.

## Contributing

Contributions are welcome. Please feel free to submit issues or pull requests.

## License

MIT License - feel free to use and modify as needed.
