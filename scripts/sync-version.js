/**
 * Sync the version from package.json into:
 *   - custom_components/voice_satellite/manifest.json
 *   - custom_components/voice_satellite/const.py
 *
 * Run automatically via npm prebuild/predev hooks.
 */
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version;

// Update manifest.json
const manifestPath = path.resolve(__dirname, '../custom_components/voice_satellite/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// Update const.py — replace INTEGRATION_VERSION line
const constPath = path.resolve(__dirname, '../custom_components/voice_satellite/const.py');
let constPy = fs.readFileSync(constPath, 'utf8');
constPy = constPy.replace(
  /^INTEGRATION_VERSION:\s*str\s*=\s*".*"$/m,
  `INTEGRATION_VERSION: str = "${version}"`
);
fs.writeFileSync(constPath, constPy);

console.log(`Version synced: ${version}`);
