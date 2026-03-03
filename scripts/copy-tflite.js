/**
 * Copy TFLite WASM files to the integration's static path.
 *
 * Copies the TFLite Web API client and WASM binaries needed for
 * microWakeWord inference. Includes SIMD and non-SIMD variants
 * (the runtime auto-detects browser capabilities).
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

console.log('TFLite WASM files copied.');
