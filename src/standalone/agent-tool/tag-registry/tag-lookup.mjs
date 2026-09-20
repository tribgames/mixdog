// Tag → session resolution and enumeration over the live tag maps, the worker
// index and (on request) a scan of open sessions.
import { agentTagOf, clean, rowMatchesContext, sessionMatchesContext } from '../helpers.mjs';
import { isLeadPoolAgent, isTerminalWorkerStatus, workerRowToSession } from '../worker-rows.mjs';

export function createTagLookup({ tags, mgr, readWorkerRows, reaper, getLiveSession, refreshTagsFromSessions }) {
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

  return { resolveTag, agentSessionEntries, nextTag };
}
