/**
 * Wake-word model loading.
 *
 * This now uses the in-repo custom runner instead of the generic TFLite Web
 * API runtime. The public API stays the same so the rest of the wake-word
 * manager does not need to care which backend is active.
 */

import { readInputQuantization } from './tflite-quant-reader.js';
import {
  CustomWakeWordModelRunner,
  clearCustomWakeWordModels,
  loadCustomWakeWordModel,
  releaseCustomWakeWordModels,
} from './custom-model-runner.js';

const MODELS_BASE = '/voice_satellite/models';

const DEFAULT_INPUT_SCALE = 0.10196078568696976;
const DEFAULT_INPUT_ZERO_POINT = -128;

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

export const MICRO_MODEL_PARAMS = {
  ok_nabu: { cutoff: 0.85, slidingWindow: 5, stepSize: 10 },
  hey_jarvis: { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  hey_mycroft: { cutoff: 0.95, slidingWindow: 5, stepSize: 10 },
  alexa: { cutoff: 0.90, slidingWindow: 5, stepSize: 10 },
  hey_home_assistant: { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  hey_luna: { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  okay_computer: { cutoff: 0.97, slidingWindow: 5, stepSize: 10 },
  stop: { cutoff: 0.50, slidingWindow: 5, stepSize: 10 },
};

let _runtime = null;
let _modelCache = {};
const _jsonParamsCache = {};

export async function loadTFLite() {
  if (!_runtime) _runtime = { backend: 'custom-js' };
  return _runtime;
}

async function _loadModelManifest(filename) {
  if (filename in _jsonParamsCache) return _jsonParamsCache[filename];
  try {
    const resp = await fetch(`${MODELS_BASE}/${filename}.json`);
    if (!resp.ok) {
      _jsonParamsCache[filename] = null;
      return null;
    }
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

async function _fetchModelQuantization(filename) {
  let scale = DEFAULT_INPUT_SCALE;
  let zeroPoint = DEFAULT_INPUT_ZERO_POINT;
  try {
    const resp = await fetch(`${MODELS_BASE}/${filename}.tflite`);
    if (resp.ok) {
      const buffer = await resp.arrayBuffer();
      const quant = readInputQuantization(buffer);
      if (quant) {
        scale = quant.scale;
        zeroPoint = quant.zeroPoint;
      }
    }
  } catch (_) {}
  return { scale, zeroPoint };
}

function _cacheParams(filename, scale, zeroPoint) {
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
}

export async function loadMicroModel(_runtimeHandle, modelName, onProgress) {
  if (_modelCache[modelName]) return _modelCache[modelName];

  const filename = TFLITE_KEYWORD_FILES[modelName] || modelName;
  if (onProgress) onProgress(modelName);

  const [{ scale, zeroPoint }] = await Promise.all([
    _fetchModelQuantization(filename),
    _loadModelManifest(filename),
  ]);

  const compiled = await loadCustomWakeWordModel(modelName);
  const runner = new CustomWakeWordModelRunner(compiled);

  _cacheParams(filename, scale, zeroPoint);
  _modelCache[modelName] = runner;
  return runner;
}

export async function loadMicroModels(runtimeHandle, modelNames, onProgress, _onStagger) {
  const unique = [...new Set(modelNames)];
  const runners = {};
  for (const name of unique) {
    runners[name] = await loadMicroModel(runtimeHandle, name, onProgress);
  }
  return runners;
}

export async function createIsolatedModelRunner(_runtimeHandle, modelName) {
  const filename = TFLITE_KEYWORD_FILES[modelName] || modelName;
  const [{ scale, zeroPoint }] = await Promise.all([
    _fetchModelQuantization(filename),
    _loadModelManifest(filename),
  ]);
  const compiled = await loadCustomWakeWordModel(modelName);
  _cacheParams(filename, scale, zeroPoint);
  return new CustomWakeWordModelRunner(compiled);
}

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
  const base = MICRO_MODEL_PARAMS[modelName] || {
    cutoff: 0.90,
    slidingWindow: 3,
    stepSize: 10,
  };
  return {
    ...base,
    inputScale: DEFAULT_INPUT_SCALE,
    inputZeroPoint: DEFAULT_INPUT_ZERO_POINT,
  };
}

export async function releaseUnusedMicroModels(activeNames, { includeStop } = {}) {
  const active = new Set(activeNames);
  for (const [name, runner] of Object.entries(_modelCache)) {
    if (name === 'stop' && !includeStop) continue;
    if (!active.has(name)) {
      try { runner.cleanUp?.(); } catch (_) {}
      delete _modelCache[name];
    }
  }
  releaseCustomWakeWordModels([...active, ...(includeStop ? ['stop'] : [])]);
}

export async function releaseMicroModels() {
  for (const runner of Object.values(_modelCache)) {
    try { runner.cleanUp?.(); } catch (_) {}
  }
  _modelCache = {};
  clearCustomWakeWordModels();
}

export async function resetRuntime() {
  const modelCount = Object.keys(_modelCache).length;
  await releaseMicroModels();
  _runtime = null;
  console.info(`[VS][wake-word] resetRuntime: cleaned ${modelCount} custom runner(s)`);
}
