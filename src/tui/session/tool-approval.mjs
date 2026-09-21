/**
 * src/tui/session/tool-approval.mjs — session-owned tool-approval queue.
 *
 * These handlers drive a small FIFO of hook approval requests and reflect the
 * active one into store state (state.toolApproval). They need live session
 * state, so the closure identifiers (state/set/nextId/disposed/timeout) are
 * threaded through the factory argument via getters — never stale snapshots.
 */
export function createToolApproval({ getState, set, nextId, getDisposed, timeoutMs }) {
  const toolApprovalQueue = [];
  let activeToolApproval = null;

  function normalizeToolApprovalRequest(input = {}, id = nextId()) {
    const now = Date.now();
    const requestTimeoutMs = timeoutMs;
    return {
      id,
      name: String(input?.name || input?.tool_name || 'tool'),
      args: input?.args ?? input?.tool_input ?? null,
      cwd: input?.cwd || null,
      sessionId: input?.sessionId || input?.session_id || null,
      toolCallId: input?.toolCallId || input?.tool_use_id || null,
      reason: String(input?.reason || input?.message || 'approval requested by hook').trim(),
      requestedAt: now,
      timeoutMs: requestTimeoutMs,
      expiresAt: now + requestTimeoutMs,
    };
  }
  // Every request expires from ITS OWN requestedAt, queued or active. Arming
  // the timer only on presentation let a queued request sit past expiresAt
  // (retaining its promise and surfacing an obsolete approval later).
  function armToolApprovalTimeout(entry) {
    if (!entry || entry.timer) return;
    const remainingMs = Math.max(0, Number(entry.request?.expiresAt || 0) - Date.now());
    entry.timer = setTimeout(() => {
      finishToolApproval(entry.id, false, 'approval timed out');
    }, remainingMs);
    entry.timer.unref?.();
  }
  // Settle one entry: drop its timeout, then hand the waiter its answer. The
  // resolve stays guarded — a waiter whose caller already went away must never
  // take the rest of the queue down with it.
  function settleToolApproval(entry, approved, reason) {
    if (entry?.timer) clearTimeout(entry.timer);
    try {
      entry.resolve({ approved, reason });
    } catch {}
  }
  function presentNextToolApproval() {
    if (activeToolApproval || getDisposed()) return;
    const entry = toolApprovalQueue.shift();
    if (!entry) {
      if (getState().toolApproval) set({ toolApproval: null });
      return;
    }
    activeToolApproval = entry;
    armToolApprovalTimeout(entry);
    set({ toolApproval: entry.request });
  }
  function finishToolApproval(id, approved, reason = '') {
    const targetId = String(id || '');
    if (activeToolApproval && activeToolApproval.id === targetId) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      set({ toolApproval: null });
      settleToolApproval(entry, approved === true, String(reason || ''));
      presentNextToolApproval();
      return true;
    }
    const index = toolApprovalQueue.findIndex((entry) => entry.id === targetId);
    if (index >= 0) {
      const [entry] = toolApprovalQueue.splice(index, 1);
      settleToolApproval(entry, approved === true, String(reason || ''));
      return true;
    }
    return false;
  }
  function denyAllToolApprovals(reason = 'approval cancelled') {
    if (activeToolApproval) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      settleToolApproval(entry, false, reason);
    }
    while (toolApprovalQueue.length > 0) {
      settleToolApproval(toolApprovalQueue.shift(), false, reason);
    }
    if (getState().toolApproval) set({ toolApproval: null });
  }
  function requestToolApproval(input = {}) {
    if (getDisposed()) return Promise.resolve({ approved: false, reason: 'runtime disposed' });
    return new Promise((resolve) => {
      const id = nextId();
      const entry = { id, request: normalizeToolApprovalRequest(input, id), resolve, timer: null };
      toolApprovalQueue.push(entry);
      armToolApprovalTimeout(entry);
      presentNextToolApproval();
    });
  }

  return {
    presentNextToolApproval,
    finishToolApproval,
    denyAllToolApprovals,
    requestToolApproval,
  };
}
