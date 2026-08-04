// Transcript ingest cluster, extracted from index.mjs (pass 2).
//
// Owns: transcript offset load/persist, JSONL tail ingestion, cwd extraction,
// timestamp coercion, and the cross-platform transcript watcher. Everything
// that touched module-level state in index.mjs (db handle, mainConfig-derived
// data dir, the _transcriptOffsets / _ingestTranscriptTails maps, the persist
// tail promise) is now closed over inside createTranscriptIngest via injected
// accessors, so index.mjs keeps ownership of the live db/config lifecycle and
// this module stays a pure factory with no import-time side effects.
import fs from 'node:fs'
import path from 'node:path'
import { normalizeIngestRole, sessionMessageContentForIngest, shouldExcludeIngestMessage } from './session-ingest.mjs'

// Pure: coerce a transcript timestamp (seconds, ms, or ISO string) to ms.
export function parseTsToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

// Pure: extract cwd from the transcript file's JSONL rows. Mixdog embeds the
// session cwd as a top-level `cwd` field on every message row, so scanning the
// first few lines is reliable on all platforms without slug-decoding ambiguity.
// Returns undefined when no cwd is found or the extracted path does not exist
// on disk (falls back to COMMON).
export function cwdFromTranscriptPath(fp) {
  let fd
  try {
    fd = fs.openSync(fp, 'r')
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 100 * 1024))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    fd = undefined
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (typeof obj.cwd === 'string' && obj.cwd) {
          const candidate = obj.cwd
          try { if (fs.statSync(candidate).isDirectory()) return candidate } catch {}
        }
      } catch {}
    }
  } catch {} finally {
    if (fd != null) { try { fs.closeSync(fd) } catch {} }
  }
  return undefined
}

// Factory. All live-state coupling is injected:
//   getDb()            -> current pg-shim db handle (or null pre-init)
//   loadMeta()         -> Promise<string> raw transcript-offsets meta value
//   persistMeta(json)  -> Promise<void> writes serialized offsets to meta
//   projectsRoot()     -> string, mixdogHome()/projects
//   resolveProjectId(cwd) -> project id | null
//   firstTextContent / cleanMemoryText -> shared ingest text helpers
//   log(msg)           -> stderr logger
//
// Returns the same surface index.mjs previously exposed as module functions,
// plus resetOffsets() for stop()'s teardown.
export function createTranscriptIngest({
  getDb,
  loadMeta,
  persistMeta,
  projectsRoot,
  resolveProjectId,
  firstTextContent,
  cleanMemoryText,
  log = () => {},
}) {
  let _transcriptOffsets = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const _ingestTranscriptTails = new Map()
  let _transcriptOffsetsPersistTail = Promise.resolve()

  async function loadTranscriptOffsets() {
    try {
      const raw = await loadMeta()
      const obj = JSON.parse(raw)
      _transcriptOffsets = new Map(Object.entries(obj))
    } catch {
      _transcriptOffsets = new Map()
    }
  }

  async function persistTranscriptOffsets() {
    const run = _transcriptOffsetsPersistTail.catch(() => {}).then(async () => {
      try {
        const obj = Object.fromEntries(_transcriptOffsets)
        await persistMeta(JSON.stringify(obj))
      } catch (e) {
        log(`[memory] persist transcript offsets failed: ${e.message}\n`)
      }
    })
    _transcriptOffsetsPersistTail = run.catch(() => {})
    return run
  }

  function runTranscriptIngestSerialized(transcriptPath, fn) {
    const key = path.resolve(transcriptPath)
    const prev = _ingestTranscriptTails.get(key) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    _ingestTranscriptTails.set(key, run.catch(() => {}))
    return run
  }

  function snapshotTranscriptOffset(transcriptPath) {
    const stored = _transcriptOffsets.get(transcriptPath)
    if (!stored) return { bytes: 0, lineIndex: 0, generation: 0 }
    return { bytes: Number(stored.bytes) || 0, lineIndex: Number(stored.lineIndex) || 0, generation: Number(stored.generation) || 0 }
  }

  async function ingestTranscriptFileImpl(transcriptPath, { cwd } = {}) {
    const db = getDb()
    let stat
    try { stat = await fs.promises.stat(transcriptPath) } catch { return 0 }
    const sessionUuid = path.basename(transcriptPath, '.jsonl')
    const prev = snapshotTranscriptOffset(transcriptPath)
    // Generation counter: a truncate/rewrite of the transcript (size shrank
    // below the persisted byte offset) resets bytes/lineIndex to 0, so the
    // rewritten lines reuse the SAME transcript:${uuid}#${index} refs as the
    // pre-truncate content. With ON CONFLICT DO NOTHING the rewritten rows were
    // silently dropped. Bump a persisted per-file generation on each detected
    // reset and fold it into source_ref so rewritten lines get fresh identities
    // and persist. Existing rows (gen 0, no suffix) are unaffected.
    let generation = Number(prev.generation) || 0
    if (stat.size < prev.bytes) {
      prev.bytes = 0
      prev.lineIndex = 0
      generation += 1
    }
    if (stat.size <= prev.bytes) return 0

    const fh = await fs.promises.open(transcriptPath, 'r')
    const buf = Buffer.alloc(stat.size - prev.bytes)
    try {
      await fh.read(buf, 0, buf.length, prev.bytes)
    } finally {
      await fh.close()
    }
    const text = buf.toString('utf8')

    const resolvedCwd = typeof cwd === 'string' && cwd ? cwd : cwdFromTranscriptPath(transcriptPath)
    // No cwd resolved -> classify as COMMON (project_id NULL). Falling back to
    // process.cwd() would misclassify rows under the service/plugin cwd.
    const projectId = resolvedCwd ? resolveProjectId(resolvedCwd) : null

    let count = 0
    let index = prev.lineIndex
    // Track the byte boundary of the LAST line we fully consumed (parsed +
    // either inserted or intentionally skipped). On parse failure or
    // transient insert error we stop and leave the boundary untouched so the
    // next sweep retries from the same position. This prevents malformed
    // trailing JSONL (mid-write partial lines) and DB hiccups from being
    // silently consumed forever.
    let lastGoodBytes = prev.bytes
    let lastGoodLineIndex = prev.lineIndex
    let cursor = 0
    while (cursor < text.length) {
      const nl = text.indexOf('\n', cursor)
      // No trailing newline -> partial line still being written; stop here
      // without advancing so the rest is re-read once the writer flushes.
      if (nl === -1) break
      const rawLine = text.slice(cursor, nl)
      const consumedBytes = Buffer.byteLength(rawLine, 'utf8') + 1
      cursor = nl + 1
      const line = rawLine.replace(/\r$/, '')
      if (!line) {
        lastGoodBytes += consumedBytes
        continue
      }
      index += 1
      let parsed
      try { parsed = JSON.parse(line) } catch {
        // Malformed line: do not advance past it; retry on next sweep.
        index -= 1
        break
      }
      // Transcript lines carry the role either as message.role (legacy) or
      // as the top-level `type` field ({"type":"assistant","message":{...}}
      // — the current session-runtime writer). Reading only message.role
      // silently skipped EVERY line of current-format transcripts, so the
      // background watcher ingested 0 rows forever.
      const role = parsed.message?.role
        ?? ((parsed.type === 'user' || parsed.type === 'assistant') ? parsed.type : undefined)
      if (role !== 'user' && role !== 'assistant') {
        lastGoodBytes += consumedBytes
        lastGoodLineIndex = index
        continue
      }
      // Reuse the ingest_session shape/exclude predicates so the transcript
      // watcher stores ONLY pure conversation rows — same purity as
      // ingest_session (strips manager.mjs prefix envelopes, drops synthetic
      // reference-files/compaction/ack/internal-notification rows).
      const shaped = { role, content: parsed.message?.content }
      if (shouldExcludeIngestMessage(shaped)) {
        lastGoodBytes += consumedBytes
        lastGoodLineIndex = index
        continue
      }
      const content = sessionMessageContentForIngest(shaped)
      if (!content || !content.trim()) {
        lastGoodBytes += consumedBytes
        lastGoodLineIndex = index
        continue
      }
      const cleaned = cleanMemoryText(content)
      if (!cleaned) {
        lastGoodBytes += consumedBytes
        lastGoodLineIndex = index
        continue
      }
      const tsMs = parseTsToMs(parsed.timestamp ?? parsed.ts ?? Date.now())
      const sourceRef = generation > 0
        ? `transcript:${sessionUuid}#${index}@g${generation}`
        : `transcript:${sessionUuid}#${index}`
      try {
        const result = await db.query(
          `INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [tsMs, role, cleaned, sourceRef, sessionUuid, index, projectId]
        )
        if (Number(result.rowCount ?? result.affectedRows ?? 0) > 0) count += 1
        lastGoodBytes += consumedBytes
        lastGoodLineIndex = index
      } catch (e) {
        log(`[transcript-watch] insert error (${sourceRef}): ${e.message}\n`)
        // Transient insert failure: leave the boundary before this line so
        // the next sweep retries it. Roll back the line counter too.
        index -= 1
        break
      }
    }
    _transcriptOffsets.set(transcriptPath, {
      bytes: lastGoodBytes,
      lineIndex: lastGoodLineIndex,
      generation,
    })
    await persistTranscriptOffsets()
    return count
  }

  async function ingestTranscriptFile(transcriptPath, options = {}) {
    return runTranscriptIngestSerialized(transcriptPath, () => ingestTranscriptFileImpl(transcriptPath, options))
  }

  function getOffset(fp) {
    return _transcriptOffsets.get(fp)
  }

  function resetOffsets() {
    _transcriptOffsets = new Map()
  }

  function initTranscriptWatcher() {
    const root = projectsRoot()
    const SAFETY_POLL_MS = 5 * 60_000
    const DEBOUNCE_MS = 500
    const watchedFiles = new Map()
    const pendingByFile = new Map()
    const watchers = []
    const intervals = []
    const polledFiles = new Set()
    let safetySweepTimeout = null

    function isWatchable(relOrBase) {
      const base = path.basename(relOrBase)
      if (!base.endsWith('.jsonl') || base.startsWith('agent-')) return false
      if (relOrBase.includes('tmp') || relOrBase.includes('cache') || relOrBase.includes('plugins')) return false
      return true
    }

    async function ingestOne(fp) {
      try {
        if (!fs.existsSync(fp)) return
        const stat = fs.statSync(fp)
        const mtime = stat.mtimeMs
        const prev = watchedFiles.get(fp)
        if (prev && prev >= mtime) return
        const n = await ingestTranscriptFile(fp, { cwd: cwdFromTranscriptPath(fp) })
        // Only mark this mtime as 'consumed' once the persisted offset has
        // fully advanced past the observed file size. On a transient insert
        // error (or a malformed trailing line) ingestTranscriptFile leaves
        // the persisted offset before the failed line for retry; caching
        // the new mtime unconditionally would suppress the next sweep until
        // the file mutated again, losing the retry. Leave the cache
        // untouched on partial advance so the next sweep re-ingests.
        const off = _transcriptOffsets.get(fp)
        if (off && off.bytes >= stat.size) {
          watchedFiles.set(fp, mtime)
        }
        if (n > 0) {
          log(`[transcript-watch] ingested ${n} entries from ${path.basename(fp)}\n`)
        }
      } catch (e) {
        log(`[transcript-watch] ingest error: ${e.message}\n`)
      }
    }

    function scheduleIngest(fp) {
      const existing = pendingByFile.get(fp)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        pendingByFile.delete(fp)
        ingestOne(fp)
      }, DEBOUNCE_MS)
      pendingByFile.set(fp, timer)
    }

    async function discoverActiveTranscripts() {
      let topLevel
      try { topLevel = await fs.promises.readdir(root) }
      catch { return [] }
      const files = []
      for (const d of topLevel) {
        if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
        const full = path.join(root, d)
        let inner
        try { inner = await fs.promises.readdir(full) } catch { continue }
        for (const f of inner) {
          if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
          const fp = path.join(full, f)
          try {
            const stat = await fs.promises.stat(fp)
            files.push({ path: fp, mtime: stat.mtimeMs })
          } catch {}
        }
      }
      const cutoff = Date.now() - 30 * 60_000
      return files.filter(f => f.mtime > cutoff)
    }

    async function safetySweep() {
      try {
        const active = await discoverActiveTranscripts()
        for (const { path: fp } of active) ingestOne(fp)
      } catch (e) {
        log(`[transcript-watch] safety sweep error: ${e.message}\n`)
      }
    }

    safetySweepTimeout = setTimeout(safetySweep, 3_000)

    // fs.watch({recursive}) is only reliable on win32.
    // darwin: recursive option unreliable — use flat watch per-entry (glob dirs at start).
    // linux/WSL: recursive not supported — use fs.watchFile polling per file found via
    //   the safety sweep, or fall back entirely to safety sweep.
    if (process.platform === 'win32') {
      try {
        const watcher = fs.watch(root, { recursive: true, persistent: true }, (_event, filename) => {
          if (!filename) return
          if (!isWatchable(filename)) return
          const fp = path.join(root, filename)
          scheduleIngest(fp)
        })
        watcher.on('error', (err) => {
          log(`[transcript-watch] fs.watch error: ${err.message}\n`)
        })
        watchers.push(watcher)
        log(`[transcript-watch] fs.watch(recursive) active on ${root}\n`)
      } catch (e) {
        log(`[transcript-watch] fs.watch setup failed: ${e.message} — relying on safety sweep only\n`)
      }
      intervals.push(setInterval(safetySweep, SAFETY_POLL_MS))
    } else if (process.platform === 'darwin') {
      // Flat watch: register a non-recursive watcher on each immediate subdirectory.
      // New subdirs are picked up on the next safety sweep cycle.
      try {
        const registerFlat = (dir) => {
          try {
            const w = fs.watch(dir, { persistent: true }, (_event, filename) => {
              if (!filename) return
              const fp = path.join(dir, filename)
              if (!isWatchable(fp)) return
              scheduleIngest(fp)
            })
            w.on('error', () => { /* ignore individual dir errors */ })
            watchers.push(w)
          } catch { /* dir may not exist yet */ }
        }
        registerFlat(root)
        try {
          for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isDirectory()) registerFlat(path.join(root, entry.name))
          }
        } catch { /* best effort */ }
        log(`[transcript-watch] flat fs.watch active on ${root} (darwin)\n`)
      } catch (e) {
        log(`[transcript-watch] flat watch setup failed: ${e.message} — relying on safety sweep only\n`)
      }
      intervals.push(setInterval(safetySweep, SAFETY_POLL_MS))
    } else {
      // linux/WSL: fs.watch recursive is unsupported. Use fs.watchFile polling for
      // individual files surfaced by the safety sweep, in addition to the sweep itself.
      log(`[transcript-watch] linux/WSL — using safety sweep + fs.watchFile polling (no recursive watch)\n`)
      // Wrap by reassigning the closure-captured reference is not possible here;
      // instead, register watchFile inside the safety sweep callback by intercepting
      // active file list after each sweep.  The interval already calls safetySweep
      // which calls ingestOne; watchFile additions happen as a side-effect of the sweep.
      const _patchedSweep = async () => {
        try {
          const active = await discoverActiveTranscripts()
          for (const { path: fp } of active) {
            if (!polledFiles.has(fp)) {
              polledFiles.add(fp)
              fs.watchFile(fp, { persistent: false, interval: 2000 }, () => {
                if (isWatchable(fp)) scheduleIngest(fp)
              })
            }
            ingestOne(fp)
          }
        } catch (e) {
          log(`[transcript-watch] linux sweep error: ${e.message}\n`)
        }
      }
      // Replace the safety sweep interval with the patched version.
      intervals.push(setInterval(_patchedSweep, SAFETY_POLL_MS))
    }

    return {
      stop() {
        if (safetySweepTimeout) { clearTimeout(safetySweepTimeout); safetySweepTimeout = null }
        for (const t of pendingByFile.values()) { try { clearTimeout(t) } catch {} }
        pendingByFile.clear()
        for (const i of intervals) { try { clearInterval(i) } catch {} }
        intervals.length = 0
        for (const w of watchers) { try { w.close() } catch {} }
        watchers.length = 0
        for (const fp of polledFiles) { try { fs.unwatchFile(fp) } catch {} }
        polledFiles.clear()
      },
    }
  }

  return {
    loadTranscriptOffsets,
    persistTranscriptOffsets,
    ingestTranscriptFile,
    cwdFromTranscriptPath,
    parseTsToMs,
    initTranscriptWatcher,
    getOffset,
    resetOffsets,
  }
}
