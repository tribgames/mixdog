import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getStandaloneMemoryRuntime } from '../../../standalone/memory-runtime-proxy.mjs'
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../../shared/runtime-root.mjs'

const RUNTIME_ROOT = resolveRuntimeRoot()
let _memoryRuntimePromise = null
const MEMORY_ENTRY = fileURLToPath(new URL('../../memory/index.mjs', import.meta.url))

async function memoryRuntime() {
  _memoryRuntimePromise ??= Promise.resolve(getStandaloneMemoryRuntime({
    entry: MEMORY_ENTRY,
    dataDir: process.env.MIXDOG_DATA_DIR,
  }))
  try {
    const runtime = await _memoryRuntimePromise
    await runtime.init()
    return runtime
  } catch (error) {
    _memoryRuntimePromise = null
    throw error
  }
}

async function replayBuffered(kind, payload) {
  const module = await memoryRuntime()
  const result = kind === 'ingest'
    ? await module.ingestTranscript(payload.filePath, { cwd: payload.cwd })
    : await module.appendEntry(payload)
  if (result?.error) throw new Error(`memory replay rejected: ${result.error}`)
  return result
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
  // the periodic drainer retry after the in-process runtime recovers.
  try {
    const module = await memoryRuntime()
    return await module.appendEntry(payload)
  } catch (e) {
    process.stderr.write(`[memory-client] appendEntry failed (${e.message}) — buffering\n`)
    const bufferPath = bufferToDisk('entry', payload)
    return bufferPath ? { ok: false, buffered: true, path: bufferPath } : { ok: false }
  }
}

export async function ingestTranscript(filePath, { cwd } = {}) {
  try {
    const module = await memoryRuntime()
    return await module.ingestTranscript(filePath, { cwd })
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
function dropDedupeIndexForPath(bufferPath) {
  for (const [key, indexedPath] of _dedupeIndex) {
    if (indexedPath === bufferPath) _dedupeIndex.delete(key)
  }
}
function replaceDedupeIndexPath(previousPath, nextPath) {
  for (const [key, indexedPath] of _dedupeIndex) {
    if (indexedPath === previousPath) _dedupeIndex.set(key, nextPath)
  }
}
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
    ensurePrivateRuntimeRoot(RUNTIME_ROOT)
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
  const bufferPath = path.join(BUFFER_DIR, name)
  try {
    fs.mkdirSync(DEAD_DIR, { recursive: true })
    fs.renameSync(bufferPath, path.join(DEAD_DIR, name))
    dropDedupeIndexForPath(bufferPath)
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
// deleted only after a successful in-process replay; a rejected replay keeps
// the file for retry, so no data
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
  try { await memoryRuntime() }
  catch (error) { return { ok: false, reason: error?.message || 'memory runtime unavailable' } }
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
      const kind = name.startsWith('ingest-') ? 'ingest' : 'entry'
      try {
        await replayBuffered(kind, payload)
        try {
          fs.unlinkSync(bufferPath)
          dropDedupeIndexForPath(bufferPath)
        } catch {}
        drained++
      } catch (e) {
        const attempts = parseRetry(name) + 1
        failed++
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
            const nextPath = path.join(BUFFER_DIR, retryName(name, attempts))
            fs.renameSync(bufferPath, nextPath)
            replaceDedupeIndexPath(bufferPath, nextPath)
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
