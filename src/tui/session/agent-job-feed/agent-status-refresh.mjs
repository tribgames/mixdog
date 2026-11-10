const TERMINAL_STATUS =
  /^(completed|complete|done|success|succeeded|ok|failed|error|timeout|killed|cancelled|canceled|denied)$/;
const AGENT_STATUS_COALESCE_MS = 16;

export function isTerminalExecutionStatus(status) {
  return TERMINAL_STATUS.test(status);
}

// Coalesces the agent-status store refreshes triggered by job notifications
// into one set() per window; a terminal status forces that refresh.
export function createAgentStatusRefresh({ set, getDisposed, agentStatusState }) {
  let timer = null;
  let force = false;

  function refresh(parsed) {
    if (!parsed?.taskId) return;
    const status = String(parsed.status || '').toLowerCase();
    force = force || isTerminalExecutionStatus(status);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (getDisposed()) return;
      const forced = force;
      force = false;
      set(agentStatusState(forced ? { force: true } : undefined));
    }, AGENT_STATUS_COALESCE_MS);
    timer.unref?.();
  }

  function dispose() {
    if (timer) clearTimeout(timer);
    timer = null;
    force = false;
  }

  return { refresh, dispose };
}
