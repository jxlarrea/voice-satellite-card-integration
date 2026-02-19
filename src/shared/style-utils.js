/**
 * Voice Satellite Card — Style Utilities
 *
 * Shared bubble/pill styling. Applies the 9-property pattern used by
 * chat bubbles, announcement bubbles, and timer pills.
 *
 * @param {HTMLElement} el - Element to style
 * @param {object} cfg - Card config object
 * @param {string} prefix - Config key prefix: 'transcription', 'response', or 'timer'
 */
export function applyBubbleStyle(el, cfg, prefix) {
  el.style.fontSize = cfg[`${prefix}_font_size`] + 'px';
  el.style.fontFamily = cfg[`${prefix}_font_family`];
  el.style.color = cfg[`${prefix}_font_color`];
  el.style.fontWeight = cfg[`${prefix}_font_bold`] ? 'bold' : 'normal';
  el.style.fontStyle = cfg[`${prefix}_font_italic`] ? 'italic' : 'normal';
  el.style.background = cfg[`${prefix}_background`];
  el.style.border = `3px solid ${cfg[`${prefix}_border_color`]}`;
  el.style.padding = cfg[`${prefix}_padding`] + 'px';
  el.style.borderRadius = cfg[`${prefix}_rounded`] ? '12px' : '0';
}
