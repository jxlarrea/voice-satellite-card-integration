/**
 * Voice Satellite Mini Card - Static Editor Preview
 *
 * Prevents the live mini runtime from initializing inside the HA card editor.
 */

import baseCSS from './preview.css';
import { getMiniGridRows, getMiniModeKey } from '../mini/constants.js';

export function renderMiniPreview(shadowRoot, config = {}) {
  _ensureMiniPreviewResizeObserver(shadowRoot);

  const mode = getMiniModeKey(config.mini_mode);
  const rows = _resolvePreviewRows(shadowRoot, mode);
  const previewHeight = _computePreviewHeight(shadowRoot, rows, mode);
  const textScale = (Number(config.text_scale) || 100) / 100;
  const styleVars = `--vs-mini-preview-rows:${rows};--vs-mini-preview-text-scale:${textScale};${previewHeight ? `--vs-mini-preview-height:${previewHeight}px;` : ''}`;

  if (mode === 'compact') {
    shadowRoot.innerHTML = `
      <style>${baseCSS}</style>
      <div class="vs-mini-preview-frame">
        <ha-card class="vs-mini-preview-card compact" style="${styleVars}">
          <div class="vs-mini-preview-surface">
            <div class="vs-mini-preview-header">
              <span class="vs-mini-preview-dot responding"></span>
              <span class="vs-mini-preview-status">Responding</span>
            </div>
            <div class="vs-mini-preview-line">
              <span class="user">Turn on the kitchen lights</span>
              <span class="vs-mini-preview-sep">\u2192</span>
              <span class="assistant">Done. I turned them on.</span>
            </div>
          </div>
        </ha-card>
      </div>
    `;
    return;
  }

  shadowRoot.innerHTML = `
    <style>${baseCSS}</style>
    <div class="vs-mini-preview-frame">
      <ha-card class="vs-mini-preview-card tall" style="${styleVars}">
        <div class="vs-mini-preview-surface">
          <div class="vs-mini-preview-label">Preview</div>
          <div class="vs-mini-preview-header">
            <span class="vs-mini-preview-dot responding"></span>
            <span class="vs-mini-preview-status">Responding</span>
          </div>
          <div class="vs-mini-preview-timers">
            <div class="vs-mini-preview-timer"><span>\u23F1</span><strong>00:04:32</strong></div>
          </div>
          <div class="vs-mini-preview-transcript">
            <div class="vs-mini-preview-msg user">Turn on the kitchen pantry light.</div>
            <div class="vs-mini-preview-msg assistant">Done. The kitchen pantry light is on.</div>
            <div class="vs-mini-preview-msg user">Set a timer for 5 minutes.</div>
            <div class="vs-mini-preview-msg assistant">Done. Your 5-minute timer has started.</div>
            <div class="vs-mini-preview-msg user">What time is it?</div>
            <div class="vs-mini-preview-msg assistant">It is 7:42 PM.</div>
          </div>
        </div>
      </ha-card>
    </div>
  `;
}

function _computePreviewHeight(shadowRoot, rows, mode) {
  const host = shadowRoot.host;
  const gridCell = host?.closest?.('.card');
  const gridCellRect = gridCell?.getBoundingClientRect?.();
  const hostRect = host?.getBoundingClientRect?.();
  const wrapper = host?.closest?.('hui-card');
  const wrapperRect = wrapper?.getBoundingClientRect?.();
  const measuredHeight = Math.floor(Math.max(gridCellRect?.height || 0, hostRect?.height || 0, wrapperRect?.height || 0));
  if (measuredHeight > 0) {
    // If we can measure the Sections grid cell, use it directly so the preview
    // grows/shrinks with the editor row setting.
    if (gridCellRect?.height) return measuredHeight;

    const rowHeight = measuredHeight / 12;
    return Math.max(mode === 'compact' ? 42 : 120, Math.round(rowHeight * rows));
  }
  return 0;
}

function _resolvePreviewRows(shadowRoot, mode) {
  const limits = getMiniGridRows(mode);
  const host = shadowRoot.host;
  const gridCell = host?.closest?.('.card');
  if (gridCell) {
    const rowSizeRaw = getComputedStyle(gridCell).getPropertyValue('--row-size').trim();
    const parsed = Number.parseInt(rowSizeRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(limits.min, Math.min(limits.max, parsed));
    }
  }
  return limits.default;
}

function _ensureMiniPreviewResizeObserver(shadowRoot) {
  const host = shadowRoot.host;
  if (!host || typeof ResizeObserver === 'undefined') return;
  if (host.__vsMiniPreviewRO) return;
  const wrapper = host.closest?.('hui-card');
  const gridCell = host.closest?.('.card');

  let raf = 0;
  const observer = new ResizeObserver(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderMiniPreview(shadowRoot, host._config || {});
    });
  });
  observer.observe(host);
  if (wrapper) observer.observe(wrapper);
  if (gridCell) observer.observe(gridCell);
  host.__vsMiniPreviewRO = observer;
}
