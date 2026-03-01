/**
 * Copy onnxruntime-web WASM files to the integration's static path.
 *
 * Copies only the WASM-backend files needed for wake word inference:
 *   - ort.wasm.min.mjs       (WASM-only ESM entry, ~46KB)
 *   - ort-wasm-simd-threaded.mjs   (worker loader, ~26KB)
 *   - ort-wasm-simd-threaded.wasm  (WASM binary, ~12MB)
 *
 * Run automatically via npm prebuild/predev hooks.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../node_modules/onnxruntime-web/dist');
const DEST = path.resolve(__dirname, '../custom_components/voice_satellite/ort');

const FILES = [
  'ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

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

  fs.copyFileSync(src, dest);
  const size = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`  ${file} (${size}KB)`);
}

console.log('ORT WASM files copied.');
