# Voice Satellite Card for Home Assistant

Transform any browser into a voice-activated satellite for Home Assistant's Assist. This custom card enables wake word detection directly in your browser, turning tablets, wall-mounted displays, or any device with a microphone into a hands-free voice assistant.

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![version](https://shields.io/github/v/release/jxlarrea/Voice-Satellite-Card-for-Home-Assistant?style=for-the-badge)](https://github.com/jxlarrea/Voice-Satellite-Card-for-Home-Assistant/releases)

![Screenshot](https://github.com/user-attachments/assets/178d8639-bf05-409e-8bc7-f4283fb36593)

## Why This Card?

Home Assistant's built-in voice features require dedicated hardware like ESPHome devices or specific voice assistant hardware. But what if you already have a tablet mounted on your wall running the Home Assistant dashboard?a

**Voice Satellite Card** solves this by:

- **Using your browser's microphone** - No additional hardware needed.
- **Supporting wake words** - Say "OK Nabu" or your custom wake word to activate.
- **Playing TTS responses** - Hear responses directly from your device or a remote media player.
- **Working on any device** - Tablets, phones, computers, kiosks.
- **Providing visual feedback** - Gradient bar shows current state.
- **Showing transcriptions** - See what was understood on screen.

Perfect for wall-mounted tablets, kiosk displays, or any browser-based Home Assistant setup.

https://github.com/user-attachments/assets/50f51ebc-be70-4ea2-a1b5-8d80446f55c2

## Important: Browser Requirements

**Warning:** This card requires microphone access and works best when:

1. **The browser has microphone permissions granted** - You will be prompted on first use.
2. **The page is served over HTTPS** - Required for microphone access in modern browsers.
3. **The screen stays on** - If the device screen turns off completely, the microphone will stop working. Use a screensaver instead of screen-off to keep the mic active.

For kiosk setups like [Fully Kiosk Browser](https://play.google.com/store/apps/details?id=de.ozerov.fully), make sure to enable microphone permissions and use the screensaver feature (not screen off) to keep the microphone active while dimming the display.

## Features

- **Wake Word Detection** - Uses Home Assistant's already configured wake word detection (like Wyoming openWakeWord) for server-side processing.
- **Works Across Views** - Pipeline stays active when switching dashboard views.
- **Auto-Start** - Automatically begins listening on page load (with fallback button).
- **Visual Feedback** - Customizable rainbow gradient bar shows listening/processing/speaking states.
- **Transcription Display** - Shows what was understood in a styled bubble.
- **Continue Conversation** - When the assistant asks a follow-up question, the card automatically listens for a response without requiring the wake word again. Conversation history is displayed in a chat-style interface.
- **Screensaver Control** - Optionally turn off Fully Kiosk screensaver when wake word is detected.
- **Configurable Chimes** - Audio feedback for wake word detection and request completion.

## Prerequisites

Before using this card, ensure you have Home Assistant with the [Assist Pipeline](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/) fully set up. A configured Assist Pipeline consists of:
   - Wake word detection ([openWakeWord](https://www.home-assistant.io/voice_control/install_wake_word_add_on/))
   - Speech-to-Text ([Whisper](https://www.home-assistant.io/integrations/whisper/), OpenAI, etc.)
   - Conversation agent ([Home Assistant](https://www.home-assistant.io/integrations/conversation/), OpenAI, Qwen, etc.)
   - Text-to-Speech ([Piper](https://www.home-assistant.io/integrations/piper/), Kokoro, etc.)

## Installation

### HACS (Recommended)

1. Open HACS in Home Assistant.
2. Click the three dots menu, then Custom repositories.
3. Add this repository URL and select Lovelace as the category.
4. Click Install.
5. Refresh your browser.

### Manual Installation

1. Download `voice-satellite-card.js` from this repository
2. Copy it to your `config/www/` folder
3. Add the resource in Home Assistant:
   - Go to Settings, Dashboards, Resources
   - Add `/local/voice-satellite-card.js` as a JavaScript module

## Configuration

### Basic Setup

Add the card to any dashboard view:

```yaml
type: custom:voice-satellite-card
```

That's it! The card will use your default Assist pipeline and start listening automatically.

### Full Configuration

```yaml
type: custom:voice-satellite-card

# Behavior
start_listening_on_load: true      # Auto-start on page load
pipeline_id: ''                    # Pipeline ID (empty = default pipeline)
wake_word_switch: ''               # Switch to turn OFF when wake word detected
                                   # e.g., 'switch.tablet_screensaver'
pipeline_timeout: 60               # Server-side: max seconds for pipeline response (0 = no timeout)
pipeline_idle_timeout: 300         # Client-side: seconds before pipeline restarts to keep TTS fresh (default 5 min)
continue_conversation: true        # Continue listening after assistant asks a follow-up question
double_tap_cancel: true            # Double-tap screen to cancel active interaction and stop TTS
chime_on_wake_word: true           # Play chime when wake word detected
chime_on_request_sent: true        # Play chime after request processed
chime_volume: 100                  # Chime volume (0-100)
tts_volume: 100                    # TTS playback volume (0-100)
tts_target: ''                     # TTS output device (empty = browser, or media_player entity ID)
debug: false                       # Show debug info in browser console

# Microphone Processing
noise_suppression: true            # Enable noise suppression
echo_cancellation: true            # Enable echo cancellation
auto_gain_control: true            # Enable automatic gain control
voice_isolation: false             # AI-based voice isolation (Chrome only)

# Appearance - Bar
bar_position: bottom               # 'bottom' or 'top'
bar_height: 16                     # Height in pixels (2-40)
bar_gradient: '#FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC'
background_blur: true               # Blurs the background when active
background_blur_intensity: 5        # Blur effect intensity

# Appearance - Transcription Bubble (User Speech)
show_transcription: true           # Show/hide the transcription bubble
transcription_font_size: 20        # Font size in pixels
transcription_font_family: inherit # CSS font family
transcription_font_color: '#444444'
transcription_font_bold: true      # Bold text
transcription_font_italic: false   # Italic text
transcription_background: '#ffffff'
transcription_border_color: 'rgba(0, 180, 255, 0.5)'
transcription_padding: 16          # Padding in pixels
transcription_rounded: true        # Rounded corners

# Appearance - Response Bubble (Assistant Speech)
show_response: true                # Show/hide the response bubble
streaming_response: false          # Stream text response in real-time
response_font_size: 20             # Font size in pixels
response_font_family: inherit      # CSS font family
response_font_color: '#444444'
response_font_bold: true           # Bold text
response_font_italic: false        # Italic text
response_background: '#ffffff'
response_border_color: 'rgba(100, 200, 150, 0.5)'
response_padding: 16               # Padding in pixels
response_rounded: true             # Rounded corners
```

### Visual Editor

All options are also available in the visual card editor.

## Usage

### Starting the Satellite

**Auto-Start**: If `start_listening_on_load` is enabled (default), the card will automatically request microphone access and begin listening.

**Manual Start**: If auto-start fails due to browser restrictions, a floating microphone button will appear. Click it to start.

### Visual States

The gradient bar indicates the current state:

| State | Appearance |
|-------|------------|
| Listening for wake word | Bar hidden (passive listening) |
| Wake word detected | Bar visible, flowing animation |
| Processing speech | Bar visible, fast animation |
| Speaking response | Bar visible, flowing animation |

### Screensaver Control

The `wake_word_switch` option is designed for Fully Kiosk Browser's screensaver. When the screensaver is active, the screen is dimmed but the microphone remains active (unlike turning the screen fully off).

```yaml
wake_word_switch: switch.tablet_screensaver
```

When the wake word is detected, this switch will be turned OFF, which exits the screensaver and wakes up the display for the interaction.

**Important:** In Fully Kiosk, do NOT use the screen on/off switch for this purpose. If the screen turns off completely, the microphone will stop working. Instead, use the screensaver switch which keeps the screen dimmed but the microphone active.

## Troubleshooting

### Microphone not working

1. Check browser permissions for microphone access.
2. Ensure you're using HTTPS (required for microphone access).
3. Try the manual start button if auto-start fails.

### Wake word not detected

1. Verify that openWakeWord is running.
2. Check that your Assist pipeline has wake word detection configured.
3. Enable `debug: true` to see events in the browser console.

### No audio response

1. Check that TTS is configured in your Assist pipeline.
2. Check browser audio permissions.

### Card not visible

This is intentional. The card itself is invisible and only shows the gradient bar and transcription bubble when active. Add it to any view and it will work in the background.

## Contributing

Contributions are welcome. Please feel free to submit issues or pull requests.

## License

MIT License - feel free to use and modify as needed.
