/**
 * Siri Skin
 *
 * Apple-inspired design with a full-screen gradient border glow
 * (purple -> blue -> teal -> pink), dark frosted overlay, and clean
 * centered text. Mimics iOS 18 Siri's edge glow aesthetic.
 */

import css from './siri.css';
import previewCSS from './siri-preview.css';

export const siriSkin = {
  id: 'siri',
  name: 'Siri',
  css,
  reactiveBar: true,
  overlayColor: [0, 0, 0],
  defaultOpacity: 0.85,
  previewCSS,
};
