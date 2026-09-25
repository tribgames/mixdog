// cycle1: the raw-row classifier pass. runCycle1 owns the per-db in-flight gate,
// the advisory lock and request coalescing; _runCycle1Impl orchestrates one
// run out of the cycle1/ modules (plan, rows, window, result).
import { __mixdogMemoryLog } from './memory-log.mjs';
import { createSemaphore, throwIfAborted } from './memory-cycle2-shared.mjs';

import { CYCLE1_INPUT_TOKEN_BUDGET, cycle1SourceBudget, partitionCycle1Rows } from './memory-chunk-quality.mjs';
import { callAgentDispatch } from './agent-ipc.mjs';
import { flushEmbeddingDirty } from './memory-embed.mjs';
import {
  markCycleRequest,
  consumeCycleRequests,
  resolveCoalesceMaxDrains,
  scheduleCoalescedCycleRetry,
  makeCycleRequestSignature,
  resolveCoalesceMaxRetries,
} from './memory-cycle-requests.mjs';
import { CYCLE1_MAX_PACKETS, CYCLE1_PACKET_MAX_ROWS, resolveCycle1Plan } from './cycle1/cycle1-plan.mjs';
import {
  countPendingRows,
  countRawUnchunkedRows,
  fetchCycle1Rows,
  groupRowsBySession,
  uniqueNumbers,
} from './cycle1/cycle1-rows.mjs';
import { processCycle1Window } from './cycle1/cycle1-window.mjs';
import {
  aggregateWindowResults,
  buildCycle1Result,
  cycle1SummaryLine,
  emptyCycle1Result,
} from './cycle1/cycle1-result.mjs';

// Per-db SKIP gate — concurrent callers coalesce into a DB-backed dirty bit;
// the lock holder drains it after the current run instead of making them wait.
const _runCycle1InFlight = new WeakMap();
const _lastCycle1LogAt = new Map();

export function getInFlightCycle1(db) {
  return _runCycle1InFlight.get(db) || null;
}

/** The lean result a cycle1 call returns when it never reached the classifier. */
async function cycle1SkipResult(db, extra = {}) {
  return {
    processed: 0,
    chunks: 0,
    skipped: 0,
    sessions: 0,
    skippedInFlight: true,
    pendingRows: await countPendingRows(db),
    ...extra,
  };
}

function logCycle1Throttled(key, message, intervalMs = 60_000) {
  const now = Date.now();
  const last = _lastCycle1LogAt.get(key) || 0;
  if (now - last < intervalMs) return;
  _lastCycle1LogAt.set(key, now);
  __mixdogMemoryLog(message);
}

export function packCycle1Windows(
  rowsBySession,
  packetSize = CYCLE1_PACKET_MAX_ROWS,
  maxPackets = CYCLE1_MAX_PACKETS,
  inputTokenBudget = CYCLE1_INPUT_TOKEN_BUDGET
) {
  const size = Math.min(CYCLE1_PACKET_MAX_ROWS, Math.max(1, Number(packetSize) || CYCLE1_PACKET_MAX_ROWS));
  const cap = Math.min(CYCLE1_MAX_PACKETS, Math.max(1, Number(maxPackets) || CYCLE1_MAX_PACKETS));
  const sourceBudget = cycle1SourceBudget(inputTokenBudget);
  let sessions = [...rowsBySession.values()].map((rows) => rows.slice().reverse());
  // Preserve the oldest selected session even when selected sessions outnumber
  // packet slots. Then round-robin: one busy session cannot consume every slot.
  if (sessions.length > cap)
    sessions = cap === 1 ? [sessions.at(-1)] : [...sessions.slice(0, cap - 1), sessions.at(-1)];
  sessions = sessions.map((rows) => partitionCycle1Rows(rows, sourceBudget, size));
  const windows = [];
  while (sessions.some((rows) => rows.length) && windows.length < cap) {
    for (const packets of sessions) {
      if (!packets.length || windows.length >= cap) continue;
      windows.push(packets.shift());
    }
  }
  return windows;
}

function mergeCycle1Results(a, b) {
  if (!a) return b;
  if (!b) return a;
  const sum = (key) => Number(a?.[key] || 0) + Number(b?.[key] || 0);
  const qualityKeys = [...new Set([...Object.keys(a?.quality || {}), ...Object.keys(b?.quality || {})])];
  const quality = {};
  for (const key of qualityKeys) {
    quality[key] = Number(a?.quality?.[key] || 0) + Number(b?.quality?.[key] || 0);
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
  };
}

export async function runCycle1(db, config = {}, options = {}, dataDir = null) {
  const signal = options?.signal;
  throwIfAborted(signal);
  const coalescedRetry = options?.coalescedRetry === true;
  const retryAttempt = Math.max(0, Number(options?.coalescedRetryAttempt || 0));
  const maxRetries = resolveCoalesceMaxRetries(config, 3);
  const requestSignature = makeCycleRequestSignature('cycle1', config, {
    preset: options?.preset,
    concurrency: options?.concurrency,
    maxConcurrent: options?.maxConcurrent,
  });
  const scheduleRetry = () =>
    scheduleCoalescedCycleRetry(
      db,
      'cycle1',
      () =>
        runCycle1(
          db,
          config,
          { ...options, signal: undefined, coalescedRetry: true, coalescedRetryAttempt: retryAttempt + 1 },
          dataDir
        ),
      config,
      requestSignature
    );
  if (_runCycle1InFlight.has(db)) {
    if (!coalescedRetry) await markCycleRequest(db, 'cycle1', 'in-flight', requestSignature);
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry();
    logCycle1Throttled('in-flight', '[cycle1] skipped: already in flight for this db\n');
    return await cycle1SkipResult(db);
  }
  const client = await db._pool.connect();
  let gotLock = false;
  try {
    throwIfAborted(signal);
    const r = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, ['mixdog.cycle1']);
    gotLock = r.rows[0]?.got === true;
  } catch (err) {
    client.release();
    if (signal?.aborted) throw signal.reason ?? err;
    __mixdogMemoryLog(`[cycle1] advisory lock query failed: ${err.message}\n`);
    if (!coalescedRetry) await markCycleRequest(db, 'cycle1', 'lock-error', requestSignature);
    return await cycle1SkipResult(db);
  }
  if (!gotLock) {
    client.release();
    if (!coalescedRetry) await markCycleRequest(db, 'cycle1', 'advisory-lock', requestSignature);
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry();
    logCycle1Throttled('advisory-lock', '[cycle1] skipped: advisory lock held by another worker\n');
    return await cycle1SkipResult(db);
  }
  const p = (async () => {
    try {
      let result = null;
      let coalescedRuns = 0;
      let coalescedRequests = 0;
      if (coalescedRetry) {
        const pending = await consumeCycleRequests(db, 'cycle1', requestSignature);
        if (pending <= 0) {
          return await cycle1SkipResult(db, { skippedInFlight: false, coalescedRetryNoop: true });
        }
        coalescedRuns += 1;
        coalescedRequests += pending;
        __mixdogMemoryLog(`[cycle1] retrying coalesced requests=${pending}\n`);
      }
      try {
        result = await _runCycle1Impl(db, config, options);
      } catch (err) {
        if (coalescedRetry) {
          await markCycleRequest(db, 'cycle1', 'retry-error', requestSignature);
          if (retryAttempt < maxRetries) scheduleRetry();
        }
        throw err;
      }
      const maxDrains = resolveCoalesceMaxDrains(config, 1);
      let drainLoops = 0;
      while (drainLoops < maxDrains) {
        throwIfAborted(signal);
        const pending = await consumeCycleRequests(db, 'cycle1', requestSignature);
        if (pending <= 0) break;
        drainLoops += 1;
        coalescedRuns += 1;
        coalescedRequests += pending;
        __mixdogMemoryLog(`[cycle1] draining coalesced requests=${pending}\n`);
        try {
          const next = await _runCycle1Impl(db, config, options);
          result = mergeCycle1Results(result, next);
        } catch (err) {
          await markCycleRequest(db, 'cycle1', 'drain-error', requestSignature);
          if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry();
          throw err;
        }
      }
      if (coalescedRuns > 0) {
        result = { ...result, coalescedRuns, coalescedRequests };
      }
      if (coalescedRetry && !result?.coalescedRetryNoop && typeof options?.onCoalescedSuccess === 'function') {
        try {
          await options.onCoalescedSuccess(result);
        } catch (err) {
          __mixdogMemoryLog(`[cycle1] coalesced success callback failed: ${err?.message || err}\n`);
        }
      }
      return result;
    } finally {
      let releaseErr = null;
      try {
        const r = await client.query(`SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`, ['mixdog.cycle1']);
        if (r.rows[0]?.unlocked !== true) releaseErr = new Error('cycle1 advisory unlock returned false');
      } catch (err) {
        releaseErr = err;
      }
      client.release(releaseErr || undefined);
    }
  })();
  _runCycle1InFlight.set(db, p);
  try {
    return await p;
  } finally {
    _runCycle1InFlight.delete(db);
  }
}

/** Too few eligible rows for a classifier call — unless the shortfall is only
 *  the omitted-row cooldown hiding a backlog that is otherwise large enough. */
function shouldQuickExit(pendingRowsAtStart, rawUnchunkedAtStart, minBatch) {
  const bypassMinBatchForCooldown =
    Number.isFinite(rawUnchunkedAtStart) &&
    rawUnchunkedAtStart >= minBatch &&
    Number.isFinite(pendingRowsAtStart) &&
    pendingRowsAtStart < minBatch;
  return Number.isFinite(pendingRowsAtStart) && pendingRowsAtStart < minBatch && !bypassMinBatchForCooldown;
}

async function _runCycle1Impl(db, config = {}, options = {}) {
  const cycleStartedAt = Date.now();
  const signal = options?.signal;
  throwIfAborted(signal);
  const pendingRowsAtStart = await countPendingRows(db);
  const rawUnchunkedAtStart = await countRawUnchunkedRows(db);
  throwIfAborted(signal);
  const plan = resolveCycle1Plan(config, options);
  const { rowsDesc, fetchMs } = await fetchCycle1Rows(db, plan);
  throwIfAborted(signal);

  // Pending rows whose session is still active are not due yet (fetchCycle1Rows).
  if (shouldQuickExit(pendingRowsAtStart, rawUnchunkedAtStart, plan.minBatch) || rowsDesc.length === 0) {
    const pendingLog = Number.isFinite(rawUnchunkedAtStart) ? rawUnchunkedAtStart : 'na';
    const eligibleLog = Number.isFinite(pendingRowsAtStart) ? pendingRowsAtStart : 'na';
    __mixdogMemoryLog(
      `[cycle1] quick-exit pending=${pendingLog} eligible=${eligibleLog} due=${rowsDesc.length} min_batch=${plan.minBatch}\n`
    );
    throwIfAborted(signal);
    flushEmbeddingDirty(db, { signal }).catch((err) =>
      __mixdogMemoryLog(`[cycle1] quick-exit embedding flush failed: ${err.message}\n`)
    );
    return emptyCycle1Result(pendingRowsAtStart);
  }

  // Rows within each session are converted back to chronological order for
  // the classifier prompt by packCycle1Windows.
  const rowsBySession = groupRowsBySession(rowsDesc, plan.sessionCap, signal);
  const windows = packCycle1Windows(rowsBySession, plan.windowSize, plan.maxPackets, plan.inputTokenBudget);
  const callLlm = typeof options?.callLlm === 'function' ? options.callLlm : callAgentDispatch;
  const sem = createSemaphore(Math.min(Math.max(1, windows.length), plan.concurrency));
  const settled = await Promise.allSettled(
    windows.map((rows, idx) =>
      sem(() => {
        throwIfAborted(signal);
        return processCycle1Window({ db, rows, windowIdx: idx, plan, signal, callLlm });
      })
    )
  );
  const rejected = settled.find((r) => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  throwIfAborted(signal);
  const totals = aggregateWindowResults(settled.map((r) => r.value));
  __mixdogMemoryLog(cycle1SummaryLine(windows.length, totals));

  // Embedding is fire-and-forget; sidecar persist does not guarantee embedding completion.
  throwIfAborted(signal);
  flushEmbeddingDirty(db, { signal })
    .then((d) => {
      if (d.attempted > 0) {
        __mixdogMemoryLog(
          `[cycle1] embedding flush attempted=${d.attempted} ok=${d.succeeded} failed=${d.failed.length}\n`
        );
      }
    })
    .catch((err) => __mixdogMemoryLog(`[cycle1] embedding flush failed: ${err.message}\n`));

  return buildCycle1Result({ totals, windowCount: windows.length, pendingRowsAtStart, fetchMs, cycleStartedAt });
}
