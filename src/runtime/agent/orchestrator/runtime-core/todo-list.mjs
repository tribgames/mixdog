// The per-owner step list behind the `todo` tool. One list lives on each
// session record (`session.todo`: the Lead session, and each agent session),
// so it is saved with the session, survives a daemon restart and compaction,
// and is never shared between a Lead and its agents.
//
// Every mutation replaces `session.todo` with a new object: the published
// snapshot is memoized by that identity, and change listeners republish it.
import { emitSessionActivityChange } from '../../../shared/session-activity-signal.mjs';
import { MAX_TODO_ITEMS, MAX_TODO_TEXT_LENGTH, TODO_OPS, TODO_STATUSES } from './todo-tool-defs.mjs';

const DEFAULT_TODO_PHASE = 'Tasks';
const OPEN_STATUSES = new Set(['pending', 'in_progress']);
const listeners = new Set();
const snapshots = new WeakMap();

const oneLine = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

function itemText(value, what = 'item') {
  const text = oneLine(value);
  if (!text) throw new Error(`todo: ${what} wording is required`);
  if ([...text].length > MAX_TODO_TEXT_LENGTH) {
    throw new Error(`todo: ${what} exceeds ${MAX_TODO_TEXT_LENGTH} characters`);
  }
  return text;
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = oneLine(raw.content);
  if (!content) return null;
  const status = TODO_STATUSES.includes(raw.status) ? raw.status : 'pending';
  const task = { content, status };
  if (status === 'blocked' && oneLine(raw.blocker)) task.blocker = oneLine(raw.blocker);
  if (oneLine(raw.note)) task.note = oneLine(raw.note);
  return task;
}

/** The session's phases, normalized (stored records are untrusted). */
export function todoPhases(session) {
  const phases = Array.isArray(session?.todo?.phases) ? session.todo.phases : [];
  return phases
    .map((phase) => ({
      name: oneLine(phase?.name) || DEFAULT_TODO_PHASE,
      tasks: (Array.isArray(phase?.tasks) ? phase.tasks : []).map(normalizeTask).filter(Boolean),
    }))
    .filter((phase) => phase.tasks.length > 0);
}

const allTasks = (phases) => phases.flatMap((phase) => phase.tasks);

/** Exactly one in_progress while actionable work exists: several keep the
 *  earliest, none starts the earliest pending. Blocked never starts itself. */
function normalizeTodoPhases(phases) {
  const tasks = allTasks(phases);
  const active = tasks.filter((task) => task.status === 'in_progress');
  for (const task of active.slice(1)) task.status = 'pending';
  if (active.length === 0) {
    const next = tasks.find((task) => task.status === 'pending');
    if (next) next.status = 'in_progress';
  }
  return phases.filter((phase) => phase.tasks.length > 0);
}

function todoCounts(phases) {
  const tasks = allTasks(phases);
  return {
    completed: tasks.filter((task) => task.status === 'completed').length,
    abandoned: tasks.filter((task) => task.status === 'abandoned').length,
    total: tasks.length,
  };
}

/** Pending and in-progress items: the work the completion check asks about. */
export function openTodoItems(session) {
  return allTasks(todoPhases(session)).filter((task) => OPEN_STATUSES.has(task.status));
}

/** Every item not completed or dropped (blocked included): what an agent
 *  leaves undone when it ends. */
export function unfinishedTodoItems(session) {
  return allTasks(todoPhases(session)).filter((task) => task.status !== 'completed' && task.status !== 'abandoned');
}

/** The published session snapshot; null for an empty list. Identity-stable
 *  while the list is unchanged. */
export function todoSnapshot(session) {
  const record = session?.todo;
  if (!record || typeof record !== 'object') return null;
  if (snapshots.has(record)) return snapshots.get(record);
  const phases = todoPhases(session);
  const snapshot = phases.length ? { phases, ...todoCounts(phases) } : null;
  snapshots.set(record, snapshot);
  return snapshot;
}

/** Agent status rows: `{ completed, total, current? }`, or null. */
export function todoProgress(session) {
  const snapshot = todoSnapshot(session);
  if (!snapshot) return null;
  const current = allTasks(snapshot.phases).find((task) => task.status === 'in_progress')?.content;
  // Rows show completed/total directly, so dropped items leave the total.
  return {
    completed: snapshot.completed,
    total: snapshot.total - snapshot.abandoned,
    ...(current ? { current } : {}),
  };
}

export function onTodoChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A list with items, every one completed or dropped. */
export function todoAllClosed(session) {
  return todoPhases(session).length > 0 && unfinishedTodoItems(session).length === 0;
}

/** Let go of the session's list. */
export function clearTodo(session, at = Date.now()) {
  session.todo = null;
  session.updatedAt = at;
  publish(session);
}

function commitPhases(session, phases, at = Date.now()) {
  session.todo = { phases, updatedAt: at };
  session.updatedAt = at;
  publish(session);
}

function publish(session) {
  // The Agents pool shows each agent's progress: it re-reads on this pulse.
  emitSessionActivityChange(session.id || '');
  for (const listener of [...listeners]) {
    try {
      listener({ sessionId: session.id || null, todo: todoSnapshot(session) });
    } catch {
      /* a listener never breaks the tool */
    }
  }
}

const MARKS = { completed: 'x', in_progress: '>', pending: ' ', blocked: '!', abandoned: '-' };

function progressLabel(phases) {
  const { completed, abandoned, total } = todoCounts(phases);
  return `${completed}/${total - abandoned}`;
}

/** The whole list as text: init/view replies and context re-injection. */
function renderTodoList(phases) {
  if (!phases.length) return 'todo: empty';
  const lines = [progressLabel(phases)];
  for (const phase of phases) {
    lines.push(phase.name);
    for (const task of phase.tasks) {
      const detail = task.blocker ? ` — blocked: ${task.blocker}` : task.note ? ` — ${task.note}` : '';
      lines.push(`  [${MARKS[task.status]}] ${task.content}${detail}`);
    }
  }
  return lines.join('\n');
}

function summaryLine(phases, op, content) {
  const tasks = allTasks(phases);
  const parts = [progressLabel(phases), `${op}: ${content}`];
  const current = tasks.find((task) => task.status === 'in_progress');
  if (current) parts.push(`next: ${current.content}`);
  else if (tasks.some((task) => task.status === 'blocked')) parts.push('next: none (blocked items wait)');
  else parts.push('all closed');
  return parts.join(' · ');
}

function initPhases(args) {
  let source;
  if (Array.isArray(args.phases) && args.phases.length) source = args.phases;
  else if (Array.isArray(args.items) && args.items.length) {
    source = [{ name: oneLine(args.phase) || DEFAULT_TODO_PHASE, items: args.items }];
  } else throw new Error('todo: init requires items or phases');
  const seen = new Set();
  const phaseNames = new Set();
  const phases = source.map((entry) => {
    const name = itemText(entry?.name, 'phase');
    if (phaseNames.has(name)) throw new Error(`todo: duplicate phase "${name}"`);
    phaseNames.add(name);
    const items = Array.isArray(entry?.items) ? entry.items : [];
    if (!items.length) throw new Error(`todo: phase "${name}" has no items`);
    return {
      name,
      tasks: items.map((raw) => {
        const content = itemText(raw);
        if (seen.has(content)) throw new Error(`todo: duplicate item "${content}"`);
        seen.add(content);
        return { content, status: 'pending' };
      }),
    };
  });
  if (seen.size > MAX_TODO_ITEMS) throw new Error(`todo: at most ${MAX_TODO_ITEMS} items`);
  return phases;
}

function findTask(phases, rawContent) {
  const content = oneLine(rawContent);
  if (!content) throw new Error('todo: item (its exact wording) is required');
  for (const phase of phases) {
    const index = phase.tasks.findIndex((task) => task.content === content);
    if (index >= 0) return { phase, index, task: phase.tasks[index] };
  }
  throw new Error(`todo: no item "${content}"; view the list for exact wordings`);
}

const OPS = {
  start(phases, args) {
    const { task } = findTask(phases, args.item);
    if (task.status === 'completed') throw new Error(`todo: "${task.content}" is completed and stays closed`);
    if (task.status === 'blocked') throw new Error(`todo: "${task.content}" is blocked; unblock it first`);
    for (const other of allTasks(phases)) if (other.status === 'in_progress') other.status = 'pending';
    task.status = 'in_progress';
    return task.content;
  },
  done(phases, args) {
    const { task } = findTask(phases, args.item);
    task.status = 'completed';
    delete task.blocker;
    const note = oneLine(args.note);
    if (note) task.note = note;
    return task.content;
  },
  drop(phases, args) {
    const { task } = findTask(phases, args.item);
    if (task.status === 'completed') throw new Error(`todo: "${task.content}" is completed and stays closed`);
    task.status = 'abandoned';
    delete task.blocker;
    return task.content;
  },
  block(phases, args) {
    const { task } = findTask(phases, args.item);
    if (task.status === 'completed' || task.status === 'abandoned') {
      throw new Error(`todo: "${task.content}" is ${task.status}; only open items can block`);
    }
    task.status = 'blocked';
    task.blocker = itemText(args.reason, 'block reason');
    return task.content;
  },
  unblock(phases, args) {
    const { task } = findTask(phases, args.item);
    if (task.status !== 'blocked') throw new Error(`todo: "${task.content}" is not blocked`);
    task.status = 'pending';
    delete task.blocker;
    return task.content;
  },
  append(phases, args) {
    const items = Array.isArray(args.items) ? args.items.map((raw) => itemText(raw)) : [];
    if (!items.length) throw new Error('todo: append requires items');
    const existing = new Set(allTasks(phases).map((task) => task.content));
    for (const content of items) {
      if (existing.has(content)) throw new Error(`todo: item "${content}" already exists`);
      existing.add(content);
    }
    if (existing.size > MAX_TODO_ITEMS) throw new Error(`todo: at most ${MAX_TODO_ITEMS} items`);
    const name = oneLine(args.phase) || phases.at(-1)?.name || DEFAULT_TODO_PHASE;
    let phase = phases.find((candidate) => candidate.name === name);
    if (!phase) {
      phase = { name, tasks: [] };
      phases.push(phase);
    }
    phase.tasks.push(...items.map((content) => ({ content, status: 'pending' })));
    return items.join(', ');
  },
  rm(phases, args) {
    const { phase, index, task } = findTask(phases, args.item);
    phase.tasks.splice(index, 1);
    return task.content;
  },
};

/** Run one `todo` call against the owner session. Returns the reply text. */
export function executeTodoTool(session, args = {}) {
  if (!session || typeof session !== 'object') throw new Error('todo: no session owns this call');
  const op = oneLine(args?.op).toLowerCase();
  if (!TODO_OPS.includes(op)) throw new Error(`todo: op must be one of ${TODO_OPS.join(', ')}`);
  if (op === 'view') return renderTodoList(todoPhases(session));
  if (op === 'init') {
    // Replacing a list that still has unfinished work would silently erase it
    // (a follow-up ask re-initing mid-request): make the model close each first.
    const unfinished = unfinishedTodoItems(session);
    if (unfinished.length) {
      const named = unfinished.slice(0, 5).map((task) => `"${task.content}"`);
      if (unfinished.length > named.length) named.push(`${unfinished.length - named.length} more`);
      throw new Error(
        `todo: init would erase unfinished items (${named.join(', ')}); done or drop each first, or append to add asks`
      );
    }
    const phases = normalizeTodoPhases(initPhases(args));
    commitPhases(session, phases);
    return renderTodoList(phases);
  }
  const phases = structuredClone(todoPhases(session));
  if (!phases.length) throw new Error('todo: the list is empty; init it first');
  const content = OPS[op](phases, args);
  const next = normalizeTodoPhases(phases);
  commitPhases(session, next);
  return summaryLine(next, op, content);
}

/** Lines naming what an agent leaves undone, '' when nothing is. */
export function notDoneReport(session) {
  const unfinished = unfinishedTodoItems(session);
  if (!unfinished.length) return '';
  return [
    'Not done:',
    ...unfinished.map((task) => `- ${task.content}${task.blocker ? ` (blocked: ${task.blocker})` : ''}`),
  ].join('\n');
}

/** The open list as a hidden reminder (after compaction, or appended to a
 *  Goal continuation); '' when nothing is open. */
export function todoContextBlock(session, lead = 'Open todo items (exact wordings):', { whole = false } = {}) {
  const phases = todoPhases(session);
  if (!phases.length) return '';
  if (!whole && !allTasks(phases).some((task) => task.status !== 'completed' && task.status !== 'abandoned')) {
    return '';
  }
  return ['<todo_state>', lead, renderTodoList(phases), '</todo_state>'].join('\n');
}

// Legacy Goal task statuses as todo statuses.
const LEGACY_GOAL_TASK_STATUS = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  dropped: 'abandoned',
  awaiting_approval: 'blocked',
};

/** Move a legacy Goal record's tasks into the session's list (once; the Goal
 *  record drops them afterwards). Items already listed keep their state. */
export function adoptLegacyGoalTasks(session, legacyTasks) {
  if (!session || !Array.isArray(legacyTasks) || !legacyTasks.length) return false;
  const phases = structuredClone(todoPhases(session));
  const existing = new Set(allTasks(phases).map((task) => task.content));
  const adopted = [];
  for (const raw of legacyTasks) {
    // Migrated wording stays whole (old tasks allowed longer text); the
    // length limit applies only to newly authored items.
    const content = oneLine(raw?.text ?? raw?.content);
    if (!content || existing.has(content)) continue;
    existing.add(content);
    const status = LEGACY_GOAL_TASK_STATUS[oneLine(raw?.status).toLowerCase()] || 'pending';
    adopted.push(status === 'blocked' ? { content, status, blocker: 'awaiting user approval' } : { content, status });
  }
  if (!adopted.length) return false;
  const name = phases.length ? 'Goal' : DEFAULT_TODO_PHASE;
  let phase = phases.find((candidate) => candidate.name === name);
  if (!phase) {
    phase = { name, tasks: [] };
    phases.push(phase);
  }
  phase.tasks.push(...adopted);
  commitPhases(session, normalizeTodoPhases(phases));
  return true;
}
