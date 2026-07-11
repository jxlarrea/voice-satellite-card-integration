/**
 * Deploy custom_components/voice_satellite to the Home Assistant SMB
 * share after a dev build.  Cross-platform replacement for the old
 * Windows-only xcopy step in the npm dev script.
 *
 * Destination resolution, first match wins:
 *   1. HA_DEPLOY_TARGET env var - path to the HA config directory
 *   2. Windows: \\hassio\config
 *   3. macOS:   /Volumes/hassio
 *   4. Linux:   /mnt/hassio
 * The mount may point at the config share itself or one level above
 * it, so the config directory is detected via configuration.yaml.
 *
 * __pycache__ directories are skipped - HA regenerates its own and the
 * local ones may target a different Python version.
 */
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../custom_components/voice_satellite');

function resolveConfigDir() {
  const candidates = [];
  if (process.env.HA_DEPLOY_TARGET) candidates.push(process.env.HA_DEPLOY_TARGET);
  if (process.platform === 'win32') candidates.push('\\\\hassio\\config');
  else if (process.platform === 'darwin') candidates.push('/Volumes/hassio/config');
  else candidates.push('/mnt/hassio/config');

  for (const base of candidates) {
    if (fs.existsSync(path.join(base, 'configuration.yaml'))) return base;
    const nested = path.join(base, 'config');
    if (fs.existsSync(path.join(nested, 'configuration.yaml'))) return nested;
  }
  return null;
}

const configDir = resolveConfigDir();
if (!configDir) {
  console.error(
    'deploy-ha: Home Assistant config share not found. Mount it '
    + '(\\\\hassio\\config on Windows, /Volumes/hassio on macOS, '
    + '/mnt/hassio/config on Linux) or set HA_DEPLOY_TARGET to the HA config '
    + 'directory.',
  );
  process.exit(1);
}

const dst = path.join(configDir, 'custom_components', 'voice_satellite');
let count = 0;
fs.cpSync(src, dst, {
  recursive: true,
  force: true,
  filter: (p) => {
    if (path.basename(p) === '__pycache__') return false;
    if (fs.statSync(p).isFile()) count += 1;
    return true;
  },
});

console.log(`Integration deployed: ${count} files -> ${dst}`);
