// Stale non-terminal rows: an index row whose session is gone and whose
// heartbeat is older than the reap window becomes a tombstone so its tag is
// freed instead of blocking spawn forever.
import { clean, positiveInt } from '../helpers.mjs';
import { TAG_TOMBSTONE_TTL_MS, isLeadPoolAgent, workerRowTime } from '../worker-rows.mjs';
import { resolveAgentTerminalReapMs } from '../../../session-runtime/config-helpers.mjs';
import { insertTombstone, isTerminalRow } from './row-helpers.mjs';

export function createStaleRowTransition({ cfgMod, tagMaps, index, getLiveSession }) {
  const { readWorkerRows, writeWorkerRows, flushWorkerIndexMutations } = index;

  function transitionStaleNonterminalRows(context = {}) {
    const staleRows = readWorkerRows(context).filter((row) => {
      if (isLeadPoolAgent(row.agent)) return false;
      if (isTerminalRow(row)) return false;
      if (getLiveSession(clean(row.sessionId))) return false;
      const rowTime = workerRowTime(row);
      const reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), row.provider);
      // A row with no timestamp has no usable heartbeat at all. Explicitly
      // disabled terminal reaping still gets the tombstone TTL as a finite
      // stale-heartbeat bound, so malformed/running index rows cannot block a
      // tag forever.
      return rowTime <= 0 || Date.now() - rowTime >= (reapMs ?? TAG_TOMBSTONE_TTL_MS);
    });
    if (staleRows.length === 0) return false;
    flushWorkerIndexMutations();
    const nowIso = new Date().toISOString();
    writeWorkerRows((byKey, tombstonesByKey, priorityTombstoneKeys) => {
      for (const row of staleRows) {
        const sessionId = clean(row.sessionId);
        for (const [key, candidate] of [...byKey.entries()]) {
          if (clean(candidate.sessionId) === sessionId) byKey.delete(key);
        }
        const tombstone = {
          tag: clean(row.tag),
          agent: clean(row.agent) || null,
          cwd: clean(row.cwd) || null,
          clientHostPid: positiveInt(row.clientHostPid),
          reapedAt: nowIso,
        };
        insertTombstone(tombstonesByKey, priorityTombstoneKeys, tombstone);
        tagMaps.unbindIfOwned(tombstone.tag, sessionId);
      }
    });
    return true;
  }

  return { transitionStaleNonterminalRows };
}
