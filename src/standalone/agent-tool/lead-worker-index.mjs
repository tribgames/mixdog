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
import { resolveAgentTerminalReapMs } from '../../session-runtime/config-helpers.mjs';
import { clean, registerExitFlush } from './helpers.mjs';
import { leadPoolTag, workerRowKey } from './worker-rows.mjs';
import { ACTIVE_LEAD_STATUS, isActiveLeadRow } from './lead-worker-index/lead-rows.mjs';
import { createLeadIndexFile } from './lead-worker-index/index-file.mjs';
import { createRowSettlement } from './lead-worker-index/row-settlement.mjs';
import { createLeadReapTimers } from './lead-worker-index/reap-timers.mjs';

export function createLeadWorkerIndex({ dataDir, cfgMod, workerRowFromSession }) {
  const activeLeadSessions = new Set();
  const index = createLeadIndexFile({ dataDir });
  const settlement = createRowSettlement({ dataDir, cfgMod });
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

  function upsertLeadSession(session, extra = {}) {
    if (!session?.id || typeof workerRowFromSession !== 'function') return false;
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
    const normalized = {
      ...row,
      // Liveness identity of the runtime that owns this status. A row stamped
      // by a process that no longer exists is recovered on the next boot.
      runtimePid: process.pid,
      reapAt: reapMs == null ? null : new Date(now + reapMs).toISOString(),
    };
    index.write((byKey) => byKey.set(session.id, normalized));
    if (ACTIVE_LEAD_STATUS.test(status) || ACTIVE_LEAD_STATUS.test(stage)) {
      activeLeadSessions.add(session.id);
      reaps.cancel(session.id);
    } else {
      activeLeadSessions.delete(session.id);
      reaps.schedule(normalized);
    }
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
  registerExitFlush(flushActiveLeadRows);

  return {
    leadWorkerIndexPath: index.path,
    readLeadWorkerRows: index.read,
    upsertLeadSession,
    removeLeadWorkerRow,
    flushActiveLeadRows,
    recoverStaleLeadRows,
  };
}
