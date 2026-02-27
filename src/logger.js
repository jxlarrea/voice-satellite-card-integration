/**
 * Voice Satellite Card - Logger
 *
 * Centralised logging controlled by config.debug flag.
 * All managers receive a reference to this logger from the card.
 */

export class Logger {
  constructor() {
    this._debug = false;
  }

  set debug(val) {
    this._debug = !!val;
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
