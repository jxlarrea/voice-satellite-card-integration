/**
 * Voice Satellite Card — Preview Renderer
 *
 * Renders a static preview of the card inside the HA card editor.
 * Shows the rainbow bar, sample chat bubbles, and a timer pill
 * so users can see the skin's appearance.
 */

import { getSkin } from '../skins/index.js';
import baseCSS from './preview.css';

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
 * All visual values are baked into the CSS — no config-driven styling needed.
 * @param {ShadowRoot} shadowRoot
 * @param {object} config
 */
export function renderPreview(shadowRoot, config) {
  const skin = getSkin(config.skin || 'default');
  if (skin.fontURL && !document.querySelector(`link[href="${skin.fontURL}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = skin.fontURL;
    document.head.appendChild(link);
  }
  shadowRoot.innerHTML = `
    <style>
      ${baseCSS}
      ${skin.previewCSS || ''}
    </style>
    <div class="preview-background"></div>
    <div class="preview-container">
      <div class="preview-label">Preview</div>
      <div class="preview-blur"></div>
      <div class="preview-bar"></div>
      <div class="preview-chat">
        <div class="preview-msg user">What's the temperature outside?</div>
        <div class="preview-msg assistant">It's currently 75\u00B0F and sunny.</div>
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
