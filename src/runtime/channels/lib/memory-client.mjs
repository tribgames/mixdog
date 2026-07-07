import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStandaloneMemoryRuntime } from '../../../standalone/memory-runtime-proxy.mjs'
import { readServicePort, markServiceUnreachable, isConnRefuseError } from '../../shared/service-discovery.mjs'

const RUNTIME_ROOT = process.env.MIXDOG_RUNTIME_ROOT
  ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
  : path.join(os.tmpdir(), 'mixdog')
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json')

let _portCache = null // { port, mtime, ts }

// Shared memory-runtime proxy handle for respawn. The channels worker is the
// one process that can find the daemon dead (no port / ECONNREFUSED) while a
// remote session is still alive. Rather than dead-lettering forever, it asks
// the SAME proxy the host uses (createStandaloneMemoryRuntime.start()) to
// re-ensure the singleton daemon. Owner-claim + fork logic is NOT duplicated
// here — start() reuses the on-disk singleton owner file, so a live daemon is
// reused and only a genuinely dead one is respawned.
const MEMORY_ENTRY = fileURLToPath(new URL('../../memory/index.mjs', import.meta.url))
const MEMORY_DATA_DIR = process.env.MIXDOG_DATA_DIR
  ? path.resolve(process.env.MIXDOG_DATA_DIR)
  : RUNTIME_ROOT
let _memoryProxy = null
let _ensuringDaemon = null
function getMemoryProxy() {
  if (!_memoryProxy) {
    _memoryProxy = createStandaloneMemoryRuntime({ entry: MEMORY_ENTRY, dataDir: MEMORY_DATA_DIR })
  }
  return _memoryProxy
}
// Ensure the daemon exists via the shared proxy. Reentrancy-guarded so a burst
// of failed appends/drains coalesces into a single start(). On success the
// port cache is invalidated so the next getMemoryPort() re-reads the freshly
// published active-instance.json. Never throws — callers keep buffering on
// failure, so a respawn miss degrades to the existing retry path, not a crash.
async function ensureMemoryDaemon() {
  if (_ensuringDaemon) return _ensuringDaemon
  _ensuringDaemon = (async () => {
    try {
      const res = await getMemoryProxy().start()
      _portCache = null
      return res?.port ?? null
    } catch (e) {
      process.stderr.write(`[memory-client] ensureMemoryDaemon failed (${e.message})\n`)
      return null
    } finally {
      _ensuringDaemon = null
    }
  })()
  return _ensuringDaemon
}

function isConnRefusedLike(err) {
  const code = String(err?.code || '')
  const msg = String(err?.message || err || '')
  return code === 'ECONNREFUSED'
    || /ECONNREFUSED|missing memory_port|memory-service timeout/i.test(msg)
}

// A discovery advert validates only the owner pid, which can be a recycled pid
// living on an unrelated process while its advertised port is dead. This client
// has no separate /health probe, so on a connect-level failure we distrust the
// port: mark it unreachable (readServicePort then skips it → legacy fallback)
// and drop the port cache so the next getMemoryPort re-resolves.
function _distrustMemoryPort(port, err) {
  // Connection-level failures ONLY. A 'memory-service timeout' means the daemon
  // is slow-but-alive — distrusting it would false-route to legacy/buffer.
  if (port && isConnRefuseError(err)) {
    markServiceUnreachable('memory', port)
    _portCache = null
  }
}

async function getMemoryPort() {
  const now = Date.now()
  if (_portCache && (now - _portCache.ts) < 5_000) return _portCache.port
  // Prefer the single-writer discovery advert (discovery/memory.json), which
  // validates the owner pid is alive. Fall back to the legacy
  // active-instance.json memory_port field for cross-version compat.
  const advertPort = readServicePort('memory', { requirePid: false })
  if (advertPort) { _portCache = { port: advertPort, mtime: 0, ts: now }; return advertPort }
  try {
    const stat = await fs.promises.stat(ACTIVE_INSTANCE_FILE)
    const mtime = stat.mtimeMs
    if (_portCache && _portCache.mtime === mtime) {
      _portCache.ts = now
      return _portCache.port
    }
    const raw = await fs.promises.readFile(ACTIVE_INSTANCE_FILE, 'utf8')
    const active = JSON.parse(raw)
    const port = Number(active && active.memory_port)
    if (!Number.isFinite(port) || port <= 0) return null
    _portCache = { port, mtime, ts: now }
    return port
  } catch {
    return null
  }
}

async function memoryFetch(method, endpoint, body = null, timeoutMs = 10_000, { throwOnError = false } = {}) {
  const port = await getMemoryPort()
  return new Promise((resolve, reject) => {
    if (!port) { reject(new Error('active-instance.json missing memory_port')); return }
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: timeoutMs,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        const status = res.statusCode || 0
        let parsed
        try { parsed = JSON.parse(data) }
        catch { parsed = { raw: data } }
        // Live callers keep lenient semantics (resolve on any response).
        // Drain replay passes throwOnError so a non-2xx status or an
        // {error} body is treated as a FAILED replay — the buffer file is
        // then kept for retry instead of being unlinked (data-loss guard).
        if (throwOnError && (status < 200 || status >= 300 || (parsed && parsed.error != null))) {
          const detail = parsed && parsed.error != null ? String(parsed.error) : `HTTP ${status}`
          reject(new Error(`memory replay rejected: ${detail}`))
          return
        }
        resolve(parsed)
      })
    })
    req.on('error', err => { _distrustMemoryPort(port, err); reject(err) })
    req.on('timeout', () => { req.destroy(); const err = new Error('memory-service timeout'); _distrustMemoryPort(port, err); reject(err) })
    if (payload) req.write(payload)
    req.end()
  })
}

const BUFFER_DIR = path.join(RUNTIME_ROOT, 'memory-buffer')
const DEAD_DIR = path.join(BUFFER_DIR, 'dead')
const MAX_DRAIN_ATTEMPTS = 5
const MAX_BUFFER_FILES = 500
let _draining = false

function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts
  }
  const parsed = Date.parse(String(ts ?? ''))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

export async function appendEntry(data) {
  const payload = {
    ts: normalizeTs(data.ts),
    role: String(data.role ?? 'user'),
    content: String(data.content ?? ''),
    sourceRef: String(data.sourceRef ?? `manual:${Date.now()}-${process.pid}`),
    sessionId: data.sessionId ?? null,
    cwd: data.cwd ?? null,
  }
  // Bounded fast attempt. On failure, buffer to disk immediately and let
  // the periodic drainer ship buffered entries when the service is back.
  // Caller is fire-and-forget (channels worker), so capping the tail at
  // ~3s prevents promises from lingering on minute-long timeouts.
  try {
    return await memoryFetch('POST', '/entry', payload, 3_000)
  } catch (e) {
    process.stderr.write(`[memory-client] appendEntry failed (${e.message}) — buffering\n`)
    // No-port / connection-refused means the daemon is likely dead. Ask the
    // shared proxy to re-ensure the singleton (reentrancy-guarded, non-throwing)
    // so buffered entries have a live target on the next periodic drain instead
    // of being retried against nothing until quarantine.
    if (isConnRefusedLike(e)) void ensureMemoryDaemon()
    const bufferPath = bufferToDisk('entry', payload)
    return bufferPath ? { ok: false, buffered: true, path: bufferPath } : { ok: false }
  }
}

export async function ingestTranscript(filePath, { cwd } = {}) {
  try {
    return await memoryFetch('POST', '/ingest-transcript', { filePath, ...(cwd ? { cwd } : {}) })
  } catch (e) {
    process.stderr.write(`[memory-client] ingestTranscript failed (${e.message}) — buffering\n`)
    // Dedupe by transcriptPath: replace any already-buffered ingest for the
    // same file so a re-ingest storm cannot fan out to N buffer files.
    const bufferPath = bufferToDisk('ingest', { filePath, ...(cwd ? { cwd } : {}) }, { dedupeKey: filePath })
    return bufferPath ? { ok: false, buffered: true, path: bufferPath } : { ok: false }
  }
}

// Persist a failed request so the drainer can replay it once the memory
// service publishes its port. `kind` selects the replay endpoint on drain.
// dedupeKey (ingest): if an existing kind-* file already carries the same
// key, overwrite it in place instead of writing a new file — one buffered
// ingest per transcriptPath. Enforces MAX_BUFFER_FILES (drop-oldest+warn).
// Atomic write: stage to a unique tmp file in the SAME dir, then rename over
// the target. rename() is atomic on a single filesystem, so a concurrent
// reader/drainer never observes a half-written buffer file.
function atomicWrite(targetPath, contents) {
  const tmp = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, contents)
  try { fs.renameSync(tmp, targetPath) }
  catch (e) { try { fs.unlinkSync(tmp) } catch {}; throw e }
}

// In-memory dedupeKey(filePath) -> absolute buffer path index. Replaces the
// per-event O(N) readdir+read+parse dedupe scan in bufferToDisk. Seeded once
// (lazily) from disk so cross-restart dedupe (one buffered ingest per
// transcriptPath) still holds; maintained incrementally on write. A stale
// entry (file drained/renamed) is caught by an existsSync guard at the call
// site, so no drain/replay format or TTL semantics change.
const _dedupeIndex = new Map()
let _dedupeIndexSeeded = false
function seedDedupeIndex(kind) {
  if (_dedupeIndexSeeded) return
  _dedupeIndexSeeded = true
  let existing = []
  try { existing = fs.readdirSync(BUFFER_DIR) } catch {}
  for (const name of existing) {
    if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(BUFFER_DIR, name), 'utf8'))
      if (prev && prev.filePath != null) _dedupeIndex.set(prev.filePath, path.join(BUFFER_DIR, name))
    } catch {}
  }
}

function bufferToDisk(kind, payload, { dedupeKey = null } = {}) {
  try {
    fs.mkdirSync(BUFFER_DIR, { recursive: true })
    if (dedupeKey != null) {
      // In-memory index (seeded once from disk) replaces the per-event O(N)
      // readdir+read+parse scan. Overwrite the existing buffered file for this
      // dedupeKey in place (atomic tmp+rename) to keep its oldest ordering slot.
      seedDedupeIndex(kind)
      const idx = _dedupeIndex.get(dedupeKey)
      if (idx && fs.existsSync(idx)) {
        atomicWrite(idx, JSON.stringify(payload, null, 2))
        return idx
      }
      if (idx) _dedupeIndex.delete(dedupeKey)
    }
    enforceBufferCap()
    const random = Math.random().toString(36).slice(2, 10)
    // Prefix carries the replay kind; timestamp prefix keeps oldest-first
    // ordering under a lexicographic sort.
    const bufferPath = path.join(BUFFER_DIR, `${kind}-${Date.now()}-${random}.json`)
    atomicWrite(bufferPath, JSON.stringify(payload, null, 2))
    if (dedupeKey != null) _dedupeIndex.set(dedupeKey, bufferPath)
    return bufferPath
  } catch (bufErr) {
    process.stderr.write(`[memory-client] Failed to buffer ${kind}: ${bufErr.message}\n`)
    return null
  }
}

// Move a buffer file to memory-buffer/dead/ (quarantine, never silent-drop).
// Returns true on success. On failure NEVER unlinks (no silent payload loss):
// leaves the file in place and returns false so the caller skips it this pass.
function moveToDead(name, reason) {
  process.stderr.write(`[memory-client] quarantining ${name} to dead/ (${reason})\n`)
  try {
    fs.mkdirSync(DEAD_DIR, { recursive: true })
    fs.renameSync(path.join(BUFFER_DIR, name), path.join(DEAD_DIR, name))
    return true
  } catch (e) {
    process.stderr.write(`[memory-client] quarantine of ${name} failed (${e.message}) — leaving in place\n`)
    return false
  }
}

// Cap the buffer directory: when at/over MAX_BUFFER_FILES, quarantine oldest
// files (lexicographic = ts-prefixed = oldest-first) to dead/ — never silently
// destroy data (MED: cap must preserve for triage, same as poison path).
function enforceBufferCap() {
  let files
  try {
    files = fs.readdirSync(BUFFER_DIR)
      .filter(f => (f.startsWith('entry-') || f.startsWith('ingest-')) && f.endsWith('.json'))
      .sort()
  } catch { return }
  let over = files.length - (MAX_BUFFER_FILES - 1)
  for (let i = 0; i < files.length && over > 0; i++, over--) {
    moveToDead(files[i], `buffer cap ${MAX_BUFFER_FILES} exceeded — oldest`)
  }
}

// Replay buffered entry-*/ingest-* files once the memory port is live.
// Oldest-first (filename carries a ms timestamp), dedupe-safe (each file is
// deleted only after a 2xx replay — memoryFetch(throwOnError) rejects on
// non-2xx/{error}, so a rejected replay keeps the file for retry, no data
// loss). Retry count is PERSISTED in the filename suffix (`.rN`) so process
// restarts don't reset the poison cap; after MAX_DRAIN_ATTEMPTS the file is
// MOVED to memory-buffer/dead/ (not deleted, not left blocking the queue).
// Reentrancy-guarded.
//
// Attempt count lives in the name: `<kind>-<ts>-<rnd>.json` (attempt 0) or
// `<kind>-<ts>-<rnd>.rN.json` (N prior failures). Parsed/rewritten via rename.
function parseRetry(name) {
  const m = name.match(/\.r(\d+)\.json$/)
  return m ? Number(m[1]) : 0
}
function retryName(name, n) {
  const base = name.replace(/\.r\d+\.json$/, '.json').replace(/\.json$/, '')
  return `${base}.r${n}.json`
}
export async function drainBuffer() {
  if (_draining) return { ok: true, skipped: 'in-progress' }
  const port = await getMemoryPort()
  if (!port) {
    // No published port: the daemon is down while buffered work is waiting.
    // Respawn it via the shared proxy (reused singleton — no fork dup) and
    // let the next tick drain against the freshly published port.
    void ensureMemoryDaemon()
    return { ok: false, reason: 'no-port' }
  }
  _draining = true
  let drained = 0
  let failed = 0
  // Files that could not be advanced this pass (rename lock/EPERM). Skipped so
  // an un-rewritable file can't wedge the oldest-first queue forever; retried
  // on the next drain (their on-disk .rN is unchanged, so the cap still holds).
  const skipThisPass = new Set()
  try {
    let files
    try {
      files = fs.readdirSync(BUFFER_DIR)
    } catch { return { ok: true, drained: 0 } }
    files = files
      .filter(f => (f.startsWith('entry-') || f.startsWith('ingest-')) && f.endsWith('.json'))
      .sort() // ts-prefixed name => oldest-first
    for (const name of files) {
      if (skipThisPass.has(name)) continue
      const bufferPath = path.join(BUFFER_DIR, name)
      let payload
      try {
        payload = JSON.parse(fs.readFileSync(bufferPath, 'utf8'))
      } catch {
        // Unparseable/corrupt buffer file — a partial write may be in flight,
        // or it may be genuinely corrupt. Do NOT unlink (silent data loss):
        // quarantine to dead/ for triage and move on. If the quarantine move
        // itself fails, skip it for this pass so it can't block oldest-first.
        if (!moveToDead(name, 'unparseable buffer file')) skipThisPass.add(name)
        continue
      }
      const endpoint = name.startsWith('ingest-') ? '/ingest-transcript' : '/entry'
      try {
        // throwOnError: non-2xx status or an {error} body REJECTS, so the
        // file is kept/aged for retry instead of unlinked (HIGH: data loss).
        await memoryFetch('POST', endpoint, payload, 10_000, { throwOnError: true })
        try { fs.unlinkSync(bufferPath) } catch {}
        drained++
      } catch (e) {
        const attempts = parseRetry(name) + 1
        failed++
        // Connection-refused mid-drain: the daemon died between the port read
        // and this POST. Re-ensure it via the shared proxy so the next tick
        // has a live target (the file is aged/kept below, never dropped here).
        if (isConnRefusedLike(e)) void ensureMemoryDaemon()
        if (attempts >= MAX_DRAIN_ATTEMPTS) {
          // Quarantine, don't drop: move to dead/ so a poison record neither
          // wedges the queue nor silently vanishes (recoverable for triage).
          moveToDead(name, `${attempts} failed replays: ${e.message}`)
        } else {
          // Persist the incremented attempt count in the filename so a
          // restart resumes the poison cap instead of resetting it. If the
          // rename fails (EPERM/lock), leave the file as-is but skip it for
          // THIS pass so it can't block the oldest-first queue forever — the
          // next drain re-reads its (unchanged) .rN and retries.
          try {
            fs.renameSync(bufferPath, path.join(BUFFER_DIR, retryName(name, attempts)))
          } catch {
            // Rename lock/EPERM: don't break the whole pass on a file we
            // couldn't even age — skip it and CONTINUE so later buffered
            // files still drain. (Strict oldest-first yields to progress
            // ONLY in this rename-failure case; a normal replay failure
            // below still breaks, since the service is likely down.)
            skipThisPass.add(name)
            continue
          }
        }
        // Stop the pass on first failure: the service is likely still down,
        // so hammering the rest wastes timeouts. Next drain retries in order.
        break
      }
    }
  } finally {
    _draining = false
  }
  return { ok: failed === 0, drained, failed }
}

