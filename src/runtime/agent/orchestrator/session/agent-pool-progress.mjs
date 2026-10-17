// The Agents pool's quiet-time inputs: each row whose turn is in flight in
// this process carries its last counted progress stamp, its runtime stage
// (and running tool), and its agent's stall-watchdog warn point. Display
// only — nothing here reads or changes the watchdog's abort policy.
import { displayProgressStage, lastProgressAt } from '../../../shared/quiet-progress.mjs';
import { resolveAgentStallThresholds } from '../stall-policy.mjs';

/** `rows` with progress fields on every row `runtimeEntry(sessionId)` reports
 *  in flight; other rows pass through untouched. */
export function withTurnProgress(rows, runtimeEntry, isTurnInFlight) {
  return rows.map((row) => {
    const entry = runtimeEntry(row?.sessionId);
    if (!isTurnInFlight(entry)) return row;
    const stage = typeof entry.stage === 'string' ? entry.stage : null;
    return {
      ...row,
      progressAt: lastProgressAt(entry) || null,
      // `model_thinking` while the sent request waits for its headers.
      progressStage: displayProgressStage(entry),
      progressTool: stage === 'tool_running' ? entry.lastToolCall || null : null,
      stallWarnMs: resolveAgentStallThresholds(row.agent).warn * 1000,
    };
  });
}
