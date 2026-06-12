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
import { VwwBackend } from '../vww/backend.js';

// The actual backend (MicroWakeWordInference | OwwBackend).  Same shape
// of methods so dispatch is uniform.
let backend = null;
// Engine kind ('mww' | 'oww') of the current backend, used to branch
// on MWW-only paths like dynamic stop-word loading.
let engineKind = null;
let currentSensitivityLabel = 'Moderately sensitive';
// Chunks older than this when dequeued are "stale": the queue is backed
// up behind a slow inference.  Just under two chunk periods (2 x 80 ms)
// so normal postMessage jitter never triggers it.
const STALE_CHUNK_MS = 150;
let staleSkips = 0;
let chunkCount = 0;
let overloadWarned = false;
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

const SENSITIVITY_MARGIN_FACTORS = {
  'Slightly sensitive': 0.5,
  'Moderately sensitive': 1.0,
  'Very sensitive': 2.0,
};
const STOP_SENSITIVITY_FACTORS = {
  'Slightly sensitive': 0.8,
  'Moderately sensitive': 1.0,
  'Very sensitive': 1.2,
};
const DEFAULT_CUTOFF = 0.90;

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
      cutoff: cutoffOverrides?.[name] ?? getMwwThreshold(name, params, sensitivityLabel),
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
  pipelineLog,
}) {
  if (backend) {
    try { backend.destroy(); } catch (_) { /* ignore */ }
    backend = null;
  }
  // Fresh backend = fresh backpressure accounting.
  staleSkips = 0;
  chunkCount = 0;
  overloadWarned = false;
  // `activeKeywords` defaults to "all models active".  When the manager
  // wants a keyword loaded but not active (the OWW stop-word case during
  // normal listening), it sends a strict subset and we deactivate the
  // rest immediately after construction.
  const active = new Set(activeKeywords || models);
  let keywordConfigs = [];
  if (engine === 'oww') {
    keywordConfigs = models.map((name) => ({
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
  } else if (engine === 'vww') {
    keywordConfigs = models.map((name) => ({
      name,
      cutoff: cutoffs?.[name],
    }));
    backend = await VwwBackend.create(
      keywordConfigs,
      workerLogger,
      energyGateEnabled,
      sensitivityLabel,
      enableTimings === true,
      { pipelineLog: pipelineLog === true },
    );
    for (const name of models) {
      if (!active.has(name)) backend.removeKeyword(name);
    }
  } else if (engine === 'mww') {
    // MWW only loads what's active.  Stop-word standby loading is
    // handled lazily by the `addKeyword` RPC (resolveMwwAddKeyword).
    keywordConfigs = await loadMwwKeywordConfigs(
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
  currentSensitivityLabel = sensitivityLabel || 'Moderately sensitive';
  engineKind = engine;
  return {
    engine,
    models,
    active: [...active],
    cutoffs: Object.fromEntries(keywordConfigs.map((cfg) => [cfg.name, cfg.cutoff])),
  };
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
    cutoff: typeof payload.cutoff === 'number'
      ? payload.cutoff
      : getMwwThreshold(payload.name, params, currentSensitivityLabel),
    slidingWindow: params.slidingWindow,
    stepSize: params.stepSize,
    inputScale: params.inputScale,
    inputZeroPoint: params.inputZeroPoint,
  };
}

function getMwwThreshold(name, params, sensitivityLabel) {
  const baseCutoff = params.cutoff ?? DEFAULT_CUTOFF;
  const table = name === 'stop' ? STOP_SENSITIVITY_FACTORS : SENSITIVITY_MARGIN_FACTORS;
  const factor = table[sensitivityLabel] ?? 1.0;
  const effective = 1 - (1 - baseCutoff) * factor;
  return Math.max(0.1, Math.min(effective, 0.99));
}

/** Async dispatch on the active backend.  Returns whatever the backend
 *  method returns (Promises are awaited). */
async function dispatch(type, payload) {
  if (type === 'init') return init(payload);
  if (!backend) throw new Error(`${type}: backend not initialized`);
  switch (type) {
    case 'processChunk': {
      // payload is { samples: Float32Array, t: epoch-ms } (older bundles
      // sent the bare Float32Array - keep accepting it).
      const samples = payload?.samples || payload;
      const sentAt = typeof payload?.t === 'number' ? payload.t : null;
      chunkCount++;
      // OWW's streaming classifier expects one embedding per 80 ms chunk.
      // Sustained skipping keeps latency bounded but compresses the
      // embedding timeline, which collapses detection accuracy - there is
      // no way to skip work in OWW without breaking its feature geometry.
      // Surface that loudly once instead of failing silently.
      if (
        !overloadWarned
        && engineKind === 'oww'
        && chunkCount > 125
        && staleSkips / chunkCount > 0.25
      ) {
        overloadWarned = true;
        workerLogger.error(
          'wake-word',
          `openWakeWord cannot keep up with real time on this device (${Math.round((staleSkips / chunkCount) * 100)}% of audio chunks skipped). Its streaming classifier degrades badly when chunks are skipped - switch to vsWakeWord or microWakeWord for reliable detection.`,
        );
      }
      // Backpressure: when inference is slower than real time (>80 ms
      // per chunk on compatibility-tier GPUs), chunks pile up in this
      // worker's message queue and the audio window falls progressively
      // behind the microphone - detections end up reacting to seconds-
      // old speech.  Chunks that aged past the threshold in the queue
      // get their audio ingested (ring + feature window stay gap-free)
      // but skip the expensive GPU run, so the queue drains to real
      // time and only fresh audio pays for inference.
      if (
        sentAt !== null
        && typeof backend.ingestChunk === 'function'
        && Date.now() - sentAt > STALE_CHUNK_MS
      ) {
        staleSkips++;
        if (staleSkips === 1 || staleSkips % 250 === 0) {
          workerLogger.log(
            'wake-word',
            `Backpressure: inference behind real time - ${staleSkips} stale chunk(s) ingested without GPU run`,
          );
        }
        return backend.ingestChunk(samples);
      }
      return backend.processChunk(samples);
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
    case 'updateThresholds': {
      if (engineKind === 'mww' && Array.isArray(payload)) {
        const updates = payload.map((u) => {
          if (typeof u?.threshold === 'number') return u;
          const params = getMicroModelParams(u.name);
          return {
            name: u.name,
            threshold: getMwwThreshold(u.name, params, currentSensitivityLabel),
          };
        });
        backend.updateThresholds(updates);
        return updates;
      }
      return backend.updateThresholds(payload);
    }
    case 'updateEnergyThresholds':
      currentSensitivityLabel = payload || 'Moderately sensitive';
      return backend.updateEnergyThresholds(payload);
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
