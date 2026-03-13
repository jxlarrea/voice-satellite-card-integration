/**
 * Copy TFLite WASM files to the integration's static path.
 *
 * Copies the TFLite Web API client and WASM binaries needed for
 * microWakeWord inference. Includes SIMD and non-SIMD variants
 * (the runtime auto-detects browser capabilities).
 *
 * Patches the JS glue files to reduce WASM memory for low-memory
 * devices (e.g. Echo Show 8). The default 32MB initial heap is far
 * more than needed for tiny wake word models (50–80KB each).
 *
 * Run automatically via npm prebuild/predev hooks.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../node_modules/@tensorflow/tfjs-tflite/wasm');
const DEST = path.resolve(__dirname, '../custom_components/voice_satellite/tflite');

const FILES = [
  'tflite_web_api_client.js',
  'tflite_web_api_cc_simd.js',
  'tflite_web_api_cc_simd.wasm',
  'tflite_web_api_cc.js',
  'tflite_web_api_cc.wasm',
];

// Reduced WASM memory settings for low-memory devices.
// Default: INITIAL_MEMORY = 33554432 (32MB), getHeapMax = 2147483648 (2GB).
// Wake word models are 50–80KB each; TFLite interpreter needs ~2–4MB total.
// 8MB initial with 128MB cap is plenty and avoids OOM on constrained devices.
const PATCHED_INITIAL_MEMORY = 8388608;   // 8MB (was 32MB)
const PATCHED_MAX_HEAP = 134217728;       // 128MB (was 2GB)

/**
 * Patch WASM JS glue to reduce memory footprint.
 * - Lowers INITIAL_MEMORY (initial WebAssembly.Memory allocation)
 * - Caps getHeapMax() (maximum memory growth)
 */
function patchWasmGlue(code) {
  let patched = code;
  let changes = 0;

  // Patch INITIAL_MEMORY: var INITIAL_MEMORY=Module["INITIAL_MEMORY"]||33554432
  const initMemRe = /(var INITIAL_MEMORY=Module\["INITIAL_MEMORY"\]\|\|)\d+/;
  if (initMemRe.test(patched)) {
    patched = patched.replace(initMemRe, `$1${PATCHED_INITIAL_MEMORY}`);
    changes++;
  }

  // Patch getHeapMax: function getHeapMax(){return 2147483648}
  const heapMaxRe = /(function getHeapMax\(\)\{return )\d+(\})/;
  if (heapMaxRe.test(patched)) {
    patched = patched.replace(heapMaxRe, `$1${PATCHED_MAX_HEAP}$2`);
    changes++;
  }

  return { patched, changes };
}

// Create destination directory
if (!fs.existsSync(DEST)) {
  fs.mkdirSync(DEST, { recursive: true });
}

for (const file of FILES) {
  const src = path.join(SRC, file);
  const dest = path.join(DEST, file);

  if (!fs.existsSync(src)) {
    console.error(`Missing: ${src}`);
    process.exit(1);
  }

  // Patch JS glue files to reduce WASM memory
  if (file.endsWith('.js') && file.startsWith('tflite_web_api_cc')) {
    const code = fs.readFileSync(src, 'utf8');
    const { patched, changes } = patchWasmGlue(code);
    fs.writeFileSync(dest, patched);
    const size = (fs.statSync(dest).size / 1024).toFixed(0);
    console.log(`  ${file} (${size}KB) — ${changes} memory patches applied`);
  } else {
    fs.copyFileSync(src, dest);
    const size = (fs.statSync(dest).size / 1024).toFixed(0);
    console.log(`  ${file} (${size}KB)`);
  }
}

console.log('TFLite WASM files copied.');
