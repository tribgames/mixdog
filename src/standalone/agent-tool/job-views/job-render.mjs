// job-views/job-render.mjs
// Shaping jobs for callers: the job list rows and the single-job status card,
// each pairing the task's own fields with either live worker progress or the
// frozen terminal view.
import { listBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';
import { positiveInt, terminalPidForContext } from '../helpers.mjs';
import { isTerminalJobStatus, terminalJobFrozenFields } from './session-progress.mjs';

/** The identity/route fields every job view starts with. `source` supplies the
 *  routing fields (a task summary or a job's meta); `afterAgent` slots extra
 *  fields right after `agent`. */
function jobHead({ taskId, type, status, startedAt, finishedAt, error }, source, afterAgent = {}) {
  return {
    task_id: taskId,
    type,
    status,
    tag: source.tag || null,
    sessionId: source.sessionId || null,
    agent: source.agent || null,
    ...afterAgent,
    preset: source.preset || null,
    provider: source.provider || null,
    model: source.model || null,
    effort: source.effort || null,
    fast: source.fast === true || source.fast === false ? source.fast : null,
    startedAt,
    finishedAt: finishedAt || null,
    error: error || null,
  };
}

export function createJobRender({ progress }) {
  function listJobs(context = {}) {
    const wantedPid = terminalPidForContext(context);
    const now = Date.now();
    const rows = listBackgroundTasks({ surface: 'agent', context }).map((task) => {
      const head = jobHead({ ...task, taskId: task.task_id, type: task.operation }, task);
      if (isTerminalJobStatus(task.status)) return { ...head, ...terminalJobFrozenFields(task.status, now) };
      return {
        ...head,
        ...progress.jobWorkerSnapshot(task.sessionId),
        ...progress.sessionProgressExtras(task.sessionId, task.agent || null, now, task.status),
      };
    });
    if (!wantedPid) return rows;
    return rows.filter((row) => {
      const pid = positiveInt(row.clientHostPid);
      // Spawn-prep rows have no worker session (and therefore no pid) yet;
      // they already passed taskMatchesScope, so the queued spawn stays
      // visible instead of vanishing until a pool slot frees up (user bug:
      // "spawned 5, only 4 listed").
      return pid ? pid === wantedPid : true;
    });
  }

  /** Before the worker session exists, live progress is empty and the status
   *  card would show only "status: running"; a minimal stage tells the caller
   *  the job is still spinning up rather than silently stalled. */
  function spawningProgress(status) {
    const spawning = status === 'running';
    return {
      worker_stage: spawning ? 'spawning' : status || 'unknown',
      last_progress: spawning ? 'spawning worker session' : status || 'unknown',
      diagnostic: spawning ? 'worker session not started yet' : status || 'unknown',
    };
  }

  function renderJob(job, includeResult = false) {
    const meta = job.meta || {};
    const head = jobHead(
      { ...job, type: job.operation },
      meta,
      meta.respawned === true
        ? {
            respawned: true,
            note: 'previous session reaped — fresh session, no prior context; re-supply anchors if needed',
          }
        : {}
    );
    const tail = includeResult && job.result !== undefined ? { result: job.result } : {};
    // Frozen terminal view: never re-read the (possibly reused) live session.
    if (isTerminalJobStatus(job.status)) {
      return { ...head, ...terminalJobFrozenFields(job.status), ...tail };
    }
    let liveProgress = progress.sessionProgressExtras(meta.sessionId, meta.agent || null, Date.now(), job.status);
    if (!meta.sessionId && (!liveProgress || Object.keys(liveProgress).length === 0)) {
      liveProgress = spawningProgress(job.status);
    }
    return {
      ...head,
      ...progress.jobWorkerSnapshot(meta.sessionId),
      ...liveProgress,
      ...tail,
    };
  }

  return { listJobs, renderJob };
}
