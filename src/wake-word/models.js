/**
 * Wake Word Model Loading
 *
 * Loads ONNX Runtime and wake word ONNX models from the
 * integration's static path (/voice_satellite/models/).
 *
 * Supports loading multiple keyword models concurrently for
 * dual wake word detection. Common models (mel, embedding, VAD)
 * are shared; keyword sessions are cached by model name.
 */

const ORT_URL = '/voice_satellite/ort/ort.wasm.min.mjs';
const ORT_WASM_PATH = '/voice_satellite/ort/';
const MODELS_BASE = '/voice_satellite/models';

// Common models shared by all wake words
const COMMON_MODELS = ['melspectrogram', 'embedding_model', 'silero_vad'];

// Keyword model filename mapping (select option → ONNX filename)
const KEYWORD_FILES = {
  ok_nabu: 'ok_nabu',
  hey_jarvis: 'hey_jarvis_v0.1',
  alexa: 'alexa_v0.1',
  hey_mycroft: 'hey_mycroft_v0.1',
  hey_rhasspy: 'hey_rhasspy_v0.1',
};

let _ort = null;
let _commonSessions = null; // { melspec, embedding, vad }
/** @type {Record<string, object>} name → InferenceSession */
let _keywordCache = {};

/**
 * Load onnxruntime-web from the integration's static path (cached after first load).
 * @returns {Promise<object>} The ort module
 */
export async function loadOrt() {
  if (_ort) return _ort;
  _ort = await import(/* webpackIgnore: true */ ORT_URL);

  // Configure WASM paths from the integration's static path
  _ort.env.wasm.wasmPaths = ORT_WASM_PATH;
  return _ort;
}

/**
 * Load the three common ONNX models (melspectrogram, embedding, VAD).
 * Cached — only loads once.
 * @param {object} ort - onnxruntime-web module
 * @param {Function} [onProgress] - callback(modelName) for progress reporting
 * @returns {Promise<{melspec: object, embedding: object, vad: object}>}
 */
async function loadCommonModels(ort, onProgress) {
  if (_commonSessions) return _commonSessions;

  const opts = { executionProviders: ['wasm'] };
  const sessions = {};

  for (const name of COMMON_MODELS) {
    if (onProgress) onProgress(name);
    const url = `${MODELS_BASE}/${name}.onnx`;
    sessions[name === 'embedding_model' ? 'embedding' : name === 'silero_vad' ? 'vad' : 'melspec'] =
      await ort.InferenceSession.create(url, opts);
  }

  _commonSessions = sessions;
  return sessions;
}

/**
 * Load a single keyword model by name (uses per-name cache).
 * @param {object} ort - onnxruntime-web module
 * @param {string} modelName - e.g. 'ok_nabu', 'hey_jarvis'
 * @param {Function} [onProgress] - callback(modelName)
 * @returns {Promise<object>} ONNX InferenceSession
 */
async function loadKeywordModel(ort, modelName, onProgress) {
  if (_keywordCache[modelName]) return _keywordCache[modelName];

  const filename = KEYWORD_FILES[modelName] || modelName;
  if (onProgress) onProgress(modelName);

  const url = `${MODELS_BASE}/${filename}.onnx`;
  const session = await ort.InferenceSession.create(url, {
    executionProviders: ['wasm'],
  });
  _keywordCache[modelName] = session;
  return session;
}

/**
 * Load common models + one or more keyword models.
 * Deduplicates model names so the same ONNX file is only loaded once.
 * @param {object} ort - onnxruntime-web module
 * @param {string[]} modelNames - keyword model names (e.g. ['ok_nabu', 'hey_jarvis'])
 * @param {Function} [onProgress] - callback(modelName) for progress reporting
 * @returns {Promise<{common: {melspec, embedding, vad}, keywords: Record<string, object>}>}
 */
export async function loadModels(ort, modelNames, onProgress) {
  const unique = [...new Set(modelNames)];
  const [common, ...keywordSessions] = await Promise.all([
    loadCommonModels(ort, onProgress),
    ...unique.map((name) => loadKeywordModel(ort, name, onProgress)),
  ]);
  const keywords = {};
  unique.forEach((name, i) => { keywords[name] = keywordSessions[i]; });
  return { common, keywords };
}

/**
 * Release keyword sessions that are no longer active.
 * @param {string[]} activeNames - model names still in use
 */
export async function releaseUnusedKeywords(activeNames) {
  const active = new Set(activeNames);
  for (const [name, session] of Object.entries(_keywordCache)) {
    if (!active.has(name)) {
      try { await session.release(); } catch (_) { /* ignore */ }
      delete _keywordCache[name];
    }
  }
}

/**
 * Get the keyword model's expected window size from its input metadata.
 * @param {object} keywordSession - ONNX InferenceSession for the keyword model
 * @returns {number} window size (default 16)
 */
export function getKeywordWindowSize(keywordSession) {
  try {
    const inputName = keywordSession.inputNames[0];
    const shape = keywordSession.inputNames.length > 0
      ? keywordSession._model?.graph?.input?.[0]?.type?.tensorType?.shape?.dim
      : null;
    if (shape && shape.length >= 2) {
      const dim = parseInt(shape[1]?.dimValue, 10);
      if (dim > 0) return dim;
    }
  } catch (_) { /* fall through */ }
  return 16; // default for all standard v0.1 models
}

/**
 * Release all loaded sessions.
 */
export async function releaseModels() {
  const sessions = [_commonSessions?.melspec, _commonSessions?.embedding, _commonSessions?.vad];
  for (const s of Object.values(_keywordCache)) sessions.push(s);
  for (const s of sessions) {
    if (s) {
      try { await s.release(); } catch (_) { /* ignore */ }
    }
  }
  _commonSessions = null;
  _keywordCache = {};
}
