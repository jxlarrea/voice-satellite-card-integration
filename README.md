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

## How It Works

Voice Satellite runs as a **global engine** that loads on every page of Home Assistant - no dashboard card required. Once you assign a satellite entity in the sidebar panel, the engine starts automatically and listens for wake words across all page navigations.

- **Turns your browser into a real satellite** - registered as a proper `assist_satellite` device in HA with full feature parity with physical voice assistants
- **On-device wake word detection** - runs microWakeWord locally in pure JavaScript with custom model support and optional voice-activated stop interruption. Falls back to server-side detection when preferred
- **Timers, announcements, conversations** - voice-activated timers with countdown pills, `assist_satellite.announce` / `start_conversation` / `ask_question` from automations
- **Media player entity** - volume control, `tts.speak` targeting, and `media_player.play_media` from automations. TTS can route to browser or a remote speaker
- **Skins** - 7 built-in skins (Default, Alexa, Google Home, Home Assistant, Retro Terminal, Siri, Waveform) with CSS overrides. Reactive audio-level animation on the activity bar
- **Screensaver** - black overlay, image/video/folder from the HA media library, or live camera feed. Cross-fades between folder items; integrates with Fully Kiosk backlight dimming and motion-dismiss
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

## Prerequisites

- **Home Assistant 2025.2.1** or later
- An [Assist Pipeline](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/) with:
  - Speech-to-Text ([Whisper](https://www.home-assistant.io/integrations/whisper/), OpenAI, etc.)
  - Conversation agent ([Home Assistant](https://www.home-assistant.io/integrations/conversation/), OpenAI, Qwen, etc.)
  - Text-to-Speech ([Piper](https://www.home-assistant.io/integrations/piper/), Kokoro, etc.)

<details>
<summary><strong>Browser requirements (microphone, HTTPS, companion app)</strong></summary>

Voice Satellite requires microphone access, so make sure that:

1. **The browser has microphone permissions granted** - you will be prompted on first use.
2. **The page is served over HTTPS** - required for microphone access in modern browsers.
3. **The screen stays on** - if the device screen turns off completely, the microphone will stop working. Use a screensaver instead of screen-off to keep the mic active.

For kiosk setups like [Fully Kiosk Browser](https://play.google.com/store/apps/details?id=de.ozerov.fully), make sure to enable microphone permissions and use the screensaver feature (not screen off) to keep the microphone active while dimming the display.

For the **Home Assistant Companion App**, enable **Autoplay videos** in Settings -> Companion App -> Other settings. Without this, the WebView will block TTS audio playback.

</details>

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

## Configuration

The **Voice Satellite** sidebar panel is the central configuration hub. Pick the satellite entity for this browser, tune microphone processing, choose a skin, and set up the screensaver - all stored per-browser in local storage. The optional [Mini Card](docs/configuration.md#mini-card) provides an inline, text-first dashboard variant when you don't want the fullscreen overlay.

<p align="center">
 <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/sidepanel.png" alt="Sidebar Panel" width="650"/>
</p>

See the [Configuration reference](docs/configuration.md) for every setting in the sidebar panel and mini card.

## Integration

Each satellite is a real `assist_satellite` device in Home Assistant, with a companion `media_player`, per-device configuration entities (pipeline, wake word, TTS output, mute, etc.), and live state sync (`idle` / `listening` / `processing` / `responding`). After every turn the integration fires a `voice_satellite_chat` event carrying the user's transcript, the assistant's full reply, and the tools the LLM invoked, ready to drive automations.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/integration.png" alt="Integration" width="650"/>
</p>

See the [Integration reference](docs/integration.md) for device entities, state values, attribute list, and event payload.

## Usage & Services

Once running, the satellite listens for the wake word, streams audio to STT, plays the TTS response, and supports natural multi-turn follow-ups with agents that allow it. It also exposes actions your automations can call: `assist_satellite.announce` for proactive TTS, `start_conversation` to ask a question and listen, `ask_question` to match the user's spoken reply against predefined answers, and `voice_satellite.wake` to trigger the satellite as if the wake word had fired.

See the [Usage & Services reference](docs/usage.md) for the full interaction flow and YAML examples for every action.

## Wake Word Detection

On-device detection runs [microWakeWord](https://github.com/kahrendt/microWakeWord) TFLite models in pure JavaScript, so audio is only streamed to Home Assistant after the wake word fires - no server-side wake word add-on required. Seven built-in wake words ship out of the box, custom `.tflite` models are auto-discovered, and "Disabled" mode keeps the mic completely off for automation-driven setups.

See the [Wake Word reference](docs/wake-word.md) for built-in models, custom model loading, configuration, and disabled mode.

## Skins & Customization

Seven built-in skins (Default, Alexa, Google Home, Home Assistant, Retro Terminal, Siri, Waveform) theme the overlay, timer pills, and activity bar. Every skin can be further tweaked via the **Custom CSS** field in the sidebar panel, and the Waveform skin exposes dedicated CSS variables for per-strand color control. Built-in chime sounds (`wake`, `done`, `error`, `alert`, `announce`) can be replaced with your own MP3s that survive HACS updates.

<img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/skins.jpg" alt="Skins" width="100%"/>

See the [Skins & Customization reference](docs/customization.md) for the skin list, CSS variable tables, and the custom sounds folder layout.

## Experimental: LLM Tools

With a tool-capable conversation agent (OpenAI, Google Generative AI, Anthropic, Ollama, etc.) plus the companion [Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools) integration, Voice Satellite can display rich visual results inline: image grids, YouTube video cards, weather forecasts, stock/crypto cards, currency conversions, and web/Wikipedia summaries with featured images.

See the [LLM Tools reference](docs/llm-tools.md) for each supported tool and the voice commands that trigger them.

## Troubleshooting

Most setup issues come from missing microphone permissions, mixed HTTP/HTTPS content, Fully Kiosk autoplay settings, or a mismatched `internal_url` that breaks the TTS proxy for announcements.

See the [Troubleshooting reference](docs/troubleshooting.md) for the four most common issues and their fixes.

## Contributing

Contributions are welcome. Please feel free to submit issues or pull requests.

## License

MIT License - see [LICENSE](LICENSE) for details.
