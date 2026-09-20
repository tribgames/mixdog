// When an active Lead row is no longer believable, and how it settles to idle:
// runtime liveness, the heartbeat sidecar, the stamp freshness window, and the
// terminal reap deadline from config.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveAgentTerminalReapMs } from '../../../session-runtime/config-helpers.mjs';
import { clean, runtimeAlive } from '../helpers.mjs';
import { isActiveLeadRow, LEAD_POOL_FRESH_MS } from './lead-rows.mjs';

export function createRowSettlement({ dataDir, cfgMod }) {
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
    if (!isActiveLeadRow(row)) return false;
    // The runtime that stamped the turn is gone: no wall-clock window can make
    // that row true again, so the panel must not wait one out.
    if (!runtimeAlive(row.runtimePid)) return true;
    if (leadHeartbeatFresh(row.sessionId, now)) return false;
    const updated = Date.parse(clean(row.updatedAt)) || 0;
    return !(updated > 0 && now - updated <= LEAD_POOL_FRESH_MS);
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
      finishedAt: touch ? stamp : clean(row.finishedAt) || clean(row.updatedAt) || stamp,
      updatedAt: touch ? stamp : clean(row.updatedAt) || stamp,
      reapAt: touch ? terminalReapAt(row, now) : clean(row.reapAt) || terminalReapAt(row, now),
    };
  }

  return { staleActiveLeadRow, idleLeadRow };
}
