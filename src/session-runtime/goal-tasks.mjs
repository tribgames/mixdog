import { GOAL_TASK_SETTLED, GOAL_TASK_STATUSES, MAX_GOAL_TASKS } from './goal-tool-defs.mjs';

const clean = (value) => String(value ?? '').trim();

// Frozen schemas can populate every optional array with an anonymous blank
// row. Only discard that filler for optional lifecycle changes; addressed,
// populated, or malformed rows must still reach the normal validators.
export function optionalGoalTaskChanges({ tasks, updates } = {}) {
  const populated = (entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
    || clean(entry.id) || clean(entry.text)
    || Object.keys(entry).some((key) => !['id', 'text', 'status', 'kind'].includes(key));
  return {
    tasks: Array.isArray(tasks) ? tasks.filter(populated) : tasks,
    updates: Array.isArray(updates) ? updates.filter(populated) : updates,
  };
}

export function normalizeGoalTasks(input, previous = [], { strict = false } = {}) {
  if (input == null) return previous.map((task) => ({ ...task }));
  if (!Array.isArray(input)) throw new Error('goal tasks must be an array');
  if (input.length > MAX_GOAL_TASKS) throw new Error(`goal tasks support at most ${MAX_GOAL_TASKS} entries`);
  const previousByText = new Map(previous.map((task) => [clean(task?.text), task]));
  const reservedIds = new Set([...previous, ...input].map((task) => clean(task?.id)).filter(Boolean));
  let nextId = 1;
  for (const id of reservedIds) {
    const match = /^task_(\d+)$/.exec(id);
    if (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) < Number.MAX_SAFE_INTEGER - MAX_GOAL_TASKS) {
      nextId = Math.max(nextId, Number(match[1]) + 1);
    }
  }
  const seenText = new Set();
  const seenIds = new Set();
  return input.map((entry, index) => {
    const source = typeof entry === 'string' ? { text: entry, status: 'pending', kind: 'work' } : entry;
    if (!source || typeof source !== 'object') throw new Error(`goal task ${index + 1} is invalid`);
    const text = clean(source.text);
    if (!text) throw new Error('goal task text is required');
    if ([...text].length > 500) throw new Error('goal task exceeds 500 characters');
    if (seenText.has(text)) throw new Error(`duplicate goal task: ${text}`);
    seenText.add(text);
    const id = clean(source.id) || clean(previousByText.get(text)?.id) || `task_${nextId++}`;
    if (seenIds.has(id)) throw new Error(`duplicate goal task id: ${id}`);
    seenIds.add(id);
    const rawStatus = clean(source.status).toLowerCase();
    const rawKind = clean(source.kind).toLowerCase();
    if (strict && !GOAL_TASK_STATUSES.includes(rawStatus)) throw new Error(`goal task ${index + 1} has an invalid status`);
    if (strict && !['work', 'verification'].includes(rawKind)) throw new Error(`goal task ${index + 1} has an invalid kind`);
    return {
      id, text,
      status: GOAL_TASK_STATUSES.includes(rawStatus) ? rawStatus : source.satisfied === true ? 'completed' : 'pending',
      kind: rawKind === 'verification' ? 'verification' : 'work',
    };
  });
}

export function taskInputRetains(entry, task) {
  if (typeof entry === 'string') return clean(entry) === task.text;
  if (!entry || typeof entry !== 'object') return false;
  return clean(entry.id) ? clean(entry.id) === task.id : clean(entry.text) === task.text;
}

// Only an explicit work-start signal resumes a paused Goal. A full snapshot
// can carry an old in-progress row while merely recording an approval request;
// a partial in_progress patch, however, explicitly starts/restarts that task.
export function goalTasksStartWork(previous, next, args = {}, { partial = false } = {}) {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  const restarted = new Set((partial && Array.isArray(args.updates) ? args.updates : [])
    .filter((patch) => clean(patch?.status).toLowerCase() === 'in_progress')
    .map((patch) => clean(patch.id)));
  return next.some((task) => task.status === 'in_progress'
    && (previousById.get(task.id)?.status !== 'in_progress' || restarted.has(task.id)));
}

export function patchGoalTasks(previous, { updates, tasks } = {}) {
  const patches = updates ?? [];
  const additions = tasks ?? [];
  if (!Array.isArray(patches) || !Array.isArray(additions)) throw new Error('goal updates and tasks must be arrays');
  if (!patches.length && !additions.length) throw new Error('goal update_tasks requires updates or new tasks');
  if (patches.length > MAX_GOAL_TASKS) throw new Error(`goal updates support at most ${MAX_GOAL_TASKS} entries`);
  const byId = new Map(previous.map((task) => [task.id, { ...task }]));
  const seen = new Set();
  for (const patch of patches) {
    const id = clean(patch?.id);
    if (!id || !byId.has(id)) throw new Error(`unknown Goal task id: ${id || '(missing)'}`);
    if (seen.has(id)) throw new Error(`duplicate Goal task update: ${id}`);
    seen.add(id);
    if (Object.keys(patch).some((key) => !['id', 'text', 'status', 'kind'].includes(key))) throw new Error(`unknown Goal task update field for ${id}`);
    byId.set(id, { ...byId.get(id), ...patch, id });
  }
  if (additions.some((task) => clean(task?.id))) throw new Error('new Goal tasks must omit ids; use updates for existing tasks');
  return normalizeGoalTasks([...byId.values(), ...additions], previous, { strict: true });
}

// Prepare a working copy without publishing it. Lifecycle actions can include
// task changes in the same durable commit instead of exposing an intermediate
// paused/active snapshot or consuming two revisions.
export function applyGoalTaskChanges(goal, args = {}, { partial = false, at = Date.now() } = {}) {
  if (goal.status === 'complete') throw new Error('cannot update tasks for a completed Goal');
  if (!partial && (!Array.isArray(args.tasks) || args.tasks.length === 0)) {
    throw new Error('goal set_tasks requires at least one task');
  }
  if (partial && goal.tasksObjectiveRevision !== goal.objectiveRevision) {
    throw new Error('Goal objective changed; read status and reconcile the full task list with set_tasks before partial updates');
  }
  const previousTasks = normalizeGoalTasks(goal.tasks || []);
  const input = partial ? patchGoalTasks(previousTasks, args) : args.tasks;
  const omitted = previousTasks.filter((task) =>
    !GOAL_TASK_SETTLED.includes(task.status)
    && !input.some((entry) => taskInputRetains(entry, task)));
  if (omitted.length > 0) {
    const detail = omitted.map((task) => `${task.id} (${task.text})`).join(', ');
    throw new Error(`cannot remove unfinished Goal tasks: ${detail}`);
  }
  const nextTasks = normalizeGoalTasks(input, previousTasks, { strict: true });
  // Re-sending the same tasks is not progress. A newly dropped task must
  // survive this turn before completion can retire the requested work.
  if (JSON.stringify(nextTasks) !== JSON.stringify(previousTasks)) goal.tasksUpdatedAt = at;
  const droppedNow = nextTasks.some((task) => task.status === 'dropped'
    && previousTasks.find((prev) => prev.id === task.id)?.status !== 'dropped');
  if (droppedNow) goal.lastDropTurn = Math.max(0, Math.floor(Number(goal.turnCount) || 0));
  goal.tasks = nextTasks;
  goal.tasksObjectiveRevision = goal.objectiveRevision;
  goal.updatedAt = at;
  return goal;
}
