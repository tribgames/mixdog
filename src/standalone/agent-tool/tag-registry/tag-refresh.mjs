// Reconciliation of the live tag maps with the worker index and, on request,
// a scan of open sessions.
import { agentTagOf, sessionMatchesContext } from '../helpers.mjs';
import { isLeadPoolAgent } from '../worker-rows.mjs';

export function createTagRefresh({ tags, tagMaps, mgr, reaper, refreshTagsFromIndex, getLiveSession }) {
  return function refreshTagsFromSessions({ scanSessions = false, context = {} } = {}) {
    reaper.transitionStaleNonterminalRows(context);
    const indexedRows = refreshTagsFromIndex(context);
    const indexedKeys = new Set(indexedRows.map((row) => `${row.tag}\0${row.sessionId}`));
    const tombstones = reaper.tagTombstoneIndex();
    for (const [tag, sessionId] of [...tags.entries()]) {
      if (indexedKeys.has(`${tag}\0${sessionId}`)) continue;
      const session = getLiveSession(sessionId);
      if (!session || session.closed || reaper.tombstoneBlocksScan(session, tag, tombstones)) tagMaps.unbind(tag);
    }
    if (!scanSessions) return;
    // Tags missing from the index are exactly the ones a reap just removed, so
    // the tombstone (not the still-open session record) decides whether this
    // scan may re-bind them.
    const pendingTerminal = [];
    for (const session of mgr.listSessions({ includeClosed: false }) || []) {
      if (isLeadPoolAgent(session?.agent)) continue;
      if (session?.closed === true) continue;
      const tag = agentTagOf(session);
      if (!tag || tags.has(tag)) continue;
      if (!sessionMatchesContext(session, context)) continue;
      if (reaper.tombstoneBlocksScan(session, tag, tombstones)) continue;
      tagMaps.bind(tag, session);
      reaper.scanUpsertSession(session, tag, tombstones, pendingTerminal);
    }
    reaper.settleScannedTerminalRows(pendingTerminal);
  };
}
