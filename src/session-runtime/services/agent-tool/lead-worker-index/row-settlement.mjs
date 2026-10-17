// When an active Lead row is no longer believable, and how it settles to idle:
// runtime liveness, the daemon's in-memory turn state, the stamp freshness
// window, and the terminal reap deadline from config.
import { clean, runtimeAlive } from '../helpers.mjs';
import { createRowLiveness } from '../worker-index/row-liveness.mjs';
import { isActiveLeadRow, LEAD_POOL_FRESH_MS } from './lead-rows.mjs';

/** `isSessionRunning(sessionId)`: whether that Lead's turn is in flight in
 *  this process (every session runs inline in the daemon). */
export function createRowSettlement({ cfgMod, isSessionRunning = () => false }) {
  // Lead rows settle to idle exactly like worker rows: same stamps, same
  // config-driven terminal reap deadline.
  const { idleRow } = createRowLiveness({ cfgMod });

  function staleActiveLeadRow(row, now) {
    if (!isActiveLeadRow(row)) return false;
    // The runtime that stamped the turn is gone: no wall-clock window can make
    // that row true again, so the panel must not wait one out.
    if (!runtimeAlive(row.runtimePid)) return true;
    if (isSessionRunning(clean(row.sessionId))) return false;
    const updated = Date.parse(clean(row.updatedAt)) || 0;
    return !(updated > 0 && now - updated <= LEAD_POOL_FRESH_MS);
  }

  // idleLeadRow(row, now, touch): `touch` marks a turn that ended HERE (fresh
  // idle stamps + reap window); recovery leaves the dead runtime's stamps alone
  // so ordering and an already scheduled reap keep their original moment.
  return { staleActiveLeadRow, idleLeadRow: idleRow };
}
