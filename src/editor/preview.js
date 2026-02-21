/**
 * Voice Satellite Card — Preview Renderer
 *
 * Renders a static preview of the card inside the HA card editor.
 * Shows the rainbow bar, sample chat bubbles, and a timer pill
 * so users can see their style changes in real time.
 */

import { seamlessGradient, DEFAULT_CONFIG } from '../constants.js';
import { applyBubbleStyle } from '../shared/style-utils.js';

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
    // Modern: <hui-card preview="">
    if (tag === 'HUI-CARD' && node.hasAttribute('preview')) return true;
    // Fallback: any element with 'preview' in tagname
    if (tag && tag.includes('PREVIEW')) return true;
    node = node.parentElement || (node.getRootNode && node.getRootNode()).host;
  }
  return false;
}

/**
 * Render a static preview inside the given shadow root.
 * @param {ShadowRoot} shadowRoot
 * @param {object} config
 */
export function renderPreview(shadowRoot, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config);

  shadowRoot.innerHTML = `
    <style>
      :host {
        display: block;
        position: relative;
        overflow: hidden;
        border-radius: var(--ha-card-border-radius, 12px);
        min-height: 380px;
      }
      .preview-background {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background-image:
          linear-gradient(45deg, #e0e0e0 25%, transparent 25%),
          linear-gradient(-45deg, #e0e0e0 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #e0e0e0 75%),
          linear-gradient(-45deg, transparent 75%, #e0e0e0 75%);
        background-size: 20px 20px;
        background-position: 0 0, 0 10px, 10px -10px, -10px 0;
        background-color: #f5f5f5;
      }
      @media (prefers-color-scheme: dark) {
        .preview-background {
          background-image:
            linear-gradient(45deg, #333 25%, transparent 25%),
            linear-gradient(-45deg, #333 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #333 75%),
            linear-gradient(-45deg, transparent 75%, #333 75%);
          background-color: #222;
        }
      }
      :host-context([data-theme="dark"]) .preview-background,
      :host-context(.dark) .preview-background {
        background-image:
          linear-gradient(45deg, #333 25%, transparent 25%),
          linear-gradient(-45deg, #333 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #333 75%),
          linear-gradient(-45deg, transparent 75%, #333 75%);
        background-color: #222;
      }
      .preview-container {
        position: relative;
        width: 100%;
        min-height: 380px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        padding: 24px 16px;
      }
      .preview-blur {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        z-index: 1;
        pointer-events: none;
      }
      .preview-bar {
        position: absolute;
        left: 0;
        right: 0;
        z-index: 2;
        background-size: 200% 100%;
        animation: preview-slide 2s linear infinite;
      }
      @keyframes preview-slide {
        0% { background-position: 200% 0; }
        100% { background-position: 0% 0; }
      }
      .preview-chat {
        position: relative;
        z-index: 3;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 80%;
        margin: 0 auto;
      }
      .preview-msg {
        max-width: 85%;
        word-wrap: break-word;
        text-align: center;
        line-height: 1.0;
        animation: preview-fade-in 0.3s ease;
      }
      .preview-msg.user {
        align-self: center;
      }
      .preview-msg.assistant {
        align-self: center;
      }
      @keyframes preview-fade-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .preview-timer {
        position: absolute;
        z-index: 4;
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: hidden;
      }
      .preview-timer-progress {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        opacity: 0.3;
        border-radius: inherit;
      }
      .preview-timer-content {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
      }
    </style>
    <div class="preview-background"></div>
    <div class="preview-container">
      <div class="preview-blur"></div>
      <div class="preview-bar"></div>
      <div class="preview-chat">
        <div class="preview-msg user"></div>
        <div class="preview-msg assistant"></div>
      </div>
      <div class="preview-timer">
        <div class="preview-timer-progress"></div>
        <div class="preview-timer-content">
          <span>⏱</span>
          <span class="preview-timer-time">00:04:32</span>
        </div>
      </div>
    </div>
  `;

  const container = shadowRoot.querySelector('.preview-container');

  // Blur overlay
  const blur = shadowRoot.querySelector('.preview-blur');
  if (cfg.background_blur) {
    blur.style.backdropFilter = `blur(${cfg.background_blur_intensity}px)`;
    blur.style.webkitBackdropFilter = `blur(${cfg.background_blur_intensity}px)`;
  }

  // Bar
  const bar = shadowRoot.querySelector('.preview-bar');
  bar.style.height = `${cfg.bar_height}px`;
  bar.style.background = seamlessGradient(cfg.bar_gradient);
  bar.style.backgroundSize = '200% 100%';
  if (cfg.bar_position === 'top') {
    bar.style.top = '0';
    bar.style.bottom = 'auto';
  } else {
    bar.style.bottom = '0';
    bar.style.top = 'auto';
  }

  // Transcription bubble
  const userMsg = shadowRoot.querySelector('.preview-msg.user');
  userMsg.textContent = "What's the temperature outside?";
  applyBubbleStyle(userMsg, cfg, 'transcription');

  // Response bubble
  const assistantMsg = shadowRoot.querySelector('.preview-msg.assistant');
  if (cfg.show_response) {
    assistantMsg.textContent = "It's currently 75°F and sunny.";
    applyBubbleStyle(assistantMsg, cfg, 'response');
  } else {
    assistantMsg.style.display = 'none';
  }

  // Bubble layout style
  const chat = shadowRoot.querySelector('.preview-chat');
  const isChatStyle = cfg.bubble_style === 'chat';
  chat.style.width = `${cfg.bubble_container_width || 80}%`;
  if (isChatStyle) {
    chat.style.alignItems = 'flex-start';
    userMsg.style.alignSelf = 'flex-end';
    userMsg.style.textAlign = 'left';
    assistantMsg.style.alignSelf = 'flex-start';
    assistantMsg.style.textAlign = 'left';
  } else {
    chat.style.alignItems = 'center';
    userMsg.style.alignSelf = 'center';
    userMsg.style.textAlign = 'center';
    assistantMsg.style.alignSelf = 'center';
    assistantMsg.style.textAlign = 'center';
  }

  // Chat position — centered by flex, with bottom margin for bar clearance
  if (cfg.bar_position === 'bottom') {
    chat.style.marginBottom = `${cfg.bar_height + 8}px`;
  } else {
    chat.style.marginTop = `${cfg.bar_height + 8}px`;
  }

  // Timer pill
  const timerPill = shadowRoot.querySelector('.preview-timer');
  applyBubbleStyle(timerPill, cfg, 'timer');

  const timerProgress = shadowRoot.querySelector('.preview-timer-progress');
  const progressColor = cfg.timer_border_color || 'rgba(100, 200, 150, 0.5)';
  timerProgress.style.background = progressColor;
  timerProgress.style.width = '65%';

  // Timer position
  const gap = 8;
  const pos = cfg.timer_position || 'top-right';
  timerPill.style.top = pos.startsWith('top') ? `${cfg.bar_height + gap + 4}px` : 'auto';
  timerPill.style.bottom = pos.startsWith('top') ? 'auto' : `${cfg.bar_height + gap + 4}px`;
  timerPill.style.left = pos.includes('left') ? `${gap}px` : 'auto';
  timerPill.style.right = pos.includes('left') ? 'auto' : `${gap}px`;
}