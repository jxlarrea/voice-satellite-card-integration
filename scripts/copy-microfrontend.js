/**
 * Copy the micro_frontend WASM build into the integration's static path.
 *
 * Mirrors copy-tflite.js — the WASM is too large to bundle through
 * webpack (and would get duplicated across chunks anyway), so we serve
 * it as a separate static asset and load it via a <script> tag at
 * runtime, exactly like the TFLite Web API client.
 *
 * The build itself happens via Docker (see
 * src/wake-word/micro-frontend-wasm/docker-build.py). This script
 * just copies the artifacts. If the build hasn't been run yet, it
 * exits silently with a hint — the integration still works for users
 * who haven't built the WASM frontend (the wake word path will fail
 * loudly when first used, but the rest of the integration loads fine).
 *
 * Run automatically via npm prebuild/predev hooks.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../src/wake-word/micro-frontend-wasm/dist');
const DEST = path.resolve(
  __dirname,
  '../custom_components/voice_satellite/wake-word-frontend',
);

const FILES = [
  'micro-frontend.js',
  'micro-frontend.wasm',
];

if (!fs.existsSync(SRC)) {
  console.log('micro_frontend WASM not built yet — skipping copy.');
  console.log(
    '  To build it: cd src/wake-word/micro-frontend-wasm && python docker-build.py',
  );
  process.exit(0);
}

if (!fs.existsSync(DEST)) {
  fs.mkdirSync(DEST, { recursive: true });
}

let allPresent = true;
for (const file of FILES) {
  const src = path.join(SRC, file);
  if (!fs.existsSync(src)) {
    console.warn(`  missing: ${file}`);
    allPresent = false;
    continue;
  }
  const dest = path.join(DEST, file);
  fs.copyFileSync(src, dest);
  const size = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`  ${file} (${size}KB)`);
}

if (allPresent) {
  console.log('micro_frontend WASM files copied.');
} else {
  console.log(
    'micro_frontend WASM build is incomplete — re-run docker-build.py.',
  );
}
