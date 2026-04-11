/**
 * microWakeWord TFLite Model Loading
 *
 * Loads the TFLite WASM runtime and microWakeWord .tflite models
 * from the integration's static path.
 *
 * Uses the raw TFLiteWebModelRunner API (via tflite_web_api_client.js)
 * loaded as a script tag — no tfjs-core dependency at runtime.
 */

import { readInputQuantization } from './tflite-quant-reader.js';

const TFLITE_CLIENT_URL = '/voice_satellite/tflite/tflite_web_api_client.js';
const TFLITE_WASM_PATH = '/voice_satellite/tflite/';
const MODELS_BASE = '/voice_satellite/models';

// Fallback input quantization (Kevin Ahrendt's V2 micro-wake-word pipeline
// produces these values for every model we've seen). Only used if reading
// the .tflite flatbuffer fails — which should never happen for a valid
// model file.
const DEFAULT_INPUT_SCALE = 0.10196078568696976;
const DEFAULT_INPUT_ZERO_POINT = -128;

// TFLite keyword model filenames (same base names as ONNX but .tflite extension)
const TFLITE_KEYWORD_FILES = {
  ok_nabu: 'ok_nabu',
  hey_jarvis: 'hey_jarvis',
  hey_mycroft: 'hey_mycroft',
  alexa: 'alexa',
  hey_home_assistant: 'hey_home_assistant',
  hey_luna: 'hey_luna',
  okay_computer: 'okay_computer',
  stop: 'stop',
};

// microWakeWord model parameters (from model manifests)
// probability_cutoff and sliding_window_size control detection sensitivity.
// feature_step_size controls how many feature frames per model inference.
// V2 models use feature_step_size=10 → input shape [1, 10, 40].
export const MICRO_MODEL_PARAMS = {
  ok_nabu:              { cutoff: 0.85, slidingWindow: 5, stepSize: 10 },
  hey_jarvis:           { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  hey_mycroft:          { cutoff: 0.95, slidingWindow: 5, stepSize: 10 },
  alexa:                { cutoff: 0.90, slidingWindow: 5, stepSize: 10 },
  hey_home_assistant:   { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  hey_luna:             { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  okay_computer:        { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  stop:                 { cutoff: 0.50, slidingWindow: 5, stepSize: 10 },
};

let _tfweb = null;
let _scriptElement = null;
/** @type {Record<string, object>} name → TFLiteWebModelRunner */
let _modelCache = {};
/** @type {Record<string, object>} name → params from companion JSON */
const _jsonParamsCache = {};

/**
 * Load the TFLite WASM runtime via script tag (cached after first load).
 * Sets window.tfweb and configures the WASM path.
 * @returns {Promise<object>} The tfweb namespace
 */
export async function loadTFLite() {
  if (_tfweb) return _tfweb;

  // Load via script tag — it's a Closure-compiled script that sets window.tfweb.
  // The script has a CommonJS `exports.tfweb = tfweb` epilogue that needs a stub.
  await new Promise((resolve, reject) => {
    if (window.tfweb) { resolve(); return; }
    if (typeof window.exports === 'undefined') window.exports = {};
    const script = document.createElement('script');
    script.src = TFLITE_CLIENT_URL;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load TFLite WASM client'));
    _scriptElement = script;
    document.head.appendChild(script);
  });

  _tfweb = window.tfweb;
  if (!_tfweb) throw new Error('TFLite WASM client loaded but tfweb not found');

  // Configure WASM binary path
  _tfweb.tflite_web_api.setWasmPath(TFLITE_WASM_PATH);
  return _tfweb;
}

/**
 * Try to load a companion JSON manifest for a model.
 * Caches the result (including failures) so we only fetch once per model.
 * @param {string} filename - model base name (without extension)
 * @returns {Promise<object|null>} parsed JSON or null
 */
async function _loadModelManifest(filename) {
  if (filename in _jsonParamsCache) return _jsonParamsCache[filename];
  try {
    const resp = await fetch(`${MODELS_BASE}/${filename}.json`);
    if (!resp.ok) { _jsonParamsCache[filename] = null; return null; }
    const json = await resp.json();
    const micro = json.micro || {};
    const params = {
      cutoff: micro.probability_cutoff ?? 0.90,
      slidingWindow: micro.sliding_window_size ?? 3,
      stepSize: micro.feature_step_size ?? 10,
      _source: `${filename}.json`,
    };
    _jsonParamsCache[filename] = params;
    return params;
  } catch (_) {
    _jsonParamsCache[filename] = null;
    return null;
  }
}

/**
 * Fetch a .tflite file briefly into a JavaScript ArrayBuffer, parse
 * the input quantization params out of its flatbuffer, then DROP the
 * buffer reference. Returns only the small `{scale, zeroPoint}` pair.
 *
 * Why we don't keep the buffer to hand to TFLite: when both the JS
 * ArrayBuffer and TFLite's WASM-side copy of the same bytes are alive
 * at the same time, peak memory during model load is roughly doubled.
 * On memory-constrained Android WebViews running dual wake words this
 * is enough to push the WASM compile path into OOM and falls through
 * to the slower ArrayBuffer instantiation (or crashes the WebView).
 *
 * Loading by URL instead lets the TFLite Web API stream the response
 * straight into WASM linear memory with no JS-side buffer alive at
 * the same time. The second URL fetch is essentially free — the
 * browser HTTP cache holds the .tflite from our quantization probe.
 *
 * The TFLite Web API client doesn't expose tensor quantization at
 * runtime, so we parse it out of the flatbuffer ourselves. This works
 * for any model — built-in or user-supplied — without a build step.
 *
 * @param {string} filename - .tflite base name (without extension)
 * @returns {Promise<{scale: number, zeroPoint: number}>}
 */
async function _fetchModelQuantization(filename) {
  let scale = DEFAULT_INPUT_SCALE;
  let zeroPoint = DEFAULT_INPUT_ZERO_POINT;
  try {
    const resp = await fetch(`${MODELS_BASE}/${filename}.tflite`);
    if (resp.ok) {
      // Block-scope the buffer so it goes out of scope (and is
      // eligible for GC) before this function even returns, never
      // mind before TFLite is asked to allocate.
      const buffer = await resp.arrayBuffer();
      const quant = readInputQuantization(buffer);
      if (quant) {
        scale = quant.scale;
        zeroPoint = quant.zeroPoint;
      }
    }
  } catch (_) { /* fall back to defaults */ }
  return { scale, zeroPoint };
}

/**
 * Load a single microWakeWord TFLite model (cached per name).
 *
 * Two-step load to keep peak memory low during dual-wake-word startup
 * on Android WebView (see _fetchModelQuantization for the rationale):
 *
 *   1. Fetch the .tflite into a short-lived JS ArrayBuffer just long
 *      enough to read its input quantization params, then drop it.
 *   2. Hand the URL (NOT the buffer) to TFLite so it can stream the
 *      response straight into WASM memory with no JS-side copy alive
 *      at the same time. The second fetch hits the browser HTTP cache
 *      and is essentially free.
 *
 * Also loads the companion JSON manifest in parallel.
 *
 * @param {object} tfweb - the tfweb namespace
 * @param {string} modelName - e.g. 'ok_nabu', 'stop'
 * @param {Function} [onProgress] - callback(modelName)
 * @returns {Promise<object>} TFLiteWebModelRunner instance
 */
export async function loadMicroModel(tfweb, modelName, onProgress) {
  if (_modelCache[modelName]) return _modelCache[modelName];

  const filename = TFLITE_KEYWORD_FILES[modelName] || modelName;
  const url = `${MODELS_BASE}/${filename}.tflite`;
  if (onProgress) onProgress(modelName);

  // Step 1: small JS-side fetch to extract quantization. Buffer is
  // dropped before we proceed to step 2.
  const [{ scale, zeroPoint }, manifest] = await Promise.all([
    _fetchModelQuantization(filename),
    _loadModelManifest(filename),
  ]);

  // Step 2: hand the URL to TFLite. It re-fetches (HTTP-cache hit
  // from step 1) and streams directly into WASM linear memory — no
  // JS-side buffer alive while TFLite is allocating its own copy.
  // numThreads: 1 — wake word models are tiny (~50KB), inference <2ms.
  // The default (hardwareConcurrency/2) spawns unnecessary Web Workers.
  const runner = await tfweb.TFLiteWebModelRunner.create(url, { numThreads: 1 });

  // Stash the parsed quantization on the cached manifest so
  // getMicroModelParams() picks it up. This works whether the model
  // had a companion JSON or not — _loadModelManifest creates a stub
  // entry on miss.
  if (_jsonParamsCache[filename]) {
    _jsonParamsCache[filename].inputScale = scale;
    _jsonParamsCache[filename].inputZeroPoint = zeroPoint;
  } else {
    _jsonParamsCache[filename] = {
      cutoff: 0.90,
      slidingWindow: 3,
      stepSize: 10,
      _source: 'tflite',
      inputScale: scale,
      inputZeroPoint: zeroPoint,
    };
  }

  _modelCache[modelName] = runner;
  return runner;
}

/**
 * Delay between sequential model loads. Each TFLiteWebModelRunner
 * instance triggers a fresh WASM module instantiation, which V8
 * implements with a streaming compile that needs a contiguous block
 * of WASM code memory. When two loads fire back-to-back, V8 hasn't
 * had time to settle from the first compile before the second one
 * starts, and on memory-constrained Android WebViews (Fully Kiosk on
 * wall-mounted tablets) the second compile OOMs and falls through to
 * the slower ArrayBuffer path — sometimes crashing the WebView
 * process entirely. Yielding to the event loop and waiting briefly
 * between loads gives V8 a chance to release transient compile state
 * before the next compile starts. 500 ms is enough on the tablets
 * we've tested, and dual wake word startup is a one-time cost so
 * the extra latency is invisible to users.
 */
const MODEL_LOAD_STAGGER_MS = 500;

/**
 * Load multiple microWakeWord models (deduplicated). Loads are
 * sequenced with a brief settle delay between each one — see
 * MODEL_LOAD_STAGGER_MS for the rationale.
 * @param {object} tfweb
 * @param {string[]} modelNames
 * @param {Function} [onProgress]
 * @param {Function} [onStagger] - called with (delayMs) before each settle delay
 * @returns {Promise<Record<string, object>>} name → runner map
 */
export async function loadMicroModels(tfweb, modelNames, onProgress, onStagger) {
  const unique = [...new Set(modelNames)];
  const runners = {};
  let first = true;
  for (const name of unique) {
    if (!first) {
      // Yield to the event loop and let V8 finish whatever GC /
      // compile-cleanup work the previous load triggered before we
      // hit it with another WASM instantiation.
      if (onStagger) onStagger(MODEL_LOAD_STAGGER_MS);
      await new Promise((resolve) => setTimeout(resolve, MODEL_LOAD_STAGGER_MS));
    }
    runners[name] = await loadMicroModel(tfweb, name, onProgress);
    first = false;
  }
  return runners;
}

/**
 * Create an isolated TFLite runner for a model — bypasses the shared cache.
 *
 * Used by the Wake Word Tester so that the standalone test session can run
 * in parallel with the main wake word engine without sharing — and
 * corrupting — the cached runner's stateful VarHandleOp ring buffers
 * (each runner instance has its own internal state). Quantization is
 * read from the flatbuffer the same way loadMicroModel does and stashed
 * in the shared params cache so getMicroModelParams() returns it.
 *
 * Caller is responsible for calling .cleanUp() on the returned runner
 * when finished, otherwise the WASM instance leaks.
 *
 * @param {object} tfweb
 * @param {string} modelName
 * @returns {Promise<object>} a fresh, uncached TFLiteWebModelRunner
 */
export async function createIsolatedModelRunner(tfweb, modelName) {
  const filename = TFLITE_KEYWORD_FILES[modelName] || modelName;
  const url = `${MODELS_BASE}/${filename}.tflite`;
  // Same two-step approach as loadMicroModel: parse quantization in a
  // tight scope, then hand the URL (not the buffer) to TFLite so the
  // JS heap stays clean while TFLite allocates.
  const [{ scale, zeroPoint }] = await Promise.all([
    _fetchModelQuantization(filename),
    _loadModelManifest(filename),
  ]);
  const runner = await tfweb.TFLiteWebModelRunner.create(url, { numThreads: 1 });

  if (_jsonParamsCache[filename]) {
    _jsonParamsCache[filename].inputScale = scale;
    _jsonParamsCache[filename].inputZeroPoint = zeroPoint;
  } else {
    _jsonParamsCache[filename] = {
      cutoff: 0.90,
      slidingWindow: 3,
      stepSize: 10,
      _source: 'tflite',
      inputScale: scale,
      inputZeroPoint: zeroPoint,
    };
  }

  return runner;
}

/**
 * Get model parameters for a keyword name. Checks (in order):
 *   1. The cached entry from a prior loadMicroModel call — this is the
 *      authoritative source: it has both the companion JSON params (if
 *      any) AND the input quantization extracted from the .tflite
 *      flatbuffer at load time.
 *   2. The hardcoded MICRO_MODEL_PARAMS table — covers the case where
 *      this function is called before the model has been loaded (e.g.
 *      the Wake Word Tester pre-rendering the threshold line for a
 *      model the user hasn't selected yet).
 *   3. Catch-all defaults for unknown custom models.
 *
 * Quantization is left as DEFAULT_INPUT_* for unloaded models. The
 * authoritative scale/zeroPoint are populated when loadMicroModel
 * actually fetches the .tflite buffer.
 *
 * @param {string} modelName
 * @returns {{cutoff: number, slidingWindow: number, stepSize: number, inputScale: number, inputZeroPoint: number}}
 */
export function getMicroModelParams(modelName) {
  const filename = TFLITE_KEYWORD_FILES[modelName] || modelName;
  const cached = _jsonParamsCache[filename];
  if (cached) {
    return {
      cutoff: cached.cutoff,
      slidingWindow: cached.slidingWindow,
      stepSize: cached.stepSize,
      _source: cached._source,
      inputScale: cached.inputScale ?? DEFAULT_INPUT_SCALE,
      inputZeroPoint: cached.inputZeroPoint ?? DEFAULT_INPUT_ZERO_POINT,
    };
  }
  const base = MICRO_MODEL_PARAMS[modelName] || { cutoff: 0.90, slidingWindow: 3, stepSize: 10 };
  return {
    ...base,
    inputScale: DEFAULT_INPUT_SCALE,
    inputZeroPoint: DEFAULT_INPUT_ZERO_POINT,
  };
}

/**
 * Release models no longer in use.
 * @param {string[]} activeNames
 * @param {object} [opts]
 * @param {boolean} [opts.includeStop] - also release the stop model (default: skip it)
 */
export async function releaseUnusedMicroModels(activeNames, { includeStop } = {}) {
  const active = new Set(activeNames);
  for (const [name, runner] of Object.entries(_modelCache)) {
    if (name === 'stop' && !includeStop) continue;
    if (!active.has(name)) {
      try { runner.cleanUp(); } catch (_) { /* ignore */ }
      delete _modelCache[name];
    }
  }
}

/**
 * Release all loaded TFLite models.
 */
export async function releaseMicroModels() {
  for (const runner of Object.values(_modelCache)) {
    try { runner.cleanUp(); } catch (_) { /* ignore */ }
  }
  _modelCache = {};
}

/**
 * Get WASM heap byte length from any cached runner's module.
 * @returns {number} heap size in bytes, or 0 if unavailable
 */
export function getWasmHeapSize() {
  for (const runner of Object.values(_modelCache)) {
    try {
      if (runner.module?.HEAPU8) return runner.module.HEAPU8.byteLength;
    } catch (_) {}
  }
  return 0;
}

/**
 * Force-reset the TFLite WASM runtime.
 * Destroys all runners, removes the TFLite script, and clears globals
 * so the next loadTFLite() call instantiates a fresh WASM module with
 * clean linear memory. This is the only way to reclaim leaked WASM memory
 * (WebAssembly linear memory can only grow, never shrink).
 */
export async function forceResetWasm() {
  for (const runner of Object.values(_modelCache)) {
    try { runner.cleanUp(); } catch (_) {}
  }
  _modelCache = {};

  if (_scriptElement) {
    _scriptElement.remove();
    _scriptElement = null;
  } else {
    const el = document.querySelector('script[src*="tflite_web_api_client"]');
    if (el) el.remove();
  }

  try { delete window.tfweb; } catch (_) { window.tfweb = undefined; }
  try { delete window.exports; } catch (_) { window.exports = undefined; }
  _tfweb = null;
}
