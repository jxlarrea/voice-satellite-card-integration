/**
 * Voice Satellite Card  -  Preview Renderer
 *
 * Renders a static preview of the card inside the HA card editor.
 * Shows the rainbow bar, sample chat bubbles, and a timer pill
 * so users can see the skin's appearance.
 */

import { getSkin } from '../skins/index.js';
import baseCSS from './preview.css';
import { t } from '../i18n/index.js';

/**
 * Detect whether this card element is inside the HA card editor preview.
 * @param {HTMLElement} el
 * @returns {boolean}
 */
export function isEditorPreview(el) {
  let node = el;
  for (let i = 0; i < 20 && node; i++) {
    const tag = node.tagName;
    // Legacy: <hui-card-preview>
    if (tag === 'HUI-CARD-PREVIEW') return true;
    // Modern: <hui-card preview=""> (attribute or property)
    if (tag === 'HUI-CARD' && (node.hasAttribute('preview') || node.preview)) return true;
    // Sections layout: <hui-dialog-edit-card>
    if (tag === 'HUI-DIALOG-EDIT-CARD') return true;
    // Fallback: any element with 'preview' in tagname
    if (tag && tag.includes('PREVIEW')) return true;
    node = node.parentElement || (node.getRootNode && node.getRootNode()).host;
  }
  return false;
}

/**
 * Render a static preview inside the given shadow root.
 * All visual values are baked into the CSS  -  no config-driven styling needed.
 * @param {ShadowRoot} shadowRoot
 * @param {object} config
 */
export function renderPreview(shadowRoot, config) {
  const hass = shadowRoot.host?._hass;
  const tt = (key, fallback) => t(hass, key, fallback);
  const skin = getSkin(config.skin || 'default');
  if (skin.fontURL && !document.querySelector(`link[href="${skin.fontURL}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = skin.fontURL;
    document.head.appendChild(link);
  }
  const scale = (config.text_scale || 100) / 100;
  const skinDefault = Math.round((skin.defaultOpacity ?? 1) * 100);
  const bgOpacity = (config.background_opacity ?? skinDefault) / 100;
  const [r, g, b] = skin.overlayColor || [0, 0, 0];
  shadowRoot.innerHTML = `
    <style>
      ${baseCSS}
      ${skin.previewCSS || ''}
    </style>
    <div class="preview-background"></div>
    <div class="preview-container" style="--vs-text-scale:${scale}">
      <div class="preview-label">${tt('editor.preview.label', 'Preview')}</div>
      <div class="preview-blur" style="background:rgba(${r},${g},${b},${bgOpacity})"></div>
      <div class="preview-bar"></div>
      <div class="preview-chat">
        <div class="preview-msg user">${tt('editor.preview.user_question', "What's the temperature outside?")}</div>
        <div class="preview-msg assistant">${tt('editor.preview.assistant_answer', "It's currently 75°F and sunny.")}</div>
      </div>
      <div class="preview-timer">
        <div class="preview-timer-progress"></div>
        <div class="preview-timer-content">
          <span>\u23F1</span>
          <span class="preview-timer-time">00:04:32</span>
        </div>
      </div>
    </div>
  `;
}
