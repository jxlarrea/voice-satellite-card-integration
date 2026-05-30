/**
 * openWakeWord model loading + caching.
 *
 * The mel spectrogram and embedding models are SHARED across every OWW
 * wake word, so we cache them at module level and load them exactly once
 * for the lifetime of the page.  Per-wake-word classifiers are also
 * cached so switching wake words doesn't refetch the model file.
 *
 * Files live at /voice_satellite/models/openwakeword/<name>.onnx.  The
 * Python integration's _load_user_custom_models pulls user-added models
 * from /config/voice_satellite/models/openwakeword/ into that path on
 * startup (one-way; we never write back to the persistent folder).
 */

import { compileOwwOnnxModel } from './onnx-runner.js';
import { withWakeWordAssetVersion } from '../versioned-url.js';

function getModelsBase() {
  return globalThis.__VS_OWW_MODELS_BASE || '/voice_satellite/models/openwakeword';
}

const SHARED_MODEL_FILES = {
  melspectrogram: 'melspectrogram.onnx',
  embedding: 'embedding_model.onnx',
};

let _sharedPromise = null;
const _classifierCache = new Map();

async function _fetchAndCompile(filename, kind) {
  const url = withWakeWordAssetVersion(`${getModelsBase()}/${filename}`);
  const resp = await fetch(url, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error(`OWW model fetch failed: ${url} (HTTP ${resp.status})`);
  }
  const buffer = await resp.arrayBuffer();
  if (kind === 'melspectrogram') {
    return compileOwwOnnxModel(buffer, { inputShape: [1, 1760] });
  }
  if (kind === 'embedding') {
    return compileOwwOnnxModel(buffer, { inputShape: [1, 76, 32, 1] });
  }
  return compileOwwOnnxModel(buffer, { inputShape: [1, 16, 96] });
}

/**
 * Load the shared mel-spec + embedding models.  Both are reused across
 * every classifier and across page lifetimes within the same SPA load.
 * @returns {Promise<{melspectrogram, embedding}>}
 */
export async function loadOwwSharedModels() {
  if (_sharedPromise) return _sharedPromise;
  _sharedPromise = (async () => {
    const [melspectrogram, embedding] = await Promise.all([
      _fetchAndCompile(SHARED_MODEL_FILES.melspectrogram, 'melspectrogram'),
      _fetchAndCompile(SHARED_MODEL_FILES.embedding, 'embedding'),
    ]);
    return { melspectrogram, embedding };
  })().catch((e) => {
    _sharedPromise = null; // allow retry
    throw e;
  });
  return _sharedPromise;
}

/**
 * Load (and cache) a wake-word classifier model.  Multiple calls with
 * the same name return the same compiled instance.
 * @param {string} modelName
 */
export async function loadOwwClassifier(modelName) {
  if (_classifierCache.has(modelName)) return _classifierCache.get(modelName);
  const compiled = await _fetchAndCompile(`${modelName}.onnx`, 'classifier');
  compiled.format = 'onnx';
  _classifierCache.set(modelName, compiled);
  return compiled;
}

/** Drop classifier cache entries no longer in `keepNames`. */
export function releaseUnusedOwwClassifiers(keepNames) {
  const keep = new Set(keepNames);
  for (const name of [..._classifierCache.keys()]) {
    if (!keep.has(name)) _classifierCache.delete(name);
  }
}

/** Full reset - clears every cached model.  Used during page teardown. */
export function clearOwwModelCache() {
  _sharedPromise = null;
  _classifierCache.clear();
}
