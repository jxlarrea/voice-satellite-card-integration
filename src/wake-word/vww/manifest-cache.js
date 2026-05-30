/**
 * Main-thread cache of vsWakeWord JSON manifests.
 *
 * Kept separate from `models.js` so the panel can read recommended
 * thresholds + feature config without pulling in the ONNX parser.
 * The worker has its own model+manifest cache via `models.js`; the
 * two are independent and only the JSON is duplicated.
 */

import { withWakeWordAssetVersion } from '../versioned-url.js';

const DEFAULT_PARAMS = {
  cutoff: 0.6,
  source: 'fallback',
};

function getManifestBase() {
  return globalThis.__VS_VWW_MODELS_BASE || '/voice_satellite/models/vswakeword';
}

const _cache = new Map();    // name → params
const _inflight = new Map(); // name → Promise

/**
 * Synchronous getter. Returns cached params if previously loaded,
 * otherwise a hardcoded fallback so the threshold UI has something to
 * render while loadVwwModelParams() is still in flight.
 */
export function getVwwModelParams(name) {
  return _cache.get(name) || DEFAULT_PARAMS;
}

/**
 * Fetch and cache a model's JSON manifest. Idempotent; concurrent
 * callers see the same in-flight promise.
 */
export async function loadVwwModelParams(name) {
  const cached = _cache.get(name);
  if (cached && cached.source !== 'fallback') return cached;
  const pending = _inflight.get(name);
  if (pending) return pending;
  const promise = (async () => {
    let manifest = null;
    try {
      const url = withWakeWordAssetVersion(`${getManifestBase()}/${name}.json`);
      const resp = await fetch(url, { cache: 'no-store' });
      if (resp.ok) manifest = await resp.json();
    } catch (_) {
      // network / parse failure leaves us on the fallback - never throws
    }
    const params = {
      cutoff: typeof manifest?.recommended_threshold === 'number'
        ? manifest.recommended_threshold
        : DEFAULT_PARAMS.cutoff,
      feature_config: manifest?.feature_config || null,
      // Optional runtime hint emitted by recent trainer versions.
      // When present and `required_hits` > 0, the VwwBackend switches
      // to N-consecutive-frames-above-cutoff detection (counter mode)
      // instead of the borderline-confirm gate.  Absent for older
      // models -> backend keeps current behavior.
      runtime: (manifest && typeof manifest === 'object' && manifest.runtime)
        ? manifest.runtime
        : null,
      // Model architecture: 'cnn' (default, single-file log-mel CNN) or
      // 'embedding' (3-file chain: OWW melspec -> OWW embedding -> our
      // tiny Conv1D+Linear classifier) or 'ctc' (v16+ phoneme-CTC
      // outputs frame-level phoneme posteriors that get greedy-decoded
      // and substring-matched against the wake-word phoneme sequence).
      // Detected from manifest.format:
      //   'vs-wake-word-logmel-cnn-v1' -> 'cnn'
      //   'vs-wake-word-embedding-v1'  -> 'embedding'
      //   'vs-wake-word-ctc-v1'        -> 'ctc'
      architecture: _detectArchitecture(manifest),
      // For 'embedding' architecture: the manifest carries an `embedding`
      // block with the upstream model file paths and slicing config.
      // For 'cnn' / 'ctc' it stays null.
      embedding: (manifest && typeof manifest.embedding === 'object')
        ? manifest.embedding
        : null,
      // For 'ctc' architecture: the manifest's `ctc` block carries the
      // phoneme vocabulary + wake-word target sequences + edit-distance
      // tolerance the decoder uses to detect the wake word from
      // frame-level phoneme posteriors.
      ctc: (manifest && typeof manifest.ctc === 'object')
        ? manifest.ctc
        : null,
      source: manifest ? 'manifest' : 'fallback',
    };
    _cache.set(name, params);
    return params;
  })().finally(() => {
    _inflight.delete(name);
  });
  _inflight.set(name, promise);
  return promise;
}

function _detectArchitecture(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'cnn';
  if (manifest.format === 'vs-wake-word-embedding-v1') return 'embedding';
  if (manifest.format === 'vs-wake-word-ctc-v1') return 'ctc';
  return 'cnn';
}

/** Drop cached params for models no longer in `keepNames`. */
export function releaseUnusedVwwManifests(keepNames) {
  const keep = new Set(keepNames);
  for (const name of [..._cache.keys()]) {
    if (!keep.has(name)) _cache.delete(name);
  }
}
