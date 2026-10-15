import { __mixdogMemoryLog } from './memory-log.mjs';

// REQUIRES: `tar` (bsdtar-compatible) on PATH.
// On Windows, bsdtar ships with Windows 10 1803+ as %SystemRoot%\System32\tar.exe.
// If tar is missing, ensureRuntime() throws with an actionable error message.
//
// Downloads and verifies a prebuilt native PG runtime from the mixdog GitHub
// release manifest.
//
// Layout: <dataDir>/runtime/runtime-{key}/  +  <dataDir>/runtime/active-version
// holding {key}. New installs key the directory by version plus asset digest;
// installs from before that keep their bare-version key and stay valid.
// Atomic swap: write active-version.tmp then rename → active-version.
// GC: removes stale runtime-* dirs and staging-* dirs on every ensureRuntime
// call, but only a dir that can be moved aside whole (never one in use).
//
// Public API: ensureRuntime(dataDir) → { runtimeDir, pgBinDir, libDir, sharePath, version }

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChild } from './pg/run-child.mjs';
import { renameWithRetrySync, writeFileAtomicSync, writeJsonAtomicSync } from '../../shared/atomic-file.mjs';
import { downloadToFileWithRetry } from '../../shared/bounded-download.mjs';
import { platformKey, platformKeyCandidates, verifySha256File } from '../../shared/native-asset.mjs';

// Bundled fallback manifest shipped alongside Mixdog. fileURLToPath required
// for cross-platform path resolution (URL.pathname returns /C:/... on Windows).
const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('../data/runtime-manifest.json', import.meta.url));

// GitHub raw URL fallback — used only when no cached or bundled manifest exists.
const MANIFEST_URL =
  'https://raw.githubusercontent.com/tribgames/mixdog/main/src/runtime/memory/data/runtime-manifest.json';

// Fail-closed asset validation. A selected manifest asset is usable only if it
// is not explicitly marked unsupported AND carries a real downloadable payload:
// non-empty url, a well-formed 64-hex sha256, and a positive integer size.
// Placeholder / TBD entries fail every payload check and are rejected.
function isUsableAsset(asset) {
  if (!asset || typeof asset !== 'object') return false;
  if (asset.unsupported === true) return false;
  if (typeof asset.url !== 'string' || asset.url.length === 0) return false;
  if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) return false;
  if (!Number.isInteger(asset.size) || asset.size <= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

async function loadManifest(dataDir) {
  // Bundled manifest FIRST: it always matches the installed mixdog version.
  // A cached <dataDir>/runtime/manifest.json from an older install must never
  // shadow it — stale caches caused sha256 mismatches on already-installed
  // machines after an upgrade. The cache is only a fallback for the rare case
  // where the bundled file is missing (e.g. a stripped checkout).
  if (existsSync(BUNDLED_MANIFEST_PATH)) {
    return JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'));
  }
  const runtimeManifestPath = join(dataDir, 'runtime', 'manifest.json');
  if (existsSync(runtimeManifestPath)) {
    try {
      return JSON.parse(readFileSync(runtimeManifestPath, 'utf8'));
    } catch {}
  }
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`[runtime-fetcher] manifest fetch failed: ${res.status} ${res.statusText}`);
  const manifest = await res.json();
  mkdirSync(join(dataDir, 'runtime'), { recursive: true });
  writeJsonAtomicSync(runtimeManifestPath, manifest, { lock: true, fsyncDir: true });
  return manifest;
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

function verifySha256(filePath, expected) {
  return verifySha256File(filePath, expected, '[runtime-fetcher]');
}

// ---------------------------------------------------------------------------
// Active-runtime validation (pointer-file layout)
// ---------------------------------------------------------------------------

function activeVersionPath(runtimeDir) {
  return join(runtimeDir, 'active-version');
}

function readActiveVersion(runtimeDir) {
  try {
    return readFileSync(activeVersionPath(runtimeDir), 'utf8').trim();
  } catch {
    return null;
  }
}

function runtimeVerDir(runtimeDir, ver) {
  return join(runtimeDir, `runtime-${ver}`);
}

// A rebuilt asset of the same version gets its own directory, so installing it
// never touches the tree a still-running PostgreSQL may hold open.
function runtimeInstallKey(version, sha256) {
  return `${version}-${String(sha256).slice(0, 12)}`;
}

// True while a PostgreSQL from this runtime is running: a running executable
// cannot be opened for writing (EBUSY on Windows, ETXTBSY on Linux).
function runtimeDirInUse(dir) {
  const exe = join(dir, 'bin', process.platform === 'win32' ? 'postgres.exe' : 'postgres');
  try {
    closeSync(openSync(exe, 'r+'));
    return false;
  } catch (error) {
    return error?.code === 'EBUSY' || error?.code === 'ETXTBSY';
  }
}

// Remove a runtime dir only when nothing runs from it, moving it aside whole
// first. Deleting in place could strip a running PostgreSQL's files and the
// sha stamp while the locked binaries survive, leaving a tree that looks
// installed but is not; an in-use dir makes this throw and stays intact.
function discardRuntimeDir(runtimeDir, dir) {
  if (runtimeDirInUse(dir)) throw new Error(`[runtime-fetcher] runtime dir is in use: ${dir}`);
  const trash = join(
    runtimeDir,
    `staging-discard-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );
  renameSync(dir, trash);
  rmSync(trash, { recursive: true, force: true });
}

function runtimePaths(verDir) {
  return {
    pgBinDir: join(verDir, 'bin'),
    libDir: join(verDir, 'lib'),
    sharePath: join(verDir, 'share'),
  };
}

// ---------------------------------------------------------------------------
// Download with retry
// ---------------------------------------------------------------------------

async function downloadWithRetry(url, destPath, expectedBytes) {
  return downloadToFileWithRetry(url, destPath, {
    maxBytes: expectedBytes,
    expectedBytes,
    label: 'memory runtime download',
    httpLabel: '[runtime-fetcher] asset download',
    onRetry: ({ attempt, delayMs, error }) => {
      __mixdogMemoryLog(
        `[runtime-fetcher] download attempt ${attempt} failed (${error?.message}), retrying in ${delayMs}ms…\n`
      );
    },
  });
}

function runtimeAssetUrlCandidates(url) {
  const value = String(url || '');
  const out = [];
  const add = (candidate) => {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  };
  add(value);
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\//i.exec(value);
  if (!match) return out;
  const releaseRepo = match[1];
  const overrides = String(
    process.env.MIXDOG_RUNTIME_RELEASE_REPOSITORY || process.env.RUNTIME_RELEASE_REPOSITORY || ''
  )
    .split(/[\s,;]+/u)
    .map((repo) => repo.trim())
    .filter(Boolean);
  for (const repo of overrides) {
    if (repo && repo !== releaseRepo) add(value.replace(`/github.com/${releaseRepo}/`, `/github.com/${repo}/`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tar entry path validation + extraction
// ---------------------------------------------------------------------------

export function _validateRuntimeTarEntries(entries, details, stagingBase) {
  if (entries.length !== details.length) {
    throw new Error('[runtime-fetcher] tar listings disagree; refusing extraction');
  }
  const resolvedBase = resolve(stagingBase);
  const resolvedEntries = new Set();
  const isInsideBase = (candidate) => {
    const remainder = relative(resolvedBase, candidate);
    return remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
  };
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.includes('\0') || entry.includes('\\') || entry.startsWith('/') || /^[A-Za-z]:/u.test(entry)) {
      throw new Error(`[runtime-fetcher] tar entry path validation failed (unsafe entry): ${entry}`);
    }
    const segments = entry.split('/');
    if (segments.includes('..')) {
      throw new Error(`[runtime-fetcher] tar entry path validation failed (unsafe entry): ${entry}`);
    }
    const resolved = resolve(join(stagingBase, entry));
    if (!isInsideBase(resolved)) {
      throw new Error(`[runtime-fetcher] tar entry escapes staging dir: ${entry}`);
    }
    resolvedEntries.add(resolved);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const detail = String(details[index] || '').trimStart();
    const type = detail[0];
    if (type === '-' || type === 'd') continue;
    if (type !== 'l' && type !== 'h') {
      throw new Error(`[runtime-fetcher] tar entry type is unsafe: ${entry}`);
    }
    const marker = type === 'l' ? ' -> ' : ' link to ';
    const markerIndex = detail.lastIndexOf(marker);
    const target = markerIndex === -1 ? '' : detail.slice(markerIndex + marker.length);
    if (
      !target ||
      target.includes('\0') ||
      target.includes('\\') ||
      target.startsWith('/') ||
      /^[A-Za-z]:/u.test(target)
    ) {
      throw new Error(`[runtime-fetcher] tar link target is unsafe: ${entry}`);
    }
    const entryPath = resolve(join(stagingBase, entry));
    const targetPath = type === 'l' ? resolve(dirname(entryPath), target) : resolve(join(stagingBase, target));
    if (!isInsideBase(targetPath) || !resolvedEntries.has(targetPath)) {
      throw new Error(`[runtime-fetcher] tar link target is unsafe: ${entry}`);
    }
  }
}

// Async throughout: the first boot extracts the whole PG runtime here, and a
// synchronous tar froze the daemon loop for seconds.
export async function _extractRuntimeTarGz(tarPath, destDir, stagingBase) {
  mkdirSync(destDir, { recursive: true });
  const resolvedTarPath = resolve(tarPath);
  const tarOptions = { cwd: dirname(resolvedTarPath) };
  const tarName = basename(resolvedTarPath);

  // List entries first and validate — reject traversal, external links, and
  // special files before the extractor can materialize archive content.
  // Keep the archive argument relative to cwd: GNU tar otherwise interprets
  // an absolute Windows path such as C:\runtime.tar.gz as a remote host path.
  const listResult = await runChild('tar', ['-tzf', tarName], tarOptions);
  if (listResult.status !== 0) {
    throw new Error(`[runtime-fetcher] tar list failed: ${listResult.stderr?.toString() || 'unknown'}`);
  }
  const detailResult = await runChild('tar', ['-tvzf', tarName], tarOptions);
  if (detailResult.status !== 0) {
    throw new Error(`[runtime-fetcher] tar detail list failed: ${detailResult.stderr?.toString() || 'unknown'}`);
  }
  const entries = (listResult.stdout?.toString() || '').split('\n').filter(Boolean);
  const details = (detailResult.stdout?.toString() || '').split('\n').filter(Boolean);
  _validateRuntimeTarEntries(entries, details, stagingBase);

  const resolvedDestDir = resolve(destDir);
  const extractionArchive = relative(resolvedDestDir, resolvedTarPath);
  const r = await runChild('tar', ['-xzf', extractionArchive], { cwd: resolvedDestDir });
  if (r.status !== 0) {
    throw new Error(`[runtime-fetcher] tar extraction failed: ${r.stderr?.toString() || 'unknown error'}`);
  }
}

// ---------------------------------------------------------------------------
// Unix exec-bit normalization
// ---------------------------------------------------------------------------

function normalizeBinExecBit(verDir) {
  if (process.platform === 'win32') return;
  const binDir = join(verDir, 'bin');
  if (!existsSync(binDir)) return;
  try {
    const entries = readdirSync(binDir);
    for (const f of entries) {
      try {
        chmodSync(join(binDir, f), 0o755);
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Staging cross-process lock — protects an in-progress download/extract/swap
// from being GC'd by a concurrently-booting sibling process.
//
// Each staging-* dir is guarded by a sibling O_EXCL lockfile `<staging>.lock`
// stamped with `<pid> <epoch-ms>`. The lockfile is held (fd open) for the whole
// download→extract→swap lifetime. GC only removes a staging dir whose guarding
// lock is NOT live (file missing, owner pid dead, or lock older than
// STAGING_LOCK_STALE_MS), so a concurrent boot mid-extract is never wiped.
// ---------------------------------------------------------------------------

// Generous staleness budget: a cold download + extract on a slow link can take
// minutes. A shorter window would let a sibling reclaim a still-live staging.
const STAGING_LOCK_STALE_MS = 600_000;

function stagingLockPath(stagingDir) {
  return `${stagingDir}.lock`;
}

function _readStagingLockPid(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const pid = Number.parseInt(String(raw).trim().split(/\s+/)[0], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function _stagingLockPidAlive(pid) {
  if (pid === null) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true; // signal delivered → owner exists
  } catch (err) {
    // ESRCH = no such process → owner is gone. Any other error (e.g. EPERM:
    // exists but unsignalable) → treat as alive so we never steal from a live
    // holder.
    return err?.code !== 'ESRCH';
  }
}

// A staging dir is protected iff its lockfile exists, names a live owner pid
// (or an unparseable-but-fresh stamp), and is not older than the stale budget.
function _stagingLockIsLive(lockPath) {
  let st;
  try {
    st = statSync(lockPath);
  } catch {
    return false;
  } // no lock → unprotected
  const pid = _readStagingLockPid(lockPath);
  if (pid !== null && !_stagingLockPidAlive(pid)) return false; // owner dead
  if (Date.now() - st.mtimeMs > STAGING_LOCK_STALE_MS) return false; // abandoned
  return true;
}

function acquireStagingLock(stagingDir) {
  const lockPath = stagingLockPath(stagingDir);
  const fd = openSync(lockPath, 'wx'); // O_EXCL: fails if a sibling already owns it
  try {
    writeFileSync(fd, `${process.pid} ${Date.now()}\n`, 'utf8');
  } catch {}
  return { fd, lockPath };
}

function releaseStagingLock(lock) {
  if (!lock) return;
  try {
    closeSync(lock.fd);
  } catch {}
  // Only unlink if we still own the stamp; a stolen+replaced lock must not be
  // destroyed out from under its new owner.
  try {
    if (_readStagingLockPid(lock.lockPath) === process.pid) unlinkSync(lock.lockPath);
  } catch {}
}

// ---------------------------------------------------------------------------
// GC — remove stale runtime-* and staging-* dirs
// ---------------------------------------------------------------------------

function gcRuntimeDir(runtimeDir, keepVer) {
  try {
    const entries = readdirSync(runtimeDir);
    const entrySet = new Set(entries);
    for (const name of entries) {
      if (name.startsWith('staging-')) {
        if (name.endsWith('.lock')) {
          // Orphan lockfile (crash after rename-away, or a failed unlink in
          // releaseStagingLock) whose matching staging dir is gone. Lockfiles
          // beside a live dir are handled by the dir branch below.
          const dirName = name.slice(0, -'.lock'.length);
          if (entrySet.has(dirName)) continue;
          const lockPath = join(runtimeDir, name);
          // Reap only a provably-dead/stale orphan; never one whose owner pid is
          // live AND fresh (_stagingLockIsLive covers both conditions).
          if (_stagingLockIsLive(lockPath)) continue;
          try {
            unlinkSync(lockPath);
          } catch {}
          continue;
        }
        const dir = join(runtimeDir, name);
        // A download (staging-{tag}.tar.gz) is guarded by its staging dir's lock.
        const guardName = name.endsWith('.tar.gz') ? name.slice(0, -'.tar.gz'.length) : name;
        const lockPath = stagingLockPath(join(runtimeDir, guardName));
        // Never wipe a staging dir or download guarded by a LIVE lock — that is
        // a sibling process mid-download/extract/swap.
        if (_stagingLockIsLive(lockPath)) continue;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        // Reap the now-orphaned (dead/stale) lockfile too.
        try {
          if (existsSync(lockPath)) unlinkSync(lockPath);
        } catch {}
      } else if (name.startsWith('runtime-') && name !== `runtime-${keepVer}`) {
        const path = join(runtimeDir, name);
        try {
          if (statSync(path).isDirectory()) discardRuntimeDir(runtimeDir, path);
          else rmSync(path, { force: true });
        } catch {}
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// ensureRuntime — public API
// ---------------------------------------------------------------------------

const runtimeCache = new Map();

// One-shot tar availability probe; result cached after first call.
let _tarProbed = false;
async function probeTar() {
  if (_tarProbed) return;
  const r = await runChild('tar', ['--version']);
  if (r.status !== 0 || r.error) {
    throw new Error(
      '[runtime-fetcher] `tar` not found or not executable. ' +
        'On Windows, bsdtar (tar.exe) is required (available since Windows 10 1803). ' +
        'Ensure tar.exe is on PATH (typically %SystemRoot%\\System32\\tar.exe).'
    );
  }
  _tarProbed = true;
}

/**
 * The manifest asset this platform installs, or a graceful-degrade error
 * naming why memory cannot run here. win32-arm64 falls back to the emulated
 * win32-x64 asset, so the selected key is returned alongside.
 */
function selectRuntimeAsset(manifest, pkey) {
  for (const candidateKey of platformKeyCandidates()) {
    const candidateAsset = manifest.assets?.[candidateKey];
    if (isUsableAsset(candidateAsset)) return { asset: candidateAsset, selectedKey: candidateKey };
  }
  const primaryAsset = manifest.assets?.[pkey];
  if (!primaryAsset) {
    // Platform/arch absent from the manifest entirely (e.g. an exotic arch).
    // The memory PG runtime cannot start here; fail with a single clear,
    // actionable message. The memory worker's init().catch reports this as
    // degraded and the rest of mixdog (agent, tools) keeps working without
    // memory.
    const supported =
      Object.keys(manifest.assets || {})
        .filter((k) => isUsableAsset(manifest.assets[k]))
        .join(', ') || '(none)';
    throw new Error(
      `[runtime-fetcher] memory runtime not available on ${pkey}: ` +
        `no runtime asset for this platform/arch in the manifest. ` +
        `Supported: ${supported}. ` +
        `Memory is disabled on this platform; the rest of mixdog continues to work.`
    );
  }
  // Platform/arch present but explicitly marked unsupported or carrying a
  // placeholder/TBD payload (e.g. linux-arm64). Same graceful-degrade path.
  throw new Error(
    `[runtime-fetcher] memory runtime not available on ${pkey}: ` +
      `this platform/arch is marked unsupported (no validated runtime asset). ` +
      `Memory is disabled on this platform; the rest of mixdog continues to work.`
  );
}

/** Fast path: the active-version pointer names this version and the extracted
 *  tree carries the expected sha256. Returns the reusable dir, else null. */
function cachedRuntimeDir(runtimeBaseDir, version, sha256) {
  const key = readActiveVersion(runtimeBaseDir);
  if (key !== version && key !== runtimeInstallKey(version, sha256)) return null;
  const verDir = runtimeVerDir(runtimeBaseDir, key);
  return readRuntimeStamp(verDir) === sha256 ? verDir : null;
}

// The asset digest stamped into a complete runtime tree, '' when absent.
function readRuntimeStamp(verDir) {
  try {
    return readFileSync(join(verDir, '.version-sha256'), 'utf8').trim();
  } catch {
    return '';
  }
}

// Publish an extracted, stamped staging tree as runtime-{key} and point
// active-version at it. A sibling that raced this install may already have
// published the same asset: that tree is kept (it may be running) and this
// copy dropped. Any other runtime-{key} tree is an interrupted install of this
// asset; it is moved aside whole, and an in-use one fails the publish intact.
function publishRuntimeDir(runtimeBaseDir, stagingDir, key, sha256) {
  const verDir = runtimeVerDir(runtimeBaseDir, key);
  if (readRuntimeStamp(verDir) === sha256) {
    rmSync(stagingDir, { recursive: true, force: true });
  } else {
    if (existsSync(verDir)) discardRuntimeDir(runtimeBaseDir, verDir);
    renameWithRetrySync(stagingDir, verDir);
  }
  writeFileAtomicSync(activeVersionPath(runtimeBaseDir), key, { fsyncDir: true });
  return verDir;
}

/**
 * Download → verify → extract → atomic swap, all under one cross-process
 * staging lock, ending with the stale-version GC. Returns the installed
 * runtime-{version} directory.
 */
async function installRuntimeVersion({ runtimeBaseDir, url, sha256, size, version, pkey }) {
  // tar is only required for the download/extract path. Probe here (not at
  // ensureRuntime entry) so a machine without tar can still reuse an
  // already-extracted, sha-matching cached runtime via the fast path.
  await probeTar();

  __mixdogMemoryLog(`[runtime-fetcher] downloading runtime ${version} for ${pkey} (~${size} bytes) …\n`);

  // Unique staging suffix prevents two siblings from colliding on one dir and
  // on its guarding lockfile (the O_EXCL acquire below would otherwise have one
  // process fail to obtain the lock for its own staging dir).
  const stagingTag = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingDir = join(runtimeBaseDir, `staging-${stagingTag}`);
  // Named after the staging dir so the same live lock guards it from GC.
  const tarPath = `${stagingDir}.tar.gz`;

  const key = runtimeInstallKey(version, sha256);
  const verDir = runtimeVerDir(runtimeBaseDir, key);

  // Cross-process lock: hold the staging lockfile (O_EXCL) for the WHOLE
  // download → extract → swap lifetime. GC in any concurrently-booting sibling
  // treats a live lock as "in progress" and will not wipe this staging dir.
  const stagingLock = acquireStagingLock(stagingDir);
  try {
    let downloadOk = false;
    let lastDownloadErr = null;
    try {
      for (const candidateUrl of runtimeAssetUrlCandidates(url)) {
        try {
          if (candidateUrl !== url) {
            __mixdogMemoryLog(
              `[runtime-fetcher] retrying runtime download from fallback release repo — ${candidateUrl}\n`
            );
          }
          await downloadWithRetry(candidateUrl, tarPath, size);
          await verifySha256(tarPath, sha256);
          downloadOk = true;
          break;
        } catch (err) {
          lastDownloadErr = err;
          try {
            rmSync(tarPath, { force: true });
          } catch {}
        }
      }
      if (!downloadOk && lastDownloadErr) throw lastDownloadErr;
      await _extractRuntimeTarGz(tarPath, stagingDir, stagingDir);
    } finally {
      try {
        rmSync(tarPath, { force: true });
      } catch {}
    }

    if (!downloadOk) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
      throw new Error(`[runtime-fetcher] download or verify failed for ${version}`);
    }

    // Stamp sha256 inside staging dir.
    writeFileSync(join(stagingDir, '.version-sha256'), sha256);
    normalizeBinExecBit(stagingDir);

    // Atomic swap:
    // 1. Rename staging → runtime-{key} (or reuse a sibling's identical publish)
    // 2. Write active-version.tmp → rename to active-version
    // Stale dirs cleaned up by GC after.
    try {
      publishRuntimeDir(runtimeBaseDir, stagingDir, key, sha256);
    } catch (swapErr) {
      __mixdogMemoryLog(`[runtime-fetcher] atomic swap failed: ${swapErr.message}\n`);
      // Attempt to leave things in a recoverable state: if verDir landed but
      // active-version didn't update, next call will re-download.
      throw swapErr;
    }

    // GC: remove stale runtime-* dirs (anything that isn't runtime-{key}).
    // Still under the lock so the just-swapped staging lockfile reap below sees
    // a consistent view.
    gcRuntimeDir(runtimeBaseDir, key);
  } finally {
    releaseStagingLock(stagingLock);
  }

  __mixdogMemoryLog(`[runtime-fetcher] runtime ready at ${verDir}\n`);
  return verDir;
}

export const _runtimeLayoutInternals = {
  acquireStagingLock,
  cachedRuntimeDir,
  discardRuntimeDir,
  gcRuntimeDir,
  publishRuntimeDir,
  releaseStagingLock,
  runtimeInstallKey,
};

export async function ensureRuntime(dataDir) {
  const key = resolve(dataDir);
  if (runtimeCache.has(key)) return runtimeCache.get(key);

  const runtimeBaseDir = join(key, 'runtime');
  mkdirSync(runtimeBaseDir, { recursive: true });

  // Entry GC: always clean staging-* (partial extracts from prior crashes), but
  // preserve runtime-${currentVer} so a sibling child's just-completed swap is
  // not wiped. multi-process race protection.
  gcRuntimeDir(runtimeBaseDir, readActiveVersion(runtimeBaseDir));

  const manifest = await loadManifest(key);
  const pkey = platformKey();
  const { asset, selectedKey } = selectRuntimeAsset(manifest, pkey);
  if (selectedKey !== pkey) {
    __mixdogMemoryLog('[runtime-fetcher] win32-arm64 has no native runtime; using win32-x64 under emulation\n');
  }

  const { url, sha256, size } = asset;
  const version = `pg${manifest.pg?.major}.${manifest.pg?.minor}+pgvector-${manifest.pgvector?.version}`;

  const verDir =
    cachedRuntimeDir(runtimeBaseDir, version, sha256) ??
    (await installRuntimeVersion({ runtimeBaseDir, url, sha256, size, version, pkey }));

  const result = { runtimeDir: verDir, ...runtimePaths(verDir), version };
  runtimeCache.set(key, result);
  return result;
}
