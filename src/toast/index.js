/**
 * ToastManager
 *
 * Single-slot, dedup'd, severity-aware runtime notifications. Subscribers
 * (the overlay's fixed-position toast, the mini card's inline strip)
 * render whatever is currently active. A newer toast replaces an older
 * one; firing the same id while it is active refreshes the timestamp
 * without re-animating the UI.
 *
 * Toast shape:
 *   {
 *     id: string,              // stable identifier for dedup
 *     severity: 'error'|'warn'|'info',
 *     category: string,        // short bucket shown inline before the description
 *     description: string,     // one-liner explaining what happened
 *     action?: {
 *       label: string,
 *       type: 'diagnostics' | 'retry' | 'custom',
 *       onClick?: () => void,  // required for type='custom'
 *     },
 *   }
 *
 * The toast UI derives a constant title from severity ("Voice Satellite
 * error" / "warning" / "notice") and renders the detail as
 * "{category}: {description}".
 */

export const SEVERITY = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
};

// Durations (ms). 0 means persistent until dismissed or replaced.
const DURATION = {
  error: 0,
  warn: 8000,
  info: 4000,
};

const TITLE_BY_SEVERITY = {
  error: 'Voice Satellite error',
  warn: 'Voice Satellite warning',
  info: 'Voice Satellite notice',
};

/**
 * Derive the title string from a toast's severity. Exposed so subscribers
 * (overlay UI, mini strip) format consistently.
 */
export function toastTitle(toast) {
  return TITLE_BY_SEVERITY[toast?.severity] || 'Voice Satellite';
}

/**
 * Derive the detail string: "{category}: {description}" when both parts
 * are present, otherwise whichever is available.
 */
export function toastDetail(toast) {
  if (!toast) return '';
  const cat = toast.category?.trim();
  const desc = toast.description?.trim();
  if (cat && desc) return `${cat}: ${desc}`;
  return cat || desc || '';
}

export class ToastManager {
  constructor(session) {
    this._session = session;
    this._log = session.logger;
    this._current = null;
    this._timer = null;
    this._subscribers = new Set();
  }

  get current() { return this._current; }

  /**
   * Show a toast, replacing any active one unless the id matches.
   * @param {object} toast
   */
  show(toast) {
    if (!toast || !toast.id || !toast.severity || !toast.category) {
      this._log.error('toast', 'show() requires id, severity, and category', toast);
      return;
    }
    // Same id currently visible: refresh timestamp, keep the UI stable.
    if (this._current?.id === toast.id) {
      this._current = { ...this._current, ...toast, timestamp: Date.now() };
      this._resetTimer();
      return;
    }
    this._clearTimer();
    this._current = { ...toast, timestamp: Date.now() };
    this._resetTimer();
    this._log.log('toast', `[${toast.severity}] ${toast.id}: ${toastDetail(toast)}`);
    this._notify();
  }

  /**
   * Dismiss a specific toast by id, or the current one if no id passed.
   * @param {string} [id]
   */
  dismiss(id) {
    if (!this._current) return;
    if (id && this._current.id !== id) return;
    this._clearTimer();
    this._current = null;
    this._notify();
  }

  /**
   * Subscribe to toast changes. Invoked immediately with the current
   * value (which may be null). Returns an unsubscribe function.
   */
  subscribe(fn) {
    this._subscribers.add(fn);
    try { fn(this._current); } catch (_) { /* best-effort */ }
    return () => this._subscribers.delete(fn);
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _resetTimer() {
    this._clearTimer();
    if (!this._current) return;
    const duration = DURATION[this._current.severity] ?? 0;
    if (duration <= 0) return;
    const id = this._current.id;
    this._timer = setTimeout(() => {
      if (this._current?.id === id) {
        this._current = null;
        this._timer = null;
        this._notify();
      }
    }, duration);
  }

  _notify() {
    for (const fn of this._subscribers) {
      try { fn(this._current); } catch (err) {
        this._log.error('toast', `Subscriber threw: ${err?.message || err}`);
      }
    }
  }
}

/**
 * Navigate to the Voice Satellite sidebar panel with the Diagnostics
 * card anchor so the subscriber can scroll it into view. Used by the
 * toast action dispatcher.
 */
export function openDiagnostics() {
  try {
    // history.pushState avoids a hard page load (hass navigation).
    const url = '/voice-satellite#diagnostics';
    window.history.pushState({}, '', url);
    window.dispatchEvent(new CustomEvent('location-changed', { composed: true }));
  } catch (_) {
    window.location.href = '/voice-satellite#diagnostics';
  }
}
