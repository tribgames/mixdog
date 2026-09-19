// Tag registry: owns the tag maps (tag -> sessionId/agent/cwd) and every
// resolution/mutation path — resolve/next/bind/forget and the session-index
// refresh. Worker-index persistence lives in worker-index.mjs and terminal
// tombstones/reap timers in terminal-reaper.mjs; the tag maps are shared by
// reference so all three sides see the same live state.
import { agentTagOf, clean, rowMatchesContext, sessionMatchesContext } from './helpers.mjs';
import { isLeadPoolAgent, isTerminalWorkerStatus, workerRowToSession } from './worker-rows.mjs';
import { createLeadWorkerIndex } from './lead-worker-index.mjs';
import { createWorkerIndex } from './worker-index.mjs';
import { createTagMaps } from './tag-maps.mjs';
import { createTerminalReaper } from './terminal-reaper.mjs';

export function createTagRegistry({ dataDir, cfgMod, mgr, emitSubagentEvent }) {
  const tagMaps = createTagMaps();
  const { tags } = tagMaps;
  const index = createWorkerIndex({
    dataDir,
    cfgMod,
    mgr,
    tags,
    tagAgents: tagMaps.tagAgents,
    tagCwds: tagMaps.tagCwds,
  });
  const { readWorkerRows, upsertWorkerSessionDeferred, removeWorkerRow, refreshTagsFromIndex } = index;
  const { upsertLeadSession } = createLeadWorkerIndex({
    dataDir,
    cfgMod,
    workerRowFromSession: index.workerRowFromSession,
  });

  function getLiveSession(sessionId) {
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    return session && session.closed !== true ? session : null;
  }

  function tagForSession(sessionId) {
    const session = getLiveSession(sessionId);
    const persistedTag = agentTagOf(session);
    if (persistedTag) return persistedTag;
    for (const [tag, sid] of tags.entries()) {
      if (sid === sessionId) return tag;
    }
    return null;
  }

  const reaper = createTerminalReaper({ cfgMod, mgr, tagMaps, index, getLiveSession, tagForSession });

  function wantsSessionScan(args = {}) {
    return args.recover === true || args.scanSessions === true || args.scan_sessions === true;
  }

  function resolveTag(target, context = {}, options = {}) {
    const scanSessions = options.scanSessions === true;
    const excludeTerminalTraces = options.excludeTerminalTraces === true;
    refreshTagsFromSessions({ scanSessions, context });
    const value = clean(target);
    if (!value) return null;
    if (value.startsWith('sess_')) {
      const session = getLiveSession(value);
      if (session && sessionMatchesContext(session, context)) return value;
      const row = readWorkerRows(context).find((item) => item.sessionId === value);
      return row ? value : null;
    }
    const matches = agentSessionEntries({ scanSessions, context, excludeTerminalTraces }).filter(
      (entry) => entry.tag === value
    );
    if (matches.length === 1) return matches[0].session.id;
    if (matches.length > 1) {
      throw new Error(`agent: tag "${value}" is ambiguous across terminals; use sessionId`);
    }
    const sessionId = tags.get(value) || null;
    const session = getLiveSession(sessionId);
    return session && sessionMatchesContext(session, context) ? sessionId : null;
  }

  function agentSessionEntries({ scanSessions = false, context = {}, excludeTerminalTraces = false } = {}) {
    const rows = [];
    const seen = new Set();
    const add = (session, fallbackTag = '') => {
      const tag = agentTagOf(session) || clean(fallbackTag);
      if (!tag || !session?.id || session.closed === true) return;
      if (isLeadPoolAgent(session.agent)) return;
      if (!sessionMatchesContext(session, context)) return;
      if (seen.has(session.id)) return;
      seen.add(session.id);
      rows.push({ tag, session });
    };
    const addIndexRow = (row) => {
      const tag = clean(row?.tag);
      const sessionId = clean(row?.sessionId);
      if (!tag || !sessionId || !rowMatchesContext(row, context)) return;
      if (isLeadPoolAgent(row.agent)) return;
      if (seen.has(sessionId)) return;
      // Collision/resolution enumeration only: a row that is in a terminal
      // (or idle-but-finished) state AND has no live session behind it is a
      // lingering trace kept for the reap grace window. excludeTerminalTraces
      // drops those rows so live-session reuse/spawn resolution can proceed;
      // list/status keep excludeTerminalTraces=false so finished workers still
      // appear.
      if (excludeTerminalTraces && isTerminalWorkerStatus(row.status || row.stage) && !getLiveSession(sessionId)) {
        return;
      }
      seen.add(sessionId);
      rows.push({ tag, session: workerRowToSession(row), indexRow: row });
    };
    for (const row of readWorkerRows(context)) addIndexRow(row);
    if (scanSessions) {
      const tombstones = reaper.tagTombstoneIndex();
      const pendingTerminal = [];
      for (const session of mgr.listSessions({ includeClosed: false }) || []) {
        if (session?.closed === true) continue;
        const tag = agentTagOf(session);
        if (tag && reaper.tombstoneBlocksScan(session, tag, tombstones)) continue;
        add(session, tag);
        if (tag) reaper.scanUpsertSession(session, tag, tombstones, pendingTerminal);
      }
      reaper.settleScannedTerminalRows(pendingTerminal);
    }
    for (const [tag, sessionId] of tags.entries()) {
      add(getLiveSession(sessionId), tag);
    }
    return rows;
  }

  function nextTag(agent, context = {}) {
    refreshTagsFromSessions({ context });
    // Auto tags are agent + a per-agent local index with NO hyphen
    // ("worker3", "heavy-worker7", or "agent1" when the agent is unset). The
    // index is the max existing `^agent(\d+)$` + 1, escaping the agent so a
    // hyphenated agent ("heavy-worker") is matched literally. Keep incrementing
    // on any live collision.
    const base = clean(agent) || 'agent';
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}(\\d+)$`);
    let maxN = 0;
    for (const existing of tags.keys()) {
      const match = re.exec(existing);
      if (!match) continue;
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
    let n = maxN + 1;
    let tag = `${base}${n}`;
    while (resolveTag(tag, context)) tag = `${base}${++n}`;
    return tag;
  }

  function refreshTagsFromSessions({ scanSessions = false, context = {} } = {}) {
    reaper.transitionStaleNonterminalRows(context);
    const indexedRows = refreshTagsFromIndex(context);
    const indexedKeys = new Set(indexedRows.map((row) => `${row.tag}\0${row.sessionId}`));
    for (const [tag, sessionId] of [...tags.entries()]) {
      if (indexedKeys.has(`${tag}\0${sessionId}`)) continue;
      const session = getLiveSession(sessionId);
      if (!session || session.closed) tagMaps.unbind(tag);
    }
    if (!scanSessions) return;
    // Tags missing from the index are exactly the ones a reap just removed, so
    // the tombstone (not the still-open session record) decides whether this
    // scan may re-bind them.
    const tombstones = reaper.tagTombstoneIndex();
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
  }

  function bindTag(tag, session, extra = {}) {
    if (!tag || !session?.id) return;
    tagMaps.bind(tag, session);
    upsertWorkerSessionDeferred(session, tag, extra);
  }

  function forgetTag(tag) {
    if (!tag) return;
    const sessionId = tags.get(tag) || '';
    tagMaps.unbind(tag);
    removeWorkerRow({ tag, sessionId });
  }

  reaper.recoverTerminalReaps();

  return {
    readAllTagTombstones: index.readAllTagTombstones,
    readTagTombstones: index.readTagTombstones,
    readWorkerRows,
    writeWorkerRows: index.writeWorkerRows,
    flushWorkerIndexMutations: index.flushWorkerIndexMutations,
    upsertWorkerSession: index.upsertWorkerSession,
    upsertWorkerSessionDeferred,
    upsertLeadSession,
    removeWorkerRow,
    refreshTagsFromIndex,
    tags,
    tagAgents: tagMaps.tagAgents,
    tagCwds: tagMaps.tagCwds,
    reapTimers: reaper.reapTimers,
    wantsSessionScan,
    resolveTag,
    getLiveSession,
    tagForSession,
    agentSessionEntries,
    nextTag,
    refreshTagsFromSessions,
    bindTag,
    forgetTag,
    forgetTerminalSession: reaper.forgetTerminalSession,
    tombstoneTerminalSession: reaper.tombstoneTerminalSession,
    tagTombstoneForTag: reaper.tagTombstoneForTag,
    consumeTagTombstone: reaper.consumeTagTombstone,
    cancelReap: reaper.cancelReap,
    clearScheduledReaps: reaper.clearScheduledReaps,
    scheduleReap: reaper.scheduleReap,
    recoverTerminalReaps: reaper.recoverTerminalReaps,
    transitionStaleNonterminalRows: reaper.transitionStaleNonterminalRows,
  };
}
