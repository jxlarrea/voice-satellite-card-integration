/**
 * JavaScript loader / API for the micro-frontend WebAssembly module.
 *
 * The WASM bundles the actual TensorFlow Lite micro_frontend C library
 * — the same code that runs on Voice PE hardware and inside the HA
 * Android app — so feature extraction is bit-exact to the reference.
 *
 * Loading model: this module does NOT import the emcc-generated .js
 * file. Webpack would otherwise bundle it (and its embedded WASM) into
 * every chunk that uses the wake word path, which on memory-constrained
 * tablets means duplicate copies in memory plus a transient base64
 * decoding peak. Instead we inject a <script> tag at runtime pointing
 * at the .js file that the integration serves as a static asset, and
 * tell emscripten where to fetch the .wasm via locateFile(). This is
 * the same pattern loadTFLite() in micro-models.js uses for the much
 * larger TFLite Web API client (~3.5 MB).
 *
 * Files are placed in custom_components/voice_satellite/wake-word-frontend/
 * by scripts/copy-microfrontend.js (npm prebuild/predev hook), and
 * frontend.py registers them as a static path.
 *
 * Public API:
 *
 *   const fe = await createWasmMicroFrontend();
 *   fe.feed(samplesFloat32)            // returns Int8Array[] feature frames
 *   fe.setQuantization(scale, zeroPoint)
 *   fe.reset()                         // adaptive state reset
 *   fe.recycleFeature(buf)
 *   fe.destroy()
 */

const URL_BASE = '/voice_satellite/wake-word-frontend';
const SCRIPT_URL = `${URL_BASE}/micro-frontend.js`;
const WASM_URL = `${URL_BASE}/micro-frontend.wasm`;

const SAMPLE_RATE = 16000;
const STEP_SIZE_MS = 10;
const FEATURE_SIZE = 40;

// Worst-case buffer sizing. Wake word audio chunks come in 1280-sample
// (80ms) units; we round up generously so multiple chunks can be fed
// in one call without reallocating.
const INPUT_CAPACITY_SAMPLES = 4096;          // ~256ms — 3 chunks plus slack
const OUTPUT_CAPACITY_FRAMES = 64;            // ~640ms of features

// Memoized module promise. Singleton pattern matches loadTFLite():
// the underlying WASM module is loaded once per page and shared by
// every WasmMicroFrontend instance, even though each instance owns
// its own C++ MicroFrontend object inside the shared WASM heap.
let _modulePromise = null;

/**
 * Load the WASM module by injecting a <script> tag and waiting for
 * window.createMicroFrontendModule to appear, then call it. The factory
 * is set on the window because we built emcc with MODULARIZE=1 (no
 * EXPORT_ES6), which produces a UMD-style global on `window`.
 */
function loadModule() {
  if (_modulePromise) return _modulePromise;

  _modulePromise = new Promise((resolve, reject) => {
    // Already loaded? (e.g. cached across navigations)
    if (typeof window.createMicroFrontendModule === 'function') {
      window.createMicroFrontendModule({
        locateFile: (filename) => filename.endsWith('.wasm') ? WASM_URL : filename,
      }).then(resolve, reject);
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (typeof window.createMicroFrontendModule !== 'function') {
        reject(new Error('micro-frontend.js loaded but createMicroFrontendModule global is missing'));
        return;
      }
      // emcc factory takes an options object. locateFile lets us point
      // it at the .wasm URL HA serves rather than wherever the .js
      // happens to live (browsers compute the .wasm path relative to
      // document.location by default, which would be wrong here).
      window.createMicroFrontendModule({
        locateFile: (filename) => filename.endsWith('.wasm') ? WASM_URL : filename,
      }).then(resolve, reject);
    };
    script.onerror = () => reject(new Error(`Failed to load ${SCRIPT_URL}`));
    document.head.appendChild(script);
  }).catch((err) => {
    // Reset so a future call can retry from scratch (e.g. after a
    // network blip on the first load).
    _modulePromise = null;
    throw err;
  });

  return _modulePromise;
}

/**
 * Create a new WASM-backed micro-frontend instance. Returns a Promise
 * because module instantiation is async on the very first call.
 *
 * @returns {Promise<WasmMicroFrontend>}
 */
export async function createWasmMicroFrontend() {
  const module = await loadModule();
  return new WasmMicroFrontend(module);
}

class WasmMicroFrontend {
  constructor(module) {
    this._module = module;
    this._fe = new module.MicroFrontend(SAMPLE_RATE, STEP_SIZE_MS);
    if (!this._fe.isInitialized()) {
      this._fe.delete();
      throw new Error('micro_frontend WASM init failed');
    }

    // Allocate input + output buffers in WASM heap. Each call to feed()
    // reuses these without reallocating, so streaming is allocation-free.
    this._inputCap = INPUT_CAPACITY_SAMPLES;     // int16 elements
    this._outputCap = OUTPUT_CAPACITY_FRAMES;    // frames
    this._inputPtr = module._malloc(this._inputCap * 2);            // int16 = 2 bytes
    this._outputPtr = module._malloc(this._outputCap * FEATURE_SIZE * 4); // float = 4 bytes

    // Per-model affine input quantization. Defaults match Kevin Ahrendt's
    // V2 micro-wake-word pipeline (all known models share these); the
    // inference engine overrides via setQuantization() per model.
    this._inputScale = 0.10196078568696976;
    this._inputZeroPoint = -128;

    // Pool of reusable Int8Array(40) buffers — allocation-avoidance so
    // we don't churn the GC at ~100 frames/sec during continuous wake
    // word detection.
    this._featurePool = [];
    this._featurePoolMax = 32;
  }

  setQuantization(scale, zeroPoint) {
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
      this._inputScale = scale;
    }
    if (typeof zeroPoint === 'number' && Number.isFinite(zeroPoint)) {
      this._inputZeroPoint = zeroPoint;
    }
  }

  /**
   * Feed Float32 audio samples (16 kHz, mono, [-1, 1]). Returns an
   * array of int8 feature frames produced for this chunk.
   *
   * @param {Float32Array} samples
   * @returns {Int8Array[]}
   */
  feed(samples) {
    if (!samples || samples.length === 0) return [];

    // Grow input buffer on demand. Rare — wake word chunks are 1280
    // samples and we sized for ~3 chunks of slack.
    if (samples.length > this._inputCap) {
      this._module._free(this._inputPtr);
      this._inputCap = samples.length * 2;
      this._inputPtr = this._module._malloc(this._inputCap * 2);
    }

    // Float32 → int16 conversion, written directly into the WASM heap
    // input buffer. The C reference frontend takes int16 PCM in the
    // [-32768, 32767] range, so we scale by 32768 and clamp at the
    // int16 cast.
    const heap16 = this._module.HEAP16;
    const baseIdx = this._inputPtr >> 1; // int16 indexing
    for (let i = 0; i < samples.length; i++) {
      let v = samples[i] * 32768.0;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      heap16[baseIdx + i] = v | 0;
    }

    // Process samples through the WASM frontend. It writes (frames × 40)
    // float32 features into the output buffer and returns the frame count.
    const framesProduced = this._fe.processSamples(
      this._inputPtr,
      samples.length,
      this._outputPtr,
      this._outputCap,
    );

    if (framesProduced <= 0) return [];

    // Quantize each float feature frame to int8 using the model's
    // affine quantization params (matches what the HA Android app does
    // — see microwakeword/src/main/cpp/MicroWakeWordEngine.cpp):
    //   int8 = round(float / inputScale + inputZeroPoint), clamped
    const heapF32 = this._module.HEAPF32;
    const outBaseIdx = this._outputPtr >> 2; // float32 indexing
    const invScale = 1.0 / this._inputScale;
    const zp = this._inputZeroPoint;

    const result = new Array(framesProduced);
    for (let f = 0; f < framesProduced; f++) {
      const buf = this._featurePool.pop() || new Int8Array(FEATURE_SIZE);
      const frameBase = outBaseIdx + f * FEATURE_SIZE;
      for (let i = 0; i < FEATURE_SIZE; i++) {
        const floatVal = heapF32[frameBase + i];
        let val = Math.round(floatVal * invScale + zp);
        if (val < -128) val = -128;
        else if (val > 127) val = 127;
        buf[i] = val;
      }
      result[f] = buf;
    }
    return result;
  }

  recycleFeature(buf) {
    if (this._featurePool.length < this._featurePoolMax && !this._featurePool.includes(buf)) {
      this._featurePool.push(buf);
    }
  }

  /**
   * Reset adaptive state (noise estimate, PCAN gain, etc.). Called by
   * the inference engine on (re)start. The C reference does NOT reset
   * during normal continuous operation, so don't call this between
   * detections — only on session boundaries.
   */
  reset() {
    this._fe.reset();
  }

  /**
   * Free WASM memory and the C++ MicroFrontend instance. Called
   * during teardown (page unload or calibration session stop) so we
   * release the WASM linear memory buffers and the C++ frontend
   * object promptly rather than waiting for GC.
   */
  destroy() {
    const heapBefore = this._module?.HEAPU8?.byteLength || 0;
    if (this._fe) {
      this._fe.delete();
      this._fe = null;
    }
    if (this._inputPtr) {
      this._module._free(this._inputPtr);
      this._inputPtr = 0;
    }
    if (this._outputPtr) {
      this._module._free(this._outputPtr);
      this._outputPtr = 0;
    }
    this._featurePool.length = 0;
    console.info(
      `[VS][wake-word] micro-frontend WASM destroyed (heap ${(heapBefore / 1024).toFixed(0)} KB)`,
    );
  }
}
