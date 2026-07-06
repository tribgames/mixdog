// Entry-mutation + phase_merge cluster extracted from memory-cycle2.mjs.
// DB status/update/merge writers plus the cosine-similarity dedup pass.
// Facade (memory-cycle2.mjs) re-exports the public members unchanged.
import { deleteRootEmbedding, syncRootEmbedding } from './memory-embed.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import { __mixdogMemoryLog, throwIfAborted } from './memory-cycle2-shared.mjs'

const TIER1_THRESHOLD = 0.78
const TIER2_LOW = 0.65
const LLM_JUDGE_CAP = 20

const TRANSIENT_PROMOTE_CATEGORIES = new Set(['task', 'issue'])

// After the gate, cap how many pending→active promotions may land in one batch.
// Overflow stays pending (not archived). Tiebreak: durable category before
// task/issue, then score DESC, then older last_seen_at, then id ASC.
export function clampPendingPromotions(statusBatch, rowsById, activeCount, activeTargetCap) {
  if (!statusBatch?.length) return { batch: statusBatch ?? [], clamped: 0 }
  const archives = []
  const promotions = []
  for (const item of statusBatch) {
    if (item.was_pending && item.new_status === 'active') promotions.push(item)
    else archives.push(item)
  }
  const slots = Math.max(0, Number(activeTargetCap) - Number(activeCount))
  if (promotions.length <= slots) return { batch: statusBatch, clamped: 0 }

  promotions.sort((a, b) => {
    const ra = rowsById.get(Number(a.entry_id))
    const rb = rowsById.get(Number(b.entry_id))
    const ta = TRANSIENT_PROMOTE_CATEGORIES.has(String(ra?.category ?? '').toLowerCase()) ? 1 : 0
    const tb = TRANSIENT_PROMOTE_CATEGORIES.has(String(rb?.category ?? '').toLowerCase()) ? 1 : 0
    if (ta !== tb) return ta - tb
    const sa = Number(ra?.score ?? 0)
    const sb = Number(rb?.score ?? 0)
    if (sb !== sa) return sb - sa
    const la = Number(ra?.last_seen_at ?? 0)
    const lb = Number(rb?.last_seen_at ?? 0)
    if (la !== lb) return la - lb
    return Number(a.entry_id) - Number(b.entry_id)
  })

  const allowed = promotions.slice(0, slots)
  const clamped = promotions.length - allowed.length
  return { batch: [...archives, ...allowed], clamped }
}

// Batch CTE UPDATE for status-only verdicts (active/archived from pending or active rows).
// Trigger handles score recompute automatically — no app-side score writes.
export async function applyBatchStatusVerdicts(db, batch, nowMs) {
  if (!batch || batch.length === 0) return { promoted: 0, archived: 0 }
  // Optimistic guard: each item may carry expected {status, reviewedAt} — the
  // snapshot the verdict was computed against. NULL expected_* means "no guard"
  // (legacy blind update). The UPDATE only fires when the row still matches, so
  // a concurrent write skips the stale verdict.
  const valueRows = batch.map((item, i) => {
    const base = i * 5
    return `($${base + 1}::bigint, $${base + 2}::text, $${base + 3}::boolean, $${base + 4}::entry_status, $${base + 5}::bigint)`
  })
  const params = []
  for (const item of batch) {
    const exp = item.expected ?? null
    const expStatus = exp && typeof exp.status === 'string' ? exp.status : null
    const expReviewed = exp && Number.isFinite(Number(exp.reviewedAt)) ? Number(exp.reviewedAt) : null
    params.push(item.entry_id, item.new_status, item.was_pending, expStatus, expReviewed)
  }
  params.push(nowMs)
  const lastParam = `$${params.length}`
  const res = await db.query(
    `WITH actions(entry_id, new_status, was_pending, exp_status, exp_reviewed) AS (
       VALUES ${valueRows.join(', ')}
     )
     UPDATE entries
     SET status = a.new_status::entry_status,
         last_seen_at = ${lastParam},
         promoted_at = CASE
           WHEN a.was_pending AND a.new_status = 'active' THEN ${lastParam}
           ELSE promoted_at
         END
     FROM actions a
     WHERE entries.id = a.entry_id AND entries.is_root = 1
       AND (a.exp_status   IS NULL OR entries.status      IS NOT DISTINCT FROM a.exp_status)
       AND (a.exp_reviewed IS NULL OR entries.reviewed_at IS NOT DISTINCT FROM a.exp_reviewed)
     RETURNING entries.id, entries.status, a.was_pending, a.new_status`,
    params,
  )
  let promoted = 0
  let archived = 0
  let archived_active = 0
  for (const r of (res.rows ?? [])) {
    if (r.was_pending && r.new_status === 'active') promoted += 1
    else if (r.new_status === 'archived') {
      archived += 1
      if (!r.was_pending) archived_active += 1
    }
  }
  return { promoted, archived, archived_active }
}

// Generic status update for archived/active terminal transitions.
// Optimistic concurrency: when the caller passes `expected` (the status and/or
// reviewed_at it observed when it made the verdict), the UPDATE only fires if
// the row still matches. A concurrent cycle/recall write that changed status or
// bumped reviewed_at makes the guard fail (0 rows) so a stale LLM verdict does
// not overwrite the newer state. Omitting `expected` preserves legacy blind
// update-by-id behavior for callers that don't track a baseline.
export async function applySimpleStatus(db, entryId, nextStatus, expected = null) {
  const params = [nextStatus, entryId]
  const guards = []
  if (expected && typeof expected.status === 'string') {
    guards.push(`status IS NOT DISTINCT FROM $${params.length + 1}::entry_status`)
    params.push(expected.status)
  }
  if (expected && Number.isFinite(Number(expected.reviewedAt))) {
    guards.push(`reviewed_at IS NOT DISTINCT FROM $${params.length + 1}::bigint`)
    params.push(Number(expected.reviewedAt))
  }
  const guardSql = guards.length ? ` AND ${guards.join(' AND ')}` : ''
  const res = await db.query(
    `UPDATE entries SET status = $1 WHERE id = $2 AND is_root = 1${guardSql}`,
    params,
  )
  return Number(res.rowCount ?? res.affectedRows ?? 0) > 0
}

export async function applyUpdate(db, entryId, element, summary, options = {}) {
  const setClauses = []
  const params = []
  let paramIdx = 1
  const newElement = (typeof element === 'string' && element.trim()) ? element.trim() : null
  const newSummary = (typeof summary === 'string' && summary.trim()) ? summary.trim() : null
  if (newElement) {
    setClauses.push(`element = $${paramIdx++}`); params.push(newElement)
  }
  if (newSummary) {
    setClauses.push(`summary = $${paramIdx++}`); params.push(newSummary)
    setClauses.push('summary_hash = NULL')
  }
  if (setClauses.length === 0) return false
  params.push(entryId)
  const idParam = paramIdx++
  // Optimistic guard (see applySimpleStatus): skip the write if the row moved
  // on since the verdict was computed. options.expected = { status, reviewedAt }.
  const guards = []
  const expected = options?.expected
  if (expected && typeof expected.status === 'string') {
    guards.push(`status IS NOT DISTINCT FROM $${paramIdx++}::entry_status`)
    params.push(expected.status)
  }
  if (expected && Number.isFinite(Number(expected.reviewedAt))) {
    guards.push(`reviewed_at IS NOT DISTINCT FROM $${paramIdx++}::bigint`)
    params.push(Number(expected.reviewedAt))
  }
  const guardSql = guards.length ? ` AND ${guards.join(' AND ')}` : ''
  const res = await db.query(
    `UPDATE entries SET ${setClauses.join(', ')} WHERE id = $${idParam} AND is_root = 1${guardSql}`,
    params,
  )
  if (Number(res.rowCount ?? res.affectedRows ?? 0) === 0) return false
  await syncRootEmbedding(db, entryId, options)
  return true
}

export async function applyMerge(db, targetId, sourceIds, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  if (!Number.isFinite(targetId)) return 0
  const targetRes = await db.query(
    `SELECT id, project_id FROM entries WHERE id = $1 AND is_root = 1`,
    [targetId],
  )
  throwIfAborted(signal)
  const target = targetRes.rows[0]
  if (!target) return 0
  let moved = 0
  for (const src of sourceIds) {
    throwIfAborted(signal)
    const sid = Number(src)
    if (!Number.isFinite(sid) || sid === targetId) continue
    const srcRes = await db.query(
      `SELECT id, project_id, status FROM entries WHERE id = $1 AND is_root = 1`,
      [sid],
    )
    throwIfAborted(signal)
    const srcRow = srcRes.rows[0]
    if (!srcRow) continue
    if (target.project_id !== srcRow.project_id) {
      __mixdogMemoryLog(
        `[cycle2] merge rejected: cross-pool (target=${targetId} project_id=${target.project_id ?? 'COMMON'} src=${sid} project_id=${srcRow.project_id ?? 'COMMON'})\n`,
      )
      continue
    }
    // Floor guard: archiving an active source row shrinks the active pool, so
    // it must reserve from the shared floor budget. Over-budget merges are
    // skipped (source stays active); pending sources never reserve.
    const srcActive = srcRow.status === 'active'
    if (srcActive && options.floorGuard && !options.floorGuard.reserve()) {
      __mixdogMemoryLog(`[cycle2] merge source archive skipped (floor guard): target=${targetId} src=${sid}\n`)
      continue
    }
    let archivedPrevStatus = null
    try {
      // Archive is the guarded mutation unit: the reservation is only kept if
      // this transaction commits. Embedding cleanup is deliberately OUTSIDE
      // this try — a post-commit cleanup failure must NOT refund the budget,
      // since the active row is already archived.
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE entries SET chunk_root = $1, project_id = $2 WHERE chunk_root = $3 AND id != $4 AND is_root = 0`,
          [targetId, target.project_id, sid, sid],
        )
        // Capture prev status in the same statement so a stale snapshot (the
        // row was already archived by a concurrent write) can refund below.
        const ar = await tx.query(
          `WITH pre AS (SELECT id, status AS prev FROM entries WHERE id = $1 AND is_root = 1)
           UPDATE entries SET status = 'archived'
           FROM pre WHERE entries.id = pre.id AND entries.is_root = 1
           RETURNING pre.prev AS prev_status`,
          [sid],
        )
        archivedPrevStatus = ar.rows?.[0]?.prev_status ?? null
      })
    } catch (err) {
      if (srcActive && options.floorGuard) options.floorGuard.refund()
      __mixdogMemoryLog(`[cycle2] merge failed (target=${targetId} src=${sid}): ${err.message}\n`)
      continue
    }
    // Archive committed. If the source was no longer active at UPDATE time,
    // the reservation did not cover a real active→archived transition — refund.
    if (srcActive && options.floorGuard && archivedPrevStatus !== 'active') options.floorGuard.refund()
    // Archive committed — best-effort embedding cleanup only. The next abort
    // checkpoint is before the next source.
    moved += 1
    try { await deleteRootEmbedding(db, sid) }
    catch (err) { __mixdogMemoryLog(`[cycle2] merge embedding cleanup failed (target=${targetId} src=${sid}): ${err.message}\n`) }
  }
  return moved
}

// ─── phase_merge: cosine-similarity dedup pass ───────────────────────────────

function _pickKeeper(a, b) {
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? a : b
  if ((a.last_seen_at ?? 0) !== (b.last_seen_at ?? 0)) return (a.last_seen_at ?? 0) > (b.last_seen_at ?? 0) ? a : b
  return a.id < b.id ? a : b
}

async function _llmJudgePair(summaryA, summaryB, siblingContext = [], options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  const llmCall = typeof options?.callLlm === 'function' ? options.callLlm : callAgentDispatch
  const siblings = Array.isArray(siblingContext) && siblingContext.length > 0
    ? `\n\nSibling near-matches (recall context only — do not absorb these into the verdict):\n${siblingContext.slice(0, 5).map((p, i) => `${i + 1}. ${String(p.a?.summary ?? '')} ↔ ${String(p.b?.summary ?? '')}`).join('\n')}`
    : ''
  const prompt =
    `Two memory entries below. Are they restating the same principle? Reply ONE WORD: merge or distinct.\n\nA: ${summaryA}\nB: ${summaryB}${siblings}`
  try {
    const raw = await llmCall({
      agent: 'cycle2-agent',
      taskType: 'maintenance',
      mode: 'cycle2-phase_merge_judge',
      preset: 'HAIKU',
      timeout: 30000,
      cwd: null,
    }, prompt)
    throwIfAborted(signal)
    return String(raw ?? '').trim().toLowerCase().startsWith('merge')
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] phase_merge llm-judge error: ${err.message}\n`)
    return false
  }
}

export async function runPhaseMerge(db, options = {}) {
  const signal = options?.signal
  const floorGuard = options?.floorGuard
  throwIfAborted(signal)
  // PG-side lateral nearest-neighbor via HNSW index — replaces JS O(n²) double loop.
  const pairRes = await db.query(
    `WITH active AS (
       SELECT id, category, summary, score, last_seen_at, status, embedding, project_id
       FROM entries
       WHERE is_root = 1 AND status = 'active' AND embedding IS NOT NULL
     )
     SELECT a.id AS a_id, a.category AS a_category, a.summary AS a_summary, a.score AS a_score, a.last_seen_at AS a_last_seen_at, a.status AS a_status,
            b.id AS b_id, b.category AS b_category, b.summary AS b_summary, b.score AS b_score, b.last_seen_at AS b_last_seen_at, b.status AS b_status,
            1 - (a.embedding <=> b.embedding)::float8 AS sim
     FROM active a
     CROSS JOIN LATERAL (
       SELECT id, category, summary, score, last_seen_at, status, embedding
       FROM active inner_b
       WHERE inner_b.id != a.id AND inner_b.category = a.category
         AND inner_b.project_id IS NOT DISTINCT FROM a.project_id
       ORDER BY inner_b.embedding <=> a.embedding
       LIMIT 8
     ) b
     WHERE a.id < b.id
       AND 1 - (a.embedding <=> b.embedding) >= $1
     ORDER BY sim DESC`,
    [TIER2_LOW],
  )
  throwIfAborted(signal)

  const tier1Pairs = []
  const tier2Pairs = []
  for (const row of pairRes.rows) {
    throwIfAborted(signal)
    const a = { id: row.a_id, category: row.a_category, summary: row.a_summary, score: row.a_score, last_seen_at: row.a_last_seen_at, status: row.a_status }
    const b = { id: row.b_id, category: row.b_category, summary: row.b_summary, score: row.b_score, last_seen_at: row.b_last_seen_at, status: row.b_status }
    if (row.sim >= TIER1_THRESHOLD) tier1Pairs.push({ a, b, sim: row.sim })
    else tier2Pairs.push({ a, b, sim: row.sim })
  }

  // No active/active similarity pairs is NOT a reason to skip the
  // core_entries overlap sweep below — that pass archives active entries
  // that restate a user-curated core row and is independent of intra-
  // entry pairing. Falling through with merged=0 keeps the cross-table
  // sweep running and the per-phase log shape intact.
  let merged = 0
  let llmCalls = 0
  const mergedIds = new Set()

  const doMerge = async (a, b, sim) => {
    throwIfAborted(signal)
    if (mergedIds.has(a.id) || mergedIds.has(b.id)) return
    const keeper = _pickKeeper(a, b)
    const loser = keeper.id === a.id ? b : a
    // phase_merge only pairs active rows, so the loser archive is an active
    // demotion — thread the floor budget through applyMerge.
    const moved = await applyMerge(db, keeper.id, [loser.id], { signal, floorGuard })
    if (moved > 0) {
      merged += moved
      mergedIds.add(loser.id)
      __mixdogMemoryLog(
        `[cycle2] phase_merge merged id=${loser.id} -> keeper=${keeper.id} category=${keeper.category} sim=${typeof sim === 'number' ? sim.toFixed(3) : '?'}\n`,
      )
    }
  }

  // Only tier1 pairs enter the LLM judge. Tier2 pairs (0.65 ≤ sim < 0.78)
  // are recall context only — passed as sibling examples to the judge, never
  // as judge input themselves, and never archived here.
  for (const pair of tier1Pairs) {
    throwIfAborted(signal)
    if (llmCalls >= LLM_JUDGE_CAP) break
    if (mergedIds.has(pair.a.id) || mergedIds.has(pair.b.id)) continue
    llmCalls++
    const shouldMerge = await _llmJudgePair(
      String(pair.a.summary ?? ''),
      String(pair.b.summary ?? ''),
      tier2Pairs,
      // Thread the in-process LLM adapter through — omitting it falls back to
      // callAgentDispatch (IPC), which is unavailable in the standalone
      // memory service and failed every judge call with
      // `agent-ipc: IPC channel unavailable`.
      { signal, callLlm: options?.callLlm },
    )
    throwIfAborted(signal)
    if (shouldMerge) await doMerge(pair.a, pair.b, pair.sim)
  }

  // Cross-table sweep: surface every active entry whose embedding sits near
  // a user-curated core_entries row (sim ≥ TIER2_LOW for broad recall) and
  // ask the LLM whether the entry is a restatement of that user rule. Only
  // the LLM verdict moves the entry to archived — embedding sim alone is
  // never authoritative. Project-scoped core only matches the same pool;
  // COMMON core is global and may absorb duplicate generated project memory.
  throwIfAborted(signal)
  const coreOverlapRes = await db.query(
    `WITH active_e AS (
       SELECT id, project_id, summary, embedding
       FROM entries
       WHERE is_root = 1 AND status = 'active' AND embedding IS NOT NULL
     )
     SELECT e.id AS entry_id, e.summary AS entry_summary, c.core_id, c.core_summary, c.sim
     FROM active_e e
     CROSS JOIN LATERAL (
       SELECT inner_c.id AS core_id, inner_c.summary AS core_summary,
              1 - (e.embedding <=> inner_c.embedding)::float8 AS sim
       FROM core_entries inner_c
       WHERE inner_c.embedding IS NOT NULL
         AND (inner_c.status IS NULL OR inner_c.status = 'active')
         AND (inner_c.project_id IS NULL OR inner_c.project_id IS NOT DISTINCT FROM e.project_id)
       ORDER BY
         CASE WHEN inner_c.project_id IS NOT DISTINCT FROM e.project_id THEN 0 ELSE 1 END,
         inner_c.embedding <=> e.embedding
       LIMIT 1
     ) c
     WHERE c.sim >= $1`,
    [TIER1_THRESHOLD],
  )
  throwIfAborted(signal)
  let coreOverlap = 0
  for (const row of coreOverlapRes.rows) {
    throwIfAborted(signal)
    if (llmCalls >= LLM_JUDGE_CAP) break
    llmCalls++
    const verdictMerge = await _llmJudgePair(
      String(row.entry_summary ?? ''),
      String(row.core_summary ?? ''),
      [],
      { signal, callLlm: options?.callLlm },
    )
    throwIfAborted(signal)
    if (!verdictMerge) continue
    // Core-overlap archive is an active demotion — reserve floor budget and
    // refund if the guarded UPDATE turns out not to fire.
    if (floorGuard && !floorGuard.reserve()) continue
    // Archiving one overlap and deleting its embedding is one mutation unit;
    // cancellation resumes at the next row boundary.
    const r = await db.query(
      // Clear a live core-candidate flag on the same UPDATE: an archived root
      // must not stay listed as a candidate or keep eating CANDIDATE_CAP. Set
      // it to 'dismissed' (terminal) since the fact already restates a core row.
      `UPDATE entries
       SET status = 'archived',
           core_candidate_status = CASE WHEN core_candidate_status = 'candidate' THEN 'dismissed' ELSE core_candidate_status END
       WHERE id = $1 AND is_root = 1 AND status = 'active'`,
      [Number(row.entry_id)],
    )
    if (Number(r.rowCount ?? r.affectedRows ?? 0) > 0) {
      coreOverlap++
      await deleteRootEmbedding(db, Number(row.entry_id))
    } else if (floorGuard) {
      floorGuard.refund()
    }
  }
  throwIfAborted(signal)
  if (coreOverlap > 0) {
    __mixdogMemoryLog(
      `[cycle2] phase_merge core_overlap archived=${coreOverlap} (LLM-judged restatements of user-curated core_entries)\n`,
    )
  }

  __mixdogMemoryLog(
    `[cycle2] phase_merge tier1_pairs=${tier1Pairs.length} tier2_pairs=${tier2Pairs.length}` +
    ` llm_calls=${llmCalls} merged=${merged} core_overlap=${coreOverlap}\n`,
  )

  return { merged, llm_calls: llmCalls, tier1_pairs: tier1Pairs.length, tier2_pairs: tier2Pairs.length, core_overlap: coreOverlap }
}
