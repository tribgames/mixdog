// session-calls/goal-recovery.mjs
// Resuming the sessions that carry an active Goal after daemon replacement:
// discovering the stored session ids, re-checking that each Goal is still
// active, and materializing the survivors under daemon ownership. Reported as
// a count summary; a session that fails to resume never stops the others.
import { SESSION_ID_PATTERN } from '../agent-tree.mjs';

export function createGoalRecovery({ log, readStoredGoal, listStoredActiveGoalSessionIds, materializeSession }) {
  return async function recoverActiveGoals() {
    if (typeof listStoredActiveGoalSessionIds !== 'function') {
      return { found: 0, resumed: 0, skipped: 0, failed: 0 };
    }
    let listed;
    try {
      listed = await listStoredActiveGoalSessionIds();
    } catch (err) {
      log(`active Goal discovery failed: ${err?.message || err}`);
      return { found: 0, resumed: 0, skipped: 0, failed: 1 };
    }
    const sessionIds = [...new Set(Array.isArray(listed) ? listed : [])]
      .map((sessionId) => String(sessionId || ''))
      .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId));
    let resumed = 0;
    let skipped = 0;
    let failed = 0;
    for (const sessionId of sessionIds) {
      try {
        if (typeof readStoredGoal === 'function') {
          const goal = await readStoredGoal(sessionId);
          if (goal?.status !== 'active') {
            skipped += 1;
            continue;
          }
        }
        await materializeSession(sessionId);
        resumed += 1;
      } catch (err) {
        failed += 1;
        log(`active Goal recovery failed session=${sessionId}: ${err?.message || err}`);
      }
      // One session per turn of the loop: a restart with many active Goals
      // resumes them in a paced sequence, never as one uninterrupted run of
      // loads and parses that holds the main thread (and its supervisor ping).
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { found: sessionIds.length, resumed, skipped, failed };
  };
}
