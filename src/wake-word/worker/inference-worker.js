/**
 * Wake-word inference Worker.
 *
 * Hosts a single MicroWakeWordInference or OwwBackend instance (selected
 * at init time) and dispatches RPC-style messages from the main thread.
 * Both engine types expose the same interface so this script doesn't
 * branch on engine after creation - it just forwards calls verbatim.
 *
 * Wire format:
 *   inbound:  { seq, type, payload }
 *   outbound: { seq, ok: true, result }   on success
 *             { seq, ok: false, error }  on failure (string)
 *             { type: 'log', category, message } unsolicited log lines
 *
 * Lifecycle:
 *   1. Main thread sends `init` with engine choice + model paths + cfg.
 *      Worker loads models, instantiates the backend, ack on success.
 *   2. Main thread sends `processChunk` per audio frame; worker invokes
 *      and posts the result.
 *   3. Other RPCs (`addKeyword`, `updateThresholds`, etc.) forward to
 *      the same instance method.
 *   4. `destroy` releases models + closes the worker.
 *
 * Note that fetch() inside a Worker uses the Worker's own origin, which
 * matches the main thread, so the model paths just work.
 */

import { loadTFLite, loadMicroModels, loadMicroModel, getMicroModelParams, releaseUnusedMicroModels, resetRuntime } from '../micro-models.js';
import { MicroWakeWordInference } from '../micro-inference.js';
import { OwwBackend } from '../oww/backend.js';

// The actual backend (MicroWakeWordInference | OwwBackend).  Same shape
// of methods so dispatch is uniform.
let backend = null;
// Engine kind ('mww' | 'oww') of the current backend, used to branch
// on MWW-only paths like dynamic stop-word loading.
let engineKind = null;
// Per-instance microWakeWord runtime + model cache.  Only used when
// engine === 'mww'.  We keep them on the worker scope so subsequent
// keyword loads can reuse the same TFLite runtime.
let mwwRuntime = null;
const mwwRunners = new Map(); // name → runner

/** Logger forwarded to the main thread so the engine's existing log
 *  pane / debug output keeps showing OWW/MWW backend messages. */
const workerLogger = {
  log: (category, message) => {
    self.postMessage({ type: 'log', category, message, level: 'log' });
  },
  error: (category, message) => {
    self.postMessage({ type: 'log', category, message, level: 'error' });
  },
};

/**
 * Build the MWW keywordConfigs array (same shape WakeWordManager builds
 * inline) by loading each requested model into the Worker-local TFLite
 * runtime.
 */
async function loadMwwKeywordConfigs(modelNames, sensitivityLabel, cutoffOverrides) {
  if (!mwwRuntime) {
    mwwRuntime = await loadTFLite();
  }
  // Drop runners for models no longer in the active set.
  for (const name of [...mwwRunners.keys()]) {
    if (!modelNames.includes(name)) mwwRunners.delete(name);
  }
  const fresh = modelNames.filter((n) => !mwwRunners.has(n));
  if (fresh.length > 0) {
    const loaded = await loadMicroModels(mwwRuntime, fresh);
    for (const [name, runner] of Object.entries(loaded)) {
      mwwRunners.set(name, runner);
    }
  }
  await releaseUnusedMicroModels(modelNames);
  return modelNames.map((name) => {
    const params = getMicroModelParams(name);
    return {
      runner: mwwRunners.get(name),
      name,
      cutoff: cutoffOverrides?.[name] ?? params.cutoff,
      slidingWindow: params.slidingWindow,
      stepSize: params.stepSize,
      inputScale: params.inputScale,
      inputZeroPoint: params.inputZeroPoint,
    };
  });
}

/** Replace the active backend.  Engines never coexist within one Worker. */
async function init({
  engine,
  models,
  activeKeywords,
  cutoffs,
  energyGateEnabled,
  sensitivityLabel,
  enableTimings,
}) {
  if (backend) {
    try { backend.destroy(); } catch (_) { /* ignore */ }
    backend = null;
  }
  // `activeKeywords` defaults to "all models active".  When the manager
  // wants a keyword loaded but not active (the OWW stop-word case during
  // normal listening), it sends a strict subset and we deactivate the
  // rest immediately after construction.
  const active = new Set(activeKeywords || models);
  if (engine === 'oww') {
    const keywordConfigs = models.map((name) => ({
      name,
      cutoff: cutoffs?.[name],
    }));
    backend = await OwwBackend.create(
      keywordConfigs,
      workerLogger,
      energyGateEnabled,
      sensitivityLabel,
      enableTimings === true,
    );
    for (const name of models) {
      if (!active.has(name)) backend.removeKeyword(name);
    }
  } else if (engine === 'mww') {
    // MWW only loads what's active.  Stop-word standby loading is
    // handled lazily by the `addKeyword` RPC (resolveMwwAddKeyword).
    const keywordConfigs = await loadMwwKeywordConfigs(
      [...active], sensitivityLabel, cutoffs,
    );
    backend = await MicroWakeWordInference.create(
      keywordConfigs,
      workerLogger,
      sensitivityLabel,
      energyGateEnabled,
    );
  } else {
    throw new Error(`Unknown engine: ${engine}`);
  }
  engineKind = engine;
  return { engine, models, active: [...active] };
}

/**
 * Resolve an MWW addKeyword config by loading the runner if needed and
 * filling in slidingWindow/stepSize/quant params from the model manifest.
 * The proxy only sends {name, cutoff} across the wire - everything else
 * is reconstructed here from the worker-local cache.
 */
async function resolveMwwAddKeyword(payload) {
  if (!mwwRuntime) mwwRuntime = await loadTFLite();
  if (!mwwRunners.has(payload.name)) {
    const runner = await loadMicroModel(mwwRuntime, payload.name);
    mwwRunners.set(payload.name, runner);
  }
  const params = getMicroModelParams(payload.name);
  return {
    runner: mwwRunners.get(payload.name),
    name: payload.name,
    cutoff: typeof payload.cutoff === 'number' ? payload.cutoff : params.cutoff,
    slidingWindow: params.slidingWindow,
    stepSize: params.stepSize,
    inputScale: params.inputScale,
    inputZeroPoint: params.inputZeroPoint,
  };
}

/** Async dispatch on the active backend.  Returns whatever the backend
 *  method returns (Promises are awaited). */
async function dispatch(type, payload) {
  if (type === 'init') return init(payload);
  if (!backend) throw new Error(`${type}: backend not initialized`);
  switch (type) {
    case 'processChunk': {
      // payload is a Float32Array (structured-cloned across the wire).
      return backend.processChunk(payload);
    }
    case 'addKeyword': {
      // The proxy strips non-clonable refs (the MWW runner) before
      // sending - restore them here so the underlying inference engines
      // get the shape they expect.
      if (engineKind === 'mww') {
        const cfg = await resolveMwwAddKeyword(payload);
        return backend.addKeyword(cfg);
      }
      return backend.addKeyword(payload);
    }
    case 'removeKeyword': return backend.removeKeyword(payload);
    case 'updateThresholds': return backend.updateThresholds(payload);
    case 'updateEnergyThresholds': return backend.updateEnergyThresholds(payload);
    case 'setEnergyGateEnabled': return backend.setEnergyGateEnabled(payload);
    case 'reset': return backend.reset();
    case 'getLatestSmoothedProbability':
      return backend.getLatestSmoothedProbability(payload);
    case 'destroy': {
      try { backend.destroy(); } catch (_) { /* ignore */ }
      backend = null;
      return null;
    }
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

self.addEventListener('message', async (event) => {
  const { seq, type, payload } = event.data || {};
  try {
    const result = await dispatch(type, payload);
    self.postMessage({ seq, ok: true, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // `code` is set by named errors (e.g. WebGpuUnavailableError) so
    // the main-thread manager can branch on it for a specific toast.
    const code = e?.code;
    self.postMessage({ seq, ok: false, error: message, code });
  }
});
