const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

import { cleanMemoryText } from './memory.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import {
  flushEmbeddingDirty, inferChunkProjectId,
} from './memory-embed.mjs'
import { markCycleRequest, consumeCycleRequests, resolveCoalesceMaxDrains, scheduleCoalescedCycleRetry, makeCycleRequestSignature, resolveCoalesceMaxRetries } from './memory-cycle-requests.mjs'

const VALID_CATEGORIES = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])
const CYCLE1_OMITTED_RETRY_LIMIT = 2
const CYCLE1_OMITTED_COOLDOWN_MS = 60 * 60 * 1000

// Structural validation only. Conceptual omission belongs to the LLM; code
// should not encode language-specific phrases such as acknowledgements.
function _isStructurallyInvalidSummary(text) {
  if (!text || typeof text !== 'string') return true
  const t = text.trim()
  if (!t) return true
  if (!/[\p{L}\p{N}]/u.test(t)) return true
  return false
}

function _isStructurallyUnchunkableInput(row) {
  const raw = cleanMemoryText(String(row?.content ?? '')).trim()
  if (!raw) return true
  return !/[\p{L}\p{N}]/u.test(raw)
}

async function markTerminalRows(db, rowIds, label = 'terminal') {
  const ids = [...new Set((Array.isArray(rowIds) ? rowIds : [])
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0))]
  if (ids.length === 0) return { attempted: 0, marked: 0, failed: 0 }
  try {
    const result = await db.query(
      `UPDATE entries
       SET chunk_root = id,
           is_root = 0,
           status = 'archived',
           reviewed_at = COALESCE(reviewed_at, $2)
       WHERE id = ANY($1::bigint[])
         AND chunk_root IS NULL
         AND is_root = 0`,
      [ids, Date.now()],
    )
    const marked = Number(result?.rowCount ?? 0)
    return { attempted: ids.length, marked, failed: Math.max(0, ids.length - marked) }
  } catch (err) {
    __mixdogMemoryLog(`[cycle1] ${label} sentinel update failed: ${err.message}\n`)
    return { attempted: ids.length, marked: 0, failed: ids.length }
  }
}

async function markOmittedRows(db, rowIds) {
  const ids = [...new Set((Array.isArray(rowIds) ? rowIds : [])
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0))]
  if (ids.length === 0) return { attempted: 0, deferred: 0, marked: 0, failed: 0 }
  try {
    const result = await db.query(
      `WITH candidates AS (
         SELECT id, COALESCE(error_count, 0) + 1 AS next_error_count
         FROM entries
         WHERE id = ANY($1::bigint[])
           AND chunk_root IS NULL
           AND is_root = 0
       )
       UPDATE entries e
       SET reviewed_at = $2,
           error_count = c.next_error_count,
           chunk_root = CASE WHEN c.next_error_count >= $3 THEN e.id ELSE e.chunk_root END,
           status = CASE WHEN c.next_error_count >= $3 THEN 'archived'::entry_status ELSE e.status END
       FROM candidates c
       WHERE e.id = c.id
       RETURNING e.id, (c.next_error_count >= $3) AS marked_terminal`,
      [ids, Date.now(), CYCLE1_OMITTED_RETRY_LIMIT],
    )
    const rows = Array.isArray(result?.rows) ? result.rows : []
    const marked = rows.filter(r => r.marked_terminal === true).length
    const deferred = rows.length - marked
    return { attempted: ids.length, deferred, marked, failed: Math.max(0, ids.length - rows.length) }
  } catch (err) {
    __mixdogMemoryLog(`[cycle1] omitted retry update failed: ${err.message}\n`)
    return { attempted: ids.length, deferred: 0, marked: 0, failed: ids.length }
  }
}

function selectRootId(members) {
  let rootId = null
  let rootTs = null
  for (const m of members) {
    const ts = Number(m.ts)
    const id = Number(m.id)
    if (!Number.isFinite(ts) || !Number.isFinite(id)) continue
    if (rootId === null || ts < rootTs || (ts === rootTs && id < rootId)) {
      rootId = id
      rootTs = ts
    }
  }
  return rootId
}

export function buildEntriesText(entries) {
  // @N is a 1-based prompt-local index; cycle1-agent answers with @N indexes.
  return entries.map((e, i) => {
    const content = cleanMemoryText(String(e.content ?? '')).slice(0, 400)
    const sess = e.session_id ? String(e.session_id).slice(0, 8) : 'null----'
    return `@${i + 1} ts:${e.ts} role:${e.role} [sess:${sess}] content:${content}`
  }).join('\n')
}

// Balanced quality rules: the model decides conceptual memory value; code only
// validates line grammar and membership.
const DEFAULT_CYCLE1_RULES = [
  `Chunk these entries. Emit one chunk per line, NO JSON, NO tool calls, NO prose.`,
  `Format: idx_csv|element|category|summary.`,
  `Every substantive @N should appear in exactly one chunk; omit entries with no standalone memory value.`,
  `Group by coherent topic, keep cause and resolution together, and never merge across [sess:] markers.`,
  `Category must be one of rule / constraint / decision / fact / goal / preference / task / issue; choose the one that best preserves future recall intent.`,
  `Keep summary compact and source-grounded; preserve decisive identifiers, constraints, causes, and outcomes when present.`,
  `First character of your response must be a digit. Use bare @N indexes without @ in output.`,
]

export function buildCycle1ChunkPrompt(rows, customRules = null) {
  const rules = Array.isArray(customRules) && customRules.length > 0
    ? customRules
    : DEFAULT_CYCLE1_RULES
  return [...rules, '', buildEntriesText(rows)].join('\n')
}

export function parseCycle1LineFormat(raw) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return null
  const lines = text.split('\n')
  const chunks = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('//') || line.startsWith('#')) continue
    if (line.startsWith('```')) continue
    const parts = line.split('|')
    if (parts.length < 4) continue
    const idxField = parts[0].trim()
    const idxList = idxField.split(',')
      .map(s => Number(String(s).replace(/^@/, '').trim()))
      .filter(n => Number.isFinite(n) && n > 0)
    if (idxList.length === 0) continue
    chunks.push({
      _idxList: idxList,
      element: parts[1].trim(),
      category: parts[2].trim(),
      summary: parts.slice(3).join('|').trim(),
    })
  }
  return chunks.length > 0 ? { chunks } : null
}

// Partition by session_id; MIN_BATCH gates total pending rows, SESSION_CAP bounds per-tick session fan-out.
const CYCLE1_MIN_BATCH = 3
const CYCLE1_SESSION_CAP = 10

// Per-db SKIP gate — concurrent callers coalesce into a DB-backed dirty bit;
// the lock holder drains it after the current run instead of making them wait.
const _runCycle1InFlight = new WeakMap()
const _lastCycle1LogAt = new Map()

export function getInFlightCycle1(db) {
  return _runCycle1InFlight.get(db) || null
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

function logCycle1Throttled(key, message, intervalMs = 60_000) {
  const now = Date.now()
  const last = _lastCycle1LogAt.get(key) || 0
  if (now - last < intervalMs) return
  _lastCycle1LogAt.set(key, now)
  __mixdogMemoryLog(message)
}

// Tiny inline semaphore — bounds cycle1 window fan-out.
function createSemaphore(limit) {
  const cap = Math.max(1, Number(limit) || 1)
  let active = 0
  const queue = []
  const release = () => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }
  return async (fn) => {
    if (active >= cap) await new Promise(res => queue.push(res))
    active += 1
    try { return await fn() }
    finally { release() }
  }
}

async function countPendingRows(db) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE chunk_root IS NULL
         AND NULLIF(btrim(session_id), '') IS NOT NULL
         AND (reviewed_at IS NULL OR reviewed_at < $1)`,
      [Date.now() - CYCLE1_OMITTED_COOLDOWN_MS],
    )
    return Number(result.rows[0]?.c ?? 0)
  } catch {
    return null
  }
}

function uniqueNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(v => Number(v))
    .filter(v => Number.isFinite(v)))]
}

function mergeCycle1Results(a, b) {
  if (!a) return b
  if (!b) return a
  const sum = (key) => Number(a?.[key] || 0) + Number(b?.[key] || 0)
  const qualityKeys = [...new Set([
    ...Object.keys(a?.quality || {}),
    ...Object.keys(b?.quality || {}),
  ])]
  const quality = {}
  for (const key of qualityKeys) {
    quality[key] = Number(a?.quality?.[key] || 0) + Number(b?.quality?.[key] || 0)
  }
  return {
    ...b,
    processed: sum('processed'),
    chunks: sum('chunks'),
    skipped: sum('skipped'),
    sessions: sum('sessions'),
    skippedInFlight: false,
    pendingRows: b.pendingRows ?? a.pendingRows,
    failed_row_ids: uniqueNumbers([...(a.failed_row_ids || []), ...(b.failed_row_ids || [])]),
    omitted_row_ids: uniqueNumbers([...(a.omitted_row_ids || []), ...(b.omitted_row_ids || [])]),
    prefiltered_row_ids: uniqueNumbers([...(a.prefiltered_row_ids || []), ...(b.prefiltered_row_ids || [])]),
    invalid_chunks: [...(a.invalid_chunks || []), ...(b.invalid_chunks || [])],
    quality,
  }
}

export async function runCycle1(db, config = {}, options = {}, dataDir = null) {
  const signal = options?.signal
  throwIfAborted(signal)
  const coalescedRetry = options?.coalescedRetry === true
  const retryAttempt = Math.max(0, Number(options?.coalescedRetryAttempt || 0))
  const maxRetries = resolveCoalesceMaxRetries(config, 3)
  const requestSignature = makeCycleRequestSignature('cycle1', config, {
    preset: options?.preset,
    concurrency: options?.concurrency,
    maxConcurrent: options?.maxConcurrent,
  })
  const scheduleRetry = () => scheduleCoalescedCycleRetry(
    db,
    'cycle1',
    () => runCycle1(db, config, { ...options, signal: undefined, coalescedRetry: true, coalescedRetryAttempt: retryAttempt + 1 }, dataDir),
    config,
    requestSignature,
  )
  if (_runCycle1InFlight.has(db)) {
    if (!coalescedRetry) await markCycleRequest(db, 'cycle1', 'in-flight', requestSignature)
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
    logCycle1Throttled('in-flight', '[cycle1] skipped: already in flight for this db\n')
    return {
      processed: 0, chunks: 0, skipped: 0, sessions: 0,
      skippedInFlight: true,
      pendingRows: await countPendingRows(db),
    }
  }
  const client = await db._pool.connect()
  let gotLock = false
  try {
    throwIfAborted(signal)
    const r = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, ['mixdog.cycle1'])
    gotLock = r.rows[0]?.got === true
  } catch (err) {
    client.release()
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle1] advisory lock query failed: ${err.message}\n`)
    if (!coalescedRetry) await markCycleRequest(db, 'cycle1', 'lock-error', requestSignature)
    return { processed: 0, chunks: 0, skipped: 0, sessions: 0, skippedInFlight: true, pendingRows: await countPendingRows(db) }
  }
  if (!gotLock) {
    client.release()
    if (!coalescedRetry) await markCycleRequest(db, 'cycle1', 'advisory-lock', requestSignature)
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
    logCycle1Throttled('advisory-lock', '[cycle1] skipped: advisory lock held by another worker\n')
    return { processed: 0, chunks: 0, skipped: 0, sessions: 0, skippedInFlight: true, pendingRows: await countPendingRows(db) }
  }
  const p = (async () => {
    try {
      let result = null
      let coalescedRuns = 0
      let coalescedRequests = 0
      if (coalescedRetry) {
        const pending = await consumeCycleRequests(db, 'cycle1', requestSignature)
        if (pending <= 0) {
          return { processed: 0, chunks: 0, skipped: 0, sessions: 0, skippedInFlight: false, pendingRows: await countPendingRows(db), coalescedRetryNoop: true }
        }
        coalescedRuns += 1
        coalescedRequests += pending
        __mixdogMemoryLog(`[cycle1] retrying coalesced requests=${pending}\n`)
      }
      try {
        result = await _runCycle1Impl(db, config, options, dataDir)
      } catch (err) {
        if (coalescedRetry) {
          await markCycleRequest(db, 'cycle1', 'retry-error', requestSignature)
          if (retryAttempt < maxRetries) scheduleRetry()
        }
        throw err
      }
      const maxDrains = resolveCoalesceMaxDrains(config, 1)
      let drainLoops = 0
      while (drainLoops < maxDrains) {
        throwIfAborted(signal)
        const pending = await consumeCycleRequests(db, 'cycle1', requestSignature)
        if (pending <= 0) break
        drainLoops += 1
        coalescedRuns += 1
        coalescedRequests += pending
        __mixdogMemoryLog(`[cycle1] draining coalesced requests=${pending}\n`)
        try {
          const next = await _runCycle1Impl(db, config, options, dataDir)
          result = mergeCycle1Results(result, next)
        } catch (err) {
          await markCycleRequest(db, 'cycle1', 'drain-error', requestSignature)
          if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
          throw err
        }
      }
      if (coalescedRuns > 0) {
        result = { ...result, coalescedRuns, coalescedRequests }
      }
      if (coalescedRetry && !result?.coalescedRetryNoop && typeof options?.onCoalescedSuccess === 'function') {
        try { await options.onCoalescedSuccess(result) }
        catch (err) { __mixdogMemoryLog(`[cycle1] coalesced success callback failed: ${err?.message || err}\n`) }
      }
      return result
    } finally {
      let releaseErr = null
      try {
        const r = await client.query(`SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`, ['mixdog.cycle1'])
        if (r.rows[0]?.unlocked !== true) releaseErr = new Error('cycle1 advisory unlock returned false')
      } catch (err) {
        releaseErr = err
      }
      client.release(releaseErr || undefined)
    }
  })()
  _runCycle1InFlight.set(db, p)
  try {
    return await p
  } finally {
    _runCycle1InFlight.delete(db)
  }
}

async function _runCycle1Impl(db, config = {}, options = {}, _dataDir = null) {
  const signal = options?.signal
  throwIfAborted(signal)
  const pendingRowsAtStart = await countPendingRows(db)
  throwIfAborted(signal)
  const batchSize = Math.max(1, Number(config.batch_size ?? 100))
  const windowSize = Math.max(1, Number(config.window_size ?? config.windowSize ?? batchSize))
  const rowsPerSession = Math.max(windowSize, Number(
    config.rows_per_session
      ?? config.rowsPerSession
      ?? config.max_rows_per_session
      ?? config.maxRowsPerSession
      ?? batchSize,
  ) || batchSize)
  // Fallback chain handles flat config + nested cycle1 wrap shapes.
  const minBatch = Math.max(1, Number(config?.min_batch ?? config?.cycle1?.min_batch ?? CYCLE1_MIN_BATCH))
  const sessionCap = Math.max(1, Number(config?.session_cap ?? config?.cycle1?.session_cap ?? CYCLE1_SESSION_CAP))
  const onlySessionId = String(config.session_id ?? config.sessionId ?? '').trim()
  const sessionFilterSql = onlySessionId ? 'AND session_id = $4' : ''
  const queryParams = [sessionCap, Date.now() - CYCLE1_OMITTED_COOLDOWN_MS, rowsPerSession]
  if (onlySessionId) queryParams.push(onlySessionId)
  const preset = options.preset || resolveMaintenancePreset('memory')
  // Inner LLM timeout aligns to caller deadline -1s so the channel side can ack gracefully.
  const callerDeadlineMs = Number(options.callerDeadlineMs ?? 0)
  const baseTimeout = Number(config?.timeout ?? config?.cycle1?.timeout ?? 180000)
  const timeout = callerDeadlineMs > 0
    ? Math.min(baseTimeout, Math.max(5000, callerDeadlineMs - 1000))
    : baseTimeout
  // Select closest/recent sessions first, then fetch closest/recent rows per
  // selected session. Memory fill is recency-first; session isolation below
  // keeps unrelated episodes out of the same classifier prompt.
  const fetchResult = await db.query(
    `WITH selected_sessions AS (
       SELECT session_id, MAX(ts) AS latest_ts, MAX(id) AS latest_id
       FROM entries
       WHERE chunk_root IS NULL
         AND NULLIF(btrim(session_id), '') IS NOT NULL
         AND (reviewed_at IS NULL OR reviewed_at < $2)
         ${sessionFilterSql}
       GROUP BY session_id
       ORDER BY latest_ts DESC, latest_id DESC
       LIMIT $1
     ), ranked AS (
       SELECT e.id, e.ts, e.role, e.content, e.session_id, e.source_ref, e.project_id,
              s.latest_ts, s.latest_id,
              ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.ts DESC, e.id DESC) AS rn
       FROM entries e
       JOIN selected_sessions s ON s.session_id = e.session_id
       WHERE e.chunk_root IS NULL
         AND (e.reviewed_at IS NULL OR e.reviewed_at < $2)
     )
     SELECT id, ts, role, content, session_id, source_ref, project_id
     FROM ranked
     WHERE rn <= $3
     ORDER BY latest_ts DESC, latest_id DESC, session_id, ts DESC, id DESC`,
    queryParams,
  )
  throwIfAborted(signal)
  const rowsDesc = fetchResult.rows

  if (Number.isFinite(pendingRowsAtStart) && pendingRowsAtStart < minBatch) {
    throwIfAborted(signal)
    flushEmbeddingDirty(db, { signal }).catch((err) =>
      __mixdogMemoryLog(`[cycle1] quick-exit embedding flush failed: ${err.message}\n`)
    )
    return {
      processed: 0, chunks: 0, skipped: 0, sessions: 0,
      skippedInFlight: false,
      pendingRows: pendingRowsAtStart,
      failed_row_ids: [], omitted_row_ids: [], invalid_chunks: [],
      quality: {
        rows_considered: 0,
        committed_members: 0,
        skipped_chunks: 0,
        omitted_rows: 0,
        failed_rows: 0,
        invalid_chunks: 0,
      },
      embedding_dirty: { deferred: true, attempted: 0, succeeded: 0, failed: 0, failed_ids: [] },
    }
  }

  // Window by session first, then by batch size inside that session. This makes
  // the classifier input structurally correct instead of relying on prompt text
  // to prevent cross-session merges. Rows within each session are converted back
  // to chronological order for the classifier prompt.
  const selectedSessions = new Set()
  const rowsBySession = new Map()
  for (const row of rowsDesc) {
    throwIfAborted(signal)
    const sid = String(row.session_id || '')
    if (!sid) continue
    if (!rowsBySession.has(sid)) {
      if (selectedSessions.size >= sessionCap) continue
      selectedSessions.add(sid)
      rowsBySession.set(sid, [])
    }
    rowsBySession.get(sid).push(row)
  }
  const windows = []
  for (const sessionRowsDesc of rowsBySession.values()) {
    const rowsAsc = sessionRowsDesc.slice().reverse()
    for (let offset = 0; offset < rowsAsc.length; offset += windowSize) {
      throwIfAborted(signal)
      windows.push(rowsAsc.slice(offset, offset + windowSize))
    }
  }

  async function processWindow(rows, windowIdx) {
    throwIfAborted(signal)
    if (rows.length === 0) {
      return {
        committedChunks: 0, committedMembers: 0, skippedChunks: 0, rowsConsidered: 0,
        invalidChunks: [], failedRowIds: [], omittedRowIds: [],
      }
    }

    const originalRows = rows
    const prefilteredRowIds = []
    let prefilterMarked = 0
    let prefilterMarkFailed = 0
    rows = originalRows.filter((row) => {
      if (!_isStructurallyUnchunkableInput(row)) return true
      prefilteredRowIds.push(Number(row.id))
      return false
    })
    if (prefilteredRowIds.length > 0) {
      const mark = await markTerminalRows(db, prefilteredRowIds, 'prefilter')
      prefilterMarked = mark.marked
      prefilterMarkFailed = mark.failed
    }
    if (rows.length === 0) {
      return {
        committedChunks: 0, committedMembers: 0, skippedChunks: 0, rowsConsidered: originalRows.length,
        invalidChunks: [], failedRowIds: [], omittedRowIds: prefilteredRowIds,
        prefilteredRowIds, prefilterMarked, prefilterMarkFailed,
      }
    }

    const userMessage = buildCycle1ChunkPrompt(rows)
    const llmCall = typeof options?.callLlm === 'function' ? options.callLlm : callAgentDispatch

    let raw
    const _tLlm = Date.now()
    try {
      raw = await llmCall({
        role: 'cycle1-agent',
        taskType: 'maintenance',
        mode: 'cycle1',
        preset,
        timeout,
        // Pin cwd to null so every memory cycle call hits the same agent cache shard.
        cwd: null,
      }, userMessage)
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[cycle1] LLM error (window=${windowIdx}): ${err.message}\n`)
      return {
        committedChunks: 0, committedMembers: 0, skippedChunks: rows.length, rowsConsidered: originalRows.length,
        invalidChunks: [{ reason: 'llm_error', member_ids: rows.map(r => Number(r.id)) }],
        failedRowIds: rows.map(r => Number(r.id)),
        omittedRowIds: prefilteredRowIds,
        prefilteredRowIds,
        prefilterMarked,
        prefilterMarkFailed,
      }
    }
    throwIfAborted(signal)
    __mixdogMemoryLog(`[cycle1-time] window=${windowIdx} llmMs=${Date.now() - _tLlm}\n`)

    const parsed = parseCycle1LineFormat(raw)
    const chunkList = Array.isArray(parsed?.chunks) ? parsed.chunks : null
    if (!chunkList) {
      __mixdogMemoryLog(`[cycle1] unparseable response (window=${windowIdx}) (${String(raw).slice(0, 200)})\n`)
      return {
        committedChunks: 0, committedMembers: 0, skippedChunks: rows.length, rowsConsidered: originalRows.length,
        invalidChunks: [{ reason: 'unparseable_response', member_ids: rows.map(r => Number(r.id)) }],
        failedRowIds: rows.map(r => Number(r.id)),
        omittedRowIds: prefilteredRowIds,
        prefilteredRowIds,
        prefilterMarked,
        prefilterMarkFailed,
      }
    }

    const entryByIdx = new Map(rows.map((r, i) => [i + 1, r]))
    const entryById = new Map(rows.map(r => [Number(r.id), r]))
    const usedIds = new Set()
    const committedRowIds = new Set()
    let committedChunks = 0
    let committedMembers = 0
    let skippedChunks = 0
    const invalidChunks = []
    const failedRowIds = []
    const referencedRowIds = new Set()

    for (const chunk of chunkList) {
      throwIfAborted(signal)
      // Out-of-range @N from the LLM = corrupt grouping. Reject the whole
      // chunk rather than silently committing the survivors; otherwise a
      // line like `1,999|...` would commit only @1 and drop @999.
      const idxList = chunk._idxList.map(n => Number(n))
      const outOfRange = idxList.filter(n => !entryByIdx.has(n))
      if (outOfRange.length > 0) {
        invalidChunks.push({ reason: 'out_of_range_idx', idx_list: idxList })
        skippedChunks += 1
        __mixdogMemoryLog(
          `[cycle1] chunk rejected: out_of_range_idx idx_list=${JSON.stringify(idxList)}\n`,
        )
        continue
      }
      const rawIds = idxList.map(n => Number(entryByIdx.get(n).id))
      for (const id of rawIds) {
        if (Number.isFinite(id)) referencedRowIds.add(id)
      }
      const dupeWithin = rawIds.length !== new Set(rawIds).size
      const externalIds = rawIds.filter(n => !Number.isFinite(n) || !entryById.has(n))
      const reusedIds = rawIds.filter(n => usedIds.has(n))
      const memberIds = rawIds.filter(n => Number.isFinite(n) && entryById.has(n) && !usedIds.has(n))
      const element = String(chunk?.element ?? '').trim()
      const category = String(chunk?.category ?? '').trim().toLowerCase()
      const summary = String(chunk?.summary ?? '').trim()

      if (dupeWithin || externalIds.length > 0 || reusedIds.length > 0) {
        const reason = dupeWithin ? 'duplicate_member_ids'
          : externalIds.length > 0 ? 'external_member_ids'
          : 'reused_member_ids'
        invalidChunks.push({ reason, member_ids: rawIds })
        skippedChunks += 1
        __mixdogMemoryLog(
          `[cycle1] chunk rejected: ${reason} member_ids=${JSON.stringify(rawIds)}\n`,
        )
        continue
      }

      if (memberIds.length === 0 || !element || !summary || !VALID_CATEGORIES.has(category)) {
        invalidChunks.push({ reason: 'incomplete_fields', member_ids: rawIds })
        skippedChunks += 1
        continue
      }

      if (_isStructurallyInvalidSummary(summary)) {
        __mixdogMemoryLog(`[cycle1] noise filtered: ${summary.slice(0, 60)}\n`)
        invalidChunks.push({ reason: 'noise_filtered', member_ids: rawIds })
        skippedChunks += 1
        continue
      }

      const members = memberIds.map(id => entryById.get(id))
      const rootId = selectRootId(members)
      if (rootId === null) {
        invalidChunks.push({ reason: 'no_root_id', member_ids: memberIds })
        skippedChunks += 1
        continue
      }

      const projectId = inferChunkProjectId(members)

      try {
        // A chunk commit is one DB transaction; do not split it with an
        // abort checkpoint. Cancellation is honored before the next chunk.
        await db.transaction(async (tx) => {
          // category on root only; recall filters member leaves via parent root.
          await tx.query(
            `UPDATE entries
             SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
                 status = 'pending', project_id = $5,
                 last_seen_at = $7
             WHERE id = $6`,
            [rootId, element, category, summary, projectId, rootId, Date.now()],
          )
          const nonRootIds = memberIds.filter(mid => mid !== rootId)
          if (nonRootIds.length > 0) {
            await tx.query(
              `UPDATE entries SET chunk_root = $1, project_id = $2 WHERE id = ANY($3::bigint[])`,
              [rootId, projectId, nonRootIds],
            )
          }
        })
        committedChunks += 1
        committedMembers += memberIds.length
        for (const mid of memberIds) {
          usedIds.add(mid)
          committedRowIds.add(mid)
        }
      } catch (err) {
        __mixdogMemoryLog(`[cycle1] chunk commit failed (root=${rootId}): ${err.message}\n`)
        skippedChunks += 1
        for (const mid of memberIds) failedRowIds.push(mid)
      }
    }

    throwIfAborted(signal)

    const llmOmittedRowIds = rows
      .map(r => Number(r.id))
      .filter(id => !committedRowIds.has(id) && !failedRowIds.includes(id) && !referencedRowIds.has(id))
    const omittedMark = await markOmittedRows(db, llmOmittedRowIds)
    const omittedRowIds = llmOmittedRowIds.concat(prefilteredRowIds)

    __mixdogMemoryLog(
      `[cycle1] window=${windowIdx} entries=${originalRows.length} prompt_entries=${rows.length} chunks=${committedChunks}` +
      ` members=${committedMembers} skipped_chunks=${skippedChunks}` +
      ` omitted=${omittedRowIds.length} prefiltered=${prefilteredRowIds.length}` +
      ` prefilter_marked=${prefilterMarked} prefilter_mark_failed=${prefilterMarkFailed}` +
      ` omitted_deferred=${omittedMark.deferred} omitted_marked=${omittedMark.marked}` +
      ` omitted_mark_failed=${omittedMark.failed}` +
      ` failed_rows=${failedRowIds.length}` +
      ` invalid_chunks=${invalidChunks.length}\n`,
    )

    return {
      committedChunks, committedMembers, skippedChunks,
      rowsConsidered: originalRows.length,
      invalidChunks, failedRowIds, omittedRowIds, prefilteredRowIds,
      prefilterMarked, prefilterMarkFailed,
      omittedMarked: omittedMark.marked,
      omittedDeferred: omittedMark.deferred,
      omittedMarkFailed: omittedMark.failed,
    }
  }

  // Cap fan-out concurrency so a large batch (or a manual run) doesn't fire all
  // window LLM calls at once and spike the provider / collide with the global
  // agent-IPC limit. Small batches (<= cap) still run fully parallel.
  const cycle1Concurrency = Math.max(1, Number(
    config.cycle1_concurrency ?? config.concurrency ?? options.concurrency ?? options.maxConcurrent ?? 4,
  ))
  const sem = createSemaphore(Math.min(Math.max(1, windows.length), cycle1Concurrency))
  const settled = await Promise.allSettled(
    windows.map((rows, idx) => sem(() => {
      throwIfAborted(signal)
      return processWindow(rows, idx)
    })),
  )
  const rejected = settled.find(r => r.status === 'rejected')
  if (rejected) throw rejected.reason
  const results = settled.map(r => r.value)
  throwIfAborted(signal)

  let totalChunks = 0
  let totalMembers = 0
  let totalSkipped = 0
  let totalRowsConsidered = 0
  const allInvalidChunks = []
  const allFailedRowIds = []
  const allOmittedRowIds = []
  const allPrefilteredRowIds = []
  let totalPrefilterMarked = 0
  let totalPrefilterMarkFailed = 0
  let totalOmittedMarked = 0
  let totalOmittedDeferred = 0
  let totalOmittedMarkFailed = 0
  for (const r of results) {
    totalChunks += r.committedChunks
    totalMembers += r.committedMembers
    totalSkipped += r.skippedChunks
    totalRowsConsidered += r.rowsConsidered
    if (Array.isArray(r.invalidChunks)) allInvalidChunks.push(...r.invalidChunks)
    if (Array.isArray(r.failedRowIds)) allFailedRowIds.push(...r.failedRowIds)
    if (Array.isArray(r.omittedRowIds)) allOmittedRowIds.push(...r.omittedRowIds)
    if (Array.isArray(r.prefilteredRowIds)) allPrefilteredRowIds.push(...r.prefilteredRowIds)
    totalPrefilterMarked += Number(r.prefilterMarked || 0)
    totalPrefilterMarkFailed += Number(r.prefilterMarkFailed || 0)
    totalOmittedMarked += Number(r.omittedMarked || 0)
    totalOmittedDeferred += Number(r.omittedDeferred || 0)
    totalOmittedMarkFailed += Number(r.omittedMarkFailed || 0)
  }

  __mixdogMemoryLog(
    `[cycle1] windows=${windows.length} rows=${totalRowsConsidered} chunks=${totalChunks}` +
    ` members=${totalMembers} skipped_chunks=${totalSkipped}` +
    ` omitted=${allOmittedRowIds.length} prefiltered=${allPrefilteredRowIds.length}` +
    ` prefilter_marked=${totalPrefilterMarked} prefilter_mark_failed=${totalPrefilterMarkFailed}` +
    ` omitted_deferred=${totalOmittedDeferred} omitted_marked=${totalOmittedMarked}` +
    ` omitted_mark_failed=${totalOmittedMarkFailed}` +
    ` failed_rows=${allFailedRowIds.length}` +
    ` invalid_chunks=${allInvalidChunks.length}\n`,
  )

  // Embedding is fire-and-forget; sidecar persist does not guarantee embedding completion.
  throwIfAborted(signal)
  flushEmbeddingDirty(db, { signal })
    .then((d) => {
      if (d.attempted > 0) {
        __mixdogMemoryLog(
          `[cycle1] embedding flush attempted=${d.attempted} ok=${d.succeeded} failed=${d.failed.length}\n`,
        )
      }
    })
    .catch((err) => __mixdogMemoryLog(`[cycle1] embedding flush failed: ${err.message}\n`))

  return {
    processed: totalMembers,
    chunks: totalChunks,
    skipped: totalSkipped,
    sessions: windows.length,
    skippedInFlight: false,
    pendingRows: pendingRowsAtStart,
    failed_row_ids: allFailedRowIds,
    omitted_row_ids: allOmittedRowIds,
    prefiltered_row_ids: allPrefilteredRowIds,
    invalid_chunks: allInvalidChunks,
    quality: {
      rows_considered: totalRowsConsidered,
      committed_members: totalMembers,
      skipped_chunks: totalSkipped,
      omitted_rows: allOmittedRowIds.length,
      prefiltered_rows: allPrefilteredRowIds.length,
      prefilter_marked_rows: totalPrefilterMarked,
      prefilter_mark_failed_rows: totalPrefilterMarkFailed,
      omitted_deferred_rows: totalOmittedDeferred,
      omitted_marked_rows: totalOmittedMarked,
      omitted_mark_failed_rows: totalOmittedMarkFailed,
      failed_rows: allFailedRowIds.length,
      invalid_chunks: allInvalidChunks.length,
    },
    embedding_dirty: { deferred: true, attempted: 0, succeeded: 0, failed: 0, failed_ids: [] },
  }
}
