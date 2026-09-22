// Bulk teardown: closing every agent session a Lead owns, cancelling the
// background tasks left running, and purging the worker rows behind them.
// Single-target close lives in ../close-flow.mjs and is injected as `close`.
import { cancelBackgroundTask, listBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';
import { presentErrorText } from '../../../runtime/shared/err-text.mjs';
import { clean } from '../helpers.mjs';
import { isLeadPoolAgent } from '../worker-rows.mjs';

export function createCloseAll({ registry, close }) {
  const { tags, tagAgents, tagCwds } = registry;

  function resetLocalTagState() {
    for (const timer of registry.reapTimers.values()) clearTimeout(timer);
    registry.reapTimers.clear();
    registry.clearScheduledReaps();
    tags.clear();
    tagAgents.clear();
    tagCwds.clear();
  }

  // Drop the closed workers' rows: every non-Lead row for an unscoped
  // teardown, only this owner's (plus the rows just closed) for a scoped one.
  function purgeWorkerRows(ownerSessionId, closedSessionIds) {
    registry.flushWorkerIndexMutations();
    registry.writeWorkerRows((byKey, tombstonesByKey) => {
      for (const [key, row] of [...byKey.entries()]) {
        if (isLeadPoolAgent(row.agent)) continue;
        if (
          ownerSessionId &&
          clean(row.ownerSessionId) !== ownerSessionId &&
          !closedSessionIds.has(clean(row.sessionId))
        )
          continue;
        byKey.delete(key);
      }
      if (!ownerSessionId) tombstonesByKey.clear();
    });
  }

  // Scoped teardown (one Lead closing/deleting/switching) must close ONLY that
  // Lead's workers: the worker index and task registry are shared by every
  // Lead in the process, and an unscoped sweep wiped sibling Leads' idle
  // workers mid-window.
  return async function closeAll(reason = 'cli-agent-close-all', scope = {}) {
    const ownerSessionId = clean(scope.callerSessionId);
    const context = ownerSessionId ? { callerSessionId: ownerSessionId } : {};
    registry.refreshTagsFromSessions({ scanSessions: false, context });
    const closed = [];
    const failed = [];
    for (const { tag, session } of registry.agentSessionEntries({ scanSessions: false, context })) {
      try {
        closed.push(await close({ sessionId: session.id }, context));
      } catch (err) {
        failed.push({ tag, error: presentErrorText(err, { surface: 'agent' }) });
      }
    }
    for (const task of listBackgroundTasks({ surface: 'agent', ...(ownerSessionId ? { context } : {}) })) {
      if (task?.status !== 'running') continue;
      cancelBackgroundTask(task.task_id, reason);
      closed.push({ closed: true, tag: task.tag || null, sessionId: task.sessionId || null, task_id: task.task_id });
    }
    if (!ownerSessionId) resetLocalTagState();
    const closedSessionIds = new Set(closed.map((row) => clean(row.sessionId)).filter(Boolean));
    purgeWorkerRows(ownerSessionId, closedSessionIds);
    return { closed, failed };
  };
}
