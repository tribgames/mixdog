// Stale non-terminal rows: an index row whose session is gone and whose
// last row stamp is older than the reap window becomes a tombstone so its tag is
// freed instead of blocking spawn forever.
import { clean } from '../helpers.mjs';
import { isUnnotifiedRestartFailure } from '../worker-index/row-liveness.mjs';
import { TAG_TOMBSTONE_TTL_MS, isLeadPoolAgent, workerRowTime } from '../worker-rows.mjs';
import { resolveAgentTerminalReapMs } from '../../../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { isTerminalRow, pastSettledRetention, sessionHasLiveWork, settledRetentionDeadline } from './row-helpers.mjs';
import { tombstoneRows } from './tombstone-rows.mjs';

// When a non-terminal row's stamp is past the reap window. A row with no
// timestamp has no usable stamp at all (due at once). Explicitly disabled
// terminal reaping still gets the tombstone TTL as a finite staleness bound,
// so malformed/running index rows cannot block a tag forever.
function nonterminalReapDeadline(getConfig, row) {
  const rowTime = workerRowTime(row);
  if (rowTime <= 0) return 0;
  return rowTime + (resolveAgentTerminalReapMs(getConfig(), row.provider) ?? TAG_TOMBSTONE_TTL_MS);
}

export function createStaleRowTransition({ cfgMod, mgr, tagMaps, index, getLiveSession }) {
  const { readWorkerRows } = index;

  // The provider window, resolved at most once per call and only for a row
  // whose decision needs it.
  const configOnce = () => {
    let config;
    return () => (config ??= cfgMod.loadConfig());
  };

  // sessionId -> what kept its row when last looked at: 'work' (aged out, but
  // the session is busy: its activity settling looks again) or 'session' (a
  // running row whose session is open: its close looks again). heldRowFor.
  const heldDue = new Map();

  /** The next moment after `since` a row of `context` comes due by its
   *  stamps alone (ms), Infinity when none will. */
  function nextStaleRowDeadline(context = {}, since = Date.now()) {
    const getConfig = configOnce();
    let next = Infinity;
    for (const row of readWorkerRows(context)) {
      if (isLeadPoolAgent(row.agent)) continue;
      let due;
      if (isTerminalRow(row)) {
        if (isUnnotifiedRestartFailure(row)) continue;
        due = settledRetentionDeadline(getConfig, row);
      } else due = nonterminalReapDeadline(getConfig, row);
      if (due > since && due < next) next = due;
    }
    return next;
  }

  function transitionStaleNonterminalRows(context = {}) {
    const now = Date.now();
    const getConfig = configOnce();
    const staleRows = readWorkerRows(context).filter((row) => {
      if (isLeadPoolAgent(row.agent)) return false;
      const sessionId = clean(row.sessionId);
      heldDue.delete(sessionId);
      // Settled rows age out of the index (the tombstone keeps the tag's reap
      // note); an owed restart failure is the only record of that result, and
      // a session still in use in this process keeps its row.
      if (isTerminalRow(row)) {
        if (isUnnotifiedRestartFailure(row)) return false;
        if (!pastSettledRetention(getConfig, row, now)) return false;
        if (!sessionHasLiveWork(mgr, sessionId)) return true;
        heldDue.set(sessionId, 'work');
        return false;
      }
      // An open session keeps its row whatever its stamps say.
      if (getLiveSession(sessionId)) {
        heldDue.set(sessionId, 'session');
        return false;
      }
      return now >= nonterminalReapDeadline(getConfig, row);
    });
    return tombstoneRows({ index, tagMaps }, staleRows);
  }

  /** What kept `sessionId`'s row when last looked at ('work' | 'session'),
   *  else null: the end of that asks for bookkeeping. */
  function heldRowFor(sessionId) {
    const id = clean(sessionId);
    const reason = heldDue.get(id);
    if (!reason) return null;
    // A row that left the index since is nobody's to look at again.
    if (readWorkerRows().some((row) => clean(row.sessionId) === id)) return reason;
    heldDue.delete(id);
    return null;
  }

  return { transitionStaleNonterminalRows, nextStaleRowDeadline, heldRowFor };
}
