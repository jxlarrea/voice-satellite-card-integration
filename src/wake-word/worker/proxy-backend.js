/**
 * Main-thread proxy that forwards inference calls to a Worker.
 *
 * Same surface as MicroWakeWordInference / OwwBackend - WakeWordManager
 * doesn't know whether its `_inference` is a real instance or a proxy.
 * The proxy just serializes calls over postMessage and matches replies
 * by sequence number.
 *
 * Why a Worker:
 *   The embedding model (OWW) takes ~25 ms per 80 ms chunk.  Running on
 *   the main thread blocks the panel's reactive bar, the chart rAF, and
 *   any other UI work.  Off-thread inference keeps frame-time clean
 *   even during continuous speech.
 *
 * Why one Worker per instance:
 *   The panel tester and the live engine each get their own proxy +
 *   Worker.  Lets the tester run independently with its own state
 *   (different sensitivity, energy-gate setting, etc.) without sharing
 *   buffers with the live engine.
 */

// Per-RPC timeouts.  Most calls (processChunk, addKeyword, etc.) finish
// in single-digit ms - 5 s is a generous "something is very wrong" cap.
// Init is the outlier: model fetch + compile + 4-second feature-buffer
// warmup can take 5-15 s on slower tablets, so we give it a much larger
// budget.  Without this split, the panel toasts a "wake word load-failed"
// error before the worker has actually finished spinning up.
const PROCESS_TIMEOUT_MS = 5000;
const INIT_TIMEOUT_MS = 60000;

export class WorkerProxyBackend {
  /**
   * Internal - use `WorkerProxyBackend.create(...)` instead.
   * @param {Worker} worker
   * @param {object} log - logger with .log(category, message)
   */
  constructor(worker, log) {
    this._worker = worker;
    this._log = log;
    this._seq = 0;
    this._pending = new Map(); // seq → {resolve, reject, timer}
    // Cache of latest per-keyword smoothed score so the panel tester
    // can read synchronously without waiting on a worker round-trip
    // for every animation frame.  Updated whenever processChunk
    // resolves.
    this._latestSmoothed = {};
    this._latestRms = 0;
    // Active keyword set + cutoffs cached on the main side so the
    // synchronous `_keywords` getter works for MWW's stop-only-mode
    // suspend/restore flow without round-tripping the worker.  Stays
    // in sync via add/removeKeyword.
    this._activeKeywords = new Set();
    this._cutoffs = {};
    this._engine = null;
    this._destroyed = false;

    this._worker.addEventListener('message', (event) => this._onMessage(event));
    this._worker.addEventListener('error', (event) => this._onError(event));
    this._worker.addEventListener('messageerror', (event) => this._onError(event));
  }

  /**
   * @param {object} options
   * @param {'mww'|'oww'} options.engine
   * @param {string[]} options.models - keyword model names
   * @param {object<string, number>} [options.cutoffs] - per-keyword cutoff override
   * @param {boolean} [options.energyGateEnabled=true]
   * @param {string} [options.sensitivityLabel='Moderately sensitive']
   * @param {boolean} [options.enableTimings=false] - tester-only diagnostics
   * @param {object} [options.log] - logger (forwarded for unsolicited worker logs)
   * @returns {Promise<WorkerProxyBackend>}
   */
  static async create(options) {
    const worker = new Worker(
      new URL('./inference-worker.js', import.meta.url),
      { type: 'module', name: `wake-word-${options.engine}` },
    );
    const proxy = new WorkerProxyBackend(worker, options.log || null);
    proxy._engine = options.engine;
    // Seed local cutoff cache from the init payload.  The active set is
    // explicit (`activeKeywords` overrides, defaults to all `models`) so
    // a keyword can be loaded but not initially active - used by OWW
    // stop-word, which is pre-loaded into the shared mel+embedding
    // pipeline but only runs inference during interruptible states.
    const allNames = options.models || [];
    const activeNames = options.activeKeywords || allNames;
    for (const name of allNames) {
      if (options.cutoffs?.[name] !== undefined) {
        proxy._cutoffs[name] = options.cutoffs[name];
      }
    }
    for (const name of activeNames) proxy._activeKeywords.add(name);
    await proxy._send('init', {
      engine: options.engine,
      models: allNames,
      activeKeywords: activeNames,
      cutoffs: options.cutoffs || {},
      energyGateEnabled: options.energyGateEnabled !== false,
      sensitivityLabel: options.sensitivityLabel || 'Moderately sensitive',
      enableTimings: options.enableTimings === true,
    }, INIT_TIMEOUT_MS);
    return proxy;
  }

  /** Send an RPC and wait for the reply. */
  _send(type, payload, timeoutMs = PROCESS_TIMEOUT_MS) {
    if (this._destroyed) {
      return Promise.reject(new Error(`Worker backend destroyed (call: ${type})`));
    }
    const seq = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(seq);
        reject(new Error(`Worker RPC timeout after ${timeoutMs}ms: ${type}`));
      }, timeoutMs);
      this._pending.set(seq, { resolve, reject, timer });
      this._worker.postMessage({ seq, type, payload });
    });
  }

  _onMessage(event) {
    const data = event.data;
    if (!data) return;
    if (data.type === 'log') {
      // Forward worker-side logs through the main-thread logger so the
      // existing UI log surfaces continue to work identically.
      const fn = data.level === 'error' ? this._log?.error : this._log?.log;
      fn?.call(this._log, data.category, data.message);
      return;
    }
    const seq = data.seq;
    const entry = this._pending.get(seq);
    if (!entry) return;
    this._pending.delete(seq);
    clearTimeout(entry.timer);
    if (data.ok) {
      // Capture per-keyword scores so the synchronous getter has fresh
      // data without round-tripping the worker.
      const result = data.result;
      if (result && typeof result === 'object' && result.perModelScores) {
        this._latestSmoothed = result.perModelScores;
      }
      if (result && typeof result.rms === 'number') {
        this._latestRms = result.rms;
      }
      entry.resolve(result);
    } else {
      // Preserve the error code so callers can branch on specific
      // failures (e.g. WebGpuUnavailableError → "switch to MWW" toast).
      const err = new Error(data.error || 'Worker RPC failed');
      if (data.code) err.code = data.code;
      entry.reject(err);
    }
  }

  _onError(event) {
    const message = event.message || String(event);
    this._log?.error?.('wake-word', `Worker error: ${message}`);
    // Fail every outstanding RPC so callers don't hang.
    for (const [seq, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Worker error: ${message}`));
    }
    this._pending.clear();
  }

  // ─── Mirror the inference-backend interface ──────────────────────────

  /**
   * Process one audio chunk.  Returns a Promise of the result shape:
   *   {detected, score, model, cutoff, rms, triggerType?, perModelScores}
   */
  async processChunk(samples) {
    // Defensive copy: we don't transfer the underlying ArrayBuffer
    // (the audio path recycles its frame buffer in a pool), so a
    // structured clone happens implicitly.  At ~5 KB / 80 ms = 62 KB/s
    // this is negligible compared to the inference cost we just moved
    // off the main thread.
    return this._send('processChunk', samples);
  }

  addKeyword(cfg) {
    if (!cfg?.name) return;
    this._activeKeywords.add(cfg.name);
    if (typeof cfg.cutoff === 'number') this._cutoffs[cfg.name] = cfg.cutoff;
    // Strip non-clonable references (e.g. MWW runner) before sending.
    // The Worker resolves the runner from its own model cache by name.
    this._send('addKeyword', { name: cfg.name, cutoff: cfg.cutoff }).catch(() => {});
  }
  removeKeyword(name) {
    this._activeKeywords.delete(name);
    this._send('removeKeyword', name).catch(() => {});
  }
  updateThresholds(thresholds) {
    if (Array.isArray(thresholds)) {
      for (const t of thresholds) {
        if (t && typeof t.threshold === 'number') this._cutoffs[t.name] = t.threshold;
      }
    }
    this._send('updateThresholds', thresholds).catch(() => {});
  }
  updateEnergyThresholds(label) { this._send('updateEnergyThresholds', label).catch(() => {}); }
  setEnergyGateEnabled(enabled) { this._send('setEnergyGateEnabled', enabled).catch(() => {}); }
  reset() { this._send('reset', null).catch(() => {}); }

  /**
   * Synchronous getter for the panel tester's chart rAF.  Returns the
   * latest per-keyword score that came back from the Worker on the
   * most recent processChunk reply.  Async-await round-trip-per-frame
   * would defeat the whole point of the Worker.
   */
  getLatestSmoothedProbability(keywordName) {
    if (keywordName === undefined) {
      let best = 0;
      for (const v of Object.values(this._latestSmoothed || {})) {
        if (v > best) best = v;
      }
      return best;
    }
    return this._latestSmoothed?.[keywordName] ?? 0;
  }

  get latestRms() {
    return this._latestRms;
  }

  /**
   * MWW exposes _keywords as an array of {name, cutoff, ...} for the
   * stop-only-mode suspend/restore flow in WakeWordManager.  We mirror
   * the active set on the main side (kept in sync via add/removeKeyword)
   * so this synchronous read works without round-tripping the worker.
   * Other fields (runner, slidingWindow, etc.) aren't included - the
   * worker's addKeyword resolves them from its own model cache by name.
   */
  get _keywords() {
    return [...this._activeKeywords].map((name) => ({
      name,
      cutoff: this._cutoffs[name] ?? 0.5,
    }));
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try { this._worker.postMessage({ seq: 0, type: 'destroy', payload: null }); } catch (_) {}
    // Reject any pending RPCs.
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Worker backend destroyed'));
    }
    this._pending.clear();
    try { this._worker.terminate(); } catch (_) {}
  }
}
