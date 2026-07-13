/**
 * Deploy custom_components/voice_satellite to the Home Assistant box
 * after a dev build.  Cross-platform replacement for the old
 * Windows-only xcopy step in the npm dev script.
 *
 * Deploy targets are tried in order until one succeeds, first match wins:
 *   1. HA_DEPLOY_TARGET env var - path to the HA config directory
 *   2. Windows: \\hassio\config
 *      macOS:   /Volumes/hassio
 *      Linux:   /mnt/hassio-smb (SMB, preferred - immune to NFS stale
 *               handles), then /mnt/hassio (NFS fallback)
 * The mount may point at the config share itself or one level above
 * it, so the config directory is detected via configuration.yaml.
 *
 * Per target: up to 3 attempts with backoff on transient I/O errors,
 * a stale-NFS-handle revalidation pass before copying, and a read-back
 * verification of manifest.json after copying so a deploy that silently
 * failed to land is reported instead of trusted.
 *
 * __pycache__ directories are skipped - HA regenerates its own and the
 * local ones may target a different Python version.
 */
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../custom_components/voice_satellite');
const ATTEMPTS_PER_TARGET = 3;
const RETRY_DELAY_MS = 2000;

function candidateBases() {
  const bases = [];
  if (process.env.HA_DEPLOY_TARGET) bases.push(process.env.HA_DEPLOY_TARGET);
  if (process.platform === 'win32') bases.push('\\\\hassio\\config');
  else if (process.platform === 'darwin') bases.push('/Volumes/hassio/config');
  else bases.push('/mnt/hassio', '/mnt/hassio-smb', '/mnt/hassio/config');
  return bases;
}

function findConfigDir(base) {
  for (const dir of [base, path.join(base, 'config')]) {
    try {
      if (fs.existsSync(path.join(dir, 'configuration.yaml'))) return dir;
    } catch {
      // unreachable mount - treat as not found
    }
  }
  return null;
}

/**
 * An NFS client can hold a stale cached dentry for dst if the directory
 * was deleted or replaced on the HA side (nlink reads 0 and any mkdir
 * inside it fails ENOENT).  Poking the path with fresh lookups forces
 * the client to revalidate the handle.  Returns true when dst is usable.
 */
function revalidateStaleDir(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return true; // does not exist yet - cpSync will create it
  }
  if (st.nlink !== 0) return true; // healthy

  console.warn(`deploy-ha: ${dir} looks like a stale NFS handle, revalidating...`);
  try { fs.rmdirSync(dir); } catch {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const probe = path.join(dir, '.deploy-ha-probe');
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch {}

  try {
    return fs.statSync(dir).nlink !== 0;
  } catch {
    return true; // dentry dropped entirely - cpSync will recreate it
  }
}

function copyTree(dst) {
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
  return count;
}

/**
 * Read manifest.json back from the destination and compare it with the
 * source byte-for-byte.  Catches deploys that "succeeded" against a dead
 * or half-broken mount without the copy actually reaching HA.
 */
function verifyDeploy(dst) {
  const marker = 'manifest.json';
  const expected = fs.readFileSync(path.join(src, marker));
  const actual = fs.readFileSync(path.join(dst, marker));
  if (!expected.equals(actual)) {
    throw new Error(`${marker} read back from ${dst} does not match the source`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function deployTo(dst) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS_PER_TARGET; attempt += 1) {
    try {
      if (!revalidateStaleDir(dst)) {
        throw new Error(`${dst} is a stale NFS handle the client cannot clear `
          + '(restart the NFS Server (Ganesha) add-on on HA to fix the server side)');
      }
      const count = copyTree(dst);
      verifyDeploy(dst);
      return count;
    } catch (err) {
      lastErr = err;
      if (attempt < ATTEMPTS_PER_TARGET) {
        console.warn(`deploy-ha: attempt ${attempt} failed (${err.message}), retrying...`);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastErr;
}

(async () => {
  const tried = [];
  for (const base of candidateBases()) {
    const configDir = findConfigDir(base);
    if (!configDir) {
      tried.push(`${base} (no configuration.yaml found)`);
      continue;
    }
    const dst = path.join(configDir, 'custom_components', 'voice_satellite');
    try {
      const count = await deployTo(dst);
      console.log(`Integration deployed: ${count} files -> ${dst}`);
      return;
    } catch (err) {
      tried.push(`${dst} (${err.message})`);
      console.warn(`deploy-ha: giving up on ${dst}, trying next target...`);
    }
  }

  console.error(
    'deploy-ha: could not deploy to any Home Assistant target.\n'
    + (tried.length ? `Tried:\n  - ${tried.join('\n  - ')}\n` : '')
    + 'Mount the HA config share (\\\\hassio\\config on Windows, '
    + '/Volumes/hassio on macOS, /mnt/hassio-smb or /mnt/hassio/config on '
    + 'Linux) or set HA_DEPLOY_TARGET to the HA config directory.',
  );
  process.exit(1);
})();
