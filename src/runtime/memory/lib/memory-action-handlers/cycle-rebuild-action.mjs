/**
 * memory-action-handlers/cycle-rebuild-action.mjs — the destructive rebuild:
 * drain whatever cycle1 is still running, truncate every classification
 * column in one transaction, then re-run cycle1 and cycle2 over the reset
 * rows. The confirm phrase is the only guard the caller gets.
 */
import { runCycle2 } from '../memory-cycle.mjs';
import { getInFlightCycle1 } from '../memory-cycle1.mjs';
import { throwIfAborted } from '../memory-cycle2-shared.mjs';

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

// Drain any pre-reset cycle1 BEFORE the destructive truncation so the
// post-reset run is not started concurrently against the same DB.
// _awaitCycle1Run() may release the outer handle on a caller deadline while
// the inner runCycle1 promise still owns the DB writes. Drain both layers,
// then loop once more if one layer exposed another promise while awaiting.
async function drainCycle1(db, getSchedulerCycle1InFlight) {
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

export function createRebuildAction({
  getDb,
  startCycle1Run,
  finalizeCycle2Run,
  getSchedulerCycle1InFlight,
  withCycle2Llm,
}) {
  return async function rebuild(args, config, signal) {
    const db = getDb();
    if (args.confirm !== 'REBUILD MEMORY') {
      return {
        text: 'rebuild requires confirm: "REBUILD MEMORY" (truncates classification columns and re-runs cycles)',
        isError: true,
      };
    }
    await drainCycle1(db, getSchedulerCycle1InFlight);
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
  };
}
