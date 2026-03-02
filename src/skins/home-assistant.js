/**
 * Home Assistant Skin
 *
 * Clean, minimal design that uses Home Assistant CSS custom properties
 * for all colors, automatically adapting to any HA theme (light, dark, custom).
 */

import css from './home-assistant.css';
import previewCSS from './home-assistant-preview.css';

export const homeAssistantSkin = {
  id: 'home-assistant',
  name: 'Home Assistant',
  css,
  reactiveBar: true,
  overlayColor: null,
  defaultOpacity: 0.85,
  previewCSS,
};
