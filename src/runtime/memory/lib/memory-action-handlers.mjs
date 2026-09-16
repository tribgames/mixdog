// Memory action + tool-call handlers extracted from index.mjs.
//
// The write/maintenance action cluster: the per-action `_handleMem*` helpers,
// the `manage`/`core`/`purge` inline branches, and the
// `memory`/`search_memories`/`recall` tool dispatch. Pure cycle/store/score
// helpers are imported directly; live DB handle, config reader, cycle
// scheduler primitives, cycle-LLM adapters, query handlers, and the transcript
// ingest helpers are injected so the facade keeps ownership of `db`, the
// scheduler, and lifecycle state. The whole-action backfill mutex lives here
// (facade-local previously) since it only guards this module's backfill path.

import {
  runCycle1,
  runCycle2,
  syncRootEmbedding,
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
  normalizeCoreInput,
  normalizeCoreOp,
} from './core-memory-store.mjs'
import { resolveProjectScope } from './project-id-resolver.mjs'
import { resolvePluginData } from '../../shared/plugin-paths.mjs'
import { getMetaValue, isBootstrapComplete } from './memory.mjs'
import { createToolCallHandler } from './tool-call-handler.mjs'
import { listManagedMemories, formatManagedMemories } from './core-memory-management.mjs'
import { publicCoreMemoryIdentity, resolveCoreMemoryIndex } from './core-memory-index.mjs'

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
  getSchedulerCycle1InFlight,
  getCycle2CallLlm,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
  addCoreImpl = addCore,
  editCoreImpl = editCore,
  deleteCoreImpl = deleteCore,
  refreshCoreMemoryFile = async () => {},
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
    const cycle2Config = { ...(config?.cycle2 || {}) }
    if (Number.isFinite(Number(args?.batch_size))) {
      cycle2Config.batch_size = Math.max(1, Math.floor(Number(args.batch_size)))
    }
    const result = await runCycle2(db, cycle2Config, c2Options)
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    await finalizeCycle2Run(result)
    const counts = {
      processed: result?.processed || 0,
      merged: result?.merged || 0,
      linked: result?.linked || 0,
      kept: result?.kept || 0,
      held: result?.held || 0,
      deferred: result?.deferred || 0,
    }
    const parts = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`)
    if (result?.ok === false) return { text: `cycle2 failed: ${result.error || 'unknown'} ${parts.join(' ')}`.trim(), isError: true }
    if (parts.length) return { text: `cycle2 ${parts.join(' ')}` }
    // No applied counts — distinguish an in-flight skip from an empty queue.
    let cause = ''
    if (result?.skippedInFlight) cause = ' (skipped: in-flight)'
    return { text: `cycle2 noop${cause}` }
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
    const r2 = await runCycle2(db, config?.cycle2 || {}, flushC2Options)
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    await finalizeCycle2Run(r2)
    return { text: `flush: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}`, isError: r2.ok === false }
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
    const lines = [
      `entries: total=${stats.total} roots=${stats.roots} cycle1_raw=${stats.unchunked_leaves} (unchunked leaves) cycle2_pending=${stats.cycle2_pending_roots} (awaiting cycle2 review)`,
      `status: ${stats.byStatus.map(r => `${r.status ?? '?'}:${r.c}`).join(', ') || 'empty'}`,
      `categories: ${stats.byCategory.map(r => `${r.category ?? 'NULL'}:${r.c}`).join(', ') || 'empty'}`,
      `core_memory: user=${stats.core_entries} embed_null=${stats.core_embed_null}`,
      `embedding_index: ready dims=${dims}${dimsErr ? ` (meta_read_error: ${dimsErr})` : ''}`,
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
            reviewed_at = NULL, cycle2_reviewed_at = NULL, duplicate_of = NULL,
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
            reviewed_at = NULL, cycle2_reviewed_at = NULL, duplicate_of = NULL,
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
    const r2 = await runCycle2(db, config?.cycle2 || {}, rebuildC2Options)
    await finalizeCycle2Run(r2)
    return { text: `rebuild: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}`, isError: r2.ok === false }
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
      signal,
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
      runCycle2: async (dbArg, c2Config, c2Options) => {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        let backfillC2Options = { ...c2Options, signal }
        if (typeof backfillC2Options?.callLlm !== 'function') {
          backfillC2Options = { ...backfillC2Options, callLlm: getCycle2CallLlm() }
        }
        const r2 = await runCycle2(dbArg, c2Config, backfillC2Options)
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
      text: `backfill: window=${result.window} scope=${result.scope} files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} reviewed=${result.reviewed} unclassified=${result.unclassified}${result.error ? ` error=${result.error}` : ''}`,
      isError: result.ok === false,
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
      if (Object.prototype.hasOwnProperty.call(args, 'status')) {
        return { text: 'manage: history importance classification is no longer supported', isError: true }
      }

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
                  status = 'pending', score = $5, last_seen_at = $6
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
        if (!newElement && !newSummary && !newCategory) {
          return { text: 'manage edit requires at least one field: element, summary, category', isError: true }
        }
        if (newCategory && !VALID_CAT.has(newCategory)) {
          return { text: `manage edit: invalid category "${newCategory}". Valid: ${[...VALID_CAT].join(', ')}`, isError: true }
        }

        const finalElement = newElement ?? existing.element
        const finalSummary = newSummary ?? existing.summary
        const finalCategory = newCategory ?? existing.category
        const nowMs = Date.now()
        const score = computeEntryScore(finalCategory, nowMs, nowMs)
        const textChanged = newElement != null || newSummary != null
        // Guard null element/summary: a category-only edit on a root
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
          await db.transaction(async tx => {
            // Editing either side invalidates the duplicate equivalence, not
            // the original chunks or their lineage.
            await tx.query(`UPDATE entries SET duplicate_of = NULL, cycle2_reviewed_at = NULL WHERE duplicate_of = $1`, [id])
            await tx.query(`
              UPDATE entries
              SET element = $1, summary = $2, category = $3, score = $4,
                  last_seen_at = $5, content = $6, cycle2_reviewed_at = NULL, duplicate_of = NULL
              WHERE id = $7
            `, [finalElement, finalSummary, finalCategory, score,
                nowMs, composedContent, id])
          })
        } catch (e) {
          return { text: `manage edit failed: ${e.message}`, isError: true }
        }
        if (textChanged) {
          try { await syncRootEmbedding(db, id) } catch (e) {
            log(`[memory.manage] embedding resync failed (id=${id}): ${e.message}\n`)
          }
        }
        return { text: `edited (id=${id}): [${finalCategory}] ${elementStr}${summaryStr ? ' — ' + summaryStr.slice(0, 200) : ''}` }
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
      const op = normalizeCoreOp(args.op)
      if (!['add', 'edit', 'delete', 'list'].includes(op)) {
        return { text: 'core requires op: add | edit | delete | list', isError: true }
      }
      const coreDataDir = (typeof DATA_DIR === 'string' ? DATA_DIR : resolvePluginData())
      if (!coreDataDir) return { text: 'core: memory data dir is not initialized', isError: true }
      // Local trim helper — the manage-block trimOrNull at :1807 is scoped to
      // that branch and unreachable from here.
      // An explicit project_id wins. Otherwise infer from the active cwd/session
      // and fall back to COMMON.
      const hasProjectIdKey = Object.prototype.hasOwnProperty.call(args, 'project_id')
      const projectIdText = typeof args.project_id === 'string' ? args.project_id.trim() : ''
      const projectId = (() => {
        if (!hasProjectIdKey || !projectIdText) return resolveProjectScope(args.cwd)
        if (projectIdText.toLowerCase() === 'common') return null
        return projectIdText
      })()
      try {
        if (args.source && args.source !== 'curated') {
          return { text: 'memory manages user-curated entries only; use recall for generated history.', isError: true }
        }
        if (op === 'add' || op === 'edit') {
          // Category is intentionally absent from the public memory schema.
          // New direct entries use normalizeCoreInput's internal compatibility
          // default; edits omit the field so editCore preserves the stored value.
          const categoryFreeArgs = { ...args }
          delete categoryFreeArgs.category
          const normalized = normalizeCoreInput(categoryFreeArgs, {
            requireElement: true,
            requireSummary: true,
            requireCategory: false,
          })
          const errors = [...normalized.errors]
          if (op === 'add') {
            if (projectId === '*') {
              errors.unshift('project_id "*" only valid for op="list"')
            }
          }
          if (errors.length) {
            return { text: `core ${op}: ${errors.join('; ')}`, isError: true }
          }
          args = {
            ...categoryFreeArgs,
            element: normalized.element,
            summary: normalized.summary,
            ...(op === 'add' ? { category: normalized.category } : {}),
          }
        }
        if (projectId === '*' && op !== 'list') {
          return { text: `core ${op}: project_id "*" only valid for op="list"`, isError: true }
        }
        if (op === 'list') {
          const page = await listManagedMemories(getDb(), projectId, args)
          return { text: args.format === 'json' ? JSON.stringify(page) : formatManagedMemories(page), ...page }
        }
        if (op === 'add') {
          const entry = await addCoreImpl(coreDataDir, args, projectId)
          await refreshCoreMemoryFile('core-add')
          return { text: `core added (${await publicCoreMemoryIdentity(getDb(), entry)}): ${entry.element} — ${entry.summary.slice(0, 200)}` }
        }
        if (op === 'edit') {
          const hasTargetProjectId = Object.prototype.hasOwnProperty.call(args, 'target_project_id')
          const targetProjectId = hasTargetProjectId
            ? (() => {
                const value = String(args.target_project_id ?? '').trim()
                return !value || value.toLowerCase() === 'common' ? null : value
              })()
            : typeof args.target_cwd === 'string' && args.target_cwd
              ? resolveProjectScope(args.target_cwd)
              : projectId
          const recordId = await resolveCoreMemoryIndex(getDb(), projectId, args.id, args.index_revision)
          const entry = await editCoreImpl(coreDataDir, recordId, {
            ...args,
            expectedProjectId: projectId,
            targetProjectId,
          })
          await refreshCoreMemoryFile('core-edit')
          return { text: `core edited (${await publicCoreMemoryIdentity(getDb(), entry)}): ${entry.element} — ${entry.summary.slice(0, 200)}` }
        }
        if (op === 'delete') {
          const recordId = await resolveCoreMemoryIndex(getDb(), projectId, args.id, args.index_revision)
          const removed = await deleteCoreImpl(coreDataDir, recordId, { expectedProjectId: projectId })
          await refreshCoreMemoryFile('core-delete')
          return { text: `core deleted (project=${projectId ?? 'COMMON'} id=${args.id}): ${removed.element}. Remaining indices were compacted; list memories before the next write.` }
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

    return {
      text: `unknown memory action: ${action}; valid: core, status. Mutation verbs belong in op.`,
      isError: true,
    }
  }

  const handleToolCall = createToolCallHandler({ handleSearch, handleMemoryAction })

  return { handleMemoryAction, handleToolCall }
}
