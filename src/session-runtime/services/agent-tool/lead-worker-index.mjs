// Process-global Lead lease pool. Durable session JSON is conversation history;
// this index alone says which Lead runtimes are still resident (running or
// idle-before-reap). It deliberately has no tag tombstones or respawn routing.
//
// A turn's teardown writes the idle row, so an ungraceful exit (crash, kill,
// dev redeploy restarting the daemon mid-turn) leaves `running` behind forever:
// the row is active, so the reaper refuses it, and the panel shows 작업 중 with
// a growing elapsed for a session that stopped (user report). Flush on exit,
// and recover what an exit could not write on the next construction
// (registerExitFlush / runtimeAlive live in helpers.mjs).
import { resolveAgentTerminalReapMs } from '../../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { clean, registerExitFlush } from './helpers.mjs';
import { leadPoolTag, workerRowKey } from './worker-rows.mjs';
import { ACTIVE_LEAD_STATUS, isActiveLeadRow } from './lead-worker-index/lead-rows.mjs';
import { createLeadIndexFile } from './lead-worker-index/index-file.mjs';
import { createRowSettlement } from './lead-worker-index/row-settlement.mjs';
import { createLeadReapTimers } from './lead-worker-index/reap-timers.mjs';
import { createForgottenLeads } from './lead-worker-index/forgotten-leads.mjs';

export function createLeadWorkerIndex({ dataDir, cfgMod, workerRowFromSession, isSessionRunning }) {
  const activeLeadSessions = new Set();
  const index = createLeadIndexFile({ dataDir });
  const forgotten = createForgottenLeads(dataDir);
  const settlement = createRowSettlement({ cfgMod, isSessionRunning });
  const reaps = createLeadReapTimers({ removeRow: (sessionId, reapAt) => removeLeadWorkerRow(sessionId, reapAt) });

  function removeLeadWorkerRow(sessionId, expectedReapAt = '') {
    const id = clean(sessionId);
    if (!id) return false;
    reaps.cancel(id);
    index.write((byKey) => {
      const current = byKey.get(id);
      if (!current) return;
      if (expectedReapAt && clean(current.reapAt) !== expectedReapAt) return;
      if (isActiveLeadRow(current)) return;
      byKey.delete(id);
    });
    return true;
  }

  /** A deleted Lead leaves the pool now, running or not, and never returns. A
   *  turn still unwinding after the delete settles by upserting its idle row —
   *  possibly through another index instance of this process — so the guard is
   *  process-wide (forgotten-leads.mjs). */
  function forgetLeadSession(sessionId) {
    const id = clean(sessionId);
    if (!id) return false;
    forgotten.forget(id);
    reaps.cancel(id);
    activeLeadSessions.delete(id);
    index.write((byKey) => {
      byKey.delete(id);
    });
    return true;
  }

  function upsertLeadSession(session, extra = {}) {
    if (!session?.id || typeof workerRowFromSession !== 'function') return false;
    if (forgotten.isForgotten(session.id)) return false;
    const owner = clean(session.owner).toLowerCase();
    const agent = clean(session.agent).toLowerCase();
    if (owner === 'agent' || (agent && agent !== 'lead')) return false;
    const now = Date.now();
    const status = clean(extra.status) || (session.closed === true ? 'closed' : clean(session.status) || 'idle');
    const stage = clean(extra.stage) || status;
    const reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), extra.provider || session.provider);
    const row = workerRowFromSession(session, leadPoolTag(session.id), {
      ...extra,
      agent: 'lead',
      ownerSessionId: session.id,
      status,
      stage,
      updatedAt: new Date(now).toISOString(),
    });
    if (!row) return false;
    const settled = !ACTIVE_LEAD_STATUS.test(status) && !ACTIVE_LEAD_STATUS.test(stage);
    const normalized = {
      ...row,
      // The pane lists a settled Lead for a fixed window from this stamp.
      finishedAt: settled ? row.finishedAt || new Date(now).toISOString() : row.finishedAt,
      // Liveness identity of the runtime that owns this status. A row stamped
      // by a process that no longer exists is recovered on the next boot.
      runtimePid: process.pid,
      reapAt: reapMs == null ? null : new Date(now + reapMs).toISOString(),
    };
    // Re-run against the locked fresh document at persist time: a delete that
    // lands (here or in another instance) between this call and the write must
    // still win over the queued row.
    index.write(
      (byKey) => {
        if (!forgotten.isForgotten(session.id)) byKey.set(session.id, normalized);
      },
      { rerun: true }
    );
    if (settled) {
      activeLeadSessions.delete(session.id);
      reaps.schedule(normalized);
    } else {
      activeLeadSessions.add(session.id);
      reaps.cancel(session.id);
    }
    return true;
  }

  /** A workspace transition moved the Lead: its existing row follows (status,
   *  reap deadline and liveness stamps unchanged). No row: nothing to write. */
  function updateLeadWorkerCwd(sessionId, cwd) {
    const id = clean(sessionId);
    const next = clean(cwd);
    if (!id || !next) return false;
    index.write((byKey) => {
      const current = byKey.get(id);
      if (!current || current.cwd === next) return;
      byKey.set(id, { ...current, cwd: next });
    });
    return true;
  }

  /** Graceful-exit settlement: every turn this process still claims goes idle
   *  before the runtime disappears. */
  function flushActiveLeadRows() {
    if (!activeLeadSessions.size) return;
    const ids = [...activeLeadSessions];
    activeLeadSessions.clear();
    const now = Date.now();
    index.write((byKey) => {
      for (const id of ids) {
        if (forgotten.isForgotten(id)) continue;
        const current = byKey.get(id);
        if (!current || !isActiveLeadRow(current)) continue;
        byKey.set(id, settlement.idleLeadRow(current, now, true));
      }
    });
  }

  /** Boot recovery for rows an ungraceful exit left running, plus the reap
   *  schedule for every settled row. */
  function recoverStaleLeadRows() {
    const now = Date.now();
    const rows = index.read();
    const stale = rows.filter((row) => settlement.staleActiveLeadRow(row, now));
    const recovered = new Map();
    if (stale.length) {
      // The write mutator runs synchronously against this process's view of
      // the index, so `recovered` is complete when write() returns.
      index.write((byKey) => {
        recovered.clear();
        for (const row of stale) {
          const key = workerRowKey(row);
          const current = byKey.get(key);
          if (!current || !settlement.staleActiveLeadRow(current, now)) continue;
          const settled = settlement.idleLeadRow(current, now);
          byKey.set(key, settled);
          recovered.set(key, settled);
        }
      });
    }
    for (const row of rows) {
      const settled = recovered.get(workerRowKey(row)) || row;
      if (!isActiveLeadRow(settled)) reaps.schedule(settled);
    }
  }

  recoverStaleLeadRows();
  function flushLeadIndexOnExit() {
    flushActiveLeadRows();
    // Writes are persisted by an async queue; the loop is gone at exit. This
    // is the best-effort last resort: a persist still running is left alone
    // (the graceful shutdown path drains before exit).
    index.flushSync();
  }
  const unregisterExitFlush = registerExitFlush(flushLeadIndexOnExit);
  let disposed = false;
  let disposePromise = null;

  function teardown() {
    reaps.cancelAll();
    unregisterExitFlush();
  }

  async function drainThenTeardown() {
    await index.flush();
    teardown();
  }

  /** Persist queued rows, drop owned reap timers, unregister. `settle` (a real
   *  teardown) also idles this runtime's own active Lead rows; a dispose that
   *  keeps background work (idle eviction) leaves them for the next owner.
   *  If the sync flush cannot run (our async writer holds the lock), the exit
   *  hook stays until the async drain settles. */
  function dispose({ settle = false } = {}) {
    if (disposed) return;
    disposed = true;
    let flushed = false;
    try {
      if (settle) flushActiveLeadRows();
      flushed = index.flushSync();
    } catch {}
    if (flushed) {
      teardown();
      return;
    }
    disposePromise = drainThenTeardown().catch(reopenAfterFailedDrain);
  }

  /** A failed drain tears nothing down; allow a later dispose to retry it. */
  function reopenAfterFailedDrain() {
    disposed = false;
    disposePromise = null;
  }

  function disposeAsync({ settle = false } = {}) {
    if (!disposePromise) {
      disposed = true;
      if (settle) flushActiveLeadRows();
      disposePromise = drainThenTeardown().catch((error) => {
        reopenAfterFailedDrain();
        throw error;
      });
    }
    return disposePromise;
  }

  return {
    dispose,
    disposeAsync,
    leadWorkerIndexPath: index.path,
    readLeadWorkerRows: index.read,
    /** Resolves once every queued Lead index write is on disk. */
    flushLeadWorkerIndexWrites: index.flush,
    upsertLeadSession,
    updateLeadWorkerCwd,
    removeLeadWorkerRow,
    forgetLeadSession,
    flushActiveLeadRows,
    recoverStaleLeadRows,
  };
}
