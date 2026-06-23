// patch-binary-fetcher.mjs — fetches the prebuilt mixdog-patch native binary
// from the GitHub release manifest. apply_patch is native-only, so callers
// surface fetch failures as clean tool errors rather than silently switching
// engines. Caches under <dataDir>/patch-bin/. Mirrors graph-binary-fetcher.mjs.
//
// Public API:
//   ensurePatchBinary(dataDir) -> absolute path to the verified binary.
//     Throws on no-asset / download / verify failure.
//   findCachedPatchBinary(dataDir) -> path | null (sync, no network).

import { createHash } from 'node:crypto';
import {
  chmodSync, createWriteStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./patch-manifest.json', import.meta.url));
const MANIFEST_URL = 'https://raw.githubusercontent.com/trib-plugin/mixdog/main/src/agent/orchestrator/tools/patch-manifest.json';

function binSuffix() {
  return process.platform === 'win32' ? '.exe' : '';
}

function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  return `${os}-${process.arch}`;
}

function patchBinDir(dataDir) {
  return join(dataDir, 'patch-bin');
}

async function loadManifest(dataDir) {
  const cached = join(patchBinDir(dataDir), 'manifest.json');
  if (existsSync(cached)) {
    try { return JSON.parse(readFileSync(cached, 'utf8')); } catch { /* fall through */ }
  }
  if (existsSync(BUNDLED_MANIFEST_PATH)) {
    return JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'));
  }
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`[patch-fetcher] manifest fetch failed: ${res.status} ${res.statusText}`);
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
        throw new Error(`[patch-fetcher] asset HTTP ${res.status} (terminal) — ${url}`);
      }
      if (!res.ok) throw new Error(`[patch-fetcher] asset HTTP ${res.status} — ${url}`);
      await pipeline(res.body, createWriteStream(destPath));
      return;
    } catch (err) {
      lastErr = err;
      if (String(err?.message || '').includes('(terminal)')) throw err;
      if (attempt < 3) {
        process.stderr.write(`[patch-fetcher] download attempt ${attempt + 1} failed (${err?.message}), retrying in ${delays[attempt]}ms…\n`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  throw lastErr;
}

function gcPatchBin(dir, keepFile) {
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'manifest.json' || name === keepFile) continue;
      if (name.startsWith('mixdog-patch')) {
        try { rmSync(join(dir, name), { force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* dir may not exist yet */ }
}

export function findCachedPatchBinary(dataDir) {
  try {
    const dir = patchBinDir(dataDir);
    const hit = readdirSync(dir).find(
      (n) => n.startsWith('mixdog-patch') && !n.endsWith('.json') && !n.includes('.tmp-'),
    );
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}

let _inflight = null;

export function ensurePatchBinary(dataDir) {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const manifest = await loadManifest(dataDir);
    const pkey = platformKey();
    const asset = manifest.assets?.[pkey];
    if (!asset || !asset.url || !asset.sha256) {
      // Unsupported platform/arch (e.g. win32-arm64): the manifest has no
      // downloadable asset for this {os}-{arch}. apply_patch is native-only
      // (no JS apply fallback), so this is terminal — surface a single clear,
      // actionable message instead of a cryptic crash downstream.
      const supported = Object.keys(manifest.assets || {}).join(', ') || '(none)';
      throw new Error(
        `[patch-fetcher] no prebuilt mixdog-patch binary for platform ${pkey} `
        + `(unsupported platform/arch — apply_patch is native-only, no JS apply fallback). `
        + `Supported platforms: ${supported}. `
        + `Build it locally: cargo build --release in native/mixdog-patch.`,
      );
    }
    const version = String(manifest.version || '0');
    const dir = patchBinDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const fileName = `mixdog-patch-${version}${binSuffix()}`;
    const destPath = join(dir, fileName);
    if (existsSync(destPath)) {
      try { if (await sha256File(destPath) === asset.sha256) return destPath; } catch { /* re-download */ }
    }
    const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
    await downloadWithRetry(asset.url, tmpPath);
    const actual = await sha256File(tmpPath);
    if (actual !== asset.sha256) {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
      throw new Error(`[patch-fetcher] sha256 mismatch for ${pkey}: expected ${asset.sha256}, got ${actual}`);
    }
    renameSync(tmpPath, destPath);
    if (process.platform !== 'win32') { try { chmodSync(destPath, 0o755); } catch { /* best-effort */ } }
    gcPatchBin(dir, fileName);
    return destPath;
  })().finally(() => { _inflight = null; });
  return _inflight;
}
