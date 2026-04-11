/**
 * Copy TFLite WASM files to the integration's static path.
 *
 * The TFLite Web loader (`tflite_web_api_client.js`) probes browser
 * features at runtime and picks one of four variant filenames:
 *
 *   tflite_web_api_cc.js              (no SIMD, no threading)
 *   tflite_web_api_cc_simd.js         (SIMD, no threading)
 *   tflite_web_api_cc_threaded.js     (no SIMD, threading)
 *   tflite_web_api_cc_simd_threaded.js (both)
 *
 * We force the loader to always pick the basic non-SIMD non-threaded
 * variant by patching the cached `wasmFeatures` object inside the
 * client to be `{simd:false, multiThreading:false}` after copying.
 * The SIMD variant produces ~37 % more compiled native code in V8's
 * code-space pool, which on memory-constrained Android WebViews is
 * the difference between fitting and OOMing. Wake word inference is
 * <2 ms either way and we run ~10 inferences per second, so the SIMD
 * speedup is irrelevant for our use case.
 *
 * Threading variants need SharedArrayBuffer, which requires COOP/COEP
 * cross-origin isolation headers — HA's static path server doesn't
 * set those, so the threaded variants are never picked in practice.
 *
 * We still ship the SIMD pair on disk as a safety net: if the patch
 * ever fails (e.g. upstream tflite-web changes the wasmFeatures
 * variable name and our string substitution silently no-ops), the
 * loader's auto-detect would pick `_simd.js` and we want it to find
 * the file rather than crash with `Cannot read properties of
 * undefined (reading '_malloc')`. The build aborts if the patch
 * fails, so this is a belt-and-braces fallback.
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

const PATCH_TARGET = 'tflite_web_api_client.js';
const PATCH_FROM = '{simd:f,multiThreading:g}';
const PATCH_TO = '{simd:!1,multiThreading:!1}';

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

const clientPath = path.join(DEST, PATCH_TARGET);
const before = fs.readFileSync(clientPath, 'utf8');
const occurrences = before.split(PATCH_FROM).length - 1;
if (occurrences !== 1) {
  console.error(
    `Failed to patch ${PATCH_TARGET}: expected 1 occurrence of ` +
    `'${PATCH_FROM}', found ${occurrences}. Upstream tflite-web has ` +
    `likely changed and the wasmFeatures override needs updating.`
  );
  process.exit(1);
}
const after = before.replace(PATCH_FROM, PATCH_TO);
fs.writeFileSync(clientPath, after);
console.log(`  patched ${PATCH_TARGET}: forced wasmFeatures to non-SIMD non-threaded`);

console.log('TFLite WASM files copied.');
