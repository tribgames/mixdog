// Memory action + tool-call handlers extracted from index.mjs.
//
// The write/maintenance action cluster: the per-action `_handleMem*` helpers,
// the `manage`/`core`/`purge`/`retro_eval_active` inline branches, and the
// `memory`/`search_memories`/`recall` tool dispatch. Pure cycle/store/score
// helpers are imported directly; live DB handle, config reader, cycle
// scheduler primitives, cycle-LLM adapters, query handlers, and the transcript
// ingest helpers are injected so the facade keeps ownership of `db`, the
// scheduler, and lifecycle state. The whole-action backfill mutex lives here
// (facade-local previously) since it only guards this module's backfill path.

import {
  runCycle1,
  runCycle2,
  runCycle3,
  runUnifiedGate,
  syncRootEmbedding,
  applySimpleStatus,
  applyUpdate,
  applyMerge,
  CYCLE2_ACTIVE_TARGET_CAP,
} from './memory-cycle.mjs'
import { getInFlightCycle1 } from './memory-cycle1.mjs'
import { pruneOldEntries } from './memory-maintenance-store.mjs'
import { computeEntryScore } from './memory-score.mjs'
import { runFullBackfill } from './memory-ops-policy.mjs'
import {
  listCore,
  addCore,
  editCore,
  deleteCore,
  listCoreCandidates,
  promoteCoreCandidate,
  dismissCoreCandidate,
  CORE_SUMMARY_MAX,
} from './core-memory-store.mjs'
import { resolveProjectScope } from './project-id-resolver.mjs'
import { resolvePluginData } from '../../shared/plugin-paths.mjs'
import { getMetaValue, isBootstrapComplete } from './memory.mjs'

export function createMemoryActionHandlers({
  getDb,
  dataDir,
  log,
  readMainConfig,
  getCycleLastRun,
  ingestSessionMessages,
  entryStats,
  handleSearch,
  dumpSessionRootChunks,
  awaitCycle1Run,
  startCycle1Run,
  finalizeCycle2Run,
  finalizeCycle3Run,
  getSchedulerCycle1InFlight,
  getCycle2CallLlm,
  getCycle3CallLlm,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
}) {
  const DATA_DIR = dataDir

  // Whole-action backfill mutex. memory-cycle1's _cycle1InFlight only protects
  // cycle1; ingest workers (memory-ops-policy.mjs) and cycle2 can still overlap
  // if a second backfill kicks in (e.g. setup-server timeout + retry). Track the
  // in-flight promise here and reject overlaps with 409.
  let _backfillInFlight = null

  async function _handleMemCycle1(args, config, signal) {
    const minBatchOverride = Number(args?.min_batch)
    const sessionCapOverride = Number(args?.session_cap)
    const batchSizeOverride = Number(args?.batch_size)
    const windowSizeOverride = Number(args?.window_size ?? args?.windowSize)
    const rowsPerSessionOverride = Number(args?.rows_per_session ?? args?.rowsPerSession ?? args?.max_rows_per_session ?? args?.maxRowsPerSession)
    const concurrencyOverride = Number(args?.concurrency)
    const sessionIdOverride = String(args?.sessionId ?? args?.session_id ?? '').trim()
    const baseCycle1 = config?.cycle1 || {}
    let cycle1Config = baseCycle1
    // _runCycle1Impl reads `config?.min_batch ?? config?.cycle1?.min_batch ??
    // default` — top-level wins, so pin the override at top-level only.
    if (Number.isFinite(minBatchOverride) && minBatchOverride > 0) {
      cycle1Config = { ...cycle1Config, min_batch: minBatchOverride }
    }
    if (Number.isFinite(sessionCapOverride) && sessionCapOverride > 0) {
      cycle1Config = { ...cycle1Config, session_cap: sessionCapOverride }
    }
    if (Number.isFinite(batchSizeOverride) && batchSizeOverride > 0) {
      cycle1Config = { ...cycle1Config, batch_size: batchSizeOverride }
    }
    if (Number.isFinite(windowSizeOverride) && windowSizeOverride > 0) {
      cycle1Config = { ...cycle1Config, window_size: windowSizeOverride }
    }
    if (Number.isFinite(rowsPerSessionOverride) && rowsPerSessionOverride > 0) {
      cycle1Config = { ...cycle1Config, rows_per_session: rowsPerSessionOverride }
    }
    if (sessionIdOverride) {
      cycle1Config = { ...cycle1Config, session_id: sessionIdOverride }
    }
    if (Number.isFinite(concurrencyOverride) && concurrencyOverride > 0) {
      cycle1Config = { ...cycle1Config, concurrency: Math.min(8, Math.floor(concurrencyOverride)) }
    }
    const callerDeadlineMs = Number(args?._callerDeadlineMs) || 0
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const cycle1Options = callerDeadlineMs > 0 ? { callerDeadlineMs, signal } : { signal }
    if (typeof args?._callLlm === 'function') {
      cycle1Options.callLlm = args._callLlm
    }
    const result = await awaitCycle1Run(
      cycle1Config,
      cycle1Options,
    )
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const pendingStr = result?.pendingRows != null ? result.pendingRows : 0
    const inFlightStr = result?.skippedInFlight === true ? 'true' : 'false'
    const timedOutPart = result?.timedOutWaiting === true ? ' timedOut=true' : ''
    const omitted = Array.isArray(result?.omitted_row_ids) ? result.omitted_row_ids.length : Number(result?.quality?.omitted_rows || 0)
    const prefiltered = Array.isArray(result?.prefiltered_row_ids) ? result.prefiltered_row_ids.length : Number(result?.quality?.prefiltered_rows || 0)
    const failedRows = Array.isArray(result?.failed_row_ids) ? result.failed_row_ids.length : Number(result?.quality?.failed_rows || 0)
    const invalidChunks = Array.isArray(result?.invalid_chunks) ? result.invalid_chunks.length : Number(result?.quality?.invalid_chunks || 0)
    return {
      ...result,
      text: `cycle1: chunks=${result.chunks} processed=${result.processed} skipped_chunks=${result.skipped}` +
        ` omitted=${omitted} prefiltered=${prefiltered} failed_rows=${failedRows} invalid_chunks=${invalidChunks}` +
        ` pending=${pendingStr} inFlight=${inFlightStr}${timedOutPart}`,
    }
  }

  async function _handleMemCycle2(args, config, signal) {
    const db = getDb()
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    let c2Options = { signal }
    if (typeof c2Options?.callLlm !== 'function') {
      c2Options = { ...c2Options, callLlm: getCycle2CallLlm() }
    }
    const result = await runCycle2(db, config?.cycle2 || {}, c2Options, DATA_DIR)
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    await finalizeCycle2Run(result)
    const counts = {
      promoted: result?.promoted || 0,
      archived: result?.archived || 0,
      merged: result?.merged || 0,
      updated: result?.updated || 0,
      kept: result?.kept || 0,
      rejected_verb: result?.rejected_verb || 0,
      merge_rejected: result?.merge_rejected || 0,
      missing_core: result?.missing_core_summary || 0,
      core_backfill: result?.core_embedding_backfill || 0,
      cascade_drop: result?.cascade?.dropped || 0,
      phase_merge: result?.phase_merge?.merged || 0,
      core_overlap: result?.phase_merge?.core_overlap || 0,
    }
    const parts = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`)
    if (parts.length) return { text: `cycle2 ${parts.join(' ')}` }
    // No applied counts — disambiguate the "noop" so a broken gate is visible
    // instead of looking like a clean, nothing-to-do run.
    let cause = ''
    if (result?.skippedInFlight) cause = ' (skipped: in-flight)'
    else if (result?.ok === false) cause = ` (error: ${result.error || 'unknown'})`
    else if (result?.gate_failed) cause = ' (gate_failed)'
    return { text: `cycle2 noop${cause}` }
  }

  async function _handleMemCycle3(args, config, signal) {
    const db = getDb()
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const confirmed = args?.confirm === 'APPLY CYCLE3'
    const requestedMode = typeof args?.cycle3Mode === 'string' ? args.cycle3Mode : null
    const applyMode = confirmed
      ? 'confirmed'
      : (requestedMode === 'proposal' || requestedMode === 'dry-run' || requestedMode === 'dryrun')
        ? 'proposal'
        : 'conservative'
    let c3Options = { signal, apply: confirmed ? true : undefined, applyMode }
    if (typeof c3Options?.callLlm !== 'function') {
      c3Options = { ...c3Options, callLlm: getCycle3CallLlm() }
    }
    const result = await runCycle3(db, config || {}, DATA_DIR, c3Options)
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    // Stamp cycle3 success: the MCP path bypasses the scheduler's coalesced
    // onCoalescedSuccess, so without this last_success_at stayed 0 despite
    // successful runs.
    await finalizeCycle3Run(result)
    const parts = ['reviewed', 'kept', 'updated', 'merged', 'deleted']
      .map(k => `${k}=${result?.[k] || 0}`)
    if (result?.proposed) {
      parts.push(`proposal_update=${result.proposed.updated || 0}`)
      parts.push(`proposal_merge=${result.proposed.merged || 0}`)
      parts.push(`proposal_delete=${result.proposed.deleted || 0}`)
    }
    if (result?.held) {
      parts.push(`held_update=${result.held.updated || 0}`)
      parts.push(`held_merge=${result.held.merged || 0}`)
      parts.push(`held_delete=${result.held.deleted || 0}`)
    }
    parts.push(`mode=${result?.applyMode || applyMode}`)
    parts.push(`applied=${result?.applied === true ? 'true' : 'false'}`)
    if (result?.skippedInFlight) parts.push('inFlight=true')
    const errPart = result?.error ? ` error=${result.error}` : ''
    return { text: `cycle3 ${parts.join(' ')}${errPart}` }
  }

  async function _handleMemFlush(args, config, signal) {
    const db = getDb()
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const r1 = await awaitCycle1Run(config?.cycle1 || {}, { signal })
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    let flushC2Options = { signal }
    if (typeof flushC2Options?.callLlm !== 'function') {
      flushC2Options = { ...flushC2Options, callLlm: getCycle2CallLlm() }
    }
    const r2 = await runCycle2(db, config?.cycle2 || {}, flushC2Options, DATA_DIR)
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    await finalizeCycle2Run(r2)
    return { text: `flush: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
  }

  async function _handleMemStatus(args, config) {
    const db = getDb()
    const stats = await entryStats()
    const last = await getCycleLastRun()
    let dims = 0
    let dimsErr = null
    try {
      const raw = await getMetaValue(db, 'embedding.current_dims', null)
      if (raw != null) dims = Number(JSON.parse(raw))
      if (!Number.isFinite(dims)) dims = 0
    } catch (e) {
      // Surface the error in the status line instead of masquerading a meta
      // read failure as dims=0 (which is indistinguishable from a fresh,
      // pre-bootstrap DB). Keep status callable so other lines still render.
      dims = 0
      dimsErr = e?.message || String(e)
    }
    const bootstrapComplete = await isBootstrapComplete(db)
    const lastCycle1Ago = last.cycle1 ? `${Math.round((Date.now() - last.cycle1) / 60000)}m ago` : 'never'
    const lastCycle2Ago = last.cycle2 ? `${Math.round((Date.now() - last.cycle2) / 60000)}m ago` : 'never'
    const activeTargetCap = Number.isFinite(Number(config?.cycle2?.active_target_cap))
      ? Number(config?.cycle2?.active_target_cap)
      : CYCLE2_ACTIVE_TARGET_CAP
    const mvState = stats.mv_hot_active_populated === null
      ? 'missing'
      : stats.mv_hot_active_populated ? 'populated' : 'unpopulated'
    const lines = [
      `entries: total=${stats.total} roots=${stats.roots} cycle1_raw=${stats.unchunked_leaves} (unchunked leaves) cycle2_pending=${stats.cycle2_pending_roots} (awaiting cycle2 review)`,
      `status: ${stats.byStatus.map(r => `${r.status ?? '?'}:${r.c}`).join(', ') || 'empty'}`,
      `categories(active): ${stats.byCategory.map(r => `${r.category ?? 'NULL'}:${r.c}`).join(', ') || 'empty'} active_target_cap=${activeTargetCap}`,
      `core_memory: user=${stats.core_entries} embed_null=${stats.core_embed_null} active_core=${stats.active_core_summaries} active_missing_core=${stats.active_core_summary_missing}`,
      `embedding_index: ready dims=${dims}${dimsErr ? ` (meta_read_error: ${dimsErr})` : ''}`,
      `recall_index: mv_hot_active=${mvState}`,
      `bootstrap: ${bootstrapComplete ? 'complete' : 'incomplete'}`,
      `last_cycle1: ${lastCycle1Ago}`,
      `last_cycle2: ${lastCycle2Ago}`,
      ...(last.cycle2_last_error ? [`last_cycle2_error: ${last.cycle2_last_error}`] : []),
    ]
    return { text: lines.join('\n') }
  }

  async function _handleMemRebuild(args, config, signal) {
    const db = getDb()
    if (args.confirm !== 'REBUILD MEMORY') {
      return { text: 'rebuild requires confirm: "REBUILD MEMORY" (truncates classification columns and re-runs cycles)', isError: true }
    }
    // Drain any pre-reset cycle1 BEFORE the destructive truncation so the
    // post-reset run is not started concurrently against the same DB.
    // _awaitCycle1Run() may release the outer handle on a caller deadline while
    // the inner runCycle1 promise still owns the DB writes. Drain both layers,
    // then loop once more if one layer exposed another promise while awaiting.
    const drainedCycle1Promises = new Set()
    for (;;) {
      const pendingCycle1Promises = [getSchedulerCycle1InFlight(), getInFlightCycle1(db)]
        .filter(p => p && !drainedCycle1Promises.has(p))
      if (pendingCycle1Promises.length === 0) break
      for (const pendingCycle1 of pendingCycle1Promises) {
        drainedCycle1Promises.add(pendingCycle1)
        try { await pendingCycle1 } catch {}
      }
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    // Cleanup must run BEFORE demotion: the original order demoted normal
    // roots (chunk_root = id) to is_root = 0 first, then ran the cleanup
    // WHERE is_root = 1 — which missed exactly those demoted rows, leaving
    // stale element/category/summary/score/embedding/summary_hash on rows that
    // had just become raw leaves. Reorder so all roots get their classification
    // columns cleared while is_root = 1 still selects them, then demote.
    // Wrap the whole destructive sequence in one transaction so a mid-step
    // failure rolls back rather than leaving a mixed state.
    await db.transaction(async (tx) => {
      await tx.query(`
        UPDATE entries
        SET element = NULL, category = NULL, summary = NULL,
            status = 'pending', score = NULL, last_seen_at = NULL,
            embedding = NULL, summary_hash = NULL,
            core_summary = NULL, reviewed_at = NULL, promoted_at = NULL,
            error_count = 0
        WHERE is_root = 1
      `)
      await tx.query(`UPDATE entries SET chunk_root = NULL, is_root = 0 WHERE chunk_root = id`)
      await tx.query(`UPDATE entries SET chunk_root = NULL WHERE is_root = 0`)
      await tx.query(`
        UPDATE entries
        SET status = NULL,
            element = NULL, category = NULL, summary = NULL,
            score = NULL, last_seen_at = NULL,
            embedding = NULL, summary_hash = NULL,
            core_summary = NULL, reviewed_at = NULL, promoted_at = NULL,
            error_count = 0
        WHERE is_root = 0
      `)
    })
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    // Force a fresh post-reset cycle1: _cycle1InFlight is guaranteed null
    // here (we drained above and have not awaited any cycle1-starting call
    // since), so calling _startCycle1Run directly skips the coalesce branch
    // inside _awaitCycle1Run and guarantees the newly demoted rows are read.
    const r1 = await startCycle1Run(config?.cycle1 || {}, { signal })
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    let rebuildC2Options = { signal }
    if (typeof rebuildC2Options?.callLlm !== 'function') {
      rebuildC2Options = { ...rebuildC2Options, callLlm: getCycle2CallLlm() }
    }
    const r2 = await runCycle2(db, config?.cycle2 || {}, rebuildC2Options, DATA_DIR)
    await finalizeCycle2Run(r2)
    return { text: `rebuild: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
  }

  async function _handleMemPrune(args, _config) {
    const db = getDb()
    if (args.confirm !== 'PRUNE OLD ENTRIES') {
      return { text: 'prune requires confirm: "PRUNE OLD ENTRIES" (permanently deletes unclassified entries older than maxDays)', isError: true }
    }
    const days = Math.max(1, Number(args.maxDays ?? 30))
    const result = await pruneOldEntries(db, days)
    return { text: `prune: deleted ${result.deleted} unclassified entries older than ${days} days` }
  }

  async function _handleMemBackfill(args, config, signal) {
    const db = getDb()
    // Whole-action mutex (transport-agnostic). _cycle1InFlight only protects
    // cycle1; ingest workers + cycle2 can still overlap if a second backfill
    // kicks in (timeout-retry, parallel callers, /api/tool vs /mcp vs
    // /admin/backfill). Sentinel is set synchronously before any await so a
    // burst of concurrent calls cannot all pass the check.
    if (_backfillInFlight) {
      return { text: 'backfill already in progress', isError: true }
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const window = args.window != null ? String(args.window) : '7d'
    const scope = args.scope != null ? String(args.scope) : 'all'
    const limit = args.limit != null ? Math.max(1, Number(args.limit)) : null
    // Capture the cycle2 envelope so we can route through _finalizeCycle2Run
    // (which records cycle2_last_error and clears scheduler delay only on
    // ok:true) rather than stamping cycle2 unconditionally afterward.
    let _capturedCycle2
    const promise = runFullBackfill(db, {
      window,
      scope,
      limit,
      config,
      dataDir: DATA_DIR,
      ingestTranscriptFile,
      cwdFromTranscriptPath,
      // Re-check the IPC cancel signal at every cycle1/cycle2 iteration the
      // backfill driver dispatches. handleMemoryAction only checks once
      // before dispatch; without per-iteration checkpoints a long-running
      // backfill keeps spinning through ingest + cycle1 + cycle2 batches
      // after the proxy has already responded "cancelled" to the caller.
      runCycle1: (dbArg, cycle1Config = {}, options = {}, _dir) => {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        return awaitCycle1Run(cycle1Config, { ...options, signal })
      },
      runCycle2: async (dbArg, c2Config, c2Options, c2DataDir) => {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        let backfillC2Options = { ...c2Options, signal }
        if (typeof backfillC2Options?.callLlm !== 'function') {
          backfillC2Options = { ...backfillC2Options, callLlm: getCycle2CallLlm() }
        }
        const r2 = await runCycle2(dbArg, c2Config, backfillC2Options, c2DataDir)
        _capturedCycle2 = r2
        return r2
      },
    })
    _backfillInFlight = promise
    let result
    try {
      result = await promise
    } finally {
      if (_backfillInFlight === promise) _backfillInFlight = null
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    if (_capturedCycle2) {
      await finalizeCycle2Run(_capturedCycle2)
    }
    return {
      text: `backfill: window=${result.window} scope=${result.scope} files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} promoted=${result.promoted} unclassified=${result.unclassified}`,
    }
  }

  async function handleMemoryAction(args, signal) {
    const db = getDb()
    // Cooperative abort check: surfaces caller-cancel (IPC cancel handler)
    // before any long DB work begins on the worker side.
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const action = String(args.action ?? '')
    const config = readMainConfig()

    if (action === 'status') {
      return _handleMemStatus(args, config)
    }

    if (action === 'cycle1') {
      return _handleMemCycle1(args, config, signal)
    }

    if (action === 'cycle2' || action === 'sleep') {
      return _handleMemCycle2(args, config, signal)
    }

    if (action === 'cycle3') {
      return _handleMemCycle3(args, config, signal)
    }

    // Direct semantic-search surface for callers that want raw ranked rows
    // without going through the Lead-side recall synthesizer. The
    // handleSearch executor is exposed through the public `memory` tool action
    // `search` so callers can hit the hybrid CTE directly.
    if (action === 'search') {
      return handleSearch(args, signal)
    }

    if (action === 'flush') {
      return _handleMemFlush(args, config, signal)
    }

    if (action === 'rebuild') {
      return _handleMemRebuild(args, config, signal)
    }

    if (action === 'prune') {
      return _handleMemPrune(args, config)
    }

    if (action === 'backfill') {
      return _handleMemBackfill(args, config, signal)
    }

    if (action === 'ingest_session') {
      return ingestSessionMessages(args)
    }

    if (action === 'dump_session_roots') {
      return dumpSessionRootChunks(args)
    }

    if (action === 'manage') {
      const op = String(args.op ?? '').trim().toLowerCase()
      if (!['add', 'edit', 'delete'].includes(op)) {
        return { text: 'manage requires op: "add" | "edit" | "delete"', isError: true }
      }
      const VALID_CAT = new Set(['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue'])
      const VALID_STATUS = new Set(['pending', 'active', 'archived'])

      if (op === 'add') {
        const element = String(args.element ?? '').trim()
        const summary = String(args.summary ?? args.element ?? '').trim()
        const category = String(args.category ?? 'fact').trim().toLowerCase()
        if (!element || !summary) {
          return { text: 'manage add requires element and summary', isError: true }
        }
        if (!VALID_CAT.has(category)) {
          return { text: `manage add: invalid category "${category}". Valid: ${[...VALID_CAT].join(', ')}`, isError: true }
        }
        const nowMs = Date.now()
        const sourceRef = `manual:${nowMs}-${process.pid}`
        const manageProjectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
        try {
          let newId
          await db.transaction(async (tx) => {
            const result = await tx.query(`
              INSERT INTO entries(ts, role, content, source_ref, session_id, project_id)
              VALUES ($1, 'system', $2, $3, NULL, $4)
              RETURNING id
            `, [nowMs, element + ' — ' + summary, sourceRef, manageProjectId])
            newId = Number(result.rows[0].id)
            const score = computeEntryScore(category, nowMs, nowMs)
            await tx.query(`
              UPDATE entries
              SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
                  status = 'active', score = $5, last_seen_at = $6
              WHERE id = $7
            `, [newId, element, category, summary, score, nowMs, newId])
          })
          await syncRootEmbedding(db, newId)
          return { text: `added (id=${newId}): [${category}] ${element} — ${summary.slice(0, 200)}` }
        } catch (e) {
          return { text: `manage add failed: ${e.message}`, isError: true }
        }
      }

      if (op === 'edit') {
        const id = Number(args.id)
        if (!Number.isFinite(id) || id <= 0) {
          return { text: 'manage edit requires numeric id', isError: true }
        }
        const existing = (await db.query(
          `SELECT id, element, summary, category, status, ts, is_root FROM entries WHERE id = $1`,
          [id]
        )).rows[0]
        if (!existing) return { text: `manage edit: no entry with id=${id}`, isError: true }
        if (existing.is_root !== 1) return { text: `manage edit: id=${id} is not a root`, isError: true }

        const trimOrNull = v => {
          if (v == null) return null
          const s = String(v).trim()
          return s === '' ? null : s
        }
        const newElement = trimOrNull(args.element)
        const newSummary = trimOrNull(args.summary)
        const newCategory = trimOrNull(args.category)?.toLowerCase() ?? null
        const newStatus = trimOrNull(args.status)?.toLowerCase() ?? null

        if (!newElement && !newSummary && !newCategory && !newStatus) {
          return { text: 'manage edit requires at least one field: element, summary, category, status', isError: true }
        }
        if (newCategory && !VALID_CAT.has(newCategory)) {
          return { text: `manage edit: invalid category "${newCategory}". Valid: ${[...VALID_CAT].join(', ')}`, isError: true }
        }
        if (newStatus && !VALID_STATUS.has(newStatus)) {
          return { text: `manage edit: invalid status "${newStatus}". Valid: ${[...VALID_STATUS].join(', ')}`, isError: true }
        }

        const finalElement = newElement ?? existing.element
        const finalSummary = newSummary ?? existing.summary
        const finalCategory = newCategory ?? existing.category
        const finalStatus = newStatus ?? existing.status
        const nowMs = Date.now()
        const score = computeEntryScore(finalCategory, nowMs, nowMs)
        const textChanged = newElement != null || newSummary != null
        // Guard null element/summary: a category/status-only edit on a root
        // whose element or summary is NULL would otherwise persist literal
        // 'null — null' content and explode on finalSummary.slice() below.
        // Use empty-string sentinels for the content composition + render so
        // the row stays consistent with what's actually stored.
        const elementStr = finalElement == null ? '' : String(finalElement)
        const summaryStr = finalSummary == null ? '' : String(finalSummary)
        const composedContent = elementStr || summaryStr
          ? `${elementStr}${summaryStr ? ' — ' + summaryStr : ''}`
          : ''

        try {
          await db.query(`
            UPDATE entries
            SET element = $1, summary = $2, category = $3, status = $4, score = $5,
                last_seen_at = $6, content = $7
            WHERE id = $8
          `, [finalElement, finalSummary, finalCategory, finalStatus, score,
              nowMs, composedContent, id])
        } catch (e) {
          return { text: `manage edit failed: ${e.message}`, isError: true }
        }
        if (textChanged) {
          try { await syncRootEmbedding(db, id) } catch (e) {
            log(`[memory.manage] embedding resync failed (id=${id}): ${e.message}\n`)
          }
        }
        return { text: `edited (id=${id}): [${finalCategory}/${finalStatus}] ${elementStr}${summaryStr ? ' — ' + summaryStr.slice(0, 200) : ''}` }
      }

      if (op === 'delete') {
        const id = Number(args.id)
        if (!Number.isFinite(id) || id <= 0) {
          return { text: 'manage delete requires numeric id', isError: true }
        }
        const info = (await db.query(
          `SELECT id, category, element, is_root FROM entries WHERE id = $1`,
          [id]
        )).rows[0]
        if (!info) return { text: `manage delete: no entry with id=${id}`, isError: true }
        try {
          const result = info.is_root === 1
            ? await db.query(`DELETE FROM entries WHERE id = $1 OR chunk_root = $2`, [id, id])
            : await db.query(`DELETE FROM entries WHERE id = $1`, [id])
          return { text: `deleted (id=${id}, rows=${Number(result.rowCount ?? result.affectedRows ?? 0)}): [${info.category ?? '-'}] ${info.element ?? ''}` }
        } catch (e) {
          return { text: `manage delete failed: ${e.message}`, isError: true }
        }
      }

      return { text: `manage: unhandled op "${op}"`, isError: true }
    }

    if (action === 'core') {
      const op = String(args.op ?? '').trim().toLowerCase()
      if (!['add', 'edit', 'delete', 'list', 'candidates', 'promote', 'dismiss'].includes(op)) {
        return { text: 'core requires op: "add" | "edit" | "delete" | "list" | "candidates" | "promote" | "dismiss"', isError: true }
      }
      const coreDataDir = (typeof DATA_DIR === 'string' ? DATA_DIR : resolvePluginData())
      if (!coreDataDir) return { text: 'core: memory data dir is not initialized', isError: true }
      // Core-candidate promotion pipeline (proposal mode). The candidate flag
      // lives on generated `entries`, which carry a project_id, so these ops MUST
      // be project-scoped just like add/edit/delete — an unscoped listing/promote
      // would leak candidates across projects. project_id resolution mirrors the
      // block below: 'common'/null → COMMON (project_id NULL), '*' → all pools
      // (candidates op only, same escape hatch as op:'list'). UI calls exactly
      // these op names.
      if (op === 'candidates' || op === 'promote' || op === 'dismiss') {
        const hasPid = Object.prototype.hasOwnProperty.call(args, 'project_id')
        const scope = (() => {
          if (!hasPid || args.project_id == null) return null
          const s = String(args.project_id).trim()
          if (s === '' || s.toLowerCase() === 'common') return null
          if (s === '*') return '*'
          return s
        })()
        try {
          if (op === 'candidates') {
            const list = await listCoreCandidates(coreDataDir, scope)
            if (list.length === 0) return { text: 'core candidates: none' }
            return {
              text: list.map(c =>
                // project=<pool> lets the UI thread project_id into the follow-up
                // promote/dismiss call — matters under project_id:'*' listing where
                // rows span pools. Uses the same COMMON/slug convention as op:'list'.
                `id=${c.id} project=${c.project_id == null ? 'COMMON' : c.project_id} [${c.category}] score=${c.score == null ? '-' : c.score.toFixed(2)} ${c.element} — ${String(c.summary || '').slice(0, 200)} (${c.reason})`,
              ).join('\n'),
            }
          }
          // promote/dismiss operate on a single id but are scope-guarded: the
          // candidate must belong to the resolved scope (or COMMON), never '*'.
          if (scope === '*') {
            return { text: `core ${op}: project_id "*" only valid for op="candidates"`, isError: true }
          }
          if (op === 'promote') {
            const entry = await promoteCoreCandidate(coreDataDir, args.id, { ...args, scope })
            const mergeNote = entry.merged_with ? ` (merged into core id=${entry.merged_with}, sim=${entry.sim})` : ''
            return { text: `core promoted candidate id=${args.id} → core id=${entry.id}${mergeNote}: [${entry.category}] ${entry.element}` }
          }
          // dismiss
          const removed = await dismissCoreCandidate(coreDataDir, args.id, { scope })
          return { text: `core candidate dismissed (id=${removed.id}): [${removed.category}] ${removed.element}` }
        } catch (e) {
          return { text: `core ${op} failed: ${e.message}`, isError: true }
        }
      }
      // Local trim helper — the manage-block trimOrNull at :1807 is scoped to
      // that branch and unreachable from here.
      // Normalize project_id: 'common' (case-insensitive) or null → null (COMMON pool); non-empty string → slug.
      const hasProjectIdKey = Object.prototype.hasOwnProperty.call(args, 'project_id')
      const projectId = (() => {
        if (!hasProjectIdKey || args.project_id == null) return null
        const s = String(args.project_id).trim()
        if (s === '' || s.toLowerCase() === 'common') return null
        if (s === '*') return '*'
        return s
      })()
      try {
        if (projectId === '*' && op !== 'list') {
          return { text: `core ${op}: project_id "*" only valid for op="list"`, isError: true }
        }
        if (op === 'list') {
          if (projectId !== '*') {
            const entries = await listCore(coreDataDir, projectId)
            if (entries.length === 0) return { text: 'core: empty' }
            return { text: entries.map(e => `id=${e.id} [${e.category}] ${e.element} — ${String(e.summary || '').slice(0, 200)}`).join('\n') }
          }
          // Cross-pool listing — group by project_id, COMMON first
          const entries = await listCore(coreDataDir, '*')
          if (entries.length === 0) return { text: 'core: empty' }
          const groups = new Map()
          for (const e of entries) {
            const key = e.project_id ?? null
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key).push(e)
          }
          const lines = []
          for (const [key, rows] of groups) {
            lines.push(`${key === null ? 'COMMON' : key}:`)
            for (const e of rows) {
              lines.push(`  id=${e.id} [${e.category}] ${e.element} — ${String(e.summary || '').slice(0, 200)}`)
            }
          }
          return { text: lines.join('\n') }
        }
        if (op === 'add') {
          if (!hasProjectIdKey) {
            return { text: 'core add: project_id required — pass "common" for COMMON pool, or project slug like "owner/repo" for scoped pool', isError: true }
          }
          const entry = await addCore(coreDataDir, args, projectId)
          return { text: `core added (id=${entry.id}): [${entry.category}] ${entry.element} — ${entry.summary.slice(0, 200)}` }
        }
        if (op === 'edit') {
          const entry = await editCore(coreDataDir, args.id, args)
          return { text: `core edited (id=${entry.id}): [${entry.category}] ${entry.element} — ${entry.summary.slice(0, 200)}` }
        }
        if (op === 'delete') {
          const removed = await deleteCore(coreDataDir, args.id)
          return { text: `core deleted (id=${removed.id}): [${removed.category}] ${removed.element}` }
        }
      } catch (e) {
        return { text: `core ${op} failed: ${e.message}`, isError: true }
      }
      return { text: `core: unhandled op "${op}"`, isError: true }
    }

    if (action === 'purge') {
      if (args.confirm !== 'DELETE ALL MEMORY') {
        return { text: 'purge requires confirm: "DELETE ALL MEMORY"', isError: true }
      }
      const preCount = (await db.query(`SELECT COUNT(*) c FROM entries`)).rows[0].c
      const coreCount = (await db.query(`SELECT COUNT(*) c FROM core_entries`)).rows[0].c
      try {
        await db.query(`DELETE FROM entries`)
      } catch (e) {
        return { text: `purge failed: ${e.message}`, isError: true }
      }
      return { text: `purged generated memory entries (count=${preCount}); user core preserved (core_entries=${coreCount})` }
    }

    if (action === 'retro_eval_active') {
      if (args.confirm !== 'REEVAL ACTIVE') {
        return { text: 'retro_eval_active requires confirm: "REEVAL ACTIVE" (heavy LLM batch op — reviews all active roots through the unified gate)', isError: true }
      }
      const RETRO_BATCH = 50
      const cycle2Config = config?.cycle2 || {}
      const allActive = (await db.query(
        `SELECT id, element, category, summary, score, last_seen_at, project_id, status, reviewed_at
         FROM entries WHERE is_root = 1 AND status = 'active'
         ORDER BY reviewed_at ASC, id ASC`
      )).rows
      const total = allActive.length
      let archived = 0, kept = 0, updated = 0, merged = 0, errors = 0
      const nowMs = Date.now()
      for (let offset = 0; offset < total; offset += RETRO_BATCH) {
        const batch = allActive.slice(offset, offset + RETRO_BATCH)
        const batchIds = batch.map(r => Number(r.id))
        const activeContext = (await db.query(
          `SELECT id, element, category, summary, score, last_seen_at, project_id, status
           FROM entries WHERE is_root = 1 AND status = 'active'
           ORDER BY score DESC, last_seen_at DESC, id ASC LIMIT 200`
        )).rows
        let gateResult
        try {
          gateResult = await runUnifiedGate(db, batch, activeContext, cycle2Config, { activeCap: 200 })
        } catch (err) {
          log(`[retro_eval_active] runUnifiedGate failed (offset=${offset}): ${err.message}\n`)
          errors += batch.length
          continue
        }
        if (gateResult?.parseOk === false || gateResult?.actions === null) {
          errors += batch.length
          continue
        }
        const actions = gateResult?.actions ?? []
        // Separate explicit `core` summary lines from primary verbs so an
        // update/merge/active also refreshes the injected core_summary — mirrors
        // the cycle2 apply path (memory-cycle2.mjs). Without this, retro could
        // rewrite a root's summary while leaving its core_summary stale.
        const coreSummaryById = new Map()
        const primaryActions = []
        for (const a of actions) {
          if (a?.action === 'core') {
            const cid = Number(a.entry_id)
            const core = String(a.core_summary ?? '').replace(/\s+/g, ' ').trim().slice(0, CORE_SUMMARY_MAX)
            if (Number.isFinite(cid) && core) coreSummaryById.set(cid, core)
          } else {
            primaryActions.push(a)
          }
        }
        const allowed = new Set(batchIds)
        const rejected = gateResult?.rejected ?? new Set()
        // Partial-apply contract: rows the gate never returned a verdict for
        // (missingIds) must NOT be marked reviewed — they are left for a later
        // run. Exclude both rejected and missing ids from the reviewed set.
        const missing = new Set((gateResult?.missingIds ?? []).map(Number))
        const successIds = new Set(batchIds.filter(id => !rejected.has(id) && !missing.has(id)))
        for (const id of successIds) {
          try { await db.query(`UPDATE entries SET reviewed_at = $1 WHERE id = $2`, [nowMs, id]) } catch {}
        }
        const setCoreSummary = async (entryId, core) => {
          if (!core) return
          try { await db.query(`UPDATE entries SET core_summary = $1 WHERE id = $2 AND is_root = 1`, [core, Number(entryId)]) }
          catch (err) { log(`[retro_eval_active] core_summary update failed (id=${entryId}): ${err.message}\n`) }
        }
        if (!primaryActions.length) { kept += batch.filter(r => successIds.has(Number(r.id))).length; continue }
        const acted = new Set()
        const rowById = new Map(batch.map(r => [Number(r.id), r]))
        for (const act of primaryActions) {
          try {
            const eid = Number(act?.entry_id)
            if (!Number.isFinite(eid) || !allowed.has(eid)) continue
            acted.add(eid)
            // Optimistic guard: skip if the row moved since this batch was read.
            const snap = rowById.get(eid)
            const expected = snap ? { status: snap.status, reviewedAt: snap.reviewed_at } : null
            if (act.action === 'archived') {
              if (await applySimpleStatus(db, eid, 'archived', expected)) archived += 1
            } else if (act.action === 'active') {
              // active → active is a keep verdict from the gate.
              kept += 1
              await setCoreSummary(eid, coreSummaryById.get(eid))
            } else if (act.action === 'update') {
              if (await applyUpdate(db, eid, act.element, act.summary, { expected })) updated += 1
              await setCoreSummary(eid, coreSummaryById.get(eid))
            } else if (act.action === 'merge') {
              const targetId = Number(act?.target_id)
              const sourceIds = Array.isArray(act?.source_ids) ? act.source_ids : []
              if (!Number.isFinite(targetId) || !allowed.has(targetId)) {
                log(`[retro_eval_active] merge target outside batch (id=${targetId})\n`)
                acted.delete(eid)
                continue
              }
              const filteredSources = sourceIds.filter(s => allowed.has(Number(s)))
              if (filteredSources.length !== sourceIds.length) {
                log(
                  `[retro_eval_active] merge sources filtered: ${JSON.stringify(sourceIds)} -> ${JSON.stringify(filteredSources)}\n`,
                )
              }
              acted.add(targetId)
              filteredSources.forEach(s => acted.add(Number(s)))
              const moved = await applyMerge(db, targetId, filteredSources)
              if (moved > 0) {
                merged += moved
                if (typeof act.element === 'string' || typeof act.summary === 'string') {
                  try {
                    if (await applyUpdate(db, targetId, act.element, act.summary)) updated += 1
                  } catch (err) {
                    log(`[retro_eval_active] merge target update failed (target=${targetId}): ${err.message}\n`)
                  }
                }
                await setCoreSummary(targetId, coreSummaryById.get(targetId) || coreSummaryById.get(eid))
              }
            }
          } catch (err) {
            log(`[retro_eval_active] action error (id=${act?.entry_id}): ${err.message}\n`)
            errors += 1
          }
        }
        // Entries in successIds but not acted-upon (omit / no-op) are kept.
        kept += batch.filter(r => successIds.has(Number(r.id)) && !acted.has(Number(r.id))).length
      }
      return { text: `retro_eval_active: total=${total} archived=${archived} kept=${kept} updated=${updated} merged=${merged} errors=${errors}` }
    }

    return { text: `unknown memory action: ${action}`, isError: true }
  }

  async function handleToolCall(name, args, signal) {
    try {
      if (name === 'search_memories') {
        const result = await handleSearch(args || {}, signal)
        return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
      }
      if (name === 'recall') {
        // recall is aiWrapped in the unified build; in standalone mode map it to
        // search_memories so the advertised tool name actually works. Forward
        // every advertised arg so id/limit/offset/sort/includeArchived/
        // includeMembers/includeRaw reach handleSearch instead of being dropped.
        const a = args || {}
        const hasQuery = Array.isArray(a.query)
          ? a.query.some((value) => String(value || '').trim())
          : String(a.query ?? '').trim() !== ''
        const recallIds = hasQuery
          ? []
          : (Array.isArray(a.id) ? a.id : [a.id])
              .map((value) => Number(value))
              .filter((value) => Number.isInteger(value) && value > 0)
        const searchArgs = {
          ...(a.query !== undefined ? { query: a.query } : {}),
          ...(recallIds.length > 0 ? { ids: recallIds } : {}),
          ...(a.period ? { period: a.period } : {}),
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
          ...(a.offset !== undefined ? { offset: a.offset } : {}),
          ...(a.sort !== undefined ? { sort: a.sort } : {}),
          ...(a.category !== undefined ? { category: a.category } : {}),
          ...(a.includeArchived !== undefined ? { includeArchived: a.includeArchived } : {}),
          ...(a.includeMembers !== undefined ? { includeMembers: a.includeMembers } : {}),
          ...(a.includeRaw !== undefined ? { includeRaw: a.includeRaw } : {}),
          ...(a.cwd ? { cwd: a.cwd } : {}),
          ...(a.projectScope ? { projectScope: a.projectScope } : {}),
          ...(a.sessionId ? { sessionId: a.sessionId } : {}),
          ...(a.session_id ? { session_id: a.session_id } : {}),
          ...(a.currentSession !== undefined ? { currentSession: a.currentSession } : {}),
          // Hint only — never a filter. Marks the caller's own session as
          // "(current)" in the multi-session grouped browse output.
          ...(a.currentSessionId ? { currentSessionId: a.currentSessionId } : {}),
        }
        const result = await handleSearch(searchArgs, signal)
        return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
      }
      if (name === 'memory') {
        const result = await handleMemoryAction(args || {}, signal)
        return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
      }
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true }
    }
  }

  return { handleMemoryAction, handleToolCall }
}
