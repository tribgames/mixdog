import { __mixdogMemoryLog } from './memory-log.mjs';
import { createSemaphore, throwIfAborted } from './memory-cycle2-shared.mjs';

import {
  CYCLE1_INPUT_TOKEN_BUDGET, assessChunkQuality, cycle1SourceBudget, generateCycle1Chunks, partitionCycle1Rows,
} from './memory-chunk-quality.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import {
  flushEmbeddingDirty, inferChunkProjectId, syncRootEmbedding,
} from './memory-embed.mjs'
import { markCycleRequest, consumeCycleRequests, resolveCoalesceMaxDrains, scheduleCoalescedCycleRetry, makeCycleRequestSignature, resolveCoalesceMaxRetries } from './memory-cycle-requests.mjs'

const CYCLE1_OMITTED_COOLDOWN_MS = 60 * 60 * 1000

function _isStructurallyUnchunkableInput(row) {
  return !String(row?.content ?? '').trim()
}

function positiveEntryIds(rowIds) {
  return uniqueNumbers(rowIds).filter(id => id > 0)
}

async function markTerminalRows(db, rowIds, label = 'terminal') {
  const ids = positiveEntryIds(rowIds)
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
  const ids = positiveEntryIds(rowIds)
  if (ids.length === 0) return { attempted: 0, deferred: 0, marked: 0, failed: 0 }
  try {
    const result = await db.query(
      `UPDATE entries
       SET reviewed_at = $2,
           error_count = COALESCE(error_count, 0) + 1
       WHERE id = ANY($1::bigint[])
         AND chunk_root IS NULL
         AND is_root = 0
       RETURNING id`,
      [ids, Date.now()],
    )
    const rows = Array.isArray(result?.rows) ? result.rows : []
    // A model failure is not permission to retire source data. Keep every
    // nonempty row available after cooldown, regardless of retry count.
    return { attempted: ids.length, deferred: rows.length, marked: 0, failed: Math.max(0, ids.length - rows.length) }
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

const CYCLE1_MIN_BATCH = 3
const CYCLE1_SESSION_CAP = 10
const CYCLE1_PACKET_MAX_ROWS = 50
const CYCLE1_MAX_PACKETS = 4

// Per-db SKIP gate — concurrent callers coalesce into a DB-backed dirty bit;
// the lock holder drains it after the current run instead of making them wait.
const _runCycle1InFlight = new WeakMap()
const _lastCycle1LogAt = new Map()

export function getInFlightCycle1(db) {
  return _runCycle1InFlight.get(db) || null
}

function logCycle1Throttled(key, message, intervalMs = 60_000) {
  const now = Date.now()
  const last = _lastCycle1LogAt.get(key) || 0
  if (now - last < intervalMs) return
  _lastCycle1LogAt.set(key, now)
  __mixdogMemoryLog(message)
}

export function packCycle1Windows(rowsBySession, packetSize = CYCLE1_PACKET_MAX_ROWS, maxPackets = CYCLE1_MAX_PACKETS, inputTokenBudget = CYCLE1_INPUT_TOKEN_BUDGET) {
  const size = Math.min(CYCLE1_PACKET_MAX_ROWS, Math.max(1, Number(packetSize) || CYCLE1_PACKET_MAX_ROWS))
  const cap = Math.min(CYCLE1_MAX_PACKETS, Math.max(1, Number(maxPackets) || CYCLE1_MAX_PACKETS))
  const sourceBudget = cycle1SourceBudget(inputTokenBudget)
  let sessions = [...rowsBySession.values()].map(rows => rows.slice().reverse())
  // Preserve the oldest selected session even when selected sessions outnumber
  // packet slots. Then round-robin: one busy session cannot consume every slot.
  if (sessions.length > cap) sessions = cap === 1 ? [sessions.at(-1)] : [...sessions.slice(0, cap - 1), sessions.at(-1)]
  sessions = sessions.map(rows => partitionCycle1Rows(rows, sourceBudget, size))
  const windows = []
  while (sessions.some(rows => rows.length) && windows.length < cap) {
    for (const packets of sessions) {
      if (!packets.length || windows.length >= cap) continue
      windows.push(packets.shift())
    }
  }
  return windows
}

async function countSessionUnchunkedRows(db, { reviewedBefore = null } = {}) {
  const where = [
    'chunk_root IS NULL',
    `NULLIF(btrim(session_id), '') IS NOT NULL`,
  ]
  const params = []
  if (reviewedBefore != null) {
    params.push(reviewedBefore)
    where.push('(reviewed_at IS NULL OR reviewed_at < $1)')
  }
  try {
    const result = await db.query(
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE ${where.join('\n         AND ')}`,
      params,
    )
    return Number(result.rows[0]?.c ?? 0)
  } catch {
    return null
  }
}

function countPendingRows(db) {
  return countSessionUnchunkedRows(db, { reviewedBefore: Date.now() - CYCLE1_OMITTED_COOLDOWN_MS })
}

function countRawUnchunkedRows(db) {
  return countSessionUnchunkedRows(db)
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
  const cycleStartedAt = Date.now()
  const signal = options?.signal
  throwIfAborted(signal)
  const pendingRowsAtStart = await countPendingRows(db)
  const rawUnchunkedAtStart = await countRawUnchunkedRows(db)
  throwIfAborted(signal)
  const batchSize = Math.max(1, Number(config.batch_size ?? 100))
  const windowSize = Math.min(
    CYCLE1_PACKET_MAX_ROWS,
    Math.max(1, Number(config.window_size ?? config.windowSize ?? batchSize)),
  )
  const maxPackets = Math.min(
    CYCLE1_MAX_PACKETS,
    Math.max(1, Number(config.max_packets ?? config.maxPackets ?? CYCLE1_MAX_PACKETS)),
  )
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
  // Starvation backfill. Session selection below is recency-first, which on a
  // busy daemon means the newest sessions refill every slot on every run: a row
  // that is omitted or fails once lands behind CYCLE1_OMITTED_COOLDOWN_MS, and
  // by the time that cooldown lapses newer sessions own the whole cap again, so
  // the session is never selected a second time. Observed effect: the unchunked
  // backlog sat flat at ~550 rows across 28 starved sessions for hours while
  // each run cheerfully drained only the freshest ones. Reserve a slice of the
  // cap for the OLDEST eligible sessions so the tail always drains. Recency
  // still owns the majority of slots and the per-run session count is unchanged,
  // so classifier cost per run is not affected.
  const backfillCap = Math.min(
    Math.max(1, Math.floor(sessionCap / 3)),
    Math.max(1, sessionCap - 1),
  )
  queryParams.push(backfillCap)
  const backfillParam = `$${queryParams.length}`
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
  const fetchStartedAt = Date.now()
  const fetchResult = await db.query(
    `WITH eligible_sessions AS (
       SELECT session_id, MAX(ts) AS latest_ts, MAX(id) AS latest_id
       FROM entries
       WHERE chunk_root IS NULL
         AND NULLIF(btrim(session_id), '') IS NOT NULL
         AND (reviewed_at IS NULL OR reviewed_at < $2)
         ${sessionFilterSql}
       GROUP BY session_id
     ), recent_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM eligible_sessions
       ORDER BY latest_ts DESC, latest_id DESC
       LIMIT GREATEST($1::int - ${backfillParam}::int, 0)
     ), starved_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM eligible_sessions
       ORDER BY latest_ts ASC, latest_id ASC
       LIMIT ${backfillParam}::int
     ), selected_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM recent_sessions
       UNION
       SELECT session_id, latest_ts, latest_id FROM starved_sessions
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
  const fetchMs = Date.now() - fetchStartedAt

  const bypassMinBatchForCooldown = Number.isFinite(rawUnchunkedAtStart)
    && rawUnchunkedAtStart >= minBatch
    && Number.isFinite(pendingRowsAtStart)
    && pendingRowsAtStart < minBatch
  if (Number.isFinite(pendingRowsAtStart) && pendingRowsAtStart < minBatch && !bypassMinBatchForCooldown) {
    const pendingLog = Number.isFinite(rawUnchunkedAtStart) ? rawUnchunkedAtStart : 'na'
    const eligibleLog = Number.isFinite(pendingRowsAtStart) ? pendingRowsAtStart : 'na'
    __mixdogMemoryLog(`[cycle1] quick-exit pending=${pendingLog} eligible=${eligibleLog} min_batch=${minBatch}\n`)
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
  const inputTokenBudget = config.input_token_budget ?? CYCLE1_INPUT_TOKEN_BUDGET
  const windows = packCycle1Windows(rowsBySession, windowSize, maxPackets, inputTokenBudget)

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

    const llmCall = typeof options?.callLlm === 'function' ? options.callLlm : callAgentDispatch

    const generated = await generateCycle1Chunks(rows, {
      callLlm: llmCall,
      inputTokenBudget,
      signal,
      request: {
        agent: 'cycle1-agent',
        taskType: 'maintenance',
        preset,
        timeout,
        cwd: null,
      },
    })
    __mixdogMemoryLog(`[cycle1-time] window=${windowIdx} ${JSON.stringify(generated.stats)}\n`)
    for (const invalid of generated.invalidChunks) {
      __mixdogMemoryLog(`[cycle1] window=${windowIdx} ${invalid.reason}: ${invalid.error || 'source validation failed'}\n`)
    }
    const committedRowIds = new Set()
    let committedChunks = 0
    let committedMembers = 0
    let skippedChunks = generated.rawRowIds.length
    const invalidChunks = generated.invalidChunks
    const invalidRowIds = new Set(invalidChunks.flatMap(chunk => chunk.member_ids || []))
    const failedRowIds = generated.rawRowIds.filter(id => invalidRowIds.has(id))
    const commitStartedAt = Date.now()
    for (const chunk of generated.chunks) {
      throwIfAborted(signal)
      const { element, category, summary, members, quality } = chunk
      const memberIds = members.map(member => Number(member.id))
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
          const locked = await tx.query(
            `SELECT id, ts, role, content, session_id, chunk_root
             FROM entries WHERE id = ANY($1::bigint[]) FOR UPDATE`,
            [memberIds],
          )
          if (locked.rows.some(row => row.chunk_root != null)
            || !assessChunkQuality({ summary, chunk_quality: quality }, locked.rows).usable) {
            throw new Error('cycle1 source changed before commit')
          }
          // category on root only; recall filters member leaves via parent root.
          await tx.query(
            `UPDATE entries
             SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
                 status = 'pending', project_id = $5,
                 last_seen_at = $7, chunk_quality = $8::jsonb
             WHERE id = $6`,
            [rootId, element, category, summary, projectId, rootId, Date.now(), JSON.stringify(quality)],
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
          committedRowIds.add(mid)
        }
        // Real-time embedding: embed this episode the moment it is committed so
        // dense recall sees fresh roots without waiting for the end-of-cycle flush.
        // Fire-and-forget on a separate pool connection (independent of the
        // just-finished chunk transaction); never await — the chunk loop must
        // not block. The end-of-cycle flushEmbeddingDirty remains as a safety
        // net that sweeps any NULL embeddings this per-root path raced/missed.
        syncRootEmbedding(db, rootId, { signal })
          .catch((err) => __mixdogMemoryLog(`[cycle1] realtime embed failed (root=${rootId}): ${err.message}\n`))
      } catch (err) {
        __mixdogMemoryLog(`[cycle1] chunk commit failed (root=${rootId}): ${err.message}\n`)
        skippedChunks += 1
        for (const mid of memberIds) failedRowIds.push(mid)
      }
    }

    throwIfAborted(signal)

    const rawRowIds = rows.map(r => Number(r.id)).filter(id => !committedRowIds.has(id))
    const llmOmittedRowIds = rawRowIds.filter(id => !failedRowIds.includes(id))
    const omittedMark = await markOmittedRows(db, rawRowIds)
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
      timing: { ...generated.stats, commitMs: Date.now() - commitStartedAt },
    }
  }

  // Cap fan-out concurrency so a large batch (or a manual run) doesn't fire all
  // window LLM calls at once and spike the provider / collide with the global
  // agent-IPC limit. Small batches (<= cap) still run fully parallel.
  const cycle1Concurrency = Math.min(CYCLE1_MAX_PACKETS, Math.max(1, Number(
    config.cycle1_concurrency ?? config.concurrency ?? options.concurrency ?? options.maxConcurrent ?? CYCLE1_MAX_PACKETS,
  )))
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
  const timing = { groupingCalls: 0, verificationCalls: 0, llmMs: 0, verificationMs: 0, retries: 0, fragments: 0, commitMs: 0 }
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
    for (const key of Object.keys(timing)) timing[key] += Number(r.timing?.[key] || 0)
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
      grouping_calls: timing.groupingCalls,
      verification_calls: timing.verificationCalls,
      raw_fallback_rows: totalRowsConsidered - totalMembers,
    },
    timing: { ...timing, fetchMs, totalMs: Date.now() - cycleStartedAt },
    embedding_dirty: { deferred: true, attempted: 0, succeeded: 0, failed: 0, failed_ids: [] },
  }
}
