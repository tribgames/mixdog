/**
 * src/tui/engine/tool-approval.mjs — tool-approval queue plumbing extracted
 * from createEngineSession (engine.mjs) as a dependency-injection factory.
 *
 * These handlers drive a small FIFO of hook approval requests and reflect the
 * active one into store state (state.toolApproval). They need live session
 * state, so the closure identifiers (state/set/nextId/disposed/timeout) are
 * threaded through the factory argument via getters — never stale snapshots.
 * Every body is the original engine.mjs logic verbatim.
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
  function presentNextToolApproval() {
    if (activeToolApproval || getDisposed()) return;
    const entry = toolApprovalQueue.shift();
    if (!entry) {
      if (getState().toolApproval) set({ toolApproval: null });
      return;
    }
    activeToolApproval = entry;
    entry.timer = setTimeout(() => {
      finishToolApproval(entry.id, false, 'approval timed out');
    }, entry.request.timeoutMs);
    entry.timer.unref?.();
    set({ toolApproval: entry.request });
  }
  function finishToolApproval(id, approved, reason = '') {
    const targetId = String(id || '');
    if (activeToolApproval && activeToolApproval.id === targetId) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      if (entry.timer) clearTimeout(entry.timer);
      set({ toolApproval: null });
      try { entry.resolve({ approved: approved === true, reason: String(reason || '') }); } catch {}
      presentNextToolApproval();
      return true;
    }
    const index = toolApprovalQueue.findIndex((entry) => entry.id === targetId);
    if (index >= 0) {
      const [entry] = toolApprovalQueue.splice(index, 1);
      if (entry?.timer) clearTimeout(entry.timer);
      try { entry.resolve({ approved: approved === true, reason: String(reason || '') }); } catch {}
      return true;
    }
    return false;
  }
  function denyAllToolApprovals(reason = 'approval cancelled') {
    if (activeToolApproval) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      if (entry.timer) clearTimeout(entry.timer);
      try { entry.resolve({ approved: false, reason }); } catch {}
    }
    while (toolApprovalQueue.length > 0) {
      const entry = toolApprovalQueue.shift();
      if (entry?.timer) clearTimeout(entry.timer);
      try { entry.resolve({ approved: false, reason }); } catch {}
    }
    if (getState().toolApproval) set({ toolApproval: null });
  }
  function requestToolApproval(input = {}) {
    if (getDisposed()) return Promise.resolve({ approved: false, reason: 'runtime disposed' });
    return new Promise((resolve) => {
      const id = nextId();
      toolApprovalQueue.push({ id, request: normalizeToolApprovalRequest(input, id), resolve, timer: null });
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
