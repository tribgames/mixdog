// memory-cycle2.mjs — facade for the cycle2 maintenance cluster.
// The bulk was split into cohesive sub-modules; this file keeps the top-level
// orchestrator (runCycle2 / _runCycle2Impl) plus parseInterval, and re-exports
// the extracted members so existing importers resolve unchanged:
//   memory-cycle2-shared.mjs     — log/abort/resourceDir helpers
//   memory-cycle2-mutations.mjs  — status/update/merge writers + runPhaseMerge
//   memory-cycle2-gate.mjs       — prompt/parse/validate + runUnifiedGate + cascade
import { flushEmbeddingDirty } from './memory-embed.mjs'
import { refreshHotActive } from './memory.mjs'
import { backfillCoreEmbeddings, nominateCoreCandidates, CORE_SUMMARY_MAX } from './core-memory-store.mjs'
import { markCycleRequest, consumeCycleRequests, resolveCoalesceMaxDrains, scheduleCoalescedCycleRetry, makeCycleRequestSignature, resolveCoalesceMaxRetries } from './memory-cycle-requests.mjs'
import { __mixdogMemoryLog, throwIfAborted } from './memory-cycle2-shared.mjs'
import {
  applyBatchStatusVerdicts, clampPendingPromotions, blockTransientPromotions, applySimpleStatus, applyUpdate, applyMerge, runPhaseMerge,
} from './memory-cycle2-mutations.mjs'
import {
  CYCLE2_ACTIVE_TARGET_CAP, CYCLE2_ACTIVE_MIN_FLOOR, loadCurrentRulesDigest, runUnifiedGate, sonnetCascade,
  NON_ARCHIVE_VERBS, requiredCoreIdForAction,
} from './memory-cycle2-gate.mjs'

// Re-export the extracted public surface so importers of this path (and the
// memory-cycle.mjs barrel) keep resolving the same names.
export {
  CYCLE2_ACTIVE_TARGET_CAP,
  applySimpleStatus, applyUpdate, applyMerge,
  runPhaseMerge, loadCurrentRulesDigest, runUnifiedGate,
}


// ─── runCycle2 ───────────────────────────────────────────────────────────────

const _runCycle2InFlight = new WeakMap()

function mergeNestedNumeric(a = {}, b = {}) {
  const out = { ...a, ...b }
  for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    out[key] = Number(a?.[key] || 0) + Number(b?.[key] || 0)
  }
  return out
}

function mergeCycle2Results(a, b) {
  if (!a) return b
  if (!b) return a
  return {
    ...a,
    ...b,
    promoted: Number(a.promoted || 0) + Number(b.promoted || 0),
    archived: Number(a.archived || 0) + Number(b.archived || 0),
    merged: Number(a.merged || 0) + Number(b.merged || 0),
    updated: Number(a.updated || 0) + Number(b.updated || 0),
    floor_protected: Number(a.floor_protected || 0) + Number(b.floor_protected || 0),
    kept: Number(a.kept || 0) + Number(b.kept || 0),
    rejected_verb: Number(a.rejected_verb || 0) + Number(b.rejected_verb || 0),
    merge_rejected: Number(a.merge_rejected || 0) + Number(b.merge_rejected || 0),
    missing_core_summary: Number(a.missing_core_summary || 0) + Number(b.missing_core_summary || 0),
    promotion_blocked: Number(a.promotion_blocked || 0) + Number(b.promotion_blocked || 0),
    core_embedding_backfill: Number(a.core_embedding_backfill || 0) + Number(b.core_embedding_backfill || 0),
    core_candidates_nominated: Number(a.core_candidates_nominated || 0) + Number(b.core_candidates_nominated || 0),
    rescore: mergeNestedNumeric(a.rescore, b.rescore),
    phase_merge: mergeNestedNumeric(a.phase_merge, b.phase_merge),
    cascade: mergeNestedNumeric(a.cascade, b.cascade),
    skippedInFlight: false,
  }
}

export async function runCycle2(db, config = {}, options = {}, dataDir = null) {
  const signal = options?.signal
  throwIfAborted(signal)
  const coalescedRetry = options?.coalescedRetry === true
  const catchUpDrainPass = options?.catchUpDrainPass === true
  const retryAttempt = Math.max(0, Number(options?.coalescedRetryAttempt || 0))
  const maxRetries = resolveCoalesceMaxRetries(config, 3)
  const requestSignature = makeCycleRequestSignature('cycle2', config, {
    cascadePreset: options?.cascadePreset,
    concurrency: options?.concurrency,
  })
  const scheduleRetry = () => scheduleCoalescedCycleRetry(
    db,
    'cycle2',
    () => runCycle2(db, config, {
      ...options,
      signal: undefined,
      catchUpDrainPass: false,
      coalescedRetry: true,
      coalescedRetryAttempt: retryAttempt + 1,
    }, dataDir),
    config,
    requestSignature,
  )
  const partial = {
    promoted: 0, archived: 0, merged: 0, updated: 0, kept: 0, rejected_verb: 0,
    merge_rejected: 0,
    missing_core_summary: 0,
    promotion_clamped: 0,
    core_embedding_backfill: 0,
    rescore: { updated: 0 },
    phase_merge: { merged: 0, llm_calls: 0, tier1_pairs: 0, tier2_pairs: 0, core_overlap: 0 },
    cascade: { evaluated: 0, dropped: 0 },
  }
  if (_runCycle2InFlight.has(db)) {
    if (!coalescedRetry) await markCycleRequest(db, 'cycle2', 'in-flight', requestSignature)
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
    __mixdogMemoryLog('[cycle2] skipped: already in flight for this db\n')
    return { ok: true, ...partial, skippedInFlight: true }
  }
  const client = await db._pool.connect()
  let gotLock = false
  try {
    throwIfAborted(signal)
    const r = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, ['mixdog.cycle2'])
    gotLock = r.rows[0]?.got === true
  } catch (err) {
    client.release()
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] advisory lock query failed: ${err.message}\n`)
    if (!coalescedRetry) await markCycleRequest(db, 'cycle2', 'lock-error', requestSignature)
    return { ok: true, ...partial, skippedInFlight: true }
  }
  if (!gotLock) {
    client.release()
    if (!coalescedRetry) await markCycleRequest(db, 'cycle2', 'advisory-lock', requestSignature)
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
    __mixdogMemoryLog('[cycle2] skipped: advisory lock held by another worker\n')
    return { ok: true, ...partial, skippedInFlight: true }
  }
  const _p = (async () => {
    try {
      let result = null
      let coalescedRuns = 0
      let coalescedRequests = 0
      if (coalescedRetry && !catchUpDrainPass) {
        const pending = await consumeCycleRequests(db, 'cycle2', requestSignature)
        if (pending <= 0) return { ok: true, ...partial, skippedInFlight: false, coalescedRetryNoop: true }
        coalescedRuns += 1
        coalescedRequests += pending
        __mixdogMemoryLog(`[cycle2] retrying coalesced requests=${pending}\n`)
      } else if (coalescedRetry && catchUpDrainPass) {
        coalescedRuns += 1
        __mixdogMemoryLog('[cycle2] catch-up drain pass (direct)\n')
      }
      try {
        result = await _runCycle2Impl(db, config, options, dataDir)
      } catch (err) {
        if (coalescedRetry) {
          await markCycleRequest(db, 'cycle2', 'retry-error', requestSignature)
          if (retryAttempt < maxRetries) scheduleRetry()
        }
        throw err
      }
      const maxDrains = catchUpDrainPass ? 0 : resolveCoalesceMaxDrains(config, 1)
      let drainLoops = 0
      while (drainLoops < maxDrains) {
        throwIfAborted(signal)
        const pending = await consumeCycleRequests(db, 'cycle2', requestSignature)
        if (pending <= 0) break
        drainLoops += 1
        coalescedRuns += 1
        coalescedRequests += pending
        __mixdogMemoryLog(`[cycle2] draining coalesced requests=${pending}\n`)
        try {
          const next = await _runCycle2Impl(db, config, options, dataDir)
          result = mergeCycle2Results(result, next)
        } catch (err) {
          await markCycleRequest(db, 'cycle2', 'drain-error', requestSignature)
          if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
          throw err
        }
      }
      if (coalescedRuns > 0) {
        result = { ...result, coalescedRuns, coalescedRequests }
      }
      const okResult = { ok: true, ...result }
      if (coalescedRetry && !okResult?.coalescedRetryNoop && typeof options?.onCoalescedSuccess === 'function') {
        try { await options.onCoalescedSuccess(okResult) }
        catch (err) { __mixdogMemoryLog(`[cycle2] coalesced success callback failed: ${err?.message || err}\n`) }
      }
      return okResult
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e
      return { ok: false, error: e.message, ...partial }
    } finally {
      let releaseErr = null
      try {
        const r = await client.query(`SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`, ['mixdog.cycle2'])
        if (r.rows[0]?.unlocked !== true) releaseErr = new Error('cycle2 advisory unlock returned false')
      } catch (err) {
        releaseErr = err
      }
      client.release(releaseErr || undefined)
    }
  })()
  _runCycle2InFlight.set(db, _p)
  try { return await _p }
  finally { _runCycle2InFlight.delete(db) }
}

async function _runCycle2Impl(db, config = {}, options = {}, dataDir = null) {
  const signal = options?.signal
  throwIfAborted(signal)
  const batchSize = Math.max(1, Number(config.batch_size ?? 50))
  const activeTargetCap = Number.isFinite(Number(config.active_target_cap))
    ? Math.max(1, Number(config.active_target_cap))
    : CYCLE2_ACTIVE_TARGET_CAP
  const activeFloor = Number.isFinite(Number(config.active_floor))
    ? Math.max(0, Number(config.active_floor))
    : CYCLE2_ACTIVE_MIN_FLOOR
  const nowMs = Date.now()

  const stats = {
    promoted: 0, archived: 0, merged: 0,
    updated: 0, kept: 0, rejected_verb: 0,
    merge_rejected: 0,
    missing_core_summary: 0,
    promotion_blocked: 0,
    core_embedding_backfill: 0,
    core_candidates_nominated: 0,
    rescore: { updated: 0 },
    phase_merge: { merged: 0, llm_calls: 0, tier1_pairs: 0, tier2_pairs: 0, core_overlap: 0 },
    cascade: { evaluated: 0, dropped: 0 },
    floor_protected: 0,
  }

  if (dataDir) {
    try {
      stats.core_embedding_backfill = await backfillCoreEmbeddings(dataDir, { signal })
      throwIfAborted(signal)
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[cycle2] core embedding backfill failed: ${err.message}\n`)
    }
  }

  const activeCountRes = await db.query(
    `SELECT COUNT(*) AS c FROM entries WHERE is_root = 1 AND status = 'active'`,
    [],
  )
  throwIfAborted(signal)
  const activeCount = Number(activeCountRes.rows[0]?.c ?? 0)
  const reviewActiveRows = activeCount > activeTargetCap

  // Shared floor-demotion budget: the number of active rows that may be
  // archived this cycle before the active pool would breach the minimum
  // floor. EVERY archiving path that removes an active row must reserve()
  // from this single budget (status demotions, cascade drops, applyMerge
  // sources, and phase_merge) so no path can drain active below the floor.
  // Reservations are refunded when the underlying write turns out not to
  // demote (optimistic-guard miss / merge failure).
  const floorGuard = {
    remaining: Math.max(0, activeCount - activeFloor),
    protected: 0,
    reserve() { if (this.remaining <= 0) { this.protected += 1; return false } this.remaining -= 1; return true },
    refund(n = 1) { this.remaining += Math.max(0, n) },
  }

  // Rolling active re-review quota. Under cap, the unified selection below
  // pulls only pending rows, so an already-promoted entry that later drifts
  // stale or turns out to restate a rule file never gets re-judged — the
  // over-cap path was historically the ONLY one that re-examined active.
  // Reserve a bounded slice of batch slots for the stalest active rows so
  // rule-duplicate / drifted promotions are archived continuously instead of
  // sitting forever un-rechecked. Bounded count + reviewed_at rotation
  // prevents eroding the set to zero (the original over-cap-only concern):
  // only the oldest few are re-judged per cycle, and the gate — shown
  // {{CURRENT_RULES}} — keeps genuine A/B entries and archives only
  // restatements. Embedding dedup is skipped on purpose: rule restatements
  // are often cross-language paraphrases whose cosine never clears the merge
  // threshold, but the LLM gate catches the semantic overlap.
  // Floor guard: when the active pool is at/below the minimum floor, skip the
  // rolling active recheck entirely so demotions cannot drain it further.
  const activeRecheckQuota = (reviewActiveRows || activeCount <= activeFloor)
    ? 0
    : Math.max(0, Math.min(Number(config.active_recheck_quota ?? 8), batchSize - 1))
  const pendingLimit = batchSize - activeRecheckQuota
  // Score direction depends on the phase. Under cap we are SEEDING the active
  // set: evaluate the highest-value pending first so promotion-worthy rows
  // reach the gate instead of starving behind low-score cycle1 churn. Over cap
  // we are CONTRACTING: evaluate the lowest-score rows first to shed the
  // weakest. (The active-recheck slice below stays ASC — demote weakest active
  // first.)
  const scoreDir = reviewActiveRows ? 'ASC' : 'DESC'

  // Unified candidate selection. Pending rows (and, when over cap, active
  // rows) reach the gate here; the reserved active-recheck slice is appended
  // below. Cleanup of duplicates/stale user-core overlap also runs via
  // phase_merge / cycle3.
  const rowsRes = await db.query(`
    SELECT id, element, category, summary, score, last_seen_at, project_id, status, reviewed_at
    FROM entries
    WHERE is_root = 1
      AND (status = 'pending' OR ($2::boolean AND status = 'active'))
    ORDER BY
      CASE WHEN $2::boolean THEN CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 END
           ELSE CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 END
      END ASC,
      CASE WHEN NOT $2::boolean AND LOWER(category) IN ('task', 'issue') THEN 1 ELSE 0 END ASC,
      reviewed_at ASC NULLS FIRST,
      error_count ASC,
      score ${scoreDir},
      id ASC
    LIMIT $1
  `, [pendingLimit, reviewActiveRows])
  throwIfAborted(signal)
  const rows = rowsRes.rows

  // Append the reserved rolling slice of stalest active rows (under-cap only;
  // the over-cap branch already pulls active broadly). De-duped against the
  // primary selection so an id never gets two verdicts in one batch.
  if (activeRecheckQuota > 0 && activeCount > 0) {
    const seen = new Set(rows.map(r => Number(r.id)))
    const recheckRes = await db.query(`
      SELECT id, element, category, summary, score, last_seen_at, project_id, status, reviewed_at
      FROM entries
      WHERE is_root = 1 AND status = 'active'
      ORDER BY reviewed_at ASC NULLS FIRST, score ASC, id ASC
      LIMIT $1
    `, [activeRecheckQuota])
    throwIfAborted(signal)
    for (const r of recheckRes.rows) {
      if (!seen.has(Number(r.id))) rows.push(r)
    }
  }

  // Active snapshot for prompt context (do-not-duplicate reference).
  const activeContextRes = await db.query(`
    SELECT id, element, category, summary, score, last_seen_at, project_id, status
    FROM entries
    WHERE is_root = 1 AND status = 'active'
    ORDER BY score DESC, last_seen_at DESC, id ASC
    LIMIT 100
  `, [])
  throwIfAborted(signal)
  const activeContext = activeContextRes.rows

  const gateResult = rows.length > 0
    ? await runUnifiedGate(db, rows, activeContext, config, { activeCap: activeTargetCap, preset: options.preset, dataDir, signal, callLlm: options.callLlm })
    : { actions: [], rejected: new Set(), parseOk: true }
  throwIfAborted(signal)
  // Surface a gate parse/coverage failure so the caller can distinguish a
  // clean no-op run from one where the LLM gate produced nothing usable.
  if (gateResult.parseOk === false) stats.gate_failed = true

  const sweepCursor = nowMs

  const rowsById = new Map(rows.map(r => [Number(r.id), r]))

  // Cascade pre-pass: pull first-pass keeps (verb 'active') into Sonnet for
  // re-judge. update/merge/archived skip.
  const cascadeCandidates = []
  if (gateResult.actions) {
    // First-pass proposed core lines: under the pending-row transform the L2
    // lesson lives only in the core line, so thread it into the cascade.
    const proposedCoreById = new Map()
    for (const a of gateResult.actions) {
      if (a.action !== 'core') continue
      const id = Number(a.entry_id)
      const core = String(a.core_summary ?? '').replace(/\s+/g, ' ').trim()
      if (Number.isFinite(id) && core) proposedCoreById.set(id, core)
    }
    for (const a of gateResult.actions) {
      throwIfAborted(signal)
      if (a.action !== 'active') continue
      const row = rowsById.get(Number(a.entry_id))
      if (!row) continue
      cascadeCandidates.push({
        id: row.id, status: row.status, verb: a.action,
        category: row.category, element: row.element, summary: row.summary,
        core: proposedCoreById.get(Number(a.entry_id)) || '',
      })
    }
  }

  const rulesDigest = loadCurrentRulesDigest() || ''
  let cascadeVerdicts = new Map()
  if (cascadeCandidates.length > 0) {
    cascadeVerdicts = await sonnetCascade(cascadeCandidates, rulesDigest, { ...options, signal })
    throwIfAborted(signal)
    stats.cascade.evaluated = cascadeCandidates.length
  }

  // Apply actions.
  if (gateResult.actions) {
    const reviewedIds = []
    const rejectedActionIds = []
    const cascadeDropArchiveIds = []
    const statusBatch = []
    const coreSummaryById = new Map()
    const primaryActions = []

    for (const a of gateResult.actions) {
      throwIfAborted(signal)
      if (a.action === 'core') {
        const id = Number(a.entry_id)
        const core = String(a.core_summary ?? '').replace(/\s+/g, ' ').trim().slice(0, CORE_SUMMARY_MAX)
        if (Number.isFinite(id) && core) coreSummaryById.set(id, core)
      } else {
        primaryActions.push(a)
      }
    }

    const setCoreSummary = async (entryId, explicitSummary) => {
      const id = Number(entryId)
      if (!Number.isFinite(id)) return false
      let core = String(explicitSummary ?? '').replace(/\s+/g, ' ').trim().slice(0, CORE_SUMMARY_MAX)
      if (!core) return false
      await db.query(`UPDATE entries SET core_summary = $1 WHERE id = $2 AND is_root = 1`, [core, id])
      return true
    }

    for (const a of primaryActions) {
      throwIfAborted(signal)
      const id = Number(a.entry_id)
      if (!Number.isFinite(id)) continue
      const row = rowsById.get(id)
      if (!row) continue
      let accepted = false

      try {
        const requiresCore = NON_ARCHIVE_VERBS.has(a.action)
        const coreId = requiredCoreIdForAction(a)
        const explicitCore = coreSummaryById.get(coreId) || coreSummaryById.get(id)
        if (requiresCore && !explicitCore) {
          stats.missing_core_summary += 1
          rejectedActionIds.push(id)
          __mixdogMemoryLog(`[cycle2] non-archive action rejected: missing explicit core line id=${id} action=${a.action}\n`)
          continue
        }

        // Cascade override: drop a tentatively-kept entry → archive.
        if (a.action === 'active' && cascadeVerdicts.get(id) === 'drop') {
          cascadeDropArchiveIds.push(id)
          accepted = true
          reviewedIds.push(id)
          continue
        }

        if (a.action === 'active') {
          if (row.status === 'pending') {
            statusBatch.push({ entry_id: id, new_status: 'active', was_pending: true, expected: { status: row.status, reviewedAt: row.reviewed_at } })
          } else if (row.status === 'active') {
            stats.kept += 1
          }
          await setCoreSummary(id, explicitCore)
          accepted = true
        } else if (a.action === 'archived') {
          statusBatch.push({ entry_id: id, new_status: 'archived', was_pending: row.status === 'pending', expected: { status: row.status, reviewedAt: row.reviewed_at } })
          accepted = true
        } else if (a.action === 'update') {
          // Optimistic guard: skip if the row moved since the gate read it
          // (concurrent cycle/recall write). row is the snapshot the verdict
          // was computed against.
          if (await applyUpdate(db, id, a.element, a.summary, { signal, expected: { status: row.status, reviewedAt: row.reviewed_at } })) stats.updated += 1
          await setCoreSummary(id, explicitCore)
          accepted = true
        } else if (a.action === 'merge') {
          const sourceIds = Array.isArray(a.source_ids) ? a.source_ids : []
          const targetId = Number(a.target_id)
          if (!Number.isFinite(targetId) || sourceIds.length === 0) {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
            continue
          }
          if (targetId !== id && !sourceIds.map(Number).includes(id)) {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
            __mixdogMemoryLog(
              `[cycle2] merge rejected during apply: id=${id} target=${targetId} sources=${sourceIds.join(',')}\n`,
            )
            continue
          }
          // Bounded-erosion invariant: a merge may only consolidate entries
          // that are themselves candidates in this batch. Otherwise a single
          // rechecked active row could list source_ids pointing at active
          // entries outside the batch (e.g. ids drawn from the activeContext
          // reference list), and applyMerge would archive those too —
          // un-judged and beyond the rolling-recheck quota. Out-of-batch
          // target/source ids are rejected; a true duplicate of an existing
          // active entry is handled by the `archived` verdict instead.
          if (![targetId, ...sourceIds.map(Number)].every(mid => rowsById.has(mid))) {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
            __mixdogMemoryLog(
              `[cycle2] merge rejected: out-of-batch target/source (target=${targetId} sources=${sourceIds.join(',')})\n`,
            )
            continue
          }
          const moved = await applyMerge(db, targetId, sourceIds, { signal, floorGuard })
          throwIfAborted(signal)
          if (moved > 0) {
            stats.merged += moved
            if (typeof a.element === 'string' || typeof a.summary === 'string') {
              try { if (await applyUpdate(db, targetId, a.element, a.summary, { signal })) stats.updated += 1 }
              catch (err) {
                if (signal?.aborted) throw signal.reason ?? err
                __mixdogMemoryLog(`[cycle2] merge target update failed (target=${targetId}): ${err.message}\n`)
              }
            }
            await setCoreSummary(targetId, explicitCore)
            accepted = true
          } else {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
          }
        }
        if (accepted) reviewedIds.push(id)
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        __mixdogMemoryLog(`[cycle2] action error (id=${id}): ${err.message}\n`)
      }
    }

    if (statusBatch.length > 0) {
      // Status verdicts are applied as one SQL batch; checkpoint before the
      // batch and then again at the next cycle2 unit boundary.
      throwIfAborted(signal)
      // Reserve floor budget for each active→archived demotion; over-budget
      // demotions are dropped (the row stays active, still reviewed_at-bumped
      // via reviewedIds). Pending→archived never reserves (was never active).
      const guardedBatch = []
      let reservedDemotions = 0
      for (const item of statusBatch) {
        if (item.new_status === 'archived' && !item.was_pending) {
          if (!floorGuard.reserve()) continue
          reservedDemotions += 1
        }
        guardedBatch.push(item)
      }
      // Structural transient block runs BEFORE the cap clamp: task/issue chatter
      // and status/benchmark snapshots can never promote pending→active, so they
      // are stripped here (held pending) regardless of remaining cap slots.
      const blockRes = blockTransientPromotions(guardedBatch, rowsById)
      stats.promotion_blocked = blockRes.blocked
      const activeCountForClamp = Math.max(0, activeCount - reservedDemotions)
      const clampRes = clampPendingPromotions(blockRes.batch, rowsById, activeCountForClamp, activeTargetCap)
      stats.promotion_clamped = clampRes.clamped
      const batchRes = await applyBatchStatusVerdicts(db, clampRes.batch, nowMs)
      stats.promoted += batchRes.promoted
      stats.archived += batchRes.archived
      // Spend on CONFIRMED demotions only: refund reservations the optimistic
      // guard skipped (concurrent write moved the row).
      const confirmedActive = Number(batchRes.archived_active || 0)
      if (reservedDemotions > confirmedActive) floorGuard.refund(reservedDemotions - confirmedActive)
    }

    if (cascadeDropArchiveIds.length > 0) {
      throwIfAborted(signal)
      // Floor guard: a cascade drop of an active row reduces the pool, so
      // reserve budget; pending rows dropped here never were active. The
      // snapshot status can be stale (statusBatch above / concurrent writes),
      // so reserve optimistically then refund against the ACTUAL number of
      // active→archived transitions the UPDATE performed (prev_status read in
      // the same statement).
      let reservedActive = 0
      const toDrop = []
      for (const id of cascadeDropArchiveIds) {
        const row = rowsById.get(Number(id))
        if (row && row.status === 'active') {
          if (!floorGuard.reserve()) continue
          reservedActive += 1
        }
        toDrop.push(id)
      }
      if (toDrop.length > 0) {
        const r = await db.query(`
          WITH pre AS (SELECT id, status AS prev FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1)
          UPDATE entries SET status = 'archived'
          FROM pre
          WHERE entries.id = pre.id AND entries.is_root = 1
          RETURNING entries.id, pre.prev AS prev_status
        `, [toDrop])
        const dropped = r.rows ?? []
        stats.cascade.dropped += dropped.length
        stats.archived += dropped.length
        const actualArchivedActive = dropped.filter(x => x.prev_status === 'active').length
        if (reservedActive > actualArchivedActive) floorGuard.refund(reservedActive - actualArchivedActive)
      }
    }
    if (reviewedIds.length > 0) {
      throwIfAborted(signal)
      await db.query(`UPDATE entries SET reviewed_at = $1 WHERE id = ANY($2::bigint[])`, [sweepCursor, reviewedIds])
    }
    if (rejectedActionIds.length > 0) {
      throwIfAborted(signal)
      await db.query(
        `UPDATE entries SET error_count = COALESCE(error_count, 0) + 1 WHERE id = ANY($1::bigint[])`,
        [[...new Set(rejectedActionIds)]],
      )
    }
  } else if (rows.length > 0) {
    // Parse failure — bump error_count and advance reviewed_at so the
    // failing row sorts to the back of reviewed_at ASC NULLS FIRST (see
    // ~:1067-1073), matching CYCLE1_OMITTED_COOLDOWN_MS-style cooldown
    // semantics instead of spinning forever on the same row.
    for (const r of rows) {
      throwIfAborted(signal)
      try {
        await db.query(
          `UPDATE entries SET error_count = COALESCE(error_count, 0) + 1, reviewed_at = $1 WHERE id = $2`,
          [sweepCursor, r.id],
        )
      } catch {}
    }
  }

  // Rejected verb rows: advance reviewed_at + bump error_count so an all-reject
  // batch does not loop forever. error_count ASC sort pushes them to the back.
  if (gateResult.rejected && gateResult.rejected.size > 0) {
    stats.rejected_verb = gateResult.rejected.size
    for (const id of gateResult.rejected) {
      throwIfAborted(signal)
      try {
        await db.query(`UPDATE entries SET reviewed_at = $1 WHERE id = $2`, [sweepCursor, id])
        await db.query(
          `UPDATE entries SET error_count = COALESCE(error_count, 0) + 1 WHERE id = $1`,
          [id],
        )
      } catch {}
    }
  }

  // Flush embeddings BEFORE phase_merge: newly promoted/dirty roots have
  // NULL embeddings until the dirty queue drains, and runPhaseMerge filters
  // on `embedding IS NOT NULL` for both the cosine dedup and the core-overlap
  // pass. Running the flush after the merge would skip those rows for an
  // entire cycle. Reordering ensures same-cycle dedup/core-overlap sees them.
  try {
    throwIfAborted(signal)
    const d = await flushEmbeddingDirty(db, { signal })
    throwIfAborted(signal)
    if (d.attempted > 0) {
      __mixdogMemoryLog(
        `[cycle2] embedding flush attempted=${d.attempted} ok=${d.succeeded} failed=${d.failed.length}\n`,
      )
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] embedding flush failed: ${err.message}\n`)
  }

  // phase_merge: cosine dedup over active entries.
  const phaseMergeStats = await runPhaseMerge(db, { ...options, signal, floorGuard })
  throwIfAborted(signal)
  stats.phase_merge = phaseMergeStats
  // Surface how many active-row demotions were withheld to hold the floor
  // across every archiving path this cycle (status/cascade/merge/phase_merge).
  stats.floor_protected = floorGuard.protected

  // Core-candidate nomination (proposal mode): flag strong durable active
  // roots as core-memory candidates for user approval. Runs AFTER phase_merge
  // so its core_overlap sweep has already archived active entries that restate
  // an existing core row — nomination never re-surfaces those. NEVER
  // auto-inserts into core_entries; the user promotes via action:'core'
  // op:'promote'. Best-effort: a failure here must not fail the cycle.
  if (dataDir) {
    try {
      throwIfAborted(signal)
      stats.core_candidates_nominated = await nominateCoreCandidates(dataDir, { signal })
      throwIfAborted(signal)
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[cycle2] core-candidate nomination failed: ${err.message}\n`)
    }
  }

  // Post-gate promotion clamp (clampPendingPromotions) is the deterministic
  // active-cap safety net; the gate still contracts when Active > cap.

  // Chronic gate-failure sweep: pending roots that have failed the gate 5+
  // times AND are 30+ days old will realistically never pass (their content
  // keeps breaking the parse — 2026-07 drain left 154 such rows cycling as
  // permanent noop batches). Terminal-archive them (status only, no data
  // deletion) so they stop occupying gate batches. Same cooldown semantics
  // as the parse-failure reviewed_at advance above.
  try {
    throwIfAborted(signal)
    const sweepRes = await db.query(
      `UPDATE entries
       SET status = 'archived', reviewed_at = $1
       WHERE is_root = 1 AND status = 'pending'
         AND COALESCE(error_count, 0) >= 5
         AND ts < $2
       RETURNING id`,
      [Date.now(), Date.now() - 30 * 86_400_000],
    )
    const swept = sweepRes?.rows?.length ?? 0
    if (swept > 0) {
      stats.chronic_swept = swept
      __mixdogMemoryLog(`[cycle2] chronic gate-failure sweep archived=${swept}\n`)
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] chronic sweep failed: ${err.message}\n`)
  }

  // Refresh the hot-active materialized view now that every promotion/archival/
  // dedup mutation for this cycle has landed, so the recall hot path reads a
  // current active set. refreshHotActive is itself best-effort (logs + swallows);
  // the guard here also keeps a refresh failure from failing the cycle.
  try {
    throwIfAborted(signal)
    await refreshHotActive(db)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] mv_hot_active refresh failed: ${err.message}\n`)
  }

  __mixdogMemoryLog(
    `[cycle2] rescore=${stats.rescore.updated}` +
    ` core_backfill=${stats.core_embedding_backfill}` +
    ` active=${activeCount}/${activeTargetCap} review_active=${reviewActiveRows ? 1 : 0}` +
    ` | gate promoted=${stats.promoted} archived=${stats.archived}` +
    ` promotion_clamped=${stats.promotion_clamped} promotion_blocked=${stats.promotion_blocked}` +
    ` updated=${stats.updated} kept=${stats.kept}` +
    ` rejected_verb=${stats.rejected_verb} merge_rejected=${stats.merge_rejected}` +
    ` missing_core=${stats.missing_core_summary}` +
    ` | cascade eval=${stats.cascade.evaluated} drop=${stats.cascade.dropped}` +
    ` | phase_merge merged=${stats.phase_merge.merged} core_overlap=${stats.phase_merge.core_overlap || 0}` +
    ` llm=${stats.phase_merge.llm_calls}` +
    ` | core_candidates=${stats.core_candidates_nominated || 0}\n`,
  )

  return stats
}

export function parseInterval(s) {
  if (String(s).toLowerCase() === 'immediate') return 0
  const match = String(s).match(/^(\d+)(s|m|h)$/)
  if (!match) throw new Error(`[memory-cycle2] invalid interval config: ${s}`)
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60000, h: 3600000 }
  return Number(num) * multiplier[unit]
}
