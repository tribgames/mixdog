// voice-runtime-fetcher.mjs
//
// Single-source whisper.cpp runtime resolution: every user converges on the
// same upstream binary, but the *variant* (CPU base vs cuBLAS-11.8 vs
// cuBLAS-12.4) is selected per machine from a deterministic CUDA-toolkit
// detection. No heuristics: a variant matches only when its required CUDA
// major version is present in the local toolkit (cublas64_*.dll discovered
// in standard install paths or CUDA_PATH). The base-cpu variant is the
// requires:null bucket and is selected when nothing else matches.
//
// Layout:  <dataDir>/voice-runtime/whisper-<ver>-<variantId>/
//          <dataDir>/voice-runtime/active-version
//          <dataDir>/voice/models/<manifest.model.filename>
// Atomic swap: write active-version.tmp then rename → active-version.
// GC: removes stale whisper-* / staging-* dirs on every ensureWhisperRuntime.
//
// Public API:
//   ensureWhisperRuntime(dataDir, onProgress?) → { whisperCmd, version, variantId }
//   ensureWhisperModel(dataDir, onProgress?)   → { modelPath, modelId, size }
//   ensureFfmpegRuntime(dataDir, onProgress?)  → { ffmpegPath, version }
//   resolveManagedWhisperCmd(dataDir)     → string | null  (read-only check)
//   resolveManagedWhisperModel(dataDir)   → string | null  (read-only check)
//   resolveManagedFfmpegPath(dataDir)     → string | null  (read-only check)
//   resolveVoiceRuntime(dataDir)          → runtime descriptor; managed
//                                           whisper.cpp only

import { createHash } from 'crypto'
import {
  chmodSync, closeSync,
  createReadStream, createWriteStream, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from 'fs'
import { setTimeout as sleep } from 'timers/promises'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { spawnSync } from 'child_process'
import { createGunzip } from 'zlib'
import { renameWithRetrySync, writeFileAtomicSync } from '../../shared/atomic-file.mjs'
import { windowsProgramRoots, windowsSystemRoot } from '../../agent/orchestrator/tools/builtin/windows-roots.mjs'

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('../data/voice-runtime-manifest.json', import.meta.url))
const MANIFEST_URL = 'https://raw.githubusercontent.com/trib-plugin/mixdog/main/src/channels/data/voice-runtime-manifest.json'
const LOCK_WAIT_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])
// Hard ceiling on how long _withInstallLock will defer to an existing
// lock holder before reclaiming. Installs download + unpack runtime
// binaries; 30 minutes is well beyond any legitimate install yet
// short enough that a stale/recycled/self pid cannot hang installers
// forever. The check is age-only fallback — a verified-dead pid is
// still reclaimed immediately.
const LOCK_MAX_AGE_MS = 30 * 60 * 1000

function _readInstallLockToken(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim()
    if (!raw) return null
    const [pidLine, tsLine = ''] = raw.split(/\r?\n/)
    const pid = Number(pidLine)
    const ts = Number(tsLine)
    if (!Number.isFinite(pid) || pid <= 0) return null
    return { pid, ts, token: `${pidLine}\n${tsLine}` }
  } catch {
    return null
  }
}

function _installLockTokenMatches(lockPath, expectedPid, expectedTs, expectedToken) {
  const current = _readInstallLockToken(lockPath)
  return current?.pid === expectedPid &&
    Object.is(current.ts, expectedTs) &&
    current.token === expectedToken
}

function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform
  return `${os}-${process.arch}`
}

async function _withInstallLock(rootDir, lockName, fn, { pollMs = 250 } = {}) {
  mkdirSync(rootDir, { recursive: true })
  const lockPath = join(rootDir, `.${lockName}.lock`)
  let fd = null
  // Track when this caller first observed the lock as held by a live
  // pid OTHER than this process. Once that wait crosses
  // LOCK_MAX_AGE_MS we treat the lock as abandoned regardless of
  // process.kill(pid, 0) — a recycled/unrelated pid can keep looking
  // "alive" indefinitely without ever releasing this lockfile.
  let foreignWaitSince = 0
  let samePidWaitSince = 0
  while (true) {
    try {
      fd = openSync(lockPath, 'wx')
      // Record pid + acquire timestamp so a later waiter can age out a
      // truly abandoned lock. Single-line `${pid}\n${ms}` keeps backward
      // compat with the pid-only reader path (Number(raw) parses the
      // first line). Older lockfiles without a timestamp simply have
      // no age signal and fall back to pid-liveness alone.
      try { writeFileSync(lockPath, `${process.pid}\n${Date.now()}`) } catch {}
      break
    } catch (err) {
      if (!LOCK_WAIT_CODES.has(err.code)) throw err
      try {
        const holder = _readInstallLockToken(lockPath)
        if (!holder) {
          // empty or invalid PID — orphan lockfile, reclaim
          try { rmSync(lockPath, { force: true }) } catch {}
          foreignWaitSince = 0
          samePidWaitSince = 0
          continue
        }
        const { pid: holderPid, ts: holderTs, token: holderToken } = holder
        if (holderPid === process.pid) {
          // Another concurrent install call within this same process holds
          // the lock. Wait for its release() to remove the lockfile, then
          // retry the wx-create so installs serialize instead of racing.
          // Age fallback: a same-pid lockfile that survives past
          // LOCK_MAX_AGE_MS without release() is stale. Timestamped
          // locks use on-disk age; legacy pid-only locks use this
          // waiter's first-observed time so PID reuse cannot hang forever.
          const ageMs = Number.isFinite(holderTs) && holderTs > 0
            ? Date.now() - holderTs
            : (samePidWaitSince ? Date.now() - samePidWaitSince : 0)
          if (!Number.isFinite(holderTs) || holderTs <= 0) {
            if (!samePidWaitSince) samePidWaitSince = Date.now()
          }
          if (ageMs > LOCK_MAX_AGE_MS) {
            if (_installLockTokenMatches(lockPath, holderPid, holderTs, holderToken)) {
              try { rmSync(lockPath, { force: true }) } catch {}
              foreignWaitSince = 0
              samePidWaitSince = 0
              continue
            }
          }
          await sleep(pollMs)
          continue
        }
        samePidWaitSince = 0
        try { process.kill(holderPid, 0) }
        catch {
          try { rmSync(lockPath, { force: true }) } catch {}
          foreignWaitSince = 0
          samePidWaitSince = 0
          continue
        }
        // Live foreign pid. Apply age ceiling so a recycled/unrelated
        // pid (e.g. a long-lived shell that happens to share the pid
        // of a long-dead installer) cannot block installs forever.
        // Prefer the on-disk timestamp; fall back to the first time
        // THIS waiter saw the lock if the file predates the timestamp
        // format.
        const ageMs = Number.isFinite(holderTs) && holderTs > 0
          ? Date.now() - holderTs
          : (foreignWaitSince ? Date.now() - foreignWaitSince : 0)
        if (!foreignWaitSince) foreignWaitSince = Date.now()
        if (ageMs > LOCK_MAX_AGE_MS) {
          if (_installLockTokenMatches(lockPath, holderPid, holderTs, holderToken)) {
            try { rmSync(lockPath, { force: true }) } catch {}
            foreignWaitSince = 0
            samePidWaitSince = 0
            continue
          }
        }
      } catch {}
      await sleep(pollMs)
    }
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try { if (fd != null) closeSync(fd) } catch {}
    try { rmSync(lockPath, { force: true }) } catch {}
  }
  process.on('exit', release)
  try { return await fn() } finally { release() }
}

async function loadManifest(dataDir) {
  const cachedPath = join(dataDir, 'voice-runtime', 'manifest.json')
  if (existsSync(cachedPath)) {
    try { return JSON.parse(readFileSync(cachedPath, 'utf8')) } catch {}
  }
  if (existsSync(BUNDLED_MANIFEST_PATH)) {
    return JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'))
  }
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`[voice-runtime] manifest fetch failed: ${res.status} ${res.statusText}`)
  const manifest = await res.json()
  mkdirSync(join(dataDir, 'voice-runtime'), { recursive: true })
  writeFileSync(cachedPath, JSON.stringify(manifest, null, 2))
  return manifest
}

async function sha256File(filePath) {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

async function verifySha256(filePath, expected) {
  const actual = await sha256File(filePath)
  if (actual !== expected) {
    throw new Error(`[voice-runtime] sha256 mismatch for ${filePath}: expected ${expected}, got ${actual}`)
  }
}

// Deterministic CUDA toolkit detection on Windows.
// Returns the set of CUDA major versions discoverable on this machine — a
// `cublas64_<major>.dll` file in any standard CUDA toolkit install dir or in
// CUDA_PATH. Anything not on disk doesn't count; no heuristics, no PATH-only
// guesses.
function detectCudaMajorsWin32() {
  const found = new Set()
  const dirs = []

  const envKeys = Object.keys(process.env).filter(k =>
    k === 'CUDA_PATH' || /^CUDA_PATH_V\d+_\d+$/i.test(k)
  )
  for (const k of envKeys) {
    const p = process.env[k]
    if (p) dirs.push(join(p, 'bin'))
  }

  for (const root of windowsProgramRoots()) {
    const standardRoot = join(root, 'NVIDIA GPU Computing Toolkit', 'CUDA')
    if (!existsSync(standardRoot)) continue
    try {
      for (const e of readdirSync(standardRoot)) {
        if (/^v\d+\.\d+/.test(e)) dirs.push(join(standardRoot, e, 'bin'))
      }
    } catch {}
  }

  for (const d of dirs) {
    if (!existsSync(d)) continue
    try {
      for (const f of readdirSync(d)) {
        const m = /^cublas64_(\d+)\.dll$/i.exec(f)
        if (m) found.add(Number(m[1]))
      }
    } catch {}
  }
  return found
}

// Linux: scan LD_LIBRARY_PATH + standard paths for libcublas.so.<major>.
function detectCudaMajorsLinux() {
  const found = new Set()
  const dirs = []
  const ldPath = process.env.LD_LIBRARY_PATH || ''
  for (const p of ldPath.split(':')) { if (p) dirs.push(p) }
  dirs.push(
    '/usr/local/cuda/lib64',
    '/usr/lib/x86_64-linux-gnu',
    '/usr/lib/aarch64-linux-gnu',
  )
  const cudaPath = process.env.CUDA_PATH
  if (cudaPath) dirs.push(cudaPath + '/lib64')
  for (const d of dirs) {
    if (!existsSync(d)) continue
    try {
      for (const f of readdirSync(d)) {
        const m = /^libcublas\.so\.(\d+)$/.exec(f)
        if (m) found.add(Number(m[1]))
      }
    } catch {}
  }
  return found
}

function detectCudaMajors() {
  if (process.platform === 'win32') return detectCudaMajorsWin32()
  if (process.platform === 'darwin') {
    // darwin uses Metal — CUDA not applicable, skip detection entirely.
    return new Set()
  }
  // linux / WSL: probe for libcublas.so.<major>
  return detectCudaMajorsLinux()
}

// Deterministic NVIDIA driver presence check. The driver ships nvidia-smi.exe
// and nvml.dll into system32 whenever a supported card is detected and the
// user accepts the install. Either file's presence proves a usable driver —
// no nvidia-smi runtime invocation needed (avoids 50-200ms process spawn).
function hasNvidiaDriver() {
  if (process.platform !== 'win32') return false
  const sys = windowsSystemRoot()
  if (!sys) return false
  for (const f of ['System32\\nvidia-smi.exe', 'System32\\nvml.dll']) {
    if (existsSync(join(sys, f))) return true
  }
  return false
}

// Deterministic variant selection by explicit priority — manifest array order
// never influences the pick:
//   1. Highest matching CUDA major (CUDA > everything)
//   2. nvidia-driver generic (driver present, no toolkit required)
//   3. requires:null catch-all
function pickVariant(variants, env) {
  if (!Array.isArray(variants) || variants.length === 0) return null
  // Priority 1: highest matching CUDA major
  let bestCuda = null
  for (const v of variants) {
    if (v.requires?.cudaMajor == null) continue
    const major = Number(v.requires.cudaMajor)
    if (env.cudaMajors.has(major)) {
      if (bestCuda == null || major > Number(bestCuda.requires.cudaMajor)) bestCuda = v
    }
  }
  if (bestCuda) return bestCuda
  // Priority 2: driver-generic (nvidia driver present, no CUDA toolkit required)
  const driverV = variants.find(v => v.requires?.nvidiaDriver === true && env.hasNvidiaDriver)
  if (driverV) return driverV
  // Priority 3: catch-all (requires: null)
  return variants.find(v => v.requires == null) ?? null
}

// Process bundled extras: download supplementary archives (e.g. NVIDIA
// cublas wheels) and lift selected files into the runtime directory.
async function processExtras(extras, stagingDir, onProgress) {
  if (!Array.isArray(extras) || extras.length === 0) return
  for (const extra of extras) {
    const tag = createHash('sha256').update(extra.url).digest('hex').slice(0, 8)
    const archivePath = join(stagingDir, `extra-${tag}.${extra.format}`)
    process.stderr.write(`[voice-runtime] fetching extra ${tag} (${(extra.size / 1024 / 1024).toFixed(0)} MB) ...\n`)
    await downloadFile(extra.url, archivePath, {
      onProgress: onProgress ? (p) => onProgress({ phase: 'extra', ...p }) : null,
    })
    if (!extra.sha256) throw new Error(`[voice-runtime] manifest extra entry missing required sha256: ${extra.url}`)
    await verifySha256(archivePath, extra.sha256)

    const extractDir = join(stagingDir, `.extra-${tag}`)
    mkdirSync(extractDir, { recursive: true })
    extractZip(archivePath, extractDir)

    for (const f of extra.files) {
      const src = join(extractDir, f.from)
      const dst = join(stagingDir, f.to)
      if (!existsSync(src)) {
        throw new Error(`[voice-runtime] extra ${tag}: expected file ${f.from} not present after extract`)
      }
      mkdirSync(dirname(dst), { recursive: true })
      renameWithRetrySync(src, dst)
    }

    // Reclaim disk space — only the lifted files are kept.
    try { rmSync(extractDir, { recursive: true, force: true }) } catch {}
    try { rmSync(archivePath, { force: true }) } catch {}
  }
}

function gcStaleVersions(rootDir, activeName, prefix) {
  if (!existsSync(rootDir)) return
  for (const entry of readdirSync(rootDir)) {
    if (entry === activeName || entry === 'active-version' || entry === 'manifest.json') continue
    if (!entry.startsWith(prefix) && !entry.startsWith('staging-')) continue
    try { rmSync(join(rootDir, entry), { recursive: true, force: true }) } catch {}
  }
}

async function extractGz(gzPath, destPath) {
  await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(destPath))
}

// Sweep .staging-* partials left by killed/crashed install attempts.
function gcStagingPartials(dir) {
  if (!existsSync(dir)) return
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith('.staging-')) continue
      try { rmSync(join(dir, entry), { force: true }) } catch {}
    }
  } catch {}
}

async function downloadFile(url, destPath, { onProgress = null, timeoutMs = 180_000 } = {}) {
  // Default 180s ceiling: voice runtime tarball (ffmpeg/whisper) is < 100MB.
  // Callers may raise timeoutMs (e.g. the ~1.5GB model). On any failure path
  // the destPath is unlinked so the next attempt does not see a corrupt
  // half-written archive.
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`[voice-runtime] download failed ${res.status} ${res.statusText} (${url})`)
    if (!res.body) throw new Error(`[voice-runtime] download has no body (${url})`)
    if (onProgress) {
      const total = Number(res.headers.get('content-length')) || 0
      let downloaded = 0
      let lastEmit = 0
      const emit = (force = false) => {
        const now = Date.now()
        if (!force && now - lastEmit < 200) return
        lastEmit = now
        onProgress({ downloaded, total })
      }
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          downloaded += chunk.length
          emit()
          if (total > 0 && downloaded >= total) emit(true)
          cb(null, chunk)
        },
        flush(cb) {
          emit(true)
          cb()
        },
      })
      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(destPath))
    } else {
      await pipeline(res.body, createWriteStream(destPath))
    }
  } catch (e) {
    try { rmSync(destPath, { force: true }) } catch {}
    throw e
  }
}

// Cross-OS zip extraction. Windows 10+ and macOS ship bsdtar (handles zip via
// libarchive); Linux ships GNU tar which does NOT understand zip, so it uses
// the unzip command (preinstalled on every distro we support, apt-get on
// Ubuntu / dnf on Fedora). Platform decision is a single switch — no fallback
// chain, no probing.
function extractZip(zipPath, destDir) {
  // Windows: bundled tar.exe (libarchive) misreads `C:` drive letter as
  // host:path and tries DNS resolution. Use PowerShell Expand-Archive,
  // which is Windows-native and path-safe.
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe', windowsHide: true })
    if (r.status !== 0) {
      throw new Error(`[voice-runtime] zip extract failed via Expand-Archive: ${r.stderr?.toString() || r.stdout?.toString() || 'unknown'}`)
    }
    return
  }
  const onLinux = process.platform === 'linux'
  const cmd = onLinux ? 'unzip' : 'tar'
  const args = onLinux ? ['-q', '-o', zipPath, '-d', destDir] : ['-xf', zipPath, '-C', destDir]
  const r = spawnSync(cmd, args, { stdio: 'pipe', windowsHide: true })
  if (r.status !== 0) {
    const err = r.stderr?.toString() || r.stdout?.toString() || `status=${r.status}`
    throw new Error(`[voice-runtime] zip extract failed via ${cmd}: ${err}`)
  }
}

export async function ensureWhisperRuntime(dataDir, onProgress = null) {
  const manifest = await loadManifest(dataDir)
  const key = platformKey()
  const platformEntry = manifest.platforms?.[key]
  if (!platformEntry) {
    throw new Error(`[voice-runtime] no manifest entry for ${key} — disable voice in mixdog-config.json or add a manifest entry for this platform`)
  }

  const variants = platformEntry.variants
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error(`[voice-runtime] manifest for ${key} has no variants array`)
  }

  const env = {
    cudaMajors: detectCudaMajors(),
    hasNvidiaDriver: hasNvidiaDriver(),
  }
  const variant = pickVariant(variants, env)
  if (!variant) {
    throw new Error(`[voice-runtime] no variant matched on ${key} (cuda=${[...env.cudaMajors].join(',') || 'none'} nvidiaDriver=${env.hasNvidiaDriver}) and no requires:null fallback in manifest`)
  }

  const ver = manifest.version
  const rootDir = join(dataDir, 'voice-runtime')
  const activeName = `whisper-${ver}-${variant.id}`
  const activeDir = join(rootDir, activeName)
  const whisperCmd = join(activeDir, variant.executable)

  if (existsSync(whisperCmd)) {
    gcStaleVersions(rootDir, activeName, 'whisper-')
    return { whisperCmd, version: ver, variantId: variant.id }
  }

  return _withInstallLock(rootDir, 'install', async () => {
    if (existsSync(whisperCmd)) {
      gcStaleVersions(rootDir, activeName, 'whisper-')
      return { whisperCmd, version: ver, variantId: variant.id }
    }
    gcStagingPartials(rootDir)
    const stagingDir = join(rootDir, `staging-${process.pid}-${Date.now()}`)
    mkdirSync(stagingDir, { recursive: true })
    try {
      const archivePath = join(stagingDir, `whisper.${variant.format}`)
      process.stderr.write(`[voice-runtime] fetching whisper-${ver} variant=${variant.id} for ${key} (${(variant.size / 1024 / 1024).toFixed(0)} MB; cuda=${[...env.cudaMajors].join(',') || 'none'} nvidiaDriver=${env.hasNvidiaDriver}) ...\n`)
      await downloadFile(variant.url, archivePath, {
        onProgress: onProgress ? (p) => onProgress({ phase: 'runtime', ...p }) : null,
      })
      if (!variant.sha256) throw new Error(`[voice-runtime] manifest variant ${variant.id} for ${key} missing required sha256`)
      await verifySha256(archivePath, variant.sha256)
      extractZip(archivePath, stagingDir)
      rmSync(archivePath, { force: true })
      const stagedExec = join(stagingDir, variant.executable)
      if (!existsSync(stagedExec)) {
        throw new Error(`[voice-runtime] expected executable ${variant.executable} not present after extract`)
      }
      // Process extras (e.g. NVIDIA cublas wheel) so the bundled runtime is
      // self-contained — user does not need a separate CUDA Toolkit install.
      await processExtras(variant.extras, stagingDir, onProgress)
      // Bytes on disk first; publish ready flag only after rename completes.
      renameWithRetrySync(stagingDir, activeDir)
      writeFileAtomicSync(join(rootDir, 'active-version'), activeName, { fsyncDir: true })
      process.stderr.write(`[voice-runtime] whisper-${ver} variant=${variant.id} ready at ${activeDir}\n`)
      gcStaleVersions(rootDir, activeName, 'whisper-')
      return { whisperCmd, version: ver, variantId: variant.id }
    } catch (err) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
      throw err
    }
  })
}

// Read-only resolver: returns the cached binary path when the managed runtime
// is fully installed, null otherwise. Used by the transcribe hot path and the
// /cli-check endpoint to test installation state without triggering a fetch.
export function resolveManagedWhisperCmd(dataDir) {
  const activeFile = join(dataDir, 'voice-runtime', 'active-version')
  if (!existsSync(activeFile)) return null
  const activeName = readFileSync(activeFile, 'utf8').trim()
  if (!activeName) return null
  const activeDir = join(dataDir, 'voice-runtime', activeName)
  // Consult the bundled manifest for the platform/variant executable path
  // instead of hard-coding two layout guesses. The active-version name is
  // `whisper-<version>-<variantId>`, so we look up the matching variant and
  // use its declared `executable`. Falls through to the legacy guesses only
  // when the manifest is unreadable.
  if (existsSync(BUNDLED_MANIFEST_PATH)) {
    try {
      const manifest = JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'))
      const key = platformKey()
      const variants = manifest.platforms?.[key]?.variants
      if (Array.isArray(variants)) {
        const prefix = `whisper-${manifest.version}-`
        const variantId = activeName.startsWith(prefix) ? activeName.slice(prefix.length) : ''
        const variant = variants.find(v => v.id === variantId)
        if (variant?.executable) {
          const p = join(activeDir, variant.executable)
          if (existsSync(p)) return p
        }
      }
    } catch {}
  }
  for (const c of ['Release/whisper-cli.exe', 'Release/whisper-cli']) {
    const p = join(activeDir, c)
    if (existsSync(p)) return p
  }
  return null
}

// Read-only resolver matching the managed model layout. The bundled manifest
// path is read synchronously because this runs on the per-message hot path
// and an async fetch would add latency to every voice transcribe.
export function resolveManagedWhisperModel(dataDir) {
  if (!existsSync(BUNDLED_MANIFEST_PATH)) return null
  const manifest = JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'))
  if (!manifest.model?.filename) return null
  const p = join(dataDir, 'voice', 'models', manifest.model.filename)
  return existsSync(p) ? p : null
}

// Single managed ffmpeg binary used by transcribe (ogg→wav). Layout mirrors
// whisper-runtime: one binary per OS×arch fetched once, sha256-verified, atomic
// stage→rename, GC of stale ffmpeg-* dirs. Source binaries are gz-compressed
// raw executables on the eugeneware/ffmpeg-static GitHub releases — no archive
// extraction. The package is never bundled into the marketplace cache; the
// manifest only carries url + sha256 + size + executable name.
export async function ensureFfmpegRuntime(dataDir, onProgress = null) {
  const manifest = await loadManifest(dataDir)
  if (!manifest.ffmpeg) {
    throw new Error('[voice-runtime] manifest is missing the `ffmpeg` section — cannot resolve ffmpeg runtime')
  }
  const key = platformKey()
  const platformEntry = manifest.ffmpeg.platforms?.[key]
  if (!platformEntry) {
    throw new Error(`[voice-runtime] no ffmpeg manifest entry for ${key} — disable voice in mixdog-config.json or add a manifest entry for this platform`)
  }

  const ver = manifest.ffmpeg.version
  const rootDir = join(dataDir, 'ffmpeg-runtime')
  const activeName = `ffmpeg-${ver}`
  const activeDir = join(rootDir, activeName)
  const ffmpegPath = join(activeDir, platformEntry.executable)

  if (existsSync(ffmpegPath)) {
    gcStaleVersions(rootDir, activeName, 'ffmpeg-')
    return { ffmpegPath, version: ver }
  }

  return _withInstallLock(rootDir, 'install', async () => {
    if (existsSync(ffmpegPath)) {
      gcStaleVersions(rootDir, activeName, 'ffmpeg-')
      return { ffmpegPath, version: ver }
    }
    gcStagingPartials(rootDir)
    const stagingDir = join(rootDir, `staging-${process.pid}-${Date.now()}`)
    mkdirSync(stagingDir, { recursive: true })
    try {
      const archivePath = join(stagingDir, `ffmpeg.${platformEntry.format}`)
      process.stderr.write(`[voice-runtime] fetching ffmpeg-${ver} for ${key} (${(platformEntry.size / 1024 / 1024).toFixed(0)} MB) ...\n`)
      await downloadFile(platformEntry.url, archivePath, {
        onProgress: onProgress ? (p) => onProgress({ phase: 'ffmpeg', ...p }) : null,
      })
      if (!platformEntry.sha256) throw new Error(`[voice-runtime] manifest ffmpeg entry for ${key} missing required sha256`)
      await verifySha256(archivePath, platformEntry.sha256)
      const stagedExec = join(stagingDir, platformEntry.executable)
      if (platformEntry.format === 'gz') {
        await extractGz(archivePath, stagedExec)
      } else if (platformEntry.format === 'zip') {
        extractZip(archivePath, stagingDir)
      } else {
        throw new Error(`[voice-runtime] ffmpeg manifest format must be "gz" or "zip", got "${platformEntry.format}"`)
      }
      rmSync(archivePath, { force: true })
      if (!existsSync(stagedExec)) {
        throw new Error(`[voice-runtime] expected ffmpeg executable ${platformEntry.executable} not present after extract`)
      }
      if (process.platform !== 'win32') {
        chmodSync(stagedExec, 0o755)
      }
      // Bytes on disk first; publish ready flag only after rename completes.
      renameWithRetrySync(stagingDir, activeDir)
      writeFileAtomicSync(join(rootDir, 'active-version'), activeName, { fsyncDir: true })
      process.stderr.write(`[voice-runtime] ffmpeg-${ver} ready at ${activeDir}\n`)
      gcStaleVersions(rootDir, activeName, 'ffmpeg-')
      return { ffmpegPath, version: ver }
    } catch (err) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
      throw err
    }
  })
}

export function resolveManagedFfmpegPath(dataDir) {
  const activeFile = join(dataDir, 'ffmpeg-runtime', 'active-version')
  if (!existsSync(activeFile)) return null
  const activeName = readFileSync(activeFile, 'utf8').trim()
  if (!activeName) return null
  const activeDir = join(dataDir, 'ffmpeg-runtime', activeName)
  // Consult the bundled manifest for the platform's declared executable
  // instead of hard-coding two layout guesses. Falls through to legacy
  // guesses only when the manifest is unreadable.
  if (existsSync(BUNDLED_MANIFEST_PATH)) {
    try {
      const manifest = JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'))
      const key = platformKey()
      const platformEntry = manifest.ffmpeg?.platforms?.[key]
      if (platformEntry?.executable) {
        const p = join(activeDir, platformEntry.executable)
        if (existsSync(p)) return p
      }
    } catch {}
  }
  for (const c of ['ffmpeg.exe', 'ffmpeg']) {
    const p = join(activeDir, c)
    if (existsSync(p)) return p
  }
  return null
}

export function resolveVoiceRuntime(dataDir) {
  const managedWhisperCmd = resolveManagedWhisperCmd(dataDir)
  const managedModelPath = resolveManagedWhisperModel(dataDir)
  const managedFfmpegPath = resolveManagedFfmpegPath(dataDir)
  const ext = process.platform === 'win32' ? '.exe' : ''
  const managedServerCmd = managedWhisperCmd
    ? join(dirname(managedWhisperCmd), `whisper-server${ext}`)
    : null
  const serverCmd = managedServerCmd && existsSync(managedServerCmd) ? managedServerCmd : null
  return {
    kind: 'managed-whisper.cpp',
    label: 'whisper.cpp',
    installed: !!(managedWhisperCmd && serverCmd && managedModelPath && managedFfmpegPath),
    binary: !!managedWhisperCmd,
    model: !!managedModelPath,
    ffmpeg: !!managedFfmpegPath,
    whisperCmd: managedWhisperCmd,
    serverCmd,
    modelPath: managedModelPath,
    modelName: managedModelPath ? 'ggml-large-v3-turbo.bin' : '',
    ffmpegPath: managedFfmpegPath,
  }
}

// Single managed location for the whisper model weight file. Idempotent: if
// the resolved file exists and matches the manifest sha256, return without
// re-downloading. Atomic install via stage-then-rename so a partial download
// on a kill/crash never leaves the model dir holding a corrupted .bin.
export async function ensureWhisperModel(dataDir, onProgress = null) {
  const manifest = await loadManifest(dataDir)
  const model = manifest.model
  if (!model) {
    throw new Error('[voice-runtime] manifest is missing the `model` section — cannot resolve whisper model')
  }

  const modelDir = join(dataDir, 'voice', 'models')
  const modelPath = join(modelDir, model.filename)

  if (existsSync(modelPath)) {
    const actual = await sha256File(modelPath)
    if (actual === model.sha256) {
      return { modelPath, modelId: model.id, size: model.size }
    }
    process.stderr.write(`[voice-runtime] model ${model.filename} sha256 mismatch (expected ${model.sha256}, got ${actual}) — re-fetching\n`)
    try { rmSync(modelPath, { force: true }) } catch {}
  }

  return _withInstallLock(modelDir, 'install', async () => {
    if (existsSync(modelPath)) {
      const actual = await sha256File(modelPath)
      if (actual === model.sha256) return { modelPath, modelId: model.id, size: model.size }
      try { rmSync(modelPath, { force: true }) } catch {}
    }
    gcStagingPartials(modelDir)
    const stagingPath = join(modelDir, `.staging-${process.pid}-${Date.now()}-${model.filename}`)
    try {
      process.stderr.write(`[voice-runtime] fetching model ${model.id} (${(model.size / 1024 / 1024).toFixed(0)} MB) from ${model.url} ...\n`)
      await downloadFile(model.url, stagingPath, {
        onProgress: onProgress ? (p) => onProgress({ phase: 'model', ...p }) : null,
        timeoutMs: 1_200_000,
      })
      await verifySha256(stagingPath, model.sha256)
      renameWithRetrySync(stagingPath, modelPath)
      process.stderr.write(`[voice-runtime] model ${model.id} ready at ${modelPath}\n`)
      return { modelPath, modelId: model.id, size: model.size }
    } catch (err) {
      try { rmSync(stagingPath, { force: true }) } catch {}
      throw err
    }
  })
}
