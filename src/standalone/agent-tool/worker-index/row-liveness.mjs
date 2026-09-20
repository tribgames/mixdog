// worker-index/row-liveness.mjs
// Whether an active-looking row still has a live worker behind it, and how a
// row settles back to idle when it does not.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveAgentTerminalReapMs } from '../../../session-runtime/config-helpers.mjs';
import { clean, positiveInt, runtimeAlive } from '../helpers.mjs';

const ACTIVE_WORKER_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;
const WORKER_POOL_FRESH_MS = 2 * 60 * 1000;

export const isActiveWorkerRow = (row) =>
  ACTIVE_WORKER_STATUS.test(clean(row?.status)) || ACTIVE_WORKER_STATUS.test(clean(row?.stage));

export function createRowLiveness({ dataDir, cfgMod }) {
  function heartbeatFresh(sessionId, now) {
    const id = clean(sessionId);
    if (!dataDir || !id) return false;
    try {
      const mtimeMs = statSync(resolve(dataDir, 'sessions', `${id}.hb`)).mtimeMs || 0;
      return mtimeMs > 0 && now - mtimeMs <= WORKER_POOL_FRESH_MS;
    } catch {
      return false;
    }
  }

  /** Active status, but its runtime pid is dead, or neither its heartbeat nor
   *  its own update stamp is fresh. */
  function isStaleActive(row, now) {
    if (!isActiveWorkerRow(row)) return false;
    if (positiveInt(row.runtimePid) && !runtimeAlive(row.runtimePid)) return true;
    if (heartbeatFresh(row.sessionId, now)) return false;
    const updated = Date.parse(clean(row.updatedAt)) || 0;
    return !(updated > 0 && now - updated <= WORKER_POOL_FRESH_MS);
  }

  function terminalReapAt(row, now) {
    let reapMs = null;
    try {
      reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), row?.provider);
    } catch {
      reapMs = null;
    }
    return reapMs == null ? null : new Date(now + reapMs).toISOString();
  }

  /** The row settled to idle. `touch` restamps it as finished now (this
   *  process is giving up its own work); otherwise existing stamps win. */
  function idleRow(row, now, touch = false) {
    const stamp = new Date(now).toISOString();
    return {
      ...row,
      status: 'idle',
      stage: 'idle',
      turnStartedAt: null,
      finishedAt: touch ? stamp : clean(row.finishedAt) || clean(row.updatedAt) || stamp,
      updatedAt: touch ? stamp : clean(row.updatedAt) || stamp,
      reapAt: touch ? terminalReapAt(row, now) : clean(row.reapAt) || terminalReapAt(row, now),
    };
  }

  return { isStaleActive, idleRow };
}
