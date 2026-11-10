/**
 * Assemble the visible Agent/Lead worker pool from projection functions owned
 * by the session summary reader. Keeping orchestration here makes the pool
 * boundary explicit without moving storage authority or transcript parsing.
 */
export function listStoredAgentWorkers({
  now,
  runningSessionIds,
  storedAgentWorkerIndexRows,
  projectChildWorkerRow,
  storedLeadWorkerRows,
  projectLeadWorkerRow,
  pruneOrphanChildRows,
}) {
  const context = { now, runningSessionIds };
  const bySessionId = new Map();
  for (const row of storedAgentWorkerIndexRows()) {
    const projected = projectChildWorkerRow(row, context);
    if (projected) bySessionId.set(projected.sessionId, projected);
  }
  const liveLeadSessionIds = new Set();
  for (const row of storedLeadWorkerRows()) {
    const projected = projectLeadWorkerRow(row, context);
    if (!projected) continue;
    liveLeadSessionIds.add(projected.sessionId);
    bySessionId.set(projected.sessionId, projected);
  }
  pruneOrphanChildRows(bySessionId, { liveLeadSessionIds });
  return [...bySessionId.values()].sort((left, right) => {
    const leftTime = Date.parse(String(left.startedAt || '')) || 0;
    const rightTime = Date.parse(String(right.startedAt || '')) || 0;
    return leftTime - rightTime || left.tag.localeCompare(right.tag);
  });
}
