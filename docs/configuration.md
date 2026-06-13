# Configuration

This page covers the in-browser configuration surfaces: the **Sidebar Panel** (per-browser settings, screensaver) and the optional **Mini Card** dashboard component.

Per-device behavior (pipeline, wake word, TTS output, etc.) is configured on the device page and documented in [integration.md](integration.md).

## Contents

- [Sidebar Panel](#sidebar-panel)
  - [Engine Status](#engine-status)
  - [Settings](#settings)
  - [Preview](#preview)
  - [Advanced](#advanced)
  - [Screensaver](#screensaver)
- [Mini Card](#mini-card)
  - [Modes](#modes)
  - [Mini Card Features](#mini-card-features)
  - [Mini Card Configuration Reference](#mini-card-configuration-reference)
  - [Timers](#timers)

## Sidebar Panel

The sidebar panel is the central configuration hub for Voice Satellite.

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/sidepanel.png" alt="Sidebar Panel" width="650"/>
</p>

### Engine Status

The top of the panel shows the current engine state (running/dormant) and pipeline status (idle, listening, processing, etc.). **Start** and **Stop** buttons let you manually control the engine.

### Settings

The primary settings for this browser. Pick the satellite device this browser should drive, and toggle whether the engine should start automatically on page load.

| Setting | Description |
|---------|-------------|
| **Satellite entity** | The Voice Satellite device this browser will use. Each browser must explicitly select an entity before the engine will start. Create one entity per device in **Settings -> Devices & Services -> Voice Satellite** |
| **Auto start** | Start the engine automatically on page load. When off, use the Start button to activate manually |
| **Microphone** | Browser microphone input. Use the default device, or pick a specific input when the browser exposes one |
| **Seamless wake command (experimental)** | Off by default. Lets one-shot phrases such as "hey vesta turn off the lights" flow directly into STT. Skips the wake chime for that turn and buffers command audio while the Assist pipeline starts. Results can vary by microphone, room acoustics, and STT engine |

### Preview

A live preview of the selected skin updates as you change appearance settings.

### Advanced

Per-browser overlay appearance, microphone processing, timer behavior, and debug logging. Stored in local storage and persists across sessions.

| Setting | Description |
|---------|-------------|
| **Skin** | Select a built-in skin for the overlay UI |
| **Text Scale** | Scale all text 50-200% |
| **Background Opacity** | Override the skin's default overlay opacity (0-100%) |
| **Reactive activity bar** | Bar animates in response to mic and audio levels. Disable on slow devices |
| **Reactive bar update interval** | Controls animation smoothness (default 33ms / ~30fps) |
| **Custom CSS** | Advanced CSS overrides applied on top of the selected skin |
| **Hide on-screen countdown** *(Timers)* | Suppresses the countdown pill while a timer is running. The timer still fires and the alert still plays at zero |
| **Hide timer name on alert** *(Timers)* | Hides the timer name shown below the alert when a timer finishes |
| **Speak timer alert phrase** *(Timers)* | Adds a configurable spoken phrase after every two alert chimes. The next chime pair starts shortly after the phrase ends. Uses the same Assist pipeline that created the timer |
| **Noise suppression** *(Wake Word / STT)* | Browser-level noise suppression on the microphone input. Configurable independently for each capture phase |
| **Echo cancellation** *(Wake Word / STT)* | Browser-level echo cancellation. Configurable independently for each capture phase |
| **Auto gain control** *(Wake Word / STT)* | Browser-level automatic gain control. Configurable independently for each capture phase |
| **Voice isolation** *(Wake Word / STT)* | AI-based voice isolation (Chrome only). Configurable independently for each capture phase |
| **Follow-up listen delay** *(STT)* | Pause (0-1000 ms) inserted between the assistant finishing speaking and the mic listening again on follow-up turns (continue conversation, `start_conversation`, `ask_question`). Use this if the tail of the response (last word or two) is being captured into your next reply. Common on tablets without hardware echo cancellation, especially with synthesized voices like Piper. Try 300-500 ms; leave at 0 if follow-ups already work cleanly. Default 0 |
| **Follow-up ready chime** *(STT)* | Play the wake chime when the mic starts listening for a follow-up turn, so you have an audible "speak now" cue. Pairs naturally with a non-zero **Follow-up listen delay**. Default off. `ask_question` always plays the chime regardless of this setting since it is functional UX for that flow |
| **Debug logging** | Show debug info in the browser console |

### Screensaver

A browser overlay that kicks in after an idle timeout. Configured per-browser in the sidebar panel; automatically dismissed on voice interaction, tap, or Fully Kiosk motion detection. Hardware backlight dimming works in both Fully Kiosk (Android) and Kiosker Pro (iOS). Does not activate while the engine is stopped.

| Setting | Description |
|---------|-------------|
| **Enable Voice Satellite screensaver** | Master toggle for the overlay |
| **Idle timeout** | Seconds before the screensaver activates (10-600, default 60) |
| **Type** | **Black overlay** - solid black overlay. **Media** - image, video, folder, or camera feed selected from the HA media library. **Website** - embed any URL in an iframe (e.g. immich-kiosk, photo frame apps, a dashboard) |
| **Media source** *(Media type only)* | Use the **Browse** button to pick a file, folder, or camera from the HA media browser; the selected `media-source://` URI is shown in the read-only field next to it. Folders cycle through their playable contents; cameras stream live over WebRTC with sub-second latency (falling back to MJPEG when the camera has no WebRTC provider); images cross-fade on transitions |
| **Item interval** *(Media type, folders only)* | Seconds per image when cycling through a folder (2-600, default 10). Videos play to completion regardless |
| **Shuffle folder items** *(Media type, folders only)* | Randomize the playback order each time the folder is opened |
| **Website URL** *(Website type only)* | Full URL to embed. The site must permit iframe embedding (no strict `X-Frame-Options` / `frame-ancestors`). Touch input on the iframe is suppressed so a tap anywhere on the screen dismisses the screensaver |
| **External screensaver** *(screensaver disabled only)* | A `switch` or `input_boolean` that's forced off for the duration of each voice interaction, then left alone so its owner (typically Fully Kiosk) can resume its own idle timer. Useful to keep Fully Kiosk's screensaver from covering the voice UI mid-conversation |
| **Kiosk Browser Integration -> Screen brightness while active** | Hardware backlight level (0-100%) while the screensaver is showing. Works in Fully Kiosk (Android) and Kiosker Pro (iOS) with the JavaScript integration enabled. The previous brightness is restored on dismiss. 0% = fully dark, 100% = leave the backlight untouched (default) |
| **Kiosk Browser Integration -> Dismiss on motion** | Dismiss the screensaver when Fully Kiosk's camera-based motion detection fires. Fully Kiosk only (Kiosker Pro has no motion API). Requires Motion Detection to be enabled in the Fully Kiosk settings. Default off |

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

### Timers

Per-browser options that control the on-screen and spoken behavior of timers without affecting how they actually run. Live in the **Advanced** card under the **Timers** expandable and take effect live without restarting the engine. See the [Timers reference](timers.md) for the full picture.

| Setting | Description |
|---------|-------------|
| **Hide on-screen countdown** | Suppresses the countdown pill while a timer is running. The timer still fires and the alert still plays at zero. Useful when a tablet doubles as a wall display where pills feel intrusive |
| **Hide timer name on alert** | When a timer finishes, hides the timer name shown below the alert. The icon, time, and chime still appear |
| **Speak timer alert phrase** | Adds a spoken phrase after every two alert chimes. When enabled, the timer alert repeats as `chime -> chime -> phrase -> short pause` until dismissed |
| **Timer alert phrase** | Phrase for unnamed timers. Default: `Your timer is up.` |
| **Named timer alert phrase** | Phrase for named timers. Default: `Your %%TIMER_NAME%% timer is up.` Use `%%TIMER_NAME%%` where the runtime timer name should be inserted |
