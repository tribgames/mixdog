// Process-global Lead lease pool. Durable session JSON is conversation history;
// this index alone says which Lead runtimes are still resident (running or
// idle-before-reap). It deliberately has no tag tombstones or respawn routing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { updateJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { resolveAgentTerminalReapMs } from '../../session-runtime/config-helpers.mjs';
import { clean } from './helpers.mjs';
import { leadPoolTag, workerRowKey } from './worker-rows.mjs';
import { LEAD_WORKER_INDEX_FILE } from './tool-def.mjs';

const ACTIVE_LEAD_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;

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
  const leadWorkerIndexPath = () => dataDir ? resolve(dataDir, LEAD_WORKER_INDEX_FILE) : null;

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
      reapAt: reapMs == null ? null : new Date(now + reapMs).toISOString(),
    };
    writeLeadWorkerRows((byKey) => byKey.set(session.id, normalized));
    if (ACTIVE_LEAD_STATUS.test(status) || ACTIVE_LEAD_STATUS.test(stage)) {
      cancelLeadReap(session.id);
    } else {
      scheduleLeadReap(normalized);
    }
    return true;
  }

  for (const row of readLeadWorkerRows()) {
    if (!ACTIVE_LEAD_STATUS.test(clean(row.status || row.stage))) scheduleLeadReap(row);
  }

  return {
    leadWorkerIndexPath,
    readLeadWorkerRows,
    upsertLeadSession,
    removeLeadWorkerRow,
  };
}
