const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

// runtime-fetcher.mjs — P1 runtime fetcher for mixdog 0.4.0
// runtime-fetcher.mjs
// REQUIRES: `tar` (bsdtar-compatible) on PATH.
// On Windows, bsdtar ships with Windows 10 1803+ as %SystemRoot%\System32\tar.exe.
// If tar is missing, ensureRuntime() throws with an actionable error message.
//
// Downloads and verifies a prebuilt native PG runtime from the mixdog GitHub
// release manifest.
//
// Layout: <dataDir>/runtime/runtime-{ver}/  +  <dataDir>/runtime/active-version
// Atomic swap: write active-version.tmp then rename → active-version.
// GC: removes stale runtime-* dirs and staging-* dirs on every ensureRuntime call.
//
// Public API: ensureRuntime(dataDir) → { runtimeDir, pgBinDir, libDir, sharePath, version }

import { createHash } from 'crypto'
import {
  chmodSync, closeSync, createWriteStream, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { spawnSync } from 'child_process'
import { renameWithRetrySync, writeFileAtomicSync, writeJsonAtomicSync } from '../../shared/atomic-file.mjs'

// Bundled fallback manifest shipped alongside Mixdog. fileURLToPath required
// for cross-platform path resolution (URL.pathname returns /C:/... on Windows).
const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('../data/runtime-manifest.json', import.meta.url))

// GitHub raw URL fallback — used only when no cached or bundled manifest exists.
const MANIFEST_URL = 'https://raw.githubusercontent.com/tribgames/mixdog/main/src/runtime/memory/data/runtime-manifest.json'

// ---------------------------------------------------------------------------
// Platform key
// ---------------------------------------------------------------------------

function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform
  return `${os}-${process.arch}`
}

// Fail-closed asset validation. A selected manifest asset is usable only if it
// is not explicitly marked unsupported AND carries a real downloadable payload:
// non-empty url, a well-formed 64-hex sha256, and a positive integer size.
// Placeholder / TBD entries fail every payload check and are rejected.
function isUsableAsset(asset) {
  if (!asset || typeof asset !== 'object') return false
  if (asset.unsupported === true) return false
  if (typeof asset.url !== 'string' || asset.url.length === 0) return false
  if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) return false
  if (!Number.isInteger(asset.size) || asset.size <= 0) return false
  return true
}

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

async function loadManifest(dataDir) {
  const runtimeManifestPath = join(dataDir, 'runtime', 'manifest.json')
  if (existsSync(runtimeManifestPath)) {
    try { return JSON.parse(readFileSync(runtimeManifestPath, 'utf8')) } catch {}
  }
  if (existsSync(BUNDLED_MANIFEST_PATH)) {
    return JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'))
  }
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`[runtime-fetcher] manifest fetch failed: ${res.status} ${res.statusText}`)
  const manifest = await res.json()
  mkdirSync(join(dataDir, 'runtime'), { recursive: true })
  writeJsonAtomicSync(runtimeManifestPath, manifest, { lock: true, fsyncDir: true })
  return manifest
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

async function sha256File(filePath) {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

async function verifySha256(filePath, expected) {
  const actual = await sha256File(filePath)
  if (actual !== expected) {
    throw new Error(`[runtime-fetcher] sha256 mismatch for ${filePath}: expected ${expected}, got ${actual}`)
  }
}

// ---------------------------------------------------------------------------
// Active-runtime validation (pointer-file layout)
// ---------------------------------------------------------------------------

function activeVersionPath(runtimeDir) {
  return join(runtimeDir, 'active-version')
}

function readActiveVersion(runtimeDir) {
  try { return readFileSync(activeVersionPath(runtimeDir), 'utf8').trim() } catch { return null }
}

function runtimeVerDir(runtimeDir, ver) {
  return join(runtimeDir, `runtime-${ver}`)
}

function runtimePaths(verDir) {
  return {
    pgBinDir:  join(verDir, 'bin'),
    libDir:    join(verDir, 'lib'),
    sharePath: join(verDir, 'share'),
  }
}

// ---------------------------------------------------------------------------
// Download with retry
// ---------------------------------------------------------------------------

async function downloadWithRetry(url, destPath) {
  // 4 total attempts: 1 initial + 3 retries; waits between attempts: 1s, 3s, 9s.
  const delays = [1000, 3000, 9000]
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      if (res.status >= 400 && res.status < 500) {
        // 4xx: terminal — do not retry.
        throw new Error(`[runtime-fetcher] asset download HTTP ${res.status} (terminal) — ${url}`)
      }
      if (!res.ok) {
        throw new Error(`[runtime-fetcher] asset download HTTP ${res.status} — ${url}`)
      }
      const out = createWriteStream(destPath)
      await pipeline(res.body, out)
      return // success
    } catch (err) {
      lastErr = err
      // Terminal 4xx: do not retry.
      if (err.message.includes('(terminal)')) throw err
      if (attempt < 3) {
        __mixdogMemoryLog(`[runtime-fetcher] download attempt ${attempt + 1} failed (${err.message}), retrying in ${delays[attempt]}ms…\n`)
        await new Promise(r => setTimeout(r, delays[attempt]))
      }
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Tar entry path validation + extraction
// ---------------------------------------------------------------------------

function extractTarGz(tarPath, destDir, stagingBase) {
  mkdirSync(destDir, { recursive: true })

  // List entries first and validate — reject any that escape staging.
  const listResult = spawnSync('tar', ['-tzf', tarPath], { stdio: 'pipe', windowsHide: true })
  if (listResult.status !== 0) {
    throw new Error(`[runtime-fetcher] tar list failed: ${listResult.stderr?.toString() || 'unknown'}`)
  }
  const entries = (listResult.stdout?.toString() || '').split('\n').filter(Boolean)
  const resolvedBase = resolve(stagingBase)
  for (const entry of entries) {
    // Reject absolute paths and traversal sequences.
    if (entry.startsWith('/') || entry.includes('..')) {
      throw new Error(`[runtime-fetcher] tar entry path validation failed (unsafe entry): ${entry}`)
    }
    const resolved = resolve(join(stagingBase, entry))
    if (!resolved.startsWith(resolvedBase)) {
      throw new Error(`[runtime-fetcher] tar entry escapes staging dir: ${entry}`)
    }
  }

  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'pipe', windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`[runtime-fetcher] tar extraction failed: ${r.stderr?.toString() || 'unknown error'}`)
  }
}

// ---------------------------------------------------------------------------
// Unix exec-bit normalization
// ---------------------------------------------------------------------------

function normalizeBinExecBit(verDir) {
  if (process.platform === 'win32') return
  const binDir = join(verDir, 'bin')
  if (!existsSync(binDir)) return
  try {
    const entries = readdirSync(binDir)
    for (const f of entries) {
      try { chmodSync(join(binDir, f), 0o755) } catch {}
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
const STAGING_LOCK_STALE_MS = 600_000

function stagingLockPath(stagingDir) {
  return `${stagingDir}.lock`
}

function _readStagingLockPid(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8')
    const pid = Number.parseInt(String(raw).trim().split(/\s+/)[0], 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function _stagingLockPidAlive(pid) {
  if (pid === null) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true // signal delivered → owner exists
  } catch (err) {
    // ESRCH = no such process → owner is gone. Any other error (e.g. EPERM:
    // exists but unsignalable) → treat as alive so we never steal from a live
    // holder.
    return err?.code !== 'ESRCH'
  }
}

// A staging dir is protected iff its lockfile exists, names a live owner pid
// (or an unparseable-but-fresh stamp), and is not older than the stale budget.
function _stagingLockIsLive(lockPath) {
  let st
  try { st = statSync(lockPath) } catch { return false } // no lock → unprotected
  const pid = _readStagingLockPid(lockPath)
  if (pid !== null && !_stagingLockPidAlive(pid)) return false // owner dead
  if (Date.now() - st.mtimeMs > STAGING_LOCK_STALE_MS) return false // abandoned
  return true
}

function acquireStagingLock(stagingDir) {
  const lockPath = stagingLockPath(stagingDir)
  const fd = openSync(lockPath, 'wx') // O_EXCL: fails if a sibling already owns it
  try { writeFileSync(fd, `${process.pid} ${Date.now()}\n`, 'utf8') } catch {}
  return { fd, lockPath }
}

function releaseStagingLock(lock) {
  if (!lock) return
  try { closeSync(lock.fd) } catch {}
  // Only unlink if we still own the stamp; a stolen+replaced lock must not be
  // destroyed out from under its new owner.
  try {
    if (_readStagingLockPid(lock.lockPath) === process.pid) unlinkSync(lock.lockPath)
  } catch {}
}

// ---------------------------------------------------------------------------
// GC — remove stale runtime-* and staging-* dirs
// ---------------------------------------------------------------------------

function gcRuntimeDir(runtimeDir, keepVer) {
  try {
    const entries = readdirSync(runtimeDir)
    const entrySet = new Set(entries)
    for (const name of entries) {
      if (name.startsWith('staging-')) {
        if (name.endsWith('.lock')) {
          // Orphan lockfile (crash after rename-away, or a failed unlink in
          // releaseStagingLock) whose matching staging dir is gone. Lockfiles
          // beside a live dir are handled by the dir branch below.
          const dirName = name.slice(0, -'.lock'.length)
          if (entrySet.has(dirName)) continue
          const lockPath = join(runtimeDir, name)
          // Reap only a provably-dead/stale orphan; never one whose owner pid is
          // live AND fresh (_stagingLockIsLive covers both conditions).
          if (_stagingLockIsLive(lockPath)) continue
          try { unlinkSync(lockPath) } catch {}
          continue
        }
        const dir = join(runtimeDir, name)
        const lockPath = stagingLockPath(dir)
        // Never wipe a staging dir guarded by a LIVE lock — that is a sibling
        // process mid-extract/swap.
        if (_stagingLockIsLive(lockPath)) continue
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
        // Reap the now-orphaned (dead/stale) lockfile too.
        try { if (existsSync(lockPath)) unlinkSync(lockPath) } catch {}
      } else if (name.startsWith('runtime-') && name !== `runtime-${keepVer}`) {
        try { rmSync(join(runtimeDir, name), { recursive: true, force: true }) } catch {}
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// ensureRuntime — public API
// ---------------------------------------------------------------------------

const runtimeCache = new Map()

// One-shot tar availability probe; result cached after first call.
let _tarProbed = false
function probeTar() {
  if (_tarProbed) return
  const r = spawnSync('tar', ['--version'], { stdio: 'pipe', windowsHide: true })
  if (r.status !== 0 || r.error) {
    throw new Error(
      '[runtime-fetcher] `tar` not found or not executable. ' +
      'On Windows, bsdtar (tar.exe) is required (available since Windows 10 1803). ' +
      'Ensure tar.exe is on PATH (typically %SystemRoot%\\System32\\tar.exe).'
    )
  }
  _tarProbed = true
}

export async function ensureRuntime(dataDir) {
  const key = resolve(dataDir)
  if (runtimeCache.has(key)) return runtimeCache.get(key)

  const runtimeBaseDir = join(key, 'runtime')
  mkdirSync(runtimeBaseDir, { recursive: true })

  // Entry GC: always clean staging-* (partial extracts from prior crashes), but
  // preserve runtime-${currentVer} so a sibling child's just-completed swap is
  // not wiped. multi-process race protection.
  gcRuntimeDir(runtimeBaseDir, readActiveVersion(runtimeBaseDir))

  const manifest = await loadManifest(key)
  const pkey     = platformKey()
  const asset    = manifest.assets?.[pkey]
  if (!asset) {
    // Platform/arch absent from the manifest entirely (e.g. win32-arm64).
    // The memory PG runtime cannot start here; fail with a single clear,
    // actionable message. The memory worker's init().catch reports this as
    // degraded and the rest of mixdog (agent, tools) keeps working without
    // memory.
    const supported = Object.keys(manifest.assets || {})
      .filter((k) => isUsableAsset(manifest.assets[k]))
      .join(', ') || '(none)'
    throw new Error(
      `[runtime-fetcher] memory runtime not available on ${pkey}: ` +
      `no runtime asset for this platform/arch in the manifest. ` +
      `Supported: ${supported}. ` +
      `Memory is disabled on this platform; the rest of mixdog continues to work.`
    )
  }
  if (!isUsableAsset(asset)) {
    // Platform/arch present but explicitly marked unsupported or carrying a
    // placeholder/TBD payload (e.g. linux-arm64). Same graceful-degrade path.
    throw new Error(
      `[runtime-fetcher] memory runtime not available on ${pkey}: ` +
      `this platform/arch is marked unsupported (no validated runtime asset). ` +
      `Memory is disabled on this platform; the rest of mixdog continues to work.`
    )
  }

  const { url, sha256, size } = asset
  const version = `pg${manifest.pg?.major}.${manifest.pg?.minor}+pgvector-${manifest.pgvector?.version}`

  // Fast path: active-version pointer exists and matches expected sha256.
  const currentVer = readActiveVersion(runtimeBaseDir)
  if (currentVer === version) {
    const verDir = runtimeVerDir(runtimeBaseDir, version)
    if (existsSync(join(verDir, '.version-sha256'))) {
      const stored = readFileSync(join(verDir, '.version-sha256'), 'utf8').trim()
      if (stored === sha256) {
        const result = { runtimeDir: verDir, ...runtimePaths(verDir), version }
        runtimeCache.set(key, result)
        return result
      }
    }
  }

  // tar is only required for the download/extract path. Probe here (not at
  // function entry) so a machine without tar can still reuse an
  // already-extracted, sha-matching cached runtime via the fast path above.
  probeTar()

  __mixdogMemoryLog(`[runtime-fetcher] downloading runtime ${version} for ${pkey} (~${size} bytes) …\n`)

  // Unique staging suffix prevents two siblings from colliding on one dir and
  // on its guarding lockfile (the O_EXCL acquire below would otherwise have one
  // process fail to obtain the lock for its own staging dir).
  const stagingTag = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const stagingDir = join(runtimeBaseDir, `staging-${stagingTag}`)
  const tarPath    = join(runtimeBaseDir, `runtime-${pkey}-${stagingTag}.tar.gz`)

  const verDir  = runtimeVerDir(runtimeBaseDir, version)
  const avPath  = activeVersionPath(runtimeBaseDir)

  // Cross-process lock: hold the staging lockfile (O_EXCL) for the WHOLE
  // download → extract → swap lifetime. GC in any concurrently-booting sibling
  // treats a live lock as "in progress" and will not wipe this staging dir.
  const stagingLock = acquireStagingLock(stagingDir)
  try {
    let downloadOk = false
    try {
      await downloadWithRetry(url, tarPath)
      await verifySha256(tarPath, sha256)
      downloadOk = true
      extractTarGz(tarPath, stagingDir, stagingDir)
    } finally {
      try { rmSync(tarPath, { force: true }) } catch {}
    }

    if (!downloadOk) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
      throw new Error(`[runtime-fetcher] download or verify failed for ${version}`)
    }

    // Stamp sha256 inside staging dir.
    writeFileSync(join(stagingDir, '.version-sha256'), sha256)
    normalizeBinExecBit(stagingDir)

    // Atomic swap:
    // 1. Rename staging → runtime-{ver}
    // 2. Write active-version.tmp → rename to active-version
    // Stale dirs cleaned up by GC after.
    try {
      // If a prior runtime-{ver} dir exists (interrupted earlier run), remove it.
      if (existsSync(verDir)) {
        rmSync(verDir, { recursive: true, force: true })
      }
      renameWithRetrySync(stagingDir, verDir)
      writeFileAtomicSync(avPath, version, { fsyncDir: true })
    } catch (swapErr) {
      __mixdogMemoryLog(`[runtime-fetcher] atomic swap failed: ${swapErr.message}\n`)
      // Attempt to leave things in a recoverable state: if verDir landed but
      // active-version didn't update, next call will re-download.
      throw swapErr
    }

    // GC: remove stale runtime-* dirs (anything that isn't runtime-{version}).
    // Still under the lock so the just-swapped staging lockfile reap below sees
    // a consistent view.
    gcRuntimeDir(runtimeBaseDir, version)
  } finally {
    releaseStagingLock(stagingLock)
  }

  __mixdogMemoryLog(`[runtime-fetcher] runtime ready at ${verDir}\n`)

  const result = { runtimeDir: verDir, ...runtimePaths(verDir), version }
  runtimeCache.set(key, result)
  return result
}
