// Delayed reap timers: arm a terminal row's deadline, fire the reap when it
// elapses, and rebuild the timers after a process restart.
import { clean, clearAgentStatuslineRoute } from '../helpers.mjs';
import { workerRowTime } from '../worker-rows.mjs';
import { resolveAgentTerminalReapMs } from '../../../session-runtime/config-helpers.mjs';
import { isTerminalRow } from './row-helpers.mjs';

export function createReapTimers({ cfgMod, mgr, index, getLiveSession, tagForSession, tombstoneTerminalSession }) {
  const { readWorkerRows, writeWorkerRows, flushWorkerIndexMutations } = index;
  const reapTimers = new Map();
  // sessionId -> the reapAt a live timer was armed for. Lets a repeated session
  // scan recognise an already-armed deadline instead of re-arming (and thus
  // re-stamping) the same terminal lease on every list read.
  const scheduledReapAt = new Map();

  function isArmedFor(sessionId, reapAt) {
    return reapTimers.has(sessionId) && scheduledReapAt.get(sessionId) === reapAt;
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

  return {
    reapTimers,
    isArmedFor,
    clearScheduledReaps,
    cancelReap,
    reapTerminalRow,
    schedulePersistedReap,
    scheduleReap,
    recoverTerminalReaps,
  };
}
