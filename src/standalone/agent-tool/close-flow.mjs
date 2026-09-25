import {
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  getBackgroundTask,
  listBackgroundTasks,
  taskIdFromArgs,
} from '../../runtime/shared/background-tasks.mjs';
import { agentScope, clean, clearAgentStatuslineRoute } from './helpers.mjs';
import { isLeadPoolAgent } from './worker-rows.mjs';
import { createCloseAll } from './close-flow/close-all.mjs';

const CLOSE_REASON = 'cancelled by agent close';

// close / cleanup / closeAll: tearing workers down without leaving lingering
// worker rows or tasks that would republish a closed session as `running`.
export function createCloseFlow({ mgr, registry, views }) {
  const { tags, tagAgents } = registry;

  // Stale local metadata only: resolveTag found no session in this
  // terminal/scope, so there is no sessionId-safe worker row to delete. Never
  // turn it into a tag-wide persisted-row removal.
  function forgetStaleLocalTag(target, task) {
    registry.unbindTag(target);
    if (task?.taskId) cancelBackgroundTask(task.taskId, CLOSE_REASON);
    return { closed: true, forgotten: true, tag: target, sessionId: null, task_id: task?.taskId || null };
  }

  // Cancel any running background task bound to this session BEFORE closing
  // the session. Otherwise closeSession rejects the in-flight runSpawn with
  // "Session closed: closeSession" and the catch path reconciles the task as
  // `failed` — a user-initiated close must surface as `cancelled` instead.
  function cancelSessionTasks(sessionId, target, scopedContext) {
    for (const row of listBackgroundTasks({ surface: 'agent', context: scopedContext })) {
      if (row.sessionId !== sessionId && row.tag !== target) continue;
      cancelBackgroundTask(row.task_id, CLOSE_REASON);
    }
  }

  async function close(args, context = {}) {
    const scopedContext = agentScope(args, context);
    registry.refreshTagsFromSessions({ scanSessions: registry.wantsSessionScan(args), context: scopedContext });
    const taskId = taskIdFromArgs(args);
    const task = taskId ? getBackgroundTask(taskId, { surface: 'agent', context }) : null;
    const taskMeta = task?.meta || {};
    const target = clean(args.tag || args.sessionId || taskMeta.sessionId);
    if (!target) {
      if (task?.taskId) {
        cancelBackgroundTask(task.taskId, CLOSE_REASON);
        return { closed: true, tag: taskMeta.tag || null, sessionId: null, task_id: task.taskId };
      }
      throw new Error('agent close: tag or sessionId is required');
    }
    const sessionId = registry.resolveTag(target, scopedContext, { scanSessions: registry.wantsSessionScan(args) });
    if (!sessionId) {
      if (!target.startsWith('sess_') && tagAgents.has(target)) return forgetStaleLocalTag(target, task);
      throw new Error(`agent close: target "${target}" not found`);
    }
    if (isLeadPoolAgent(registry.getLiveSession(sessionId)?.agent)) {
      throw new Error(`agent close: target "${target}" is a Lead session`);
    }
    registry.cancelReap(sessionId);
    const descendantSessionIds =
      typeof mgr.descendantSessionIds === 'function' ? mgr.descendantSessionIds(sessionId) : [];
    const tag = registry.tagForSession(sessionId);
    clearAgentStatuslineRoute(sessionId);
    cancelSessionTasks(sessionId, target, scopedContext);
    // Close (and stamp cancelStatus) BEFORE dropping the worker row. Removing
    // the row first left the next pool read with only a leftover heartbeat,
    // which republished the session as `running`. The explicit task_id cancel
    // below is an idempotent no-op fallback once terminal.
    const ok = await mgr.closeSession(sessionId, 'cli-agent-close');
    if (task?.taskId) cancelBackgroundTask(task.taskId, CLOSE_REASON);
    // Drop the row only once the cancellation is DURABLY recorded: a failed
    // close that still forgot the row left a fresh heartbeat with no cancelled
    // state — the exact lingering row this path exists to prevent.
    if (ok) {
      registry.forgetTerminalSession(tag, sessionId);
      for (const descendantSessionId of descendantSessionIds) {
        registry.removeWorkerRow({ sessionId: descendantSessionId });
      }
    }
    return { closed: ok, tag, sessionId, task_id: task?.taskId || null };
  }

  function cleanup(args = {}, context = {}) {
    const scopedContext = agentScope(args, context);
    const beforeTags = tags.size;
    registry.refreshTagsFromSessions({ scanSessions: registry.wantsSessionScan(args), context: scopedContext });
    const cleaned = cleanupBackgroundTasks({ surface: 'agent', context: scopedContext, force: args.force === true });
    return {
      tasksRemoved: cleaned.removed,
      tagsRemoved: beforeTags - tags.size,
      tasks: views.listJobs(scopedContext).length,
      // Cleanup reports how many worker rows remain known (idle/terminal
      // included); only the /agents worker section hides terminal rows.
      workers: views.list({
        scanSessions: registry.wantsSessionScan(args),
        context: scopedContext,
        includeTerminal: true,
      }).length,
    };
  }

  return { close, cleanup, closeAll: createCloseAll({ registry, close }) };
}
