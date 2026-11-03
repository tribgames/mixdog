// Stale non-terminal rows: an index row whose session is gone and whose
// last row stamp is older than the reap window becomes a tombstone so its tag is
// freed instead of blocking spawn forever.
import { clean, positiveInt } from '../helpers.mjs';
import { isUnnotifiedRestartFailure } from '../worker-index/row-liveness.mjs';
import { TAG_TOMBSTONE_TTL_MS, isLeadPoolAgent, workerRowTime } from '../worker-rows.mjs';
import { resolveAgentTerminalReapMs } from '../../../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { insertTombstone, isTerminalRow, pastSettledRetention, sessionHasLiveWork } from './row-helpers.mjs';

export function createStaleRowTransition({ cfgMod, mgr, tagMaps, index, getLiveSession }) {
  const { readWorkerRows, writeWorkerRows, flushWorkerIndexMutations } = index;

  function transitionStaleNonterminalRows(context = {}) {
    const now = Date.now();
    // Resolved at most once, and only for a row whose decision needs the
    // provider window.
    let config;
    const getConfig = () => (config ??= cfgMod.loadConfig());
    const staleRows = readWorkerRows(context).filter((row) => {
      if (isLeadPoolAgent(row.agent)) return false;
      // Settled rows age out of the index (the tombstone keeps the tag's reap
      // note); an owed restart failure is the only record of that result, and
      // a session still in use in this process keeps its row.
      if (isTerminalRow(row)) {
        if (isUnnotifiedRestartFailure(row)) return false;
        if (!pastSettledRetention(getConfig, row, now) || sessionHasLiveWork(mgr, clean(row.sessionId))) return false;
        return true;
      }
      if (getLiveSession(clean(row.sessionId))) return false;
      const rowTime = workerRowTime(row);
      // A row with no timestamp has no usable stamp at all. Explicitly
      // disabled terminal reaping still gets the tombstone TTL as a finite
      // staleness bound, so malformed/running index rows cannot block a
      // tag forever.
      if (rowTime <= 0) return true;
      const reapMs = resolveAgentTerminalReapMs(getConfig(), row.provider);
      return now - rowTime >= (reapMs ?? TAG_TOMBSTONE_TTL_MS);
    });
    if (staleRows.length === 0) return false;
    flushWorkerIndexMutations();
    const nowIso = new Date().toISOString();
    const reapedIds = new Set(staleRows.map((row) => clean(row.sessionId)));
    writeWorkerRows((byKey, tombstonesByKey, priorityTombstoneKeys) => {
      for (const [key, candidate] of byKey) {
        if (reapedIds.has(clean(candidate.sessionId))) byKey.delete(key);
      }
      for (const row of staleRows) {
        const sessionId = clean(row.sessionId);
        const tombstone = {
          tag: clean(row.tag),
          agent: clean(row.agent) || null,
          cwd: clean(row.cwd) || null,
          clientHostPid: positiveInt(row.clientHostPid),
          sessionId,
          parentSessionId: clean(row.parentSessionId) || null,
          ownerSessionId: clean(row.ownerSessionId) || null,
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
