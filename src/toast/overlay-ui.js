/**
 * Overlay toast UI.
 *
 * Fixed-position DOM element attached to document.body so it sits above
 * any skin chrome. Subscribes to the ToastManager and renders whatever
 * is currently active. One slot at a time: the incoming toast replaces
 * the outgoing one with a short cross-fade.
 */

import { openDiagnostics, toastTitle, toastDetail } from './index.js';

const HOST_ID = 'voice-satellite-toast';
const HOST_KEY = '__vsToastHost';

/**
 * Mount the overlay toast once per page and hook it up to the session's
 * ToastManager. Safe to call multiple times; repeated calls are a no-op.
 */
export function mountOverlayToast(session) {
  if (window[HOST_KEY]) return;
  window[HOST_KEY] = true;

  _injectStyles();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.className = 'vs-toast-host';
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('role', 'status');
  document.body.appendChild(host);

  session.toast.subscribe((toast) => {
    _render(host, toast, session);
  });
}

function _render(host, toast, session) {
  if (!toast) {
    // Fade out any active toast and remove after the transition.
    const existing = host.querySelector('.vs-toast');
    if (existing) {
      existing.classList.add('is-leaving');
      setTimeout(() => { existing.remove(); }, 180);
    }
    return;
  }

  // Clear any outgoing toast immediately; incoming takes the slot.
  host.innerHTML = '';
  const el = document.createElement('div');
  el.className = `vs-toast is-${toast.severity}`;
  el.dataset.toastId = toast.id;

  const stripe = document.createElement('div');
  stripe.className = 'vs-toast-stripe';
  el.appendChild(stripe);

  const icon = document.createElement('img');
  icon.className = 'vs-toast-icon';
  icon.src = '/voice_satellite/brand/icon.png';
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  el.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'vs-toast-body';

  const title = document.createElement('div');
  title.className = 'vs-toast-title';
  title.textContent = toastTitle(toast);
  body.appendChild(title);

  const detailText = toastDetail(toast);
  if (detailText) {
    const detail = document.createElement('div');
    detail.className = 'vs-toast-detail';
    detail.textContent = detailText;
    body.appendChild(detail);
  }

  if (toast.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vs-toast-action';
    btn.textContent = toast.action.label;
    btn.addEventListener('click', () => {
      if (toast.action.type === 'diagnostics') {
        openDiagnostics();
      } else if (typeof toast.action.onClick === 'function') {
        toast.action.onClick();
      }
      session.toast.dismiss(toast.id);
    });
    body.appendChild(btn);
  }

  el.appendChild(body);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'vs-toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '&times;';
  close.addEventListener('click', () => session.toast.dismiss(toast.id));
  el.appendChild(close);

  host.appendChild(el);

  // Next frame: enter animation.
  requestAnimationFrame(() => el.classList.add('is-visible'));
}

function _injectStyles() {
  if (document.getElementById('vs-toast-styles')) return;
  const style = document.createElement('style');
  style.id = 'vs-toast-styles';
  style.textContent = `
    .vs-toast-host {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 24px;
      display: flex;
      justify-content: center;
      pointer-events: none;
      z-index: 2147483000;
      padding: 0 16px;
      box-sizing: border-box;
    }
    /* Sized for wall-mounted tablet viewing distance (a few feet away).
       Font sizes and the close button tap target are deliberately larger
       than a typical desktop toast. */
    .vs-toast {
      pointer-events: auto;
      display: flex;
      align-items: stretch;
      max-width: 720px;
      width: min(720px, 100%);
      background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
      color: var(--primary-text-color, #fff);
      border-radius: 0;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.25);
      overflow: hidden;
      transform: translateY(16px);
      opacity: 0;
      transition: transform 180ms ease, opacity 180ms ease;
      font-family: var(--ha-font-family, Roboto, sans-serif);
    }
    .vs-toast.is-visible { transform: translateY(0); opacity: 1; }
    .vs-toast.is-leaving { transform: translateY(8px); opacity: 0; }
    .vs-toast-stripe {
      flex: 0 0 8px;
      background: var(--primary-color, #03a9f4);
    }
    .vs-toast.is-error .vs-toast-stripe { background: var(--error-color, #f44336); }
    .vs-toast.is-warn  .vs-toast-stripe { background: var(--warning-color, #ff9800); }
    .vs-toast.is-info  .vs-toast-stripe { background: var(--primary-color, #03a9f4); }
    .vs-toast-icon {
      flex: 0 0 auto;
      width: 44px;
      height: 44px;
      margin: 16px 0 16px 18px;
      object-fit: contain;
      align-self: flex-start;
    }
    .vs-toast-body {
      flex: 1;
      min-width: 0;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .vs-toast-title {
      font-size: 19px;
      font-weight: 600;
      line-height: 1.3;
    }
    .vs-toast-detail {
      font-size: 17px;
      color: var(--secondary-text-color, #bbb);
      line-height: 1.45;
      word-break: break-word;
    }
    .vs-toast-action {
      align-self: flex-start;
      margin-top: 8px;
      background: transparent;
      color: var(--primary-color, #03a9f4);
      border: none;
      padding: 8px 0;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      min-height: 40px;
    }
    .vs-toast-action:hover { opacity: 0.8; }
    .vs-toast.is-error .vs-toast-action { color: var(--error-color, #f44336); }
    .vs-toast.is-warn  .vs-toast-action { color: var(--warning-color, #ff9800); }
    .vs-toast-close {
      flex: 0 0 auto;
      align-self: flex-start;
      background: transparent;
      color: var(--secondary-text-color, #bbb);
      border: none;
      padding: 14px 20px;
      font-size: 44px;
      font-weight: 300;
      line-height: 1;
      cursor: pointer;
      font-family: inherit;
      min-width: 64px;
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vs-toast-close:hover { color: var(--primary-text-color, #fff); }
    @media (max-width: 640px) {
      .vs-toast-host { bottom: 16px; padding: 0 12px; }
    }
  `;
  document.head.appendChild(style);
}
