/**
 * Logger
 *
 * Centralised logging controlled by config.debug flag.
 * All managers receive a reference to this logger from the card.
 *
 * URL override: append ?vs_debug=true to enable or ?vs_debug=false
 * to disable logging regardless of the config flag. The override is
 * persisted in localStorage so it survives page reloads on kiosk
 * devices where editing the URL is inconvenient.
 */

const _STORAGE_KEY = 'vs-debug-override';

function _checkUrlOverride() {
  try {
    const params = new URLSearchParams(window.location.search);
    const val = params.get('vs_debug');
    if (val === 'true') {
      localStorage.setItem(_STORAGE_KEY, 'true');
      return true;
    }
    if (val === 'false') {
      localStorage.removeItem(_STORAGE_KEY);
      return false;
    }
    // No URL param — check persisted override
    if (localStorage.getItem(_STORAGE_KEY) === 'true') return true;
  } catch (_) { /* localStorage unavailable */ }
  return null;
}

export class Logger {
  constructor() {
    const override = _checkUrlOverride();
    this._override = override;
    this._debug = override ?? false;
  }

  set debug(val) {
    this._debug = this._override ?? !!val;
  }

  /**
   * @param {string} category - Log tag (e.g. 'pipeline', 'tts')
   * @param {string} msg - Message
   * @param {*} [data] - Optional data to log
   */
  log(category, msg, data) {
    if (!this._debug) return;
    if (data !== undefined) {
      console.log(`[VS][${category}] ${msg}`, data);
    } else {
      console.log(`[VS][${category}] ${msg}`);
    }
  }

  /**
   * @param {string} category
   * @param {string} msg
   * @param {*} [data]
   */
  error(category, msg, data) {
    if (data !== undefined) {
      console.error(`[VS][${category}] ${msg}`, data);
    } else {
      console.error(`[VS][${category}] ${msg}`);
    }
  }
}
