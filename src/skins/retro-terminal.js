/**
 * Voice Satellite Card — Retro Terminal Skin
 *
 * Green phosphor CRT aesthetic with monospace font,
 * scanline overlay, and glow effects.
 */

import css from './retro-terminal.css';
import previewCSS from './retro-terminal-preview.css';

export const retroTerminalSkin = {
  id: 'retro-terminal',
  name: 'Retro Terminal',
  css,
  reactiveBar: true,
  overlayColor: [0, 10, 0],
  defaultOpacity: 0.92,
  previewCSS,
};
