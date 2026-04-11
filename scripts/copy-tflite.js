/**
 * Copy TFLite WASM files to the integration's static path.
 *
 * We ship the non-SIMD AND the SIMD pair. The TFLite Web loader
 * (`tflite_web_api_client.js`) probes browser features at runtime
 * and picks one of four variant filenames:
 *
 *   tflite_web_api_cc.js              (no SIMD, no threading)
 *   tflite_web_api_cc_simd.js         (SIMD, no threading)
 *   tflite_web_api_cc_threaded.js     (no SIMD, threading)
 *   tflite_web_api_cc_simd_threaded.js (both)
 *
 * Threading variants need SharedArrayBuffer, which requires COOP/COEP
 * cross-origin isolation headers — HA's static path server doesn't
 * set those, so the threaded variants are never picked in practice
 * and we don't ship them.
 *
 * On Android WebViews running Fully Kiosk, SIMD is supported but
 * threading is not, so the loader picks `_simd.js`. The non-SIMD
 * variant is picked when SIMD is unsupported (older browsers, some
 * desktop configurations). We must ship both — the loader does NOT
 * fall back from one to the other; if it picks `_simd.js` and the
 * file 404s, it stores an undefined Module in its singleton and
 * every subsequent call to TFLiteWebModelRunner.create() crashes
 * with `Cannot read properties of undefined (reading '_malloc')`.
 *
 * Run automatically via npm prebuild/predev hooks.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../node_modules/@tensorflow/tfjs-tflite/wasm');
const DEST = path.resolve(__dirname, '../custom_components/voice_satellite/tflite');

const FILES = [
  'tflite_web_api_client.js',
  'tflite_web_api_cc.js',
  'tflite_web_api_cc.wasm',
  'tflite_web_api_cc_simd.js',
  'tflite_web_api_cc_simd.wasm',
];

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
