/**
 * vsWakeWord model loading + caching.
 *
 * Two architectures are supported, chosen per-keyword by the manifest's
 * `format` field:
 *
 *   - `vs-wake-word-logmel-cnn-v1` (default, format="cnn"): a single
 *     ONNX log-mel CNN graph.  Compiled into one CompiledOwwModel.
 *   - `vs-wake-word-embedding-v1`  (format="embedding"): a 3-stage chain:
 *       audio -> melspectrogram.onnx -> embedding_model.onnx -> classifier.onnx
 *     The first two stages are shared across all embedding-arch keywords;
 *     only the classifier is per-keyword.
 *
 * Files live at /voice_satellite/models/vswakeword/<name>.onnx and
 * /voice_satellite/models/vswakeword/<name>.json.  Embedding-arch
 * deployments also include the two shared upstream ONNX files at
 * /voice_satellite/models/vswakeword/melspectrogram.onnx and
 * .../embedding_model.onnx.  The Python integration's
 * _sync_custom_models() copies any user-added models from
 * /config/voice_satellite/models/vswakeword/ into that path on
 * startup (one-way; persistent folder is the source of truth).
 */

import { compileOwwOnnxModel } from './onnx-runner.js';
import { checkpointVwwStartup } from './startup-breadcrumb.js';
import { withWakeWordAssetVersion } from '../versioned-url.js';

function getModelsBase() {
  return globalThis.__VS_VWW_MODELS_BASE || '/voice_satellite/models/vswakeword';
}

const _modelCache = new Map();      // name → { compiled, manifest, architecture, ... }
const _inflight = new Map();        // name → Promise<entry>

// Shared upstream models for `embedding` architecture.  Loaded lazily on
// the first embedding-arch keyword, then reused for any subsequent one.
let _sharedEmbeddingPipeline = null;
let _sharedEmbeddingInflight = null;

async function _fetchManifest(name) {
  const url = withWakeWordAssetVersion(`${getModelsBase()}/${name}.json`);
  await checkpointVwwStartup('model:fetch-manifest', { model: name, url });
  // `cache: 'no-store'` so manifest edits take effect on plain reload.
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) return null;
  return resp.json();
}

async function _fetchAndCompile(urlOrName, manifestForShape) {
  // urlOrName: either an absolute path (for upstream shared models) or
  // just a name (resolved against getModelsBase()).
  const url = urlOrName.startsWith('/') || urlOrName.includes('://')
    ? withWakeWordAssetVersion(urlOrName)
    : withWakeWordAssetVersion(`${getModelsBase()}/${urlOrName}.onnx`);
  await checkpointVwwStartup('model:fetch-onnx', { model: urlOrName, url });
  const resp = await fetch(url, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error(`VWW ONNX fetch failed: ${url} (HTTP ${resp.status})`);
  }
  const buffer = await resp.arrayBuffer();
  // The trainer emits CNN manifests as `input.shape` and embedding
  // manifests as top-level `input_shape`.  Support both so we always
  // pass a concrete shape to the runner - the ONNX's declared shape is
  // dynamic ['batch', 'time', 96] for the embedding classifier, which
  // WebGPU cannot allocate a buffer for.
  const inputShape = manifestForShape?.input?.shape
    || manifestForShape?.input_shape
    || null;
  await checkpointVwwStartup('model:compile-onnx', {
    model: urlOrName,
    inputShape,
    bytes: buffer.byteLength,
  });
  const compiled = compileOwwOnnxModel(buffer, inputShape ? { inputShape } : undefined);
  compiled.format = 'onnx';
  return compiled;
}

/** Load + cache the shared OWW melspectrogram + embedding ONNX files.
 * Called by every embedding-arch keyword; serialized so concurrent
 * loadVwwModel() calls all see the same compiled pair. */
async function _loadSharedEmbeddingPipeline(embeddingBlock) {
  if (_sharedEmbeddingPipeline) return _sharedEmbeddingPipeline;
  if (_sharedEmbeddingInflight) return _sharedEmbeddingInflight;
  // Resolve paths.  The manifest paths are relative to the project
  // root (e.g. 'data/pretrained/melspectrogram.onnx') as the trainer
  // wrote them, but the runtime serves files from the deployment
  // models dir.  Use the filename portion under that dir.
  const fname = (p, def) => {
    const raw = (p || def || '').split('/').pop();
    return raw || def;
  };
  const melName = fname(embeddingBlock?.melspectrogram_model, 'melspectrogram.onnx');
  const embName = fname(embeddingBlock?.embedding_model, 'embedding_model.onnx');
  const melUrl = withWakeWordAssetVersion(`${getModelsBase()}/${melName}`);
  const embUrl = withWakeWordAssetVersion(`${getModelsBase()}/${embName}`);

  // The shared melspec + embedding ONNX files have DYNAMIC input shapes
  // in their declared graphs (melspec: ['batch_size', 'samples'];
  // embedding: ['unk__314', 76, 32, 1]).  WebGPU can't allocate buffers
  // for unknown dim sizes, so override with the concrete shapes our
  // pipeline uses:
  //   melspec: (1, 1760) - CHUNK_SAMPLES (1280) + MEL_PREFIX (480).
  //   embedding: (1, 76, 32, 1) - the 76-frame mel slice OWW expects.
  const melShape = [1, 1760];
  const embShape = [
    1,
    embeddingBlock?.embedding_input_frames ?? 76,
    embeddingBlock?.embedding_input_mels ?? 32,
    1,
  ];

  _sharedEmbeddingInflight = (async () => {
    const [melspec, embedding] = await Promise.all([
      _fetchAndCompile(melUrl, { input_shape: melShape }),
      _fetchAndCompile(embUrl, { input_shape: embShape }),
    ]);
    _sharedEmbeddingPipeline = { melspec, embedding };
    return _sharedEmbeddingPipeline;
  })().finally(() => { _sharedEmbeddingInflight = null; });
  return _sharedEmbeddingInflight;
}

/**
 * Load (and cache) a vsWakeWord model.  Returns:
 *   - For 'cnn': { architecture: 'cnn', compiled, manifest }
 *   - For 'embedding': { architecture: 'embedding', compiled, manifest,
 *                       sharedMelspec, sharedEmbedding, embeddingConfig }
 * where `compiled` is the per-keyword classifier in the embedding case.
 */
export async function loadVwwModel(name) {
  const cached = _modelCache.get(name);
  if (cached) return cached;
  const pending = _inflight.get(name);
  if (pending) return pending;
  const promise = (async () => {
    const manifest = await _fetchManifest(name);
    const isEmbedding = manifest && manifest.format === 'vs-wake-word-embedding-v1';
    const isCtc = manifest && manifest.format === 'vs-wake-word-ctc-v1';

    if (isEmbedding) {
      const shared = await _loadSharedEmbeddingPipeline(manifest.embedding || {});
      const classifier = await _fetchAndCompile(name, manifest);
      const entry = {
        architecture: 'embedding',
        compiled: classifier,
        manifest,
        sharedMelspec: shared.melspec,
        sharedEmbedding: shared.embedding,
        embeddingConfig: manifest.embedding || {},
      };
      _modelCache.set(name, entry);
      return entry;
    }

    if (isCtc) {
      // v16+ CTC: same single-stage log-mel CNN backbone as the binary
      // 'cnn' path, just a different output shape ((1, T_out, V) instead
      // of (1, 1)).  Load via _fetchAndCompile exactly like CNN; the
      // CTC manifest carries the phoneme inventory + wake-word targets
      // the runtime decoder needs.
      const inputShape = manifest?.input?.shape || [1, 98, 40];
      const compiled = await _fetchAndCompile(name, { input: { shape: inputShape } });
      const entry = {
        architecture: 'ctc',
        compiled,
        manifest,
        ctcConfig: manifest.ctc || null,
      };
      _modelCache.set(name, entry);
      return entry;
    }

    // Default CNN path - same behavior as before the embedding-arch
    // refactor.  Single self-contained ONNX, default input shape if
    // the manifest doesn't carry one.
    const inputShape = manifest?.input?.shape || [1, 98, 40];
    const compiled = await _fetchAndCompile(name, { input: { shape: inputShape } });
    const entry = {
      architecture: 'cnn',
      compiled,
      manifest,
    };
    _modelCache.set(name, entry);
    return entry;
  })().finally(() => {
    _inflight.delete(name);
  });
  _inflight.set(name, promise);
  return promise;
}

/** Drop cached models no longer in `keepNames`.  Also drops the shared
 * embedding pipeline if no remaining models use it. */
export function releaseUnusedVwwModels(keepNames) {
  const keep = new Set(keepNames);
  for (const name of [..._modelCache.keys()]) {
    if (!keep.has(name)) _modelCache.delete(name);
  }
  // Free shared embedding pipeline if no embedding-arch model remains.
  const anyEmbedding = [..._modelCache.values()].some(e => e.architecture === 'embedding');
  if (!anyEmbedding) {
    _sharedEmbeddingPipeline = null;
  }
}

/** Full reset - clears every cached model.  Used during page teardown. */
export function clearVwwModelCache() {
  _modelCache.clear();
  _inflight.clear();
  _sharedEmbeddingPipeline = null;
  _sharedEmbeddingInflight = null;
}
