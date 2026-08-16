// Process-global Lead lease pool. Durable session JSON is conversation history;
// this index alone says which Lead runtimes are still resident (running or
// idle-before-reap). It deliberately has no tag tombstones or respawn routing.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { updateJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { resolveAgentTerminalReapMs } from '../../session-runtime/config-helpers.mjs';
import { clean } from './helpers.mjs';
import { leadPoolTag, workerRowKey } from './worker-rows.mjs';
import { LEAD_WORKER_INDEX_FILE } from './tool-def.mjs';

const ACTIVE_LEAD_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;

// Mirror of the pool reader's freshness window (store-summary-reader): a row is
// only believed to be working while its heartbeat sidecar or its own stamp sits
// inside this window. Recovery applies the SAME rule, so the index can never
// keep claiming work the panel has already stopped believing.
const LEAD_POOL_FRESH_MS = 2 * 60 * 1000;

// A turn's teardown writes the idle row, so an ungraceful exit (crash, kill,
// dev redeploy restarting the daemon mid-turn) leaves `running` behind forever:
// the row is active, so the reaper refuses it, and the panel shows 작업 중 with
// a growing elapsed for a session that stopped (user report). Flush on exit,
// and recover what an exit could not write on the next construction.
const exitFlushes = new Set();
let exitFlushInstalled = false;

function registerExitFlush(flush) {
  exitFlushes.add(flush);
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.on('exit', () => {
    for (const entry of exitFlushes) {
      try { entry(); } catch { /* exit flush is best effort */ }
    }
  });
}

/** Unstamped legacy rows report alive: only the freshness window judges them. */
function runtimeAlive(pid) {
  const id = Number(pid) || 0;
  if (id <= 0 || id === process.pid) return true;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function normalizeLeadRows(value) {
  const source = Array.isArray(value?.workers)
    ? value.workers
    : (value?.workers && typeof value.workers === 'object'
      ? Object.values(value.workers)
      : []);
  return source
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const sessionId = clean(row.sessionId);
      if (!sessionId) return null;
      return {
        ...row,
        tag: leadPoolTag(sessionId),
        sessionId,
        ownerSessionId: sessionId,
        agent: 'lead',
        status: clean(row.status) || 'idle',
        stage: clean(row.stage) || clean(row.status) || 'idle',
        updatedAt: clean(row.updatedAt) || null,
        reapAt: clean(row.reapAt) || null,
      };
    })
    .filter(Boolean);
}

export function createLeadWorkerIndex({ dataDir, cfgMod, workerRowFromSession }) {
  const reapTimers = new Map();
  const activeLeadSessions = new Set();
  const leadWorkerIndexPath = () => dataDir ? resolve(dataDir, LEAD_WORKER_INDEX_FILE) : null;

  function leadHeartbeatFresh(sessionId, now) {
    const id = clean(sessionId);
    if (!dataDir || !id) return false;
    try {
      const mtimeMs = statSync(resolve(dataDir, 'sessions', `${id}.hb`)).mtimeMs || 0;
      return mtimeMs > 0 && now - mtimeMs <= LEAD_POOL_FRESH_MS;
    } catch {
      return false;
    }
  }

  function staleActiveLeadRow(row, now) {
    if (!ACTIVE_LEAD_STATUS.test(clean(row?.status || row?.stage))) return false;
    // The runtime that stamped the turn is gone: no wall-clock window can make
    // that row true again, so the panel must not wait one out.
    if (!runtimeAlive(row.runtimePid)) return true;
    if (leadHeartbeatFresh(row.sessionId, now)) return false;
    const updated = Date.parse(clean(row.updatedAt)) || 0;
    return !(updated > 0 && now - updated <= LEAD_POOL_FRESH_MS);
  }

  function terminalReapAt(row, now) {
    let reapMs = null;
    try { reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), row?.provider); }
    catch { reapMs = null; }
    return reapMs == null ? null : new Date(now + reapMs).toISOString();
  }

  /** Settle one active row. `touch` marks a turn that ended HERE (fresh idle
   *  stamps + reap window); recovery leaves the dead runtime's stamps alone so
   *  ordering and an already scheduled reap keep their original moment. */
  function idleLeadRow(row, now, touch = false) {
    const stamp = new Date(now).toISOString();
    return {
      ...row,
      status: 'idle',
      stage: 'idle',
      turnStartedAt: null,
      finishedAt: touch ? stamp : (clean(row.finishedAt) || clean(row.updatedAt) || stamp),
      updatedAt: touch ? stamp : (clean(row.updatedAt) || stamp),
      reapAt: touch ? terminalReapAt(row, now) : (clean(row.reapAt) || terminalReapAt(row, now)),
    };
  }

  function readLeadWorkerRows() {
    const file = leadWorkerIndexPath();
    if (!file) return [];
    try { return normalizeLeadRows(JSON.parse(readFileSync(file, 'utf8'))); }
    catch { return []; }
  }

  function writeLeadWorkerRows(mutator) {
    const file = leadWorkerIndexPath();
    if (!file || typeof mutator !== 'function') return null;
    try {
      return updateJsonAtomicSync(file, (current) => {
        const byKey = new Map();
        for (const row of normalizeLeadRows(current)) byKey.set(workerRowKey(row), row);
        mutator(byKey);
        const workers = {};
        for (const row of byKey.values()) workers[workerRowKey(row)] = row;
        return { version: 1, updatedAt: new Date().toISOString(), workers };
      }, { lock: true });
    } catch {
      return null;
    }
  }

  function cancelLeadReap(sessionId) {
    const handle = reapTimers.get(sessionId);
    if (!handle) return false;
    clearTimeout(handle);
    reapTimers.delete(sessionId);
    return true;
  }

  function removeLeadWorkerRow(sessionId, expectedReapAt = '') {
    const id = clean(sessionId);
    if (!id) return false;
    cancelLeadReap(id);
    writeLeadWorkerRows((byKey) => {
      const current = byKey.get(id);
      if (!current) return;
      if (expectedReapAt && clean(current.reapAt) !== expectedReapAt) return;
      if (ACTIVE_LEAD_STATUS.test(clean(current.status || current.stage))) return;
      byKey.delete(id);
    });
    return true;
  }

  function scheduleLeadReap(row) {
    const sessionId = clean(row?.sessionId);
    const reapAt = clean(row?.reapAt);
    if (!sessionId || !reapAt) return;
    cancelLeadReap(sessionId);
    const delay = Math.max(0, (Date.parse(reapAt) || 0) - Date.now());
    const handle = setTimeout(() => {
      reapTimers.delete(sessionId);
      removeLeadWorkerRow(sessionId, reapAt);
    }, delay);
    handle.unref?.();
    reapTimers.set(sessionId, handle);
  }

  function upsertLeadSession(session, extra = {}) {
    if (!session?.id || typeof workerRowFromSession !== 'function') return false;
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
    writeLeadWorkerRows((byKey) => byKey.set(session.id, normalized));
    if (ACTIVE_LEAD_STATUS.test(status) || ACTIVE_LEAD_STATUS.test(stage)) {
      activeLeadSessions.add(session.id);
      cancelLeadReap(session.id);
    } else {
      activeLeadSessions.delete(session.id);
      scheduleLeadReap(normalized);
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
    writeLeadWorkerRows((byKey) => {
      for (const id of ids) {
        const current = byKey.get(id);
        if (!current || !ACTIVE_LEAD_STATUS.test(clean(current.status || current.stage))) continue;
        byKey.set(id, idleLeadRow(current, now, true));
      }
    });
  }

  /** Boot recovery for rows an ungraceful exit left running, plus the reap
   *  schedule for every settled row. */
  function recoverStaleLeadRows() {
    const now = Date.now();
    const rows = readLeadWorkerRows();
    const stale = rows.filter((row) => staleActiveLeadRow(row, now));
    const recovered = new Map();
    if (stale.length) {
      writeLeadWorkerRows((byKey) => {
        recovered.clear();
        for (const row of stale) {
          const key = workerRowKey(row);
          const current = byKey.get(key);
          if (!current || !staleActiveLeadRow(current, now)) continue;
          const settled = idleLeadRow(current, now);
          byKey.set(key, settled);
          recovered.set(key, settled);
        }
      });
    }
    for (const row of rows) {
      const settled = recovered.get(workerRowKey(row)) || row;
      if (!ACTIVE_LEAD_STATUS.test(clean(settled.status || settled.stage))) scheduleLeadReap(settled);
    }
  }

  recoverStaleLeadRows();
  registerExitFlush(flushActiveLeadRows);

  return {
    leadWorkerIndexPath,
    readLeadWorkerRows,
    upsertLeadSession,
    removeLeadWorkerRow,
    flushActiveLeadRows,
    recoverStaleLeadRows,
  };
}
