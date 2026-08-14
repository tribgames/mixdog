import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
  streamResponseToFile,
} from '../../../shared/bounded-download.mjs';

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./spawn-manifest.json', import.meta.url));

function binSuffix() {
  return process.platform === 'win32' ? '.exe' : '';
}

function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  return `${os}-${process.arch}`;
}

function spawnBinDir(dataDir) {
  return join(dataDir, 'spawn-bin');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function validVersion(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function validSpawnAsset(manifest, pkey) {
  if (!validVersion(manifest?.version)) return false;
  const asset = manifest.assets?.[pkey];
  if (!asset || !/^[a-f0-9]{64}$/i.test(String(asset.sha256 || ''))) return false;
  const expectedUrl = `https://github.com/tribgames/mixdog/releases/download/spawn-v${manifest.version}`
    + `/mixdog-spawn-${pkey}${binSuffix()}`;
  return asset.url === expectedUrl;
}

function bundledManifest(options = {}) {
  if (options.bundledManifest) return options.bundledManifest;
  return existsSync(BUNDLED_MANIFEST_PATH) ? readJson(BUNDLED_MANIFEST_PATH) : null;
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function downloadWithRetry(url, destPath) {
  const delays = [1000, 3000, 9000];
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`[spawn-fetcher] asset HTTP ${response.status} (terminal) — ${url}`);
      }
      if (!response.ok) throw new Error(`[spawn-fetcher] asset HTTP ${response.status} — ${url}`);
      await streamResponseToFile(response, destPath, {
        maxBytes: MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
        label: 'spawn binary download',
      });
      return;
    } catch (error) {
      lastError = error;
      if (String(error?.message || '').includes('(terminal)')) throw error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  throw lastError;
}

function gcSpawnBin(dir, keepFile) {
  try {
    for (const name of readdirSync(dir)) {
      if (name === keepFile) continue;
      if (name.startsWith('mixdog-spawn-')) {
        try { rmSync(join(dir, name), { force: true }); } catch {}
      }
    }
  } catch {}
}

export function findCachedSpawnBinary(dataDir, options = {}) {
  try {
    const manifest = bundledManifest(options);
    const pkey = platformKey();
    if (!validSpawnAsset(manifest, pkey)) return null;
    const hit = join(spawnBinDir(dataDir), `mixdog-spawn-${manifest.version}${binSuffix()}`);
    if (!existsSync(hit)) return null;
    const actual = createHash('sha256').update(readFileSync(hit)).digest('hex');
    return actual === manifest.assets[pkey].sha256.toLowerCase() ? hit : null;
  } catch {
    return null;
  }
}

let inflight = null;

export function ensureSpawnBinary(dataDir, options = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const manifest = bundledManifest(options);
    const pkey = platformKey();
    if (!validSpawnAsset(manifest, pkey)) {
      const supported = Object.keys(manifest?.assets || {}).join(', ') || '(none; spawn release not synchronized)';
      throw new Error(
        `[spawn-fetcher] no verified mixdog-spawn binary for ${pkey}. `
        + `Supported platforms: ${supported}. No local-build or Node shell fallback is permitted.`,
      );
    }
    const asset = manifest.assets[pkey];
    const dir = spawnBinDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const fileName = `mixdog-spawn-${manifest.version}${binSuffix()}`;
    const destPath = join(dir, fileName);
    if (existsSync(destPath)) {
      try {
        if (await sha256File(destPath) === asset.sha256.toLowerCase()) return destPath;
      } catch {}
    }
    const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
    await (options.download || downloadWithRetry)(asset.url, tmpPath);
    const actual = await sha256File(tmpPath);
    if (actual !== asset.sha256.toLowerCase()) {
      try { rmSync(tmpPath, { force: true }); } catch {}
      throw new Error(`[spawn-fetcher] sha256 mismatch for ${pkey}: expected ${asset.sha256}, got ${actual}`);
    }
    renameSync(tmpPath, destPath);
    if (process.platform !== 'win32') {
      try { chmodSync(destPath, 0o755); } catch {}
    }
    gcSpawnBin(dir, fileName);
    return destPath;
  })().finally(() => { inflight = null; });
  return inflight;
}
