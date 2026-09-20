/**
 * src/session-runtime/turn/session-ops.mjs - between-turn session commands:
 * clear, rewind, manual compact, tool mode, cwd, and live transcript reads.
 */
import { normalizeToolMode } from '../effort.mjs';
import { interruptTaskWaitForSession } from '../../runtime/agent/orchestrator/session/task-wait-control.mjs';
import { markPendingGoalReminder } from '../goal-reminder.mjs';

export function createSessionOps(deps) {
  const {
    getSession,
    setSession,
    getCurrentCwd,
    setMode,
    getActiveTurnCount,
    mgr,
    invalidateContextStatusCache,
    agentTool,
    invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy,
    applyResolvedCwd,
    resolveCwdPath,
    agentStatusState,
    getReservedSessionId,
  } = deps;

  function recoverAgentWorkers() {
    try {
      agentTool.recoverWorkers?.({ clientHostPid: getSession()?.clientHostPid || process.pid });
    } catch {}
  }

  async function clear(options = {}) {
    const session = getSession();
    if (!session?.id) return false;
    const cleared = await mgr.clearSessionMessages(session.id, options);
    if (!cleared) return false;
    setSession(typeof cleared === 'object' ? cleared : mgr.getSession(session.id) || session);
    if (options.recoverAgent === true) recoverAgentWorkers();
    invalidateContextStatusCache();
    return true;
  }

  // Message-selector rewind: drop the chosen user prompt and everything
  // after it from the model history. Unlike clear() the session object is
  // kept (same id, same provider/model/cwd) — only the tail is undone.
  async function rewindMessages(options = {}) {
    const session = getSession();
    if (!session?.id) return null;
    const result = await mgr.rewindSessionMessagesTo?.(session.id, options);
    if (!result) return null;
    setSession(mgr.getSession(session.id) || session);
    invalidateContextStatusCache();
    return result;
  }

  async function compact(options = {}) {
    const session = getSession();
    if (!session?.id) return null;
    if (getActiveTurnCount() > 0) {
      return { changed: false, reason: 'compact skipped: turn in progress' };
    }
    // Manual compact bypasses loop.mjs, so its PreCompact/PostCompact never
    // fire here — dispatch them explicitly via the session-property hooks.
    try {
      await session.preCompactHook?.({ trigger: 'manual' });
    } catch {
      /* best-effort: PreCompact hook must never break manual compact */
    }
    const result = await mgr.compactSessionMessages(session.id);
    try {
      await session.postCompactHook?.({ trigger: 'manual' });
    } catch {
      /* best-effort: PostCompact hook must never break manual compact */
    }
    setSession(mgr.getSession(session.id) || session);
    // Manual /compact drops the Goal's tool results exactly like the
    // automatic path, so it marks the same one-shot state reminder.
    try {
      markPendingGoalReminder(getSession(), 'compaction');
    } catch {
      /* best-effort: a Goal reminder must never break manual compact */
    }
    if (options.recoverAgent === true) recoverAgentWorkers();
    invalidateContextStatusCache();
    return result;
  }

  async function setToolMode(nextMode) {
    const mode = normalizeToolMode(nextMode);
    setMode(mode);
    if (typeof refreshEmptySessionToolPolicy === 'function') {
      await refreshEmptySessionToolPolicy();
    } else {
      invalidatePreSessionToolSurface();
    }
    return mode;
  }

  function interruptTaskWait(reason = 'user-message') {
    const sessionId = getSession()?.id || getReservedSessionId?.() || '';
    return interruptTaskWaitForSession(sessionId, reason);
  }

  // Raw model-message read for LIVE transcript consumers (remote agent
  // handoff, daemon session.read). Answers from the in-memory session so a
  // just-committed final turn is readable immediately — the debounced disk
  // save can lag a finished turn past any remote waiter's window.
  function readModelMessages(messageStart = 0) {
    const messages = getSession()?.messages;
    const list = Array.isArray(messages) ? messages : [];
    const start = Math.max(0, Number(messageStart) || 0);
    return { messageCount: list.length, messages: list.slice(start) };
  }

  function setCwd(path) {
    applyResolvedCwd(resolveCwdPath(path), { persistProjectSelection: true });
    return getCurrentCwd();
  }

  return {
    clear,
    rewindMessages,
    compact,
    setToolMode,
    agentStatus: () => agentStatusState(),
    interruptTaskWait,
    readModelMessages,
    onAgentStatusChange: (listener) => agentTool.onStatusChange?.(listener) || (() => {}),
    setCwd,
  };
}
