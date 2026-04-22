/**
 * DiagnosticsManager
 *
 * Runs a registry of troubleshooting checks (client-side + server-side
 * via WebSocket) and returns a structured report. Drives the "Diagnostics
 * & troubleshooting" section of the sidebar panel and produces a
 * copy-paste report for GitHub issues.
 *
 * Each check is a POJO:
 *   { id, category, title, run: async (ctx) => ({ status, detail?, remediation? }) }
 *
 * Status codes: 'pass' | 'warn' | 'fail' | 'info' | 'skip'
 */

import { CLIENT_CHECKS } from './checks.js';
import { VERSION } from '../constants.js';

const WS_TYPE = 'voice_satellite/run_diagnostics';
const SERVER_TIMEOUT_MS = 5000;

export class DiagnosticsManager {
  /**
   * @param {object} host - Any object exposing getters for
   *   `logger`, `hass`, `config`, and `connection`. The session
   *   satisfies this interface; the sidebar panel creates its own
   *   lightweight host so it doesn't depend on the session singleton
   *   (which may be absent or stale-cached in the Companion App).
   */
  constructor(host) {
    this._host = host;
    this._log = host.logger;
    this._checks = [...CLIENT_CHECKS];
    this._lastReport = null;
  }

  get lastReport() { return this._lastReport; }

  /**
   * Register an additional check at runtime.
   * @param {object} check - { id, category, title, run }
   */
  register(check) {
    this._checks.push(check);
  }

  /**
   * Run all registered checks plus the server-side batch.
   * @returns {Promise<{summary, results, generatedAt}>}
   */
  async runAll() {
    this._log.log('diagnostics', `Running ${this._checks.length} client checks`);

    const ctx = this._buildContext();

    // Run client checks in parallel. Each check owns its own error handling
    // so a thrown exception becomes a 'fail' result rather than aborting
    // the whole run.
    const clientResults = await Promise.all(
      this._checks.map((check) => runCheck(check, ctx)),
    );

    // Fetch server results in parallel with client checks when possible,
    // but we need ctx.entityId which is sync, so just kick off here.
    const serverResults = await this._runServerChecks(ctx);

    const results = [...clientResults, ...serverResults];
    const summary = buildSummary(results);
    const report = {
      generatedAt: Date.now(),
      summary,
      results,
    };
    this._lastReport = report;
    this._log.log('diagnostics', `Completed: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    return report;
  }

  /**
   * Ask the integration to run its server-side checks via WebSocket.
   * Returns an empty list if the WS command is unreachable.
   */
  async _runServerChecks(ctx) {
    const connection = this._host.connection;
    if (!connection) {
      return [{
        id: 'srv.ws-unreachable',
        category: 'Home Assistant',
        title: 'WebSocket connection',
        status: 'fail',
        detail: 'Not connected to Home Assistant',
        remediation: 'Refresh the page and make sure you are logged in.',
      }];
    }

    try {
      const response = await withTimeout(
        connection.sendMessagePromise({
          type: WS_TYPE,
          entity_id: ctx.entityId || null,
          page_protocol: window.location.protocol,
          bundle_version: VERSION,
        }),
        SERVER_TIMEOUT_MS,
        'run_diagnostics timed out',
      );
      if (!response || !Array.isArray(response.results)) {
        return [];
      }
      return response.results;
    } catch (err) {
      this._log.error('diagnostics', `Server checks failed: ${err?.message || err}`);
      return [{
        id: 'srv.error',
        category: 'Home Assistant',
        title: 'Server diagnostics',
        status: 'fail',
        detail: `Could not reach voice_satellite/run_diagnostics (${err?.message || err})`,
        remediation: 'The integration may be out of date. Update Voice Satellite via HACS and reload the page.',
      }];
    }
  }

  _buildContext() {
    const host = this._host;
    const hass = host?.hass;
    const config = host?.config || {};
    return {
      host,
      hass,
      config,
      entityId: config?.satellite_entity || null,
    };
  }
}

async function runCheck(check, ctx) {
  const base = {
    id: check.id,
    category: check.category,
    title: check.title,
  };
  try {
    const out = await check.run(ctx);
    if (!out || !out.status) {
      return { ...base, status: 'info', detail: 'Check returned no result' };
    }
    return { ...base, ...out };
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: `Check threw: ${err?.message || err}`,
    };
  }
}

function buildSummary(results) {
  const s = { pass: 0, warn: 0, fail: 0, info: 0, skip: 0, total: results.length };
  for (const r of results) {
    s[r.status] = (s[r.status] || 0) + 1;
  }
  s.worst = s.fail > 0 ? 'fail' : s.warn > 0 ? 'warn' : 'pass';
  return s;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
