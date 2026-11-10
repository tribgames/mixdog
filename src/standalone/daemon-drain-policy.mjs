/** Whether an idle GC sweep may start: no service call and no running turn
 *  (provider stream / tool call). Background-task-only sessions and memory
 *  agents do not block it — unlike drainDeferral, which guards shutdown. */
export function idleGcEligible(work) {
  const { activeCalls = 0, queuedCalls = 0, turnBusySessions = 0 } = work || {};
  return !(activeCalls > 0 || queuedCalls > 0 || turnBusySessions > 0);
}

/** Whether self-shutdown must wait for in-flight work. A forced replacement
 *  never waits: shutdown() aborts busy sessions, service calls and agent runs. */
export function drainDeferral(work, { force = false } = {}) {
  if (force) return null;
  const { activeCalls = 0, queuedCalls = 0, busySessions = 0, busyMemoryAgents = 0 } = work || {};
  if (activeCalls > 0 || queuedCalls > 0) return 'calls';
  if (busySessions > 0 || busyMemoryAgents > 0) return 'busy';
  return null;
}
