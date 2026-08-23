// Tag registry + terminal-session reaping, extracted from agent-tool.mjs.
// Owns the tag maps (tag -> sessionId/agent/cwd) and every mutation path:
// resolve/next/bind/forget, session-index refresh, terminal tombstones, and
// the delayed reap timers. The maps are returned by reference so the
// remaining agent-tool closure keeps its original direct reads.
import { agentTagOf, clean, clearAgentStatuslineRoute, positiveInt, rowMatchesContext, sessionMatchesContext } from './helpers.mjs';
import { TAG_TOMBSTONE_TTL_MS, isLeadPoolAgent, isTerminalWorkerStatus, tagTombstoneKey, workerRowTime, workerRowToSession } from './worker-rows.mjs';
import { resolveAgentTerminalReapMs } from '../../session-runtime/config-helpers.mjs';
import { createLeadWorkerIndex } from './lead-worker-index.mjs';
import { createWorkerIndex } from './worker-index.mjs';
export function createTagRegistry({
  dataDir,
  cfgMod,
  mgr,
  emitSubagentEvent,
}) {
  const tags = new Map();
  const tagAgents = new Map();
  const tagCwds = new Map();
  const reapTimers = new Map();
  // Worker-index persistence (row store, parse cache, batched atomic writer,
  // tag projection) lives in agent-tool/worker-index.mjs; the tag maps are
  // shared by reference so both sides see the same live state.
  const {
    readAllTagTombstones,
    readTagTombstones,
    readWorkerRows,
    writeWorkerRows,
    flushWorkerIndexMutations,
    workerRowFromSession,
    upsertWorkerSession,
    upsertWorkerSessionDeferred,
    removeWorkerRow,
    refreshTagsFromIndex,
  } = createWorkerIndex({ dataDir, cfgMod, mgr, tags, tagAgents, tagCwds });
  const { upsertLeadSession } = createLeadWorkerIndex({
    dataDir,
    cfgMod,
    workerRowFromSession,
  });

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
    const matches = agentSessionEntries({ scanSessions, context, excludeTerminalTraces })
      .filter((entry) => entry.tag === value);
    if (matches.length === 1) return matches[0].session.id;
    if (matches.length > 1) {
      throw new Error(`agent: tag "${value}" is ambiguous across terminals; use sessionId`);
    }
    const sessionId = tags.get(value) || null;
    const session = getLiveSession(sessionId);
    return session && sessionMatchesContext(session, context) ? sessionId : null;
  }

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
      // lingering trace kept for the reap grace window. excludeTerminalTraces drops those
      // rows so live-session reuse/spawn resolution can proceed; list/status
      // keep excludeTerminalTraces=false so finished workers still appear.
      if (excludeTerminalTraces
        && isTerminalWorkerStatus(row.status || row.stage)
        && !getLiveSession(sessionId)) {
        return;
      }
      seen.add(sessionId);
      rows.push({ tag, session: workerRowToSession(row), indexRow: row });
    };
    for (const row of readWorkerRows(context)) addIndexRow(row);
    if (scanSessions) {
      for (const session of mgr.listSessions({ includeClosed: false }) || []) {
        const tag = agentTagOf(session);
        add(session, tag);
        if (tag) upsertWorkerSessionDeferred(session, tag);
      }
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
    transitionStaleNonterminalRows(context);
    const indexedRows = refreshTagsFromIndex(context);
    const indexedKeys = new Set(indexedRows.map((row) => `${row.tag}\0${row.sessionId}`));
    for (const [tag, sessionId] of [...tags.entries()]) {
      if (indexedKeys.has(`${tag}\0${sessionId}`)) continue;
      const session = getLiveSession(sessionId);
      if (!session || session.closed) {
        tags.delete(tag);
        tagAgents.delete(tag);
        tagCwds.delete(tag);
      }
    }
    if (!scanSessions) return;
    for (const session of mgr.listSessions({ includeClosed: false }) || []) {
      if (isLeadPoolAgent(session?.agent)) continue;
      const tag = agentTagOf(session);
      if (!tag || tags.has(tag)) continue;
      if (!sessionMatchesContext(session, context)) continue;
      tags.set(tag, session.id);
      if (session.agent) tagAgents.set(tag, session.agent);
      if (session.cwd) tagCwds.set(tag, session.cwd);
      upsertWorkerSessionDeferred(session, tag);
    }
  }

  function bindTag(tag, session, extra = {}) {
    if (!tag || !session?.id) return;
    tags.set(tag, session.id);
    if (session.agent) tagAgents.set(tag, session.agent);
    if (session.cwd) tagCwds.set(tag, session.cwd);
    upsertWorkerSessionDeferred(session, tag, extra);
  }

  function forgetTag(tag) {
    if (!tag) return;
    const sessionId = tags.get(tag) || '';
    tags.delete(tag);
    tagAgents.delete(tag);
    tagCwds.delete(tag);
    removeWorkerRow({ tag, sessionId });
  }

  function forgetTerminalSession(tag, sessionId) {
    const value = clean(tag);
    const id = clean(sessionId);
    if (value && id && tags.get(value) === id) {
      tags.delete(value);
      tagAgents.delete(value);
      tagCwds.delete(value);
    }
    if (id) removeWorkerRow({ sessionId: id });
  }

  function tombstoneTerminalSession(tag, sessionId, session = null, expectedReapAt = '') {
    const value = clean(tag);
    const id = clean(sessionId);
    if (!value || !id) {
      if (!expectedReapAt) forgetTerminalSession(value, id);
      return false;
    }
    let applied = false;
    flushWorkerIndexMutations();
    writeWorkerRows((byKey, tombstonesByKey, priorityTombstoneKeys) => {
      const matches = [...byKey.entries()]
        .filter(([, row]) => clean(row.sessionId) === id);
      const expected = expectedReapAt
        ? matches.find(([, row]) =>
          clean(row.reapAt) === expectedReapAt
          && isTerminalWorkerStatus(row.status || row.stage))
        : null;
      // A stale timer from an earlier turn must never reap newer work.
      if (expectedReapAt && !expected) return;
      const source = expected?.[1] || matches[0]?.[1] || {};
      const tombstone = {
        tag: value,
        agent: clean(session?.agent || source.agent) || null,
        cwd: clean(session?.cwd || source.cwd) || null,
        clientHostPid: positiveInt(session?.clientHostPid || source.clientHostPid),
        reapedAt: new Date().toISOString(),
      };
      for (const [key] of matches) {
        byKey.delete(key);
      }
      const tombstoneKey = tagTombstoneKey(tombstone);
      tombstonesByKey.set(tombstoneKey, tombstone);
      priorityTombstoneKeys.add(tombstoneKey);
      applied = true;
    });
    if (!applied) return false;
    if (tags.get(value) === id) {
      tags.delete(value);
      tagAgents.delete(value);
      tagCwds.delete(value);
    }
    return true;
  }

  function tagTombstoneForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return null;
    return readTagTombstones(context).find((row) => row.tag === value) || null;
  }

  function consumeTagTombstone(tombstone) {
    if (!tombstone?.tag) return false;
    const key = tagTombstoneKey(tombstone);
    flushWorkerIndexMutations();
    writeWorkerRows((_byKey, tombstonesByKey) => tombstonesByKey.delete(key));
    return true;
  }

  function cancelReap(sessionId) {
    const handle = reapTimers.get(sessionId);
    if (!handle) return false;
    clearTimeout(handle);
    reapTimers.delete(sessionId);
    return true;
  }

  function reapTerminalRow(row) {
    const sessionId = clean(row?.sessionId);
    const reapAt = clean(row?.reapAt);
    const tag = clean(row?.tag) || tagForSession(sessionId);
    if (!sessionId || !reapAt || !tag) return false;
    const session = getLiveSession(sessionId);
    if (!tombstoneTerminalSession(tag, sessionId, session, reapAt)) return false;
    try { mgr.hideSessionFromList?.(sessionId); } catch {}
    clearAgentStatuslineRoute(sessionId);
    // Reaping expires only the reusable tag/runtime lease. The transcript is
    // user-visible from the parent task's agent tab, so terminal cleanup must
    // never tombstone it ahead of that parent.
    try { mgr.unloadSessionRuntime?.(sessionId, 'terminal-reap'); } catch {}
    return true;
  }

  function schedulePersistedReap(row) {
    const sessionId = clean(row?.sessionId);
    const reapAt = clean(row?.reapAt);
    const deadline = Date.parse(reapAt) || 0;
    if (!sessionId || !deadline) return false;
    cancelReap(sessionId);
    const handle = setTimeout(() => {
      reapTimers.delete(sessionId);
      reapTerminalRow(row);
    }, Math.max(0, deadline - Date.now()));
    handle.unref?.();
    reapTimers.set(sessionId, handle);
    return true;
  }

  function scheduleReap(sessionId, provider = null) {
    const id = clean(sessionId);
    if (!id) return false;
    cancelReap(id);
    // The terminal upsert is deferred to batch parallel fanout writes. Flush it
    // before stamping the deadline so reapAt and the terminal state land in one
    // durable lifecycle order.
    flushWorkerIndexMutations();
    const row = readWorkerRows().find((entry) => clean(entry.sessionId) === id);
    if (!row || !isTerminalWorkerStatus(row.status || row.stage)) return false;
    const reapProvider = clean(provider) || clean(row.provider)
      || clean(getLiveSession(id)?.provider) || null;
    const reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), reapProvider);
    const reapAt = reapMs == null ? null : new Date(Date.now() + reapMs).toISOString();
    let persisted = null;
    writeWorkerRows((byKey) => {
      for (const [key, current] of byKey.entries()) {
        if (clean(current.sessionId) !== id) continue;
        if (!isTerminalWorkerStatus(current.status || current.stage)) return;
        persisted = { ...current, reapAt };
        byKey.set(key, persisted);
        return;
      }
    });
    return persisted?.reapAt ? schedulePersistedReap(persisted) : false;
  }

  /** Rebuild child terminal timers after a process restart. Legacy rows have
   * no reapAt, so derive the original absolute deadline from their frozen
   * terminal stamp instead of granting a fresh full lease on every boot. */
  function recoverTerminalReaps() {
    flushWorkerIndexMutations();
    const now = Date.now();
    const recovered = [];
    writeWorkerRows((byKey) => {
      for (const [key, row] of byKey.entries()) {
        if (!isTerminalWorkerStatus(row.status || row.stage)) continue;
        let reapAt = clean(row.reapAt);
        if (!(Date.parse(reapAt) > 0)) {
          const reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), row.provider);
          if (reapMs == null) continue;
          const terminalAt = workerRowTime(row);
          // A timestamp-free legacy row cannot prove that its grace already
          // elapsed. Give it one normal window from recovery; timestamped rows
          // keep their original completion-based deadline.
          reapAt = new Date((terminalAt > 0 ? terminalAt : now) + reapMs).toISOString();
        }
        const next = { ...row, reapAt };
        byKey.set(key, next);
        recovered.push(next);
      }
    });
    for (const row of recovered) {
      if ((Date.parse(row.reapAt) || 0) <= now) reapTerminalRow(row);
      else schedulePersistedReap(row);
    }
  }

  function transitionStaleNonterminalRows(context = {}) {
    const staleRows = readWorkerRows(context).filter((row) => {
      if (isLeadPoolAgent(row.agent)) return false;
      if (isTerminalWorkerStatus(row.status || row.stage)) return false;
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
        const tombstoneKey = tagTombstoneKey(tombstone);
        tombstonesByKey.set(tombstoneKey, tombstone);
        priorityTombstoneKeys.add(tombstoneKey);
        if (tags.get(tombstone.tag) === sessionId) {
          tags.delete(tombstone.tag);
          tagAgents.delete(tombstone.tag);
          tagCwds.delete(tombstone.tag);
        }
      }
    });
    return true;
  }

  recoverTerminalReaps();

  return {
    readAllTagTombstones,
    readTagTombstones,
    readWorkerRows,
    writeWorkerRows,
    flushWorkerIndexMutations,
    upsertWorkerSession,
    upsertWorkerSessionDeferred,
    upsertLeadSession,
    removeWorkerRow,
    refreshTagsFromIndex,
    tags,
    tagAgents,
    tagCwds,
    reapTimers,
    wantsSessionScan,
    resolveTag,
    getLiveSession,
    tagForSession,
    agentSessionEntries,
    nextTag,
    refreshTagsFromSessions,
    bindTag,
    forgetTag,
    forgetTerminalSession,
    tombstoneTerminalSession,
    tagTombstoneForTag,
    consumeTagTombstone,
    cancelReap,
    scheduleReap,
    recoverTerminalReaps,
    transitionStaleNonterminalRows,
  };
}
