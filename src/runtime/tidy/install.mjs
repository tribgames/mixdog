// Managed engine installs: manifest → download → sha256 → extract → atomic
// rename into <pluginData>/tools/<engine>/<version>/.
//
// Policy gating happens BEFORE any network call: 'never' refuses, 'ask' returns
// needsApproval unless the call carried approveDownloads:true, 'auto' proceeds.
// Toolchain engines (rustfmt, gofmt, zig fmt, ...) are never downloadable.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MAX_NATIVE_BINARY_DOWNLOAD_BYTES, streamResponseToFile } from '../shared/bounded-download.mjs';
import { platformKey, sha256File } from '../shared/native-asset.mjs';
import { readJsonSafe } from '../shared/json-file.mjs';
import { ENGINE_CATALOG } from './engines.mjs';
import { extractArchive } from './extract.mjs';

const MANIFEST_PATH = fileURLToPath(new URL('./engines-manifest.json', import.meta.url));
const LABEL = '[tidy-install]';

/** {os}-{arch} key into a manifest engine's `assets` map. */
export function platformAssetKey() {
  return platformKey();
}

export function readEnginesManifest(path = MANIFEST_PATH) {
  const manifest = readJsonSafe(path);
  if (!manifest || typeof manifest !== 'object' || typeof manifest.engines !== 'object') {
    return { version: 1, engines: {} };
  }
  return manifest;
}

export function managedToolsDir(pluginData) {
  return join(pluginData, 'tools');
}

export function managedEngineDir(pluginData, id, version) {
  return join(managedToolsDir(pluginData), String(id), String(version));
}

export function manifestAsset(manifest, id, pkey = platformAssetKey()) {
  const entry = manifest?.engines?.[id];
  const asset = entry?.assets?.[pkey] || entry?.assets?.any;
  if (!entry || !asset || typeof asset.url !== 'string' || !asset.url) return null;
  return { entry, asset, version: String(entry.version || '0'), pkey: entry?.assets?.[pkey] ? pkey : 'any' };
}

/** An already-installed managed binary for `id`, or null. Sync, no network. */
export function managedEngineBinary({ id, manifest, pluginData }) {
  const found = manifestAsset(manifest, id);
  if (!found || !pluginData) return null;
  const binPath = String(found.asset.binPath || '');
  if (!binPath) return null;
  const full = join(managedEngineDir(pluginData, id, found.version), binPath);
  return existsSync(full) ? { path: full, version: found.version } : null;
}

/** Throws unless `filePath` hashes to `expected`. */
export async function verifyDownloadDigest(filePath, expected, label = LABEL) {
  const wanted = String(expected || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(wanted)) {
    throw new Error(`${label} manifest sha256 is not a 64-hex digest`);
  }
  const actual = (await sha256File(filePath)).toLowerCase();
  if (actual !== wanted) {
    throw new Error(`${label} sha256 mismatch: expected ${wanted}, got ${actual}`);
  }
  return actual;
}

/**
 * Decide what an install call may do, without touching the network.
 * Returns { targets, present, needsApproval, errors }.
 */
export function planInstall({ ids = [], manifest, pluginData = '', policy = 'auto', approveDownloads = false } = {}) {
  const targets = [];
  const present = [];
  const errors = [];
  const pending = [];
  for (const rawId of ids) {
    const id = String(rawId || '');
    const catalog = ENGINE_CATALOG[id];
    if (!catalog) {
      errors.push({ id, error: `unknown engine "${id}"` });
      continue;
    }
    if (catalog.toolchain) {
      errors.push({ id, error: 'toolchain engine; install it yourself', installHint: catalog.installHint });
      continue;
    }
    if (!catalog.managed) {
      errors.push({ id, error: 'project-local engine; tidy never downloads it', installHint: catalog.installHint });
      continue;
    }
    const found = manifestAsset(manifest, id);
    if (!found) {
      errors.push({
        id,
        error: `no ${platformAssetKey()} asset in the engines manifest`,
        installHint: catalog.installHint,
      });
      continue;
    }
    const installed = managedEngineBinary({ id, manifest, pluginData });
    if (installed) {
      present.push({ id, version: installed.version, path: installed.path });
      continue;
    }
    pending.push({
      id,
      version: found.version,
      url: found.asset.url,
      sha256: String(found.asset.sha256 || ''),
      archive: String(found.asset.archive || 'none'),
      binPath: String(found.asset.binPath || ''),
      bytes: Number(found.asset.bytes ?? found.asset.size ?? 0) || 0,
      license: String(found.entry.license || ''),
    });
  }
  if (pending.length === 0) return { targets, present, errors, needsApproval: null };
  if (policy === 'never') {
    for (const item of pending) {
      errors.push({
        id: item.id,
        error: 'downloads are disabled by policy (tidy.downloads="never")',
        installHint: ENGINE_CATALOG[item.id].installHint,
      });
    }
    return { targets, present, errors, needsApproval: null };
  }
  if (policy !== 'auto' && !approveDownloads) {
    return {
      targets,
      present,
      errors,
      needsApproval: {
        engines: pending.map(({ id, version, bytes, license }) => ({
          id,
          version,
          bytes,
          ...(license ? { license } : {}),
        })),
        bytes: pending.reduce((sum, item) => sum + item.bytes, 0),
        reason: 'tidy.downloads="ask": re-run with approveDownloads:true to download these engines',
      },
    };
  }
  targets.push(...pending);
  return { targets, present, errors, needsApproval: null };
}

async function downloadAsset(target, tmpDir, fetchFn, signal, onProgress) {
  const archiveFile = join(tmpDir, `asset-${target.id}`);
  const response = await fetchFn(target.url, { signal, redirect: 'follow' });
  if (!response?.ok) {
    throw new Error(`${LABEL} ${target.id}: HTTP ${response?.status || 0} for ${target.url}`);
  }
  await streamResponseToFile(response, archiveFile, {
    maxBytes: MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
    label: `${LABEL} ${target.id}`,
    // Byte progress per engine: the desktop card renders it live, so the
    // callback carries the engine id the bytes belong to.
    ...(typeof onProgress === 'function'
      ? {
          onProgress: ({ downloaded, total }) => {
            onProgress({ id: target.id, receivedBytes: downloaded, totalBytes: total });
          },
        }
      : {}),
  });
  return archiveFile;
}

/** Download + verify + extract one engine into its versioned managed dir. */
export async function installEngine(
  target,
  { pluginData, fetchFn = globalThis.fetch, signal = null, onProgress = null } = {}
) {
  const engineRoot = join(managedToolsDir(pluginData), target.id);
  const finalDir = managedEngineDir(pluginData, target.id, target.version);
  const binFull = join(finalDir, target.binPath);
  if (existsSync(binFull)) {
    return { id: target.id, version: target.version, path: binFull, bytes: 0, status: 'present' };
  }
  mkdirSync(engineRoot, { recursive: true });
  const tmpDir = join(engineRoot, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const archiveFile = await downloadAsset(target, tmpDir, fetchFn, signal, onProgress);
    await verifyDownloadDigest(archiveFile, target.sha256);
    const bytes = statSync(archiveFile).size;
    const stageDir = join(tmpDir, 'stage');
    await extractArchive({
      archive: target.archive,
      srcPath: archiveFile,
      destDir: stageDir,
      binPath: target.binPath,
    });
    const stagedBin = join(stageDir, target.binPath);
    if (!existsSync(stagedBin)) {
      throw new Error(`${LABEL} ${target.id}: archive has no ${target.binPath}`);
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(stagedBin, 0o755);
      } catch {
        /* best-effort */
      }
    }
    try {
      renameSync(stageDir, finalDir);
    } catch (error) {
      // A concurrent install won the race; its verified copy is equivalent.
      if (!existsSync(binFull)) throw error;
    }
    return { id: target.id, version: target.version, path: binFull, bytes, status: 'installed' };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Plan + execute installs for `ids`. Never throws for a single engine: each
 * failure lands in `errors` so the report can show the rest.
 */
export async function installEngines({
  ids = [],
  manifest = null,
  pluginData = '',
  policy = 'auto',
  approveDownloads = false,
  fetchFn = globalThis.fetch,
  signal = null,
  onProgress = null,
} = {}) {
  const loaded = manifest || readEnginesManifest();
  const plan = planInstall({ ids, manifest: loaded, pluginData, policy, approveDownloads });
  const installed = [...plan.present];
  const errors = [...plan.errors];
  if (!pluginData && plan.targets.length > 0) {
    return {
      installed,
      errors: [...errors, { id: '*', error: 'no plugin data directory for managed installs' }],
      needsApproval: null,
    };
  }
  for (const target of plan.targets) {
    try {
      installed.push(await installEngine(target, { pluginData, fetchFn, signal, onProgress }));
    } catch (error) {
      errors.push({ id: target.id, error: error?.message || String(error) });
    }
  }
  return { installed, errors, needsApproval: plan.needsApproval };
}
