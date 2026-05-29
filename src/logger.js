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
const _BUFFER_KEY = '__vsLogBuffer';
const _MAX_BUFFER_ENTRIES = 500;
const _MAX_DATA_CHARS = 1800;

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
    this._buffer = _getBuffer();
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
    this._record('log', category, msg, data);
    if (!this._debug) return;
    if (data !== undefined) {
      console.log(`[VS][${category}] ${msg}`, data);
    } else {
      console.log(`[VS][${category}] ${msg}`);
    }
  }

  /**
   * Debug-only log. No-op when debug mode is off (skips both the ring
   * buffer AND the console).  Use for high-frequency diagnostics that
   * would otherwise saturate the 500-entry buffer in seconds (e.g.
   * per-chunk wake-word near-miss decodes at 12.5/s).
   *
   * Named `logDebug` (not `debug`) because the class already has a
   * `set debug(val)` setter for the debug-mode flag, and a same-named
   * method would override the setter (and break all .log() output).
   *
   * @param {string} category - Log tag (e.g. 'wake-word')
   * @param {string} msg - Message
   * @param {*} [data] - Optional data to log
   */
  logDebug(category, msg, data) {
    if (!this._debug) return;
    this._record('log', category, msg, data);
    if (data !== undefined) {
      console.log(`[VS][${category}] ${msg}`, data);
    } else {
      console.log(`[VS][${category}] ${msg}`);
    }
  }

  /**
   * Whether debug mode is currently enabled.  Callers can use this to
   * skip expensive formatting work entirely when the resulting log
   * wouldn't be emitted anyway.
   */
  get isDebug() {
    return !!this._debug;
  }

  /**
   * @param {string} category
   * @param {string} msg
   * @param {*} [data]
   */
  error(category, msg, data) {
    this._record('error', category, msg, data);
    if (data !== undefined) {
      console.error(`[VS][${category}] ${msg}`, data);
    } else {
      console.error(`[VS][${category}] ${msg}`);
    }
  }

  getEntries() {
    return this._buffer.slice();
  }

  exportText(limit = _MAX_BUFFER_ENTRIES) {
    return exportLogBufferText(limit);
  }

  _record(level, category, msg, data) {
    const entry = {
      ts: Date.now(),
      level,
      category,
      msg: String(msg ?? ''),
    };
    const serialized = _serializeData(data);
    if (serialized) entry.data = serialized;
    this._buffer.push(entry);
    if (this._buffer.length > _MAX_BUFFER_ENTRIES) {
      this._buffer.splice(0, this._buffer.length - _MAX_BUFFER_ENTRIES);
    }
  }
}

export function exportLogBufferText(limit = _MAX_BUFFER_ENTRIES) {
  const entries = _getBuffer().slice(-limit);
  if (!entries.length) return 'No Voice Satellite session logs captured yet.';
  return entries.map((entry) => {
    const ts = new Date(entry.ts).toISOString();
    const suffix = entry.data ? ` ${entry.data}` : '';
    return `${ts} [${entry.level}] [${entry.category}] ${entry.msg}${suffix}`;
  }).join('\n');
}

function _getBuffer() {
  return window[_BUFFER_KEY] || (window[_BUFFER_KEY] = []);
}

function _serializeData(data) {
  if (data === undefined) return '';
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  try {
    if (typeof data === 'string') return data;
    const seen = new WeakSet();
    const json = JSON.stringify(data, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (typeof value === 'function') return '[Function]';
      return value;
    });
    return _truncate(json || String(data));
  } catch (_) {
    return _truncate(String(data));
  }
}

function _truncate(text) {
  if (!text || text.length <= _MAX_DATA_CHARS) return text || '';
  return `${text.slice(0, _MAX_DATA_CHARS)}...`;
}
