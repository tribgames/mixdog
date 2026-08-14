// graph-binary-fetcher.mjs — fetches the prebuilt mixdog-graph native binary
// from the GitHub release manifest. The code graph has NO JS parse fallback,
// so the binary is required; ensureGraphBinary downloads + sha256-verifies it
// on first use and caches it under <dataDir>/graph-bin/. Mirrors the runtime
// fetcher pattern (memory/lib/runtime-fetcher.mjs) but for a single binary —
// no tar extraction.
//
// Public API:
//   ensureGraphBinary(dataDir) -> absolute path to the verified binary.
//     Throws if no asset matches the platform, or download/verify fails.
//   findCachedGraphBinary(dataDir) -> path | null (sync, no network).

import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
  streamResponseToFile,
} from '../../../shared/bounded-download.mjs';

// Bundled fallback manifest shipped with Mixdog. CI rewrites this on each
// release with the per-platform asset URLs + sha256.
const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./graph-manifest.json', import.meta.url));

// GitHub raw fallback — only consulted when neither cached nor bundled exists.
const MANIFEST_URL = 'https://raw.githubusercontent.com/tribgames/mixdog/main/src/runtime/agent/orchestrator/tools/graph-manifest.json';

function binSuffix() {
  return process.platform === 'win32' ? '.exe' : '';
}

function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  return `${os}-${process.arch}`;
}

function graphBinDir(dataDir) {
  return join(dataDir, 'graph-bin');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function validGraphAsset(manifest, pkey) {
  const version = String(manifest?.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const asset = manifest.assets?.[pkey];
  if (!asset || !/^[a-f0-9]{64}$/i.test(String(asset.sha256 || ''))) return false;
  const expectedUrl = `https://github.com/tribgames/mixdog/releases/download/graph-v${version}`
    + `/mixdog-graph-${pkey}${binSuffix()}`;
  return asset.url === expectedUrl;
}

function selectLocalManifest(dataDir, options = {}) {
  const bundled = options.bundledManifest
    || (existsSync(BUNDLED_MANIFEST_PATH) ? readJson(BUNDLED_MANIFEST_PATH) : null);
  if (bundled) return bundled;
  const cached = readJson(join(graphBinDir(dataDir), 'manifest.json'));
  return validGraphAsset(cached, platformKey()) ? cached : null;
}

async function loadManifest(dataDir, options = {}) {
  // Bundled manifest FIRST: it always matches the installed mixdog version.
  // A stale cached manifest.json from an older install must never shadow it
  // (caused sha256 mismatches on already-installed machines after upgrades).
  const local = selectLocalManifest(dataDir, options);
  if (local) return local;
  const res = await (options.fetch || fetch)(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`[graph-fetcher] manifest fetch failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function downloadWithRetry(url, destPath) {
  // 4 attempts total (1 + 3 retries); backoff 1s/3s/9s. 4xx is terminal.
  const delays = [1000, 3000, 9000];
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`[graph-fetcher] asset HTTP ${res.status} (terminal) — ${url}`);
      }
      if (!res.ok) throw new Error(`[graph-fetcher] asset HTTP ${res.status} — ${url}`);
      await streamResponseToFile(res, destPath, {
        maxBytes: MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
        label: 'graph binary download',
      });
      return;
    } catch (err) {
      lastErr = err;
      if (String(err?.message || '').includes('(terminal)')) throw err;
      if (attempt < 3) {
        process.stderr.write(`[graph-fetcher] download attempt ${attempt + 1} failed (${err?.message}), retrying in ${delays[attempt]}ms…\n`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  throw lastErr;
}

// Remove stale binaries + tmp files, keeping the active one.
function gcGraphBin(dir, keepFile) {
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'manifest.json' || name === keepFile) continue;
      if (name.startsWith('mixdog-graph')) {
        try { rmSync(join(dir, name), { force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* dir may not exist yet */ }
}

// Sync, network-free lookup of an already-cached binary. Used by the sync
// _graphBinaryPath() resolver before falling back to an async fetch.
export function findCachedGraphBinary(dataDir, options = {}) {
  try {
    const dir = graphBinDir(dataDir);
    const manifest = selectLocalManifest(dataDir, options);
    const pkey = platformKey();
    if (!validGraphAsset(manifest, pkey)) return null;
    const hit = join(dir, `mixdog-graph-${manifest.version}${binSuffix()}`);
    if (!existsSync(hit)) return null;
    const actual = createHash('sha256').update(readFileSync(hit)).digest('hex');
    return actual === manifest.assets[pkey].sha256.toLowerCase() ? hit : null;
  } catch {
    return null;
  }
}

let _inflight = null;

export function ensureGraphBinary(dataDir, options = {}) {
  // Single-flight: concurrent callers (prewarm + cache-miss) share one download.
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const manifest = await loadManifest(dataDir, options);
    const pkey = platformKey();
    const asset = manifest.assets?.[pkey];
    if (!validGraphAsset(manifest, pkey)) {
      // Unsupported platform/arch (e.g. win32-arm64): the manifest has no
      // downloadable asset for this {os}-{arch}. The code graph has NO JS
      // parsing fallback, so this is terminal — surface a single clear,
      // actionable message instead of a cryptic crash downstream.
      const supported = Object.keys(manifest.assets || {}).join(', ') || '(none)';
      throw new Error(
        `[graph-fetcher] no prebuilt mixdog-graph binary for platform ${pkey} `
        + `(unsupported platform/arch — there is no JS parsing fallback). `
        + `Supported platforms: ${supported}. `
        + `Build it locally: cargo build --release in native/mixdog-graph.`,
      );
    }
    const version = String(manifest.version || '0');
    const dir = graphBinDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const fileName = `mixdog-graph-${version}${binSuffix()}`;
    const destPath = join(dir, fileName);
    if (existsSync(destPath)) {
      try { if (await sha256File(destPath) === asset.sha256) return destPath; } catch { /* re-download */ }
    }
    const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
    await (options.download || downloadWithRetry)(asset.url, tmpPath);
    const actual = await sha256File(tmpPath);
    if (actual !== asset.sha256) {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
      throw new Error(`[graph-fetcher] sha256 mismatch for ${pkey}: expected ${asset.sha256}, got ${actual}`);
    }
    renameSync(tmpPath, destPath);
    if (process.platform !== 'win32') { try { chmodSync(destPath, 0o755); } catch { /* best-effort */ } }
    gcGraphBin(dir, fileName);
    return destPath;
  })().finally(() => { _inflight = null; });
  return _inflight;
}
