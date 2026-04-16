/**
 * Copy local font files to the frontend directory.
 *
 * Run automatically via npm prebuild/predev hooks.
 */
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../src/fonts');
const dst = path.resolve(__dirname, '../custom_components/voice_satellite/frontend/fonts');

if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });

const files = fs.readdirSync(src).filter(f => f.endsWith('.woff2'));
for (const file of files) {
  fs.copyFileSync(path.join(src, file), path.join(dst, file));
}

console.log(`Fonts copied: ${files.length} files`);
