// When an active Lead row is no longer believable, and how it settles to idle:
// runtime liveness, the heartbeat sidecar, the stamp freshness window, and the
// terminal reap deadline from config.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { clean, runtimeAlive } from '../helpers.mjs';
import { createRowLiveness } from '../worker-index/row-liveness.mjs';
import { isActiveLeadRow, LEAD_POOL_FRESH_MS } from './lead-rows.mjs';

export function createRowSettlement({ dataDir, cfgMod }) {
  // Lead rows settle to idle exactly like worker rows: same stamps, same
  // config-driven terminal reap deadline.
  const { idleRow } = createRowLiveness({ dataDir, cfgMod });

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

  /** Settle one active row. `touch` marks a turn that ended HERE (fresh idle
   *  stamps + reap window); recovery leaves the dead runtime's stamps alone so
   *  ordering and an already scheduled reap keep their original moment. */
  return { staleActiveLeadRow, idleLeadRow: idleRow };
}
