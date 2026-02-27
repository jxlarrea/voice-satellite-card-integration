/**
 * Voice Satellite Card - Google Home Skin
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
  overlayColor: [255, 255, 255],
  defaultOpacity: 0.75,
  previewCSS,
  fontURL: 'https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap',
};
