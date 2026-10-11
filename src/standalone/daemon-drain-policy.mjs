/** Whether self-shutdown must wait for in-flight work. A forced replacement
 *  never waits: shutdown() aborts busy sessions, service calls and agent runs. */
export function drainDeferral(work, { force = false } = {}) {
  if (force) return null;
  const { activeCalls = 0, queuedCalls = 0, busySessions = 0, busyMemoryAgents = 0 } = work || {};
  if (activeCalls > 0 || queuedCalls > 0) return 'calls';
  if (busySessions > 0 || busyMemoryAgents > 0) return 'busy';
  return null;
}
