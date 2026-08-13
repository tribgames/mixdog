// Fetch and verify the platform-specific mixdog-token Node-API addon.
// Failures remain a soft degrade because context counting has a WASM fallback.
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
  streamResponseToFile,
} from '../../../shared/bounded-download.mjs';

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./token-manifest.json', import.meta.url));
const MANIFEST_URL = 'https://raw.githubusercontent.com/tribgames/mixdog/main/src/runtime/agent/orchestrator/tools/token-manifest.json';
const ADDON_SUFFIX = '.node';

function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  return `${os}-${process.arch}`;
}

function tokenBinDir(dataDir) {
  return join(dataDir, 'token-bin');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function manifestVersion(manifest) {
  const value = String(manifest?.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
  return value.split('.').map(Number);
}

function compareManifestVersions(a, b) {
  const av = manifestVersion(a);
  const bv = manifestVersion(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  }
  return 0;
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function validAddonManifest(manifest, pkey) {
  if (!manifestVersion(manifest)) return false;
  const asset = manifest.assets?.[pkey];
  if (!asset || !validSha256(asset.sha256) || typeof asset.url !== 'string') return false;
  const expectedUrl = `https://github.com/tribgames/mixdog/releases/download/token-v${manifest.version}`
    + `/mixdog-token-${pkey}${ADDON_SUFFIX}`;
  return asset.url === expectedUrl;
}

function bundledManifest(options) {
  if (options.bundledManifest) return options.bundledManifest;
  return existsSync(BUNDLED_MANIFEST_PATH) ? readJson(BUNDLED_MANIFEST_PATH) : null;
}

function selectLocalManifest(dataDir, options = {}) {
  const bundled = bundledManifest(options);
  const cachedPath = join(tokenBinDir(dataDir), 'manifest.json');
  const cached = existsSync(cachedPath) ? readJson(cachedPath) : null;
  const pkey = platformKey();
  if (bundled) {
    if (compareManifestVersions(cached, bundled) === 1 && validAddonManifest(cached, pkey)) {
      return cached;
    }
    return validAddonManifest(bundled, pkey) ? bundled : null;
  }
  return validAddonManifest(cached, pkey) ? cached : null;
}

async function loadManifest(dataDir, options = {}) {
  const local = selectLocalManifest(dataDir, options);
  if (local) return local;
  const res = await (options.fetch || fetch)(
    MANIFEST_URL,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) {
    throw new Error(`[token-fetcher] manifest fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function downloadWithRetry(url, destPath) {
  const delays = [1000, 3000, 9000];
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`[token-fetcher] asset HTTP ${res.status} (terminal) — ${url}`);
      }
      if (!res.ok) throw new Error(`[token-fetcher] asset HTTP ${res.status} — ${url}`);
      await streamResponseToFile(res, destPath, {
        maxBytes: MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
        label: 'token addon download',
      });
      return;
    } catch (error) {
      lastError = error;
      if (String(error?.message || '').includes('(terminal)')) throw error;
      if (attempt < 3) {
        process.stderr.write(
          `[token-fetcher] download attempt ${attempt + 1} failed (${error?.message}), `
          + `retrying in ${delays[attempt]}ms…\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }
  throw lastError;
}

function gcTokenBin(dir, keepFile) {
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'manifest.json' || name === keepFile) continue;
      if (name.startsWith('mixdog-token')) {
        try { rmSync(join(dir, name), { force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* dir may not exist yet */ }
}

export function findCachedTokenAddon(dataDir, options = {}) {
  try {
    const dir = tokenBinDir(dataDir);
    const manifest = selectLocalManifest(dataDir, options);
    const asset = manifest?.assets?.[platformKey()];
    if (!validAddonManifest(manifest, platformKey())) return null;
    const fileName = `mixdog-token-${manifest.version}${ADDON_SUFFIX}`;
    const hit = join(dir, fileName);
    if (!existsSync(hit)) return null;
    const actual = createHash('sha256').update(readFileSync(hit)).digest('hex');
    return actual === asset.sha256.toLowerCase() ? hit : null;
  } catch {
    return null;
  }
}

let inflight = null;

export function ensureTokenAddon(dataDir, options = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const manifest = await loadManifest(dataDir, options);
    const pkey = platformKey();
    if (!validAddonManifest(manifest, pkey)) {
      const supported = Object.keys(manifest?.assets || {}).join(', ') || '(none)';
      throw new Error(
        `[token-fetcher] no Node-API mixdog-token addon for platform ${pkey} `
        + `(token counting degrades to the in-process WASM worker). `
        + `Manifest platforms: ${supported}.`,
      );
    }
    const asset = manifest.assets[pkey];
    const version = String(manifest.version);
    const dir = tokenBinDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const fileName = `mixdog-token-${version}${ADDON_SUFFIX}`;
    const destPath = join(dir, fileName);
    if (existsSync(destPath)) {
      try {
        if (await sha256File(destPath) === asset.sha256.toLowerCase()) return destPath;
      } catch { /* re-download */ }
    }
    const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
    await (options.download || downloadWithRetry)(asset.url, tmpPath);
    const actual = await sha256File(tmpPath);
    if (actual !== asset.sha256.toLowerCase()) {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
      throw new Error(
        `[token-fetcher] sha256 mismatch for ${pkey}: expected ${asset.sha256}, got ${actual}`,
      );
    }
    renameSync(tmpPath, destPath);
    gcTokenBin(dir, fileName);
    return destPath;
  })().finally(() => { inflight = null; });
  return inflight;
}
