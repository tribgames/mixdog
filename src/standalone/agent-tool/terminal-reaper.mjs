// Terminal-session reaping for the agent tag registry: tag tombstones, the
// scan admission guard they impose, the delayed reap timers and their
// recovery after a restart. Reaping expires only the tag/runtime lease — the
// session record stays open so the transcript remains visible from the parent
// task.
import { agentTagOf, clean, clearAgentStatuslineRoute, positiveInt, stampMs } from './helpers.mjs';
import { TAG_TOMBSTONE_TTL_MS, isTerminalWorkerStatus, isLeadPoolAgent, tagTombstoneKey, workerRowTime } from './worker-rows.mjs';
import { ACTIVE_STAGES } from './tool-def.mjs';
import { resolveAgentTerminalReapMs } from '../../session-runtime/config-helpers.mjs';

/** Latest proof of life on the session record itself. createdAt is included
 * as the last resort so a brand-new session that has not been stamped yet is
 * never mistaken for the reaped one that used to own its tag. */
function sessionActivityAt(session) {
  let latest = 0;
  for (const value of [session?.updatedAt, session?.finishedAt, session?.lastUsedAt, session?.createdAt]) {
    const parsed = stampMs(value);
    if (parsed > latest) latest = parsed;
  }
  return latest;
}

function isTerminalRow(row) {
  return isTerminalWorkerStatus(row.status || row.stage);
}

function insertTombstone(tombstonesByKey, priorityTombstoneKeys, tombstone) {
  const key = tagTombstoneKey(tombstone);
  tombstonesByKey.set(key, tombstone);
  priorityTombstoneKeys.add(key);
}

export function createTerminalReaper({ cfgMod, mgr, tagMaps, index, getLiveSession, tagForSession }) {
  const { tags } = tagMaps;
  const {
    readAllTagTombstones,
    readTagTombstones,
    readWorkerRows,
    writeWorkerRows,
    flushWorkerIndexMutations,
    upsertWorkerSessionDeferred,
    removeWorkerRow,
  } = index;
  const reapTimers = new Map();
  // sessionId -> the reapAt a live timer was armed for. Lets a repeated session
  // scan recognise an already-armed deadline instead of re-arming (and thus
  // re-stamping) the same terminal lease on every list read.
  const scheduledReapAt = new Map();

  function tagTombstoneIndex() {
    const byKey = new Map();
    for (const row of readAllTagTombstones()) byKey.set(tagTombstoneKey(row), row);
    return byKey;
  }

  // Without this guard a session scan re-binds a reaped tag and re-stamps the
  // row, handing the reaped worker a brand-new full reap lease on every list
  // read — the agent list could then never clear.
  function tombstoneBlocksScan(session, tag, tombstones) {
    const value = clean(tag);
    const sessionId = clean(session?.id);
    if (!value || !sessionId) return false;
    // A tag that currently maps to this session was re-bound by a real
    // lifecycle write (spawn/send/index row); the tombstone is spent.
    if (tags.get(value) === sessionId) return false;
    const tombstone = tombstones.get(tagTombstoneKey({ tag: value, clientHostPid: session?.clientHostPid }));
    const reapedAt = stampMs(tombstone?.reapedAt);
    if (!reapedAt) return false;
    // Activity after the reap means the session legitimately came back; only a
    // session that has been idle since its own reap stays suppressed.
    return reapedAt >= sessionActivityAt(session);
  }

  function scanSessionIsTerminal(session) {
    if (!session) return false;
    if (session.closed === true) return true;
    if (!isTerminalWorkerStatus(clean(session.status) || 'idle')) return false;
    const runtime = mgr.getSessionRuntime?.(clean(session.id)) || null;
    if (runtime?.controller?.signal && !runtime.controller.signal.aborted) return false;
    const stage = clean(runtime?.stage);
    return !(stage && ACTIVE_STAGES.has(stage));
  }

  /** Extra fields for a scan/rebind upsert of an already-terminal session. The
   * default row build stamps updatedAt = now and clears reapAt, which restarts
   * the lease from the read instead of from the work: a terminal session owns
   * its frozen stamps, and its deadline is derived from them. Returns null for
   * running/active sessions so they keep the normal (now-based) behavior. */
  function terminalScanExtra(session) {
    if (!scanSessionIsTerminal(session)) return null;
    const terminalAtMs = sessionActivityAt(session);
    // A stamp-free session cannot prove when its grace started; leave it to the
    // normal path rather than inventing an elapsed deadline.
    if (!(terminalAtMs > 0)) return null;
    const stamp = new Date(terminalAtMs).toISOString();
    const sessionId = clean(session?.id);
    const existing = readWorkerRows().find((row) => clean(row.sessionId) === sessionId) || null;
    const reapMs = resolveAgentTerminalReapMs(
      cfgMod.loadConfig(),
      clean(existing?.provider) || clean(session?.provider)
    );
    // An existing lease is authoritative: a read must never extend or reset it.
    const existingReapMs = stampMs(existing?.reapAt);
    let reapAt = null;
    if (existingReapMs > 0) reapAt = new Date(existingReapMs).toISOString();
    else if (reapMs != null) reapAt = new Date(terminalAtMs + reapMs).toISOString();
    const finishedMs = stampMs(session?.finishedAt) || stampMs(existing?.finishedAt);
    return {
      // Stamps are re-emitted as ISO so a numeric session stamp cannot leak an
      // unparseable value into the row store.
      updatedAt: stamp,
      finishedAt: finishedMs > 0 ? new Date(finishedMs).toISOString() : stamp,
      reapAt,
    };
  }

  // Shared session-scan admission: returns false when the scan must not
  // resurrect this session, otherwise indexes it (terminal sessions with their
  // own stamps) and records any terminal deadline for settlement.
  function scanUpsertSession(session, tag, tombstones, pendingTerminal) {
    if (tombstoneBlocksScan(session, tag, tombstones)) return false;
    const extra = terminalScanExtra(session);
    upsertWorkerSessionDeferred(session, tag, extra || {});
    if (extra?.reapAt) {
      pendingTerminal.push({
        tag: agentTagOf(session) || clean(tag),
        sessionId: clean(session.id),
        reapAt: extra.reapAt,
      });
    }
    return true;
  }

  /** Arm (or immediately run) the reap for rows a scan just (re)indexed. An
   * already-elapsed deadline is reaped now instead of buying a new window. */
  function settleScannedTerminalRows(pendingTerminal) {
    if (!pendingTerminal.length) return;
    const now = Date.now();
    for (const row of pendingTerminal) {
      const deadline = stampMs(row.reapAt);
      if (!deadline) continue;
      // reapTerminalRow -> tombstoneTerminalSession flushes the deferred upsert
      // first, so the row it matches on is the one this scan just wrote.
      if (deadline <= now) reapTerminalRow(row);
      else if (!reapTimers.has(row.sessionId) || scheduledReapAt.get(row.sessionId) !== row.reapAt)
        schedulePersistedReap(row);
    }
  }

  function forgetTerminalSession(tag, sessionId) {
    const id = clean(sessionId);
    tagMaps.unbindIfOwned(clean(tag), id);
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
      const matches = [...byKey.entries()].filter(([, row]) => clean(row.sessionId) === id);
      const expected = expectedReapAt
        ? matches.find(([, row]) => clean(row.reapAt) === expectedReapAt && isTerminalRow(row))
        : null;
      // A stale timer from an earlier turn must never reap newer work.
      if (expectedReapAt && !expected) return;
      const source = expected?.[1] || matches[0]?.[1] || {};
      for (const [key] of matches) {
        byKey.delete(key);
      }
      insertTombstone(tombstonesByKey, priorityTombstoneKeys, {
        tag: value,
        agent: clean(session?.agent || source.agent) || null,
        cwd: clean(session?.cwd || source.cwd) || null,
        clientHostPid: positiveInt(session?.clientHostPid || source.clientHostPid),
        reapedAt: new Date().toISOString(),
      });
      applied = true;
    });
    if (!applied) return false;
    tagMaps.unbindIfOwned(value, id);
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

  /** closeAll() drops every timer wholesale; the armed-deadline bookkeeping
   * must go with them or a later scan would trust a timer that no longer runs. */
  function clearScheduledReaps() {
    scheduledReapAt.clear();
  }

  function cancelReap(sessionId) {
    const handle = reapTimers.get(sessionId);
    scheduledReapAt.delete(sessionId);
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
    try {
      mgr.hideSessionFromList?.(sessionId);
    } catch {}
    clearAgentStatuslineRoute(sessionId);
    // Reaping expires only the reusable tag/runtime lease. The transcript is
    // user-visible from the parent task's agent tab, so terminal cleanup must
    // never tombstone it ahead of that parent.
    try {
      mgr.unloadSessionRuntime?.(sessionId, 'terminal-reap');
    } catch {}
    return true;
  }

  function schedulePersistedReap(row) {
    const sessionId = clean(row?.sessionId);
    const reapAt = clean(row?.reapAt);
    const deadline = Date.parse(reapAt) || 0;
    if (!sessionId || !deadline) return false;
    cancelReap(sessionId);
    const handle = setTimeout(
      () => {
        reapTimers.delete(sessionId);
        scheduledReapAt.delete(sessionId);
        reapTerminalRow(row);
      },
      Math.max(0, deadline - Date.now())
    );
    handle.unref?.();
    reapTimers.set(sessionId, handle);
    scheduledReapAt.set(sessionId, reapAt);
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
    if (!row || !isTerminalRow(row)) return false;
    const reapProvider = clean(provider) || clean(row.provider) || clean(getLiveSession(id)?.provider) || null;
    const reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), reapProvider);
    const reapAt = reapMs == null ? null : new Date(Date.now() + reapMs).toISOString();
    let persisted = null;
    writeWorkerRows((byKey) => {
      for (const [key, current] of byKey.entries()) {
        if (clean(current.sessionId) !== id) continue;
        if (!isTerminalRow(current)) return;
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
        if (!isTerminalRow(row)) continue;
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

  return {
    reapTimers,
    tagTombstoneIndex,
    tombstoneBlocksScan,
    scanUpsertSession,
    settleScannedTerminalRows,
    forgetTerminalSession,
    tombstoneTerminalSession,
    tagTombstoneForTag,
    consumeTagTombstone,
    clearScheduledReaps,
    cancelReap,
    scheduleReap,
    recoverTerminalReaps,
    transitionStaleNonterminalRows,
  };
}
