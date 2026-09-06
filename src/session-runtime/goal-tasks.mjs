import { GOAL_TASK_STATUSES, MAX_GOAL_TASKS } from './goal-tool-defs.mjs';

const clean = (value) => String(value ?? '').trim();

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
