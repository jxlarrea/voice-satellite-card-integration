/**
 * Alexa Skin
 *
 * Dark theme with cyan accent glow, inspired by the Echo Show UI.
 * Uses a bottom edge glow instead of a rainbow bar.
 */

import css from './alexa.css';
import previewCSS from './alexa-preview.css';

export const alexaSkin = {
  id: 'alexa',
  name: 'Alexa',
  css,
  reactiveBar: true,
  overlayColor: [0, 8, 20],
  defaultOpacity: 0.7,
  previewCSS,
};
