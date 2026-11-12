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

// First index of `order` ([due, sid] ascending) whose due is >= `due` / > `due`.
function lowerBound(order, due) {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (order[mid][0] < due) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function upperBound(order, due) {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (order[mid][0] <= due) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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

  // When `row` comes due by its stamps alone (ms; Infinity: never, or not a row
  // that ages out).
  function rowDeadline(getConfig, row) {
    if (isLeadPoolAgent(row.agent)) return Infinity;
    if (isTerminalRow(row)) {
      if (isUnnotifiedRestartFailure(row)) return Infinity;
      return settledRetentionDeadline(getConfig, row);
    }
    return nonterminalReapDeadline(getConfig, row);
  }

  // Every admitted row's deadline, ordered: the index's change feed updates
  // the rows that changed, and a call is a binary search. A deadline reads the
  // config only through its provider's reap window, so the windows the
  // deadlines were computed with are checked once per call, per provider.
  const deadlines = {
    feed: index.rowFeed,
    stopFeed: null,
    order: [], // [due, sid] ascending by due
    bySid: new Map(), // sid -> { due, provider }
    windows: new Map(), // provider -> the window the deadlines used
    providers: new Map(), // provider -> count of rows
  };

  function removeDeadline(sid) {
    const held = deadlines.bySid.get(sid);
    if (!held) return;
    deadlines.bySid.delete(sid);
    const count = (deadlines.providers.get(held.provider) || 1) - 1;
    if (count > 0) deadlines.providers.set(held.provider, count);
    else deadlines.providers.delete(held.provider);
    if (!Number.isFinite(held.due)) return;
    const { order } = deadlines;
    for (let i = lowerBound(order, held.due); i < order.length && order[i][0] === held.due; i += 1) {
      if (order[i][1] !== sid) continue;
      order.splice(i, 1);
      return;
    }
  }

  function placeDeadline(getConfig, sid) {
    removeDeadline(sid);
    const rec = deadlines.feed.rows().get(sid);
    if (!rec?.admitted) return;
    const provider = rec.row.provider ?? null;
    const due = rowDeadline(getConfig, rec.row);
    deadlines.bySid.set(sid, { due, provider });
    deadlines.providers.set(provider, (deadlines.providers.get(provider) || 0) + 1);
    if (Number.isFinite(due)) deadlines.order.splice(lowerBound(deadlines.order, due), 0, [due, sid]);
  }

  let pendingSids = null; // feed changes since the last call (null: rebuild all)
  function trackDeadlines() {
    if (deadlines.stopFeed) return;
    deadlines.stopFeed = deadlines.feed.subscribe(({ sids }) => {
      if (pendingSids) for (const sid of sids) pendingSids.add(sid);
    });
  }

  /** The next moment after `since` a row of `context` comes due by its
   *  stamps alone (ms), Infinity when none will. */
  function nextStaleRowDeadline(context = {}, since = Date.now()) {
    const getConfig = configOnce();
    if (Object.keys(context || {}).length > 0) {
      let next = Infinity;
      for (const row of readWorkerRows(context)) {
        const due = rowDeadline(getConfig, row);
        if (due > since && due < next) next = due;
      }
      return next;
    }
    trackDeadlines();
    deadlines.feed.sync();
    if (pendingSids === null) {
      pendingSids = new Set(deadlines.feed.rows().keys());
      for (const sid of [...deadlines.bySid.keys()]) pendingSids.add(sid);
    }
    // A provider whose window moved (a config change) re-places its rows.
    for (const [provider, window] of deadlines.windows) {
      if (!deadlines.providers.has(provider)) {
        deadlines.windows.delete(provider);
        continue;
      }
      if (Object.is(resolveAgentTerminalReapMs(getConfig(), provider), window)) continue;
      for (const [sid, held] of deadlines.bySid) if (held.provider === provider) pendingSids.add(sid);
    }
    const changed = pendingSids;
    pendingSids = new Set();
    for (const sid of changed) placeDeadline(getConfig, sid);
    for (const provider of deadlines.providers.keys()) {
      deadlines.windows.set(provider, resolveAgentTerminalReapMs(getConfig(), provider));
    }
    const at = upperBound(deadlines.order, since);
    return at < deadlines.order.length ? deadlines.order[at][0] : Infinity;
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
