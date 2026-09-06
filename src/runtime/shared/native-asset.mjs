// native-asset.mjs — shared primitives for Mixdog-managed native assets:
// the prebuilt tool binaries (graph / patch / spawn) and the runtime bundles
// (memory, voice) that ship from GitHub releases. Every fetcher resolves the
// same {os}-{arch} platform key, verifies the same 64-hex sha256, and installs
// a single binary through the same tmp → verify → rename → gc flow.

import { createHash } from 'node:crypto';
import {
  chmodSync, createReadStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  downloadToFileWithRetry,
  MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
} from './bounded-download.mjs';

export const RELEASE_DOWNLOAD_BASE = 'https://github.com/tribgames/mixdog/releases/download';

export function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  return `${os}-${process.arch}`;
}

export function binSuffix() {
  return process.platform === 'win32' ? '.exe' : '';
}

export function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function validSemver(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

// Streaming digest: runtime bundles and GGUF models are large, so never buffer
// the whole file. `signal` aborts the read mid-stream.
export async function sha256File(filePath, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export function sha256FileSync(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export async function verifySha256File(filePath, expected, label = '[native-asset]') {
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`${label} sha256 mismatch for ${filePath}: expected ${expected}, got ${actual}`);
  }
}

export function releaseAssetUrl({ tag, name, pkey = platformKey() }) {
  return `${RELEASE_DOWNLOAD_BASE}/${tag}/${name}-${pkey}${binSuffix()}`;
}

// A manifest asset is trusted only when its version is strict semver, its
// sha256 is well formed, and its url is exactly the release URL Mixdog CI
// publishes for that version — never an arbitrary host from a cache file.
export function validReleaseAsset(manifest, pkey, { name, tagPrefix }) {
  if (!validSemver(manifest?.version)) return false;
  const asset = manifest.assets?.[pkey];
  if (!asset || !validSha256(asset.sha256) || typeof asset.url !== 'string') return false;
  return asset.url === releaseAssetUrl({ tag: `${tagPrefix}${manifest.version}`, name, pkey });
}

export function readBundledManifest(bundledPath, options = {}) {
  if (options.bundledManifest) return options.bundledManifest;
  return existsSync(bundledPath) ? readJsonOrNull(bundledPath) : null;
}

export async function fetchRemoteManifest(url, { fetch: fetchFn = fetch, label = '[native-asset]' } = {}) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${label} manifest fetch failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export function createBinaryDownloader({ name, label }) {
  return (url, destPath) => downloadToFileWithRetry(url, destPath, {
    maxBytes: MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
    label: `${name} binary download`,
    httpLabel: `${label} asset`,
    onRetry: ({ attempt, delayMs, error }) => {
      process.stderr.write(`${label} download attempt ${attempt} failed (${error?.message}), retrying in ${delayMs}ms…\n`);
    },
  });
}

// Remove stale binaries + tmp files sharing `prefix`, keeping the active one.
export function gcBinaryDir(dir, { keep, prefix }) {
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'manifest.json' || name === keep) continue;
      if (name.startsWith(prefix)) {
        try { rmSync(join(dir, name), { force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* dir may not exist yet */ }
}

// Sync, network-free lookup of an already-installed binary.
export function findCachedBinary({ dir, fileName, sha256 }) {
  try {
    const hit = join(dir, fileName);
    if (!existsSync(hit)) return null;
    return sha256FileSync(hit) === String(sha256).toLowerCase() ? hit : null;
  } catch {
    return null;
  }
}

// Download → verify → atomic rename → chmod → gc. Returns the installed path;
// an already-installed binary with a matching digest short-circuits.
export async function installVerifiedBinary({ dir, fileName, asset, download, label, pkey, gcPrefix }) {
  mkdirSync(dir, { recursive: true });
  const destPath = join(dir, fileName);
  const expected = String(asset.sha256).toLowerCase();
  if (existsSync(destPath)) {
    try { if (await sha256File(destPath) === expected) return destPath; } catch { /* re-download */ }
  }
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  await download(asset.url, tmpPath);
  const actual = await sha256File(tmpPath);
  if (actual !== expected) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
    throw new Error(`${label} sha256 mismatch for ${pkey}: expected ${asset.sha256}, got ${actual}`);
  }
  renameSync(tmpPath, destPath);
  if (process.platform !== 'win32') { try { chmodSync(destPath, 0o755); } catch { /* best-effort */ } }
  gcBinaryDir(dir, { keep: fileName, prefix: gcPrefix });
  return destPath;
}

// Concurrent callers (prewarm + cache-miss) share one in-flight promise.
export function singleFlight(task) {
  let inflight = null;
  return (...args) => {
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => task(...args)).finally(() => { inflight = null; });
    return inflight;
  };
}
