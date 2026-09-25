/**
 * memory-action-handlers/cycle-backfill-action.mjs — the backfill action: one
 * driver run over a transcript window, with the whole-action mutex and the
 * per-iteration cancel checkpoints the driver's cycle1/cycle2 callbacks need.
 */
import { runCycle2 } from '../memory-cycle.mjs';
import { runFullBackfill } from '../memory-ops-policy.mjs';
import { throwIfAborted } from '../memory-cycle2-shared.mjs';

export function createBackfillAction({
  getDb,
  dataDir,
  awaitCycle1Run,
  finalizeCycle2Run,
  withCycle2Llm,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
}) {
  // Whole-action backfill mutex (transport-agnostic). memory-cycle1's
  // _runCycle1InFlight only protects cycle1; ingest workers
  // (memory-ops-policy.mjs) and cycle2 can still overlap if a second backfill
  // kicks in (timeout-retry, parallel callers, /api/tool vs /mcp vs
  // /admin/backfill). Track the in-flight promise here and reject overlaps
  // with 409.
  let backfillInFlight = null;

  return async function backfill(args, config, signal) {
    const db = getDb();
    // Sentinel is set synchronously before any await so a burst of concurrent
    // calls cannot all pass the check.
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
  };
}
