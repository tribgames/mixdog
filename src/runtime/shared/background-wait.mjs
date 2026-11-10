// The one rule for "this session is waiting on work that will wake it": an
// agent it started is still running, or a background shell job it started in
// the CURRENT user cycle (since its last genuine user prompt) is still
// running — started with `background: true` or moved to the background after
// its hold alike; its completion arrives as a task notification. Running jobs
// from earlier cycles (long-lived servers, watchers) and the processes a
// finished command left behind (`detached`) never count. The cycle is stamped
// on the job when it starts (stampShellJobCycle), never read from its command.
// Shared by the end-of-turn todo completion check and Goal auto-continuation.
import { clean } from './clean.mjs';
import { hasActiveBackgroundTasks } from './background-tasks.mjs';

// Session id -> its user cycle number. In memory like the shell jobs it
// stamps: a restarted process has no running jobs from an earlier cycle.
const userCycles = new Map();

/** A genuine user prompt opened a new cycle for `sessionId`. */
export function beginUserCycle(sessionId) {
  const id = clean(sessionId);
  if (id) userCycles.set(id, (userCycles.get(id) || 0) + 1);
}

const currentUserCycle = (sessionId) => userCycles.get(clean(sessionId)) || 0;

/** Record on a starting background shell job the owner's current cycle. */
export function stampShellJobCycle(task) {
  if (task?.ownerSessionId) task.userCycle = currentUserCycle(task.ownerSessionId);
  return task;
}

const ACTIVE_AGENT_STATUSES = new Set([
  'connecting',
  'requesting',
  'streaming',
  'tool_running',
  'running',
  'cancelling',
]);

/** A running agent among published status rows (`agentJobs` / `agentWorkers`). */
function runningAgentWork(agentStatus) {
  const jobs = Array.isArray(agentStatus?.agentJobs) ? agentStatus.agentJobs : [];
  if (jobs.some((job) => clean(job?.status).toLowerCase() === 'running')) return true;
  const workers = Array.isArray(agentStatus?.agentWorkers) ? agentStatus.agentWorkers : [];
  return workers.some((worker) => {
    const status = clean(worker?.status).toLowerCase();
    const stage = clean(worker?.stage || worker?.worker_stage).toLowerCase();
    return ACTIVE_AGENT_STATUSES.has(status) || ACTIVE_AGENT_STATUSES.has(stage);
  });
}

/** Whether `sessionId` waits on an agent or an awaited background shell. */
export function awaitingBackgroundWork({ sessionId = null, agentStatus = null } = {}) {
  if (runningAgentWork(agentStatus)) return true;
  const id = clean(sessionId);
  if (!id) return false;
  return (
    hasActiveBackgroundTasks({ callerSessionId: id, surface: 'agent' }) ||
    hasActiveBackgroundTasks({
      callerSessionId: id,
      surface: 'shell',
      awaitedOnly: true,
      match: (task) => task.userCycle === currentUserCycle(id),
    })
  );
}
