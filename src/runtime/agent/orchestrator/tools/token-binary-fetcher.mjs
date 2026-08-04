// token-binary-fetcher.mjs — fetches the prebuilt mixdog-token native binary
// from the GitHub release manifest. Token counting has an in-process WASM
// fallback, so callers treat fetch failures as a soft degrade (never a tool
// error). Caches under <dataDir>/token-bin/. Mirrors graph-binary-fetcher.mjs.
//
// Public API:
//   ensureTokenBinary(dataDir) -> absolute path to the verified binary.
//     Throws on no-asset / download / verify failure.
//   findCachedTokenBinary(dataDir) -> path | null (sync, no network).
// Both accept an optional dependency object used by deterministic tests:
//   { bundledManifest, download }.

import { createHash } from 'node:crypto';
import {
  chmodSync, createWriteStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./token-manifest.json', import.meta.url));
const MANIFEST_URL = 'https://raw.githubusercontent.com/tribgames/mixdog/main/src/runtime/agent/orchestrator/tools/token-manifest.json';

function binSuffix() {
  return process.platform === 'win32' ? '.exe' : '';
}

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

function validCachedUpgrade(manifest, pkey) {
  if (!manifestVersion(manifest)) return false;
  const asset = manifest.assets?.[pkey];
  if (!asset || !validSha256(asset.sha256) || typeof asset.url !== 'string') return false;
  const expectedUrl = `https://github.com/tribgames/mixdog/releases/download/token-v${manifest.version}`
    + `/mixdog-token-${pkey}${binSuffix()}`;
  return asset.url === expectedUrl;
}

function bundledManifest(options) {
  if (options.bundledManifest) return options.bundledManifest;
  return existsSync(BUNDLED_MANIFEST_PATH) ? readJson(BUNDLED_MANIFEST_PATH) : null;
}

function selectLocalManifest(dataDir, options = {}) {
  const bundled = bundledManifest(options);
  const cached = join(tokenBinDir(dataDir), 'manifest.json');
  const cachedManifest = existsSync(cached) ? readJson(cached) : null;
  if (bundled) {
    // The installed manifest is the minimum policy. A cache may advance it,
    // but only with a strict newer semver and a trusted, fully hashed asset.
    if (compareManifestVersions(cachedManifest, bundled) === 1
      && validCachedUpgrade(cachedManifest, platformKey())) {
      return cachedManifest;
    }
    return bundled;
  }
  return validCachedUpgrade(cachedManifest, platformKey()) ? cachedManifest : null;
}

async function loadManifest(dataDir, options = {}) {
  const local = selectLocalManifest(dataDir, options);
  if (local) return local;
  const fetchFn = options.fetch || fetch;
  const res = await fetchFn(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) });
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
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`[token-fetcher] asset HTTP ${res.status} (terminal) — ${url}`);
      }
      if (!res.ok) throw new Error(`[token-fetcher] asset HTTP ${res.status} — ${url}`);
      await pipeline(res.body, createWriteStream(destPath));
      return;
    } catch (err) {
      lastErr = err;
      if (String(err?.message || '').includes('(terminal)')) throw err;
      if (attempt < 3) {
        process.stderr.write(`[token-fetcher] download attempt ${attempt + 1} failed (${err?.message}), retrying in ${delays[attempt]}ms…\n`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  throw lastErr;
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

export function findCachedTokenBinary(dataDir, options = {}) {
  try {
    const dir = tokenBinDir(dataDir);
    const manifest = selectLocalManifest(dataDir, options);
    const asset = manifest?.assets?.[platformKey()];
    const version = manifestVersion(manifest);
    if (!version || !validSha256(asset?.sha256)) return null;
    const fileName = `mixdog-token-${manifest.version}${binSuffix()}`;
    const hit = join(dir, fileName);
    if (!existsSync(hit)) return null;
    const actual = createHash('sha256').update(readFileSync(hit)).digest('hex');
    return actual === asset.sha256.toLowerCase() ? hit : null;
  } catch {
    return null;
  }
}

let _inflight = null;

export function ensureTokenBinary(dataDir, options = {}) {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const manifest = await loadManifest(dataDir, options);
    const pkey = platformKey();
    const asset = manifest.assets?.[pkey];
    if (!asset || !asset.url || !validSha256(asset.sha256) || !manifestVersion(manifest)) {
      // Unsupported platform/arch, or no token-v release published yet. The
      // caller degrades to the in-process WASM worker, so the message only
      // needs to explain why the accelerator is absent.
      const supported = Object.keys(manifest.assets || {}).join(', ') || '(none)';
      throw new Error(
        `[token-fetcher] no prebuilt mixdog-token binary for platform ${pkey} `
        + `(token counting degrades to the in-process WASM worker). `
        + `Manifest platforms: ${supported}. `
        + `Build it locally: cargo build --release in native/mixdog-token.`,
      );
    }
    const version = String(manifest.version || '0');
    const dir = tokenBinDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const fileName = `mixdog-token-${version}${binSuffix()}`;
    const destPath = join(dir, fileName);
    if (existsSync(destPath)) {
      try { if (await sha256File(destPath) === asset.sha256.toLowerCase()) return destPath; } catch { /* re-download */ }
    }
    const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
    await (options.download || downloadWithRetry)(asset.url, tmpPath);
    const actual = await sha256File(tmpPath);
    if (actual !== asset.sha256.toLowerCase()) {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
      throw new Error(`[token-fetcher] sha256 mismatch for ${pkey}: expected ${asset.sha256}, got ${actual}`);
    }
    renameSync(tmpPath, destPath);
    if (process.platform !== 'win32') { try { chmodSync(destPath, 0o755); } catch { /* best-effort */ } }
    gcTokenBin(dir, fileName);
    return destPath;
  })().finally(() => { _inflight = null; });
  return _inflight;
}
