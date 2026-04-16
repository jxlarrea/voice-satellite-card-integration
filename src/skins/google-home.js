/**
 * Google Home Skin
 *
 * Light theme with Google's 4-color palette (blue, red, yellow, green),
 * Material Design cards, and a clean frosted overlay.
 */

import css from './google-home.css';
import previewCSS from './google-home-preview.css';

export const googleHomeSkin = {
  id: 'google-home',
  name: 'Google Home',
  css,
  reactiveBar: true,
  hasDarkTheme: true,
  overlayColor: [245, 244, 242],
  darkOverlayColor: [32, 33, 36],
  defaultOpacity: 1,
  darkDefaultOpacity: 1,
  previewCSS,
};
