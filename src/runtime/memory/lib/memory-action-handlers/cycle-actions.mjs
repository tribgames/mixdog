/**
 * memory-action-handlers/cycle-actions.mjs — the cycle-driven memory actions:
 * cycle1, cycle2/sleep, flush, rebuild and backfill. Cycle scheduler
 * primitives and the cycle2 LLM adapter are injected; the whole-action
 * backfill mutex lives here since it only guards this module's backfill path.
 */
import { runCycle2 } from '../memory-cycle.mjs';
import { getInFlightCycle1 } from '../memory-cycle1.mjs';
import { runFullBackfill } from '../memory-ops-policy.mjs';
import { throwIfAborted } from '../memory-cycle2-shared.mjs';

// `_runCycle1Impl` reads `config?.min_batch ?? config?.cycle1?.min_batch ??
// default` — top-level wins, so overrides are pinned at top-level only.
const CYCLE1_NUMERIC_OVERRIDES = [
  ['min_batch', (args) => args?.min_batch],
  ['session_cap', (args) => args?.session_cap],
  ['batch_size', (args) => args?.batch_size],
  ['window_size', (args) => args?.window_size ?? args?.windowSize],
  [
    'rows_per_session',
    (args) => args?.rows_per_session ?? args?.rowsPerSession ?? args?.max_rows_per_session ?? args?.maxRowsPerSession,
  ],
];

function cycle1ConfigFromArgs(args, baseCycle1) {
  let cycle1Config = baseCycle1;
  for (const [key, pick] of CYCLE1_NUMERIC_OVERRIDES) {
    const value = Number(pick(args));
    if (Number.isFinite(value) && value > 0) cycle1Config = { ...cycle1Config, [key]: value };
  }
  const sessionIdOverride = String(args?.sessionId ?? args?.session_id ?? '').trim();
  if (sessionIdOverride) cycle1Config = { ...cycle1Config, session_id: sessionIdOverride };
  const concurrencyOverride = Number(args?.concurrency);
  if (Number.isFinite(concurrencyOverride) && concurrencyOverride > 0) {
    cycle1Config = { ...cycle1Config, concurrency: Math.min(8, Math.floor(concurrencyOverride)) };
  }
  return cycle1Config;
}

function countOf(list, fallback) {
  return Array.isArray(list) ? list.length : Number(fallback || 0);
}

function cycle1SummaryText(result) {
  const pendingStr = result?.pendingRows != null ? result.pendingRows : 0;
  const inFlightStr = result?.skippedInFlight === true ? 'true' : 'false';
  const timedOutPart = result?.timedOutWaiting === true ? ' timedOut=true' : '';
  const omitted = countOf(result?.omitted_row_ids, result?.quality?.omitted_rows);
  const prefiltered = countOf(result?.prefiltered_row_ids, result?.quality?.prefiltered_rows);
  const failedRows = countOf(result?.failed_row_ids, result?.quality?.failed_rows);
  const invalidChunks = countOf(result?.invalid_chunks, result?.quality?.invalid_chunks);
  return (
    `cycle1: chunks=${result.chunks} processed=${result.processed} skipped_chunks=${result.skipped}` +
    ` omitted=${omitted} prefiltered=${prefiltered} failed_rows=${failedRows} invalid_chunks=${invalidChunks}` +
    ` pending=${pendingStr} inFlight=${inFlightStr}${timedOutPart}`
  );
}

function cycle2SummaryResult(result) {
  const counts = {
    processed: result?.processed || 0,
    merged: result?.merged || 0,
    linked: result?.linked || 0,
    kept: result?.kept || 0,
    held: result?.held || 0,
    deferred: result?.deferred || 0,
  };
  const parts = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`);
  if (result?.ok === false)
    return { text: `cycle2 failed: ${result.error || 'unknown'} ${parts.join(' ')}`.trim(), isError: true };
  if (parts.length) return { text: `cycle2 ${parts.join(' ')}` };
  // No applied counts — distinguish an in-flight skip from an empty queue.
  let cause = '';
  if (result?.skippedInFlight) cause = ' (skipped: in-flight)';
  return { text: `cycle2 noop${cause}` };
}

// Every root-classification column, cleared before demotion. Cleanup must run
// BEFORE demotion: demoting normal roots (chunk_root = id) first and then
// cleaning WHERE is_root = 1 missed exactly the demoted rows, leaving stale
// element/category/summary/score/embedding/summary_hash on rows that had
// just become raw leaves.
const REBUILD_RESET_ROOTS = `
        UPDATE entries
        SET element = NULL, category = NULL, summary = NULL,
            status = 'pending', score = NULL, last_seen_at = NULL,
            embedding = NULL, summary_hash = NULL,
            reviewed_at = NULL, cycle2_reviewed_at = NULL, duplicate_of = NULL,
            error_count = 0
        WHERE is_root = 1
      `;
const REBUILD_RESET_LEAVES = `
        UPDATE entries
        SET status = NULL,
            element = NULL, category = NULL, summary = NULL,
            score = NULL, last_seen_at = NULL,
            embedding = NULL, summary_hash = NULL,
            reviewed_at = NULL, cycle2_reviewed_at = NULL, duplicate_of = NULL,
            error_count = 0
        WHERE is_root = 0
      `;

export function createCycleActions({
  getDb,
  dataDir,
  awaitCycle1Run,
  startCycle1Run,
  finalizeCycle2Run,
  getSchedulerCycle1InFlight,
  getCycle2CallLlm,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
}) {
  // Whole-action backfill mutex. memory-cycle1's _cycle1InFlight only protects
  // cycle1; ingest workers (memory-ops-policy.mjs) and cycle2 can still overlap
  // if a second backfill kicks in (e.g. setup-server timeout + retry). Track the
  // in-flight promise here and reject overlaps with 409.
  let backfillInFlight = null;

  const withCycle2Llm = (options) =>
    typeof options.callLlm === 'function' ? options : { ...options, callLlm: getCycle2CallLlm() };

  async function cycle1(args, config, signal) {
    const cycle1Config = cycle1ConfigFromArgs(args, config?.cycle1 || {});
    const callerDeadlineMs = Number(args?._callerDeadlineMs) || 0;
    throwIfAborted(signal);
    const cycle1Options = callerDeadlineMs > 0 ? { callerDeadlineMs, signal } : { signal };
    if (typeof args?._callLlm === 'function') {
      cycle1Options.callLlm = args._callLlm;
    }
    const result = await awaitCycle1Run(cycle1Config, cycle1Options);
    throwIfAborted(signal);
    return { ...result, text: cycle1SummaryText(result) };
  }

  async function cycle2(args, config, signal) {
    const db = getDb();
    throwIfAborted(signal);
    const cycle2Config = { ...(config?.cycle2 || {}) };
    if (Number.isFinite(Number(args?.batch_size))) {
      cycle2Config.batch_size = Math.max(1, Math.floor(Number(args.batch_size)));
    }
    const result = await runCycle2(db, cycle2Config, withCycle2Llm({ signal }));
    throwIfAborted(signal);
    await finalizeCycle2Run(result);
    return cycle2SummaryResult(result);
  }

  async function flush(_args, config, signal) {
    const db = getDb();
    throwIfAborted(signal);
    const r1 = await awaitCycle1Run(config?.cycle1 || {}, { signal });
    throwIfAborted(signal);
    const r2 = await runCycle2(db, config?.cycle2 || {}, withCycle2Llm({ signal }));
    throwIfAborted(signal);
    await finalizeCycle2Run(r2);
    return {
      text: `flush: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}`,
      isError: r2.ok === false,
    };
  }

  // Drain any pre-reset cycle1 BEFORE the destructive truncation so the
  // post-reset run is not started concurrently against the same DB.
  // _awaitCycle1Run() may release the outer handle on a caller deadline while
  // the inner runCycle1 promise still owns the DB writes. Drain both layers,
  // then loop once more if one layer exposed another promise while awaiting.
  async function drainCycle1(db) {
    const drained = new Set();
    for (;;) {
      const pending = [getSchedulerCycle1InFlight(), getInFlightCycle1(db)].filter((p) => p && !drained.has(p));
      if (pending.length === 0) break;
      for (const promise of pending) {
        drained.add(promise);
        try {
          await promise;
        } catch {}
      }
    }
  }

  async function rebuild(args, config, signal) {
    const db = getDb();
    if (args.confirm !== 'REBUILD MEMORY') {
      return {
        text: 'rebuild requires confirm: "REBUILD MEMORY" (truncates classification columns and re-runs cycles)',
        isError: true,
      };
    }
    await drainCycle1(db);
    throwIfAborted(signal);
    // The whole destructive sequence runs in one transaction so a mid-step
    // failure rolls back rather than leaving a mixed state.
    await db.transaction(async (tx) => {
      await tx.query(REBUILD_RESET_ROOTS);
      await tx.query(`UPDATE entries SET chunk_root = NULL, is_root = 0 WHERE chunk_root = id`);
      await tx.query(`UPDATE entries SET chunk_root = NULL WHERE is_root = 0`);
      await tx.query(REBUILD_RESET_LEAVES);
    });
    throwIfAborted(signal);
    // Force a fresh post-reset cycle1: _cycle1InFlight is guaranteed null
    // here (drained above, no cycle1-starting call awaited since), so calling
    // startCycle1Run directly skips the coalesce branch inside awaitCycle1Run
    // and guarantees the newly demoted rows are read.
    const r1 = await startCycle1Run(config?.cycle1 || {}, { signal });
    throwIfAborted(signal);
    const r2 = await runCycle2(db, config?.cycle2 || {}, withCycle2Llm({ signal }));
    await finalizeCycle2Run(r2);
    return {
      text: `rebuild: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}`,
      isError: r2.ok === false,
    };
  }

  async function backfill(args, config, signal) {
    const db = getDb();
    // Whole-action mutex (transport-agnostic). _cycle1InFlight only protects
    // cycle1; ingest workers + cycle2 can still overlap if a second backfill
    // kicks in (timeout-retry, parallel callers, /api/tool vs /mcp vs
    // /admin/backfill). Sentinel is set synchronously before any await so a
    // burst of concurrent calls cannot all pass the check.
    if (backfillInFlight) {
      return { text: 'backfill already in progress', isError: true };
    }
    throwIfAborted(signal);
    const window = args.window != null ? String(args.window) : '7d';
    const scope = args.scope != null ? String(args.scope) : 'all';
    const limit = args.limit != null ? Math.max(1, Number(args.limit)) : null;
    // Capture the cycle2 envelope so it routes through finalizeCycle2Run
    // (which records cycle2_last_error and clears scheduler delay only on
    // ok:true) rather than stamping cycle2 unconditionally afterward.
    let capturedCycle2;
    const promise = runFullBackfill(db, {
      signal,
      window,
      scope,
      limit,
      config,
      dataDir,
      ingestTranscriptFile,
      cwdFromTranscriptPath,
      // Re-check the IPC cancel signal at every cycle1/cycle2 iteration the
      // backfill driver dispatches. handleMemoryAction only checks once
      // before dispatch; without per-iteration checkpoints a long-running
      // backfill keeps spinning through ingest + cycle1 + cycle2 batches
      // after the proxy has already responded "cancelled" to the caller.
      runCycle1: (_dbArg, cycle1Config = {}, options = {}, _dir) => {
        throwIfAborted(signal);
        return awaitCycle1Run(cycle1Config, { ...options, signal });
      },
      runCycle2: async (dbArg, c2Config, c2Options) => {
        throwIfAborted(signal);
        const r2 = await runCycle2(dbArg, c2Config, withCycle2Llm({ ...c2Options, signal }));
        capturedCycle2 = r2;
        return r2;
      },
    });
    backfillInFlight = promise;
    let result;
    try {
      result = await promise;
    } finally {
      if (backfillInFlight === promise) backfillInFlight = null;
    }
    throwIfAborted(signal);
    if (capturedCycle2) {
      await finalizeCycle2Run(capturedCycle2);
    }
    return {
      text: `backfill: window=${result.window} scope=${result.scope} files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} reviewed=${result.reviewed} unclassified=${result.unclassified}${result.error ? ` error=${result.error}` : ''}`,
      isError: result.ok === false,
    };
  }

  return { cycle1, cycle2, flush, rebuild, backfill };
}
