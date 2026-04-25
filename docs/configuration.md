# Configuration

This page covers the in-browser configuration surfaces: the **Sidebar Panel** (per-browser settings, screensaver) and the optional **Mini Card** dashboard component.

Per-device behavior (pipeline, wake word, TTS output, etc.) is configured on the device page and documented in [integration.md](integration.md).

## Contents

- [Sidebar Panel](#sidebar-panel)
  - [Engine Status](#engine-status)
  - [Satellite Entity](#satellite-entity)
  - [Settings](#settings)
  - [Screensaver](#screensaver)
  - [Preview](#preview)
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

### Screensaver

A browser overlay that kicks in after an idle timeout. Configured per-browser in the sidebar panel; automatically dismissed on voice interaction, tap, or Fully Kiosk motion detection. Does not activate while the engine is stopped.

| Setting | Description |
|---------|-------------|
| **Enable Voice Satellite screensaver** | Master toggle for the overlay |
| **Idle timeout** | Seconds before the screensaver activates (10-600, default 60) |
| **Type** | **Black overlay** - solid black overlay. **Media** - image, video, folder, or camera feed selected from the HA media library. **Website** - embed any URL in an iframe (e.g. immich-kiosk, photo frame apps, a dashboard) |
| **Media source** *(Media type only)* | Paste a `media-source://` URI or use the **Browse** button to open the HA media browser. Folders cycle through their playable contents; cameras stream live via MJPEG; images cross-fade on transitions |
| **Item interval** *(Media type, folders only)* | Seconds per image when cycling through a folder (2-600, default 10). Videos play to completion regardless |
| **Shuffle folder items** *(Media type, folders only)* | Randomize the playback order each time the folder is opened |
| **Website URL** *(Website type only)* | Full URL to embed. The site must permit iframe embedding (no strict `X-Frame-Options` / `frame-ancestors`). Touch input on the iframe is suppressed so a tap anywhere on the screen dismisses the screensaver |
| **External screensaver** *(screensaver disabled only)* | A `switch` or `input_boolean` that's forced off for the duration of each voice interaction, then left alone so its owner (typically Fully Kiosk) can resume its own idle timer. Useful to keep Fully Kiosk's screensaver from covering the voice UI mid-conversation |
| **Fully Kiosk Integration -> Screen brightness while active** | Hardware backlight level (0-100%) while the screensaver is showing. The previous brightness is restored on dismiss. 0% = fully dark, 100% = leave the backlight untouched (default) |
| **Fully Kiosk Integration -> Dismiss on motion** | Dismiss the screensaver when Fully Kiosk's camera-based motion detection fires. Requires Motion Detection to be enabled in the Fully Kiosk settings. Default off |

### Preview

A live preview of the selected skin updates as you change appearance settings.

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

Per-browser toggles that control the on-screen behavior of timers without affecting how they actually run. Both default off, both take effect live without restarting the engine. See the [Timers reference](timers.md) for the full picture.

| Setting | Description |
|---------|-------------|
| **Hide on-screen countdown** | Suppresses the countdown pill while a timer is running. The timer still fires and the alert still plays at zero. Useful when a tablet doubles as a wall display where pills feel intrusive |
| **Hide timer name on alert** | When a timer finishes, hides the timer name shown below the alert. The icon, time, and chime still appear |