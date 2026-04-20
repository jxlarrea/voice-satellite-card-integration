# Customization

Theming the overlay (skins, custom CSS) and replacing the built-in chime sounds.

## Contents

- [Skins](#skins)
  - [Built-in Skins](#built-in-skins)
  - [Custom CSS](#custom-css)
  - [Waveform Skin CSS Variables](#waveform-skin-css-variables)
- [Custom Sounds](#custom-sounds)

## Skins

Voice Satellite includes a skin system that themes the entire overlay UI - activity bar, text display, timers, and background. Select a skin in the sidebar panel under **Settings**.

<img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/skins.jpg" alt="Skins" width="100%"/>

### Built-in Skins

| Skin | Description |
|------|-------------|
| **Default** | Rainbow gradient bar with enhanced glow, floating text with colored fading borders, white overlay |
| **Alexa** | Cyan glow bar, dark overlay, centered bold text, Echo-inspired design |
| **Google Home** | Four-color Google gradient bar, left-aligned text, Nest-inspired design. Supports light and dark mode which automatically follows your HA theme or can be forced via the Theme Mode setting |
| **Home Assistant** | Matches your HA theme natively in both light and dark mode. All colors derived from your theme's primary color and card background via CSS custom properties - automatically adapts to any HA theme. Monochromatic four-tone activity bar with flowing gradient animation |
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

The Waveform skin exposes CSS variables for full color customization of strands, background, and UI elements. Override them in the **Custom CSS** field. Dark and light themes have independent variables - set them separately to customize each mode.

<details>
<summary><strong>Available variables</strong></summary>

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

</details>

<details>
<summary><strong>Example: monochrome theme</strong></summary>

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

</details>

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
