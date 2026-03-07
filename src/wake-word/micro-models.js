/**
 * microWakeWord TFLite Model Loading
 *
 * Loads the TFLite WASM runtime and microWakeWord .tflite models
 * from the integration's static path.
 *
 * Uses the raw TFLiteWebModelRunner API (via tflite_web_api_client.js)
 * loaded as a script tag — no tfjs-core dependency at runtime.
 */

const TFLITE_CLIENT_URL = '/voice_satellite/tflite/tflite_web_api_client.js';
const TFLITE_WASM_PATH = '/voice_satellite/tflite/';
const MODELS_BASE = '/voice_satellite/models';

// TFLite keyword model filenames (same base names as ONNX but .tflite extension)
const TFLITE_KEYWORD_FILES = {
  ok_nabu: 'ok_nabu',
  hey_jarvis: 'hey_jarvis',
  hey_mycroft: 'hey_mycroft',
  alexa: 'alexa',
  stop: 'stop',
};

// microWakeWord model parameters (from model manifests)
// probability_cutoff and sliding_window_size control detection sensitivity.
// feature_step_size controls how many feature frames per model inference.
// V2 models use feature_step_size=10 → input shape [1, 10, 40].
export const MICRO_MODEL_PARAMS = {
  ok_nabu:     { cutoff: 0.97, slidingWindow: 3, stepSize: 10 },
  hey_jarvis:  { cutoff: 0.97, slidingWindow: 3, stepSize: 10 },
  hey_mycroft: { cutoff: 0.95, slidingWindow: 3, stepSize: 10 },
  alexa:       { cutoff: 0.90, slidingWindow: 3, stepSize: 10 },
  stop:        { cutoff: 0.50, slidingWindow: 3, stepSize: 10 },
};

let _tfweb = null;
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
 * Load a single microWakeWord TFLite model (cached per name).
 * Also attempts to load a companion JSON manifest for model parameters.
 * @param {object} tfweb - the tfweb namespace
 * @param {string} modelName - e.g. 'ok_nabu', 'stop'
 * @param {Function} [onProgress] - callback(modelName)
 * @returns {Promise<object>} TFLiteWebModelRunner instance
 */
export async function loadMicroModel(tfweb, modelName, onProgress) {
  if (_modelCache[modelName]) return _modelCache[modelName];

  const filename = TFLITE_KEYWORD_FILES[modelName] || modelName;
  if (onProgress) onProgress(modelName);

  // Load model and companion JSON in parallel
  const [runner] = await Promise.all([
    tfweb.TFLiteWebModelRunner.create(`${MODELS_BASE}/${filename}.tflite`),
    _loadModelManifest(filename),
  ]);
  _modelCache[modelName] = runner;
  return runner;
}

/**
 * Load multiple microWakeWord models (deduplicated).
 * @param {object} tfweb
 * @param {string[]} modelNames
 * @param {Function} [onProgress]
 * @returns {Promise<Record<string, object>>} name → runner map
 */
export async function loadMicroModels(tfweb, modelNames, onProgress) {
  const unique = [...new Set(modelNames)];
  const runners = {};
  for (const name of unique) {
    runners[name] = await loadMicroModel(tfweb, name, onProgress);
  }
  return runners;
}

/**
 * Get model parameters for a keyword name.
 * Checks companion JSON manifest first, then hardcoded defaults.
 * @param {string} modelName
 * @returns {{cutoff: number, slidingWindow: number, stepSize: number}}
 */
export function getMicroModelParams(modelName) {
  const filename = TFLITE_KEYWORD_FILES[modelName] || modelName;
  return _jsonParamsCache[filename] || MICRO_MODEL_PARAMS[modelName] || { cutoff: 0.90, slidingWindow: 3, stepSize: 10 };
}

/**
 * Release models no longer in use (skips 'stop' — managed separately).
 * @param {string[]} activeNames
 */
export async function releaseUnusedMicroModels(activeNames) {
  const active = new Set(activeNames);
  for (const [name, runner] of Object.entries(_modelCache)) {
    if (name === 'stop') continue;
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
