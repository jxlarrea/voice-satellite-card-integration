/**
 * Default Skin
 */

import css from './default.css';
import previewCSS from './default-preview.css';

export const defaultSkin = {
  id: 'default',
  name: 'Default',
  css,
  reactiveBar: true,
  hasDarkTheme: true,
  overlayColor: [245, 244, 242],
  darkOverlayColor: [18, 18, 18],
  defaultOpacity: 0.85,
  darkDefaultOpacity: 0.85,
  previewCSS,
};
