/**
 * Wake Word Model Loading
 *
 * Loads ONNX Runtime and wake word ONNX models from the
 * integration's static path (/voice_satellite/models/).
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
let _keywordSession = null;
let _loadedKeyword = null;

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
 * Load a keyword model by name.
 * @param {object} ort - onnxruntime-web module
 * @param {string} modelName - e.g. 'ok_nabu', 'hey_jarvis'
 * @param {Function} [onProgress] - callback(modelName) for progress reporting
 * @returns {Promise<object>} ONNX InferenceSession
 */
async function loadKeywordModel(ort, modelName, onProgress) {
  if (_loadedKeyword === modelName && _keywordSession) return _keywordSession;

  const filename = KEYWORD_FILES[modelName] || modelName;
  if (onProgress) onProgress(modelName);

  const url = `${MODELS_BASE}/${filename}.onnx`;
  _keywordSession = await ort.InferenceSession.create(url, {
    executionProviders: ['wasm'],
  });
  _loadedKeyword = modelName;
  return _keywordSession;
}

/**
 * Load all models required for wake word detection.
 * @param {object} ort - onnxruntime-web module
 * @param {string} modelName - keyword model name (e.g. 'ok_nabu')
 * @param {Function} [onProgress] - callback(modelName) for progress reporting
 * @returns {Promise<{melspec: object, embedding: object, vad: object, keyword: object}>}
 */
export async function loadModels(ort, modelName, onProgress) {
  const [common, keyword] = await Promise.all([
    loadCommonModels(ort, onProgress),
    loadKeywordModel(ort, modelName, onProgress),
  ]);
  return { ...common, keyword };
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
  const sessions = [_commonSessions?.melspec, _commonSessions?.embedding, _commonSessions?.vad, _keywordSession];
  for (const s of sessions) {
    if (s) {
      try { await s.release(); } catch (_) { /* ignore */ }
    }
  }
  _commonSessions = null;
  _keywordSession = null;
  _loadedKeyword = null;
}
