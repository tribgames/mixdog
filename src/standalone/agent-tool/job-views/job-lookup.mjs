// job-views/job-lookup.mjs
// Resolving read/status arguments to a job: by task id, then by tag/sessionId
// against the background-task registry, then — because background tasks are
// process-memory only while a worker SESSION can outlive its spawn task (task
// pruned, engine restarted) — a synthetic job built from the worker session.
import { getBackgroundTask, listBackgroundTasks, taskIdFromArgs } from '../../../runtime/shared/background-tasks.mjs';
import { clean } from '../helpers.mjs';

/** The worker's readable result: its last non-empty assistant message, else
 *  its last handoff, else a placeholder. */
function workerResultText(session) {
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  const lastAssistant = [...msgs]
    .reverse()
    .find((m) => m?.role === 'assistant' && (typeof m.content === 'string' ? m.content.trim() : m.content));
  if (lastAssistant) {
    return typeof lastAssistant.content === 'string' ? lastAssistant.content : JSON.stringify(lastAssistant.content);
  }
  if (typeof session.lastHandoff === 'string' && session.lastHandoff.trim()) return session.lastHandoff;
  return '(worker session has no assistant output yet)';
}

export function createJobLookup({ mgr, tags, refreshTagsFromSessions }) {
  function getJob(args, context = {}) {
    const taskId = taskIdFromArgs(args);
    if (taskId) {
      const task = getBackgroundTask(taskId, { surface: 'agent', context });
      if (!task) throw new Error(`agent read/status: task "${taskId}" not found`);
      return task;
    }
    // Same precedence as close(): clean(args.tag || args.sessionId || ...).
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('agent read/status: task_id, tag, or sessionId is required');
    const candidates = listBackgroundTasks({ surface: 'agent', context })
      .filter(Boolean)
      .filter((row) => row.tag === target || row.sessionId === target);
    if (!candidates.length) throw new Error(`agent read/status: no task found for tag/sessionId "${target}"`);
    // Prefer most recent when multiple tasks match the same tag.
    candidates.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
    const task = getBackgroundTask(candidates[0].task_id, { surface: 'agent', context });
    if (!task) throw new Error(`agent read/status: task "${candidates[0].task_id}" not found`);
    return task;
  }

  function workerFallbackJob(target, context = {}) {
    refreshTagsFromSessions({ scanSessions: true, context });
    const sessionId = tags.get(target) || (mgr.getSession(target) ? target : null);
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    if (!session) return null;
    return {
      taskId: null,
      operation: 'worker',
      status: session.closed === true ? 'closed' : session.status || 'idle',
      startedAt: session.createdAt || null,
      finishedAt: null,
      error: null,
      result: workerResultText(session),
      meta: {
        tag: tags.has(target) ? target : session.tag || null,
        sessionId,
        agent: session.agent || null,
        preset: session.presetName || null,
        provider: session.provider || null,
        model: session.model || null,
        effort: session.effort || null,
        fast: session.fast === true,
      },
    };
  }

  function getJobOrWorker(args, context = {}) {
    try {
      return getJob(args, context);
    } catch (error) {
      const target = clean(args.tag || args.sessionId);
      const fallback = target ? workerFallbackJob(target, context) : null;
      if (fallback) return fallback;
      throw error;
    }
  }

  return { getJob, workerFallbackJob, getJobOrWorker };
}
