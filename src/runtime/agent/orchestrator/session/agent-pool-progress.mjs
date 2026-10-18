// The Agents pool's quiet-time inputs: each row whose turn is in flight in
// this process carries its last counted progress stamp, its runtime stage
// (and running tool), and its agent's stall-watchdog warn point. Display
// only — nothing here reads or changes the watchdog's abort policy.
import { displayProgressStage, lastProgressAt } from '../../../shared/quiet-progress.mjs';
import { resolveAgentStallThresholds } from '../stall-policy.mjs';

/** `rows` with progress fields on every row `runtimeEntry(sessionId)` reports
 *  in flight. `awaitingTask` marks a row whose agent waits on its background
 *  work: 'wait' while its turn sits in `task wait`, 'background' while it is
 *  idle with a background task it handed off still running. Other rows pass
 *  through untouched. */
export function withTurnProgress(rows, runtimeEntry, isTurnInFlight, hasRunningTasks = () => false) {
  return rows.map((row) => {
    const entry = runtimeEntry(row?.sessionId);
    if (!isTurnInFlight(entry)) {
      return row?.sessionId && hasRunningTasks(row.sessionId) ? { ...row, awaitingTask: 'background' } : row;
    }
    const stage = typeof entry.stage === 'string' ? entry.stage : null;
    // The in-flight turn's own start is the elapsed origin. The index row's
    // stamp is written deferred (and a Lead row may never get one), so right
    // after a wake it still holds the PREVIOUS turn's start or none.
    const askStartedAt = Number(entry.askStartedAt) || 0;
    const rowStart = Number(row.turnStartedAt) || Date.parse(row.turnStartedAt) || 0;
    return {
      ...row,
      ...(askStartedAt > rowStart ? { turnStartedAt: new Date(askStartedAt).toISOString() } : {}),
      ...(entry.taskWaits > 0 ? { awaitingTask: 'wait' } : {}),
      progressAt: lastProgressAt(entry) || null,
      // `model_thinking` while the sent request waits for its headers.
      progressStage: displayProgressStage(entry),
      progressTool: stage === 'tool_running' ? entry.lastToolCall || null : null,
      stallWarnMs: resolveAgentStallThresholds(row.agent).warn * 1000,
    };
  });
}
