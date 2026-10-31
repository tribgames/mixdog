// End-of-turn completion check for the session's todo list.
//
// A turn that ends without a tool call while pending/in-progress items remain
// gets one hidden reminder naming them, and the loop sends again. Bounded:
// at most MAX_TODO_REMINDERS per user cycle (reset only by a genuine user
// prompt, never by an automatic continuation), and silent after a reminder
// that produced no progress (no tool batch since). Skipped while the turn is
// genuinely waiting: on the user (an approval denied or a question left
// unanswered this turn), on an agent, or on a background shell started this
// user cycle (background-wait.mjs).
// Cancelled, failed and usage-limited turns never reach this point.
//
// With an active Goal whose items are all closed, the same check asks once
// per cycle for the completion audit: complete the Goal or append the rest.
import { resolvePluginData } from '../../../../../shared/plugin-paths.mjs';
import { awaitingBackgroundWork, beginUserCycle } from '../../../../../shared/background-wait.mjs';
import { readStoredGoalSnapshot } from '../../../runtime-core/goal-storage.mjs';
import { clearTodo, openTodoItems, todoAllClosed, todoPhases } from '../../../runtime-core/todo-list.mjs';
import { TODO_TOOL } from '../../../runtime-core/todo-tool-defs.mjs';
import { HIDDEN_AGENT_NAMES } from '../hidden-agents.mjs';
import { _isMutationTool, _isShellTool } from '../tool-classify.mjs';

const MAX_TODO_REMINDERS = 3;

// Sessions whose current turn waits on the user's decision (in memory: the
// turn itself is in memory, and a new turn clears it).
const userWaits = new Set();

/** The current turn now waits on the user (approval denied, question dismissed). */
export function noteTodoUserWait(sessionId) {
  if (sessionId) userWaits.add(String(sessionId));
}

function checkState(session) {
  const current = session.todoCheck;
  if (current && typeof current === 'object') return current;
  session.todoCheck = { reminders: 0, awaitingProgress: false, auditAsked: false };
  return session.todoCheck;
}

/** A turn starts: `genuine` (a real user prompt) opens a new reminder cycle. */
export function beginTodoTurn(session, { genuine = false } = {}) {
  if (!session || typeof session !== 'object') return;
  if (session.id) userWaits.delete(String(session.id));
  if (genuine) {
    session.todoCheck = { reminders: 0, awaitingProgress: false, auditAsked: false };
    beginUserCycle(session.id);
    // A finished list stays on screen until the user moves on, then goes the
    // way a finished Goal does. An active Goal keeps it for its audit.
    if (todoAllClosed(session) && !activeGoal(session.id)) clearTodo(session);
  }
}

/**
 * A delegated agent received a new brief or follow-up (a genuine prompt) with
 * no open list: the hidden reminder trailing that prompt, once per prompt, or
 * null. The tool description alone was read past on short multi-ask briefs.
 */
export function todoStartReminder(session) {
  if (!session || typeof session !== 'object' || session.owner !== 'agent') return null;
  if (HIDDEN_AGENT_NAMES.has(session.agent)) return null;
  if (!session.tools?.some((tool) => tool?.name === TODO_TOOL.name)) return null;
  if (openTodoItems(session).length) return null;
  return [
    '<system-reminder>',
    'If this brief has three or more steps or several asks, init the todo list with every ask as its own item in the same response as your first tool call; each item the brief lists is its own todo item, never folded into one. A single step or a plain answer needs none. Do not mention this reminder.',
    '</system-reminder>',
  ].join('\n');
}

/** A tool batch ran: the last reminder produced progress. */
export function noteTodoProgress(session) {
  if (session?.todoCheck?.awaitingProgress) session.todoCheck.awaitingProgress = false;
}

// Mid-turn nudge: a long turn can finish items without ever touching the list,
// leaving the progress shown to the user stale. After this many successful
// mutating tool calls with no todo call (and no earlier nudge), one hidden
// reminder is appended. Counted per call, not per batch, so a turn of parallel
// edits ages the list faster than a turn of reads; a batch of three edits is
// three. What mutates is the work the list tracks: file edits, command
// execution (shell, as a bash tool is) and mutating git/github requests.
const STALE_TODO_MUTATIONS = 10;

function mutatingCall(call, results) {
  const name = call?.name ?? call?.function?.name;
  const args = call?.arguments ?? call?.function?.arguments;
  if (!_isMutationTool(name, args) && !_isShellTool(name)) return false;
  const result = results.find((message) => message?.toolCallId === call.id);
  // A call that failed or was skipped (a dependency guard after a failed edit) changed nothing.
  return result?.toolKind !== 'error' && result?.toolKind !== 'skipped';
}

/**
 * A tool batch ran with `calls` (and their result messages): the hidden
 * stale-list reminder to append to the transcript, or null. Calls are read in
 * order: a todo call restarts the count, a successful mutating call adds one.
 * Outside the end-of-turn budget (`todoCheck.reminders`) and its progress gate.
 */
export function staleTodoReminder(session, calls = [], results = [], { sessionAgent = null } = {}) {
  if (!session || typeof session !== 'object' || HIDDEN_AGENT_NAMES.has(sessionAgent)) return null;
  const check = checkState(session);
  for (const call of calls) {
    if ((call?.name ?? call?.function?.name) === TODO_TOOL.name) check.staleMutations = 0;
    else if (mutatingCall(call, results)) check.staleMutations = (check.staleMutations || 0) + 1;
  }
  const phases = todoPhases(session);
  // A finished list needs nothing more; no list at all is nudged once per
  // user cycle (long runs that never made one), an open list repeatedly.
  if (phases.length && !openTodoItems(session).length) {
    check.staleMutations = 0;
    return null;
  }
  if (!phases.length && check.createNudged) return null;
  if ((check.staleMutations || 0) < STALE_TODO_MUTATIONS) return null;
  check.staleMutations = 0;
  if (!phases.length) {
    check.createNudged = true;
    return [
      '<system-reminder>',
      'No todo list exists for this work yet. If it has three or more steps, init one now with the steps left and keep it current; if it is a single step, ignore this. Keep working; do not mention this reminder.',
      '</system-reminder>',
    ].join('\n');
  }
  return [
    '<system-reminder>',
    'The todo tool has not been used for a while. Mark finished items done now (one call each, never batched at the end) so the in-progress pointer is on what you are doing. Keep working; do not mention this reminder.',
    ...phases.flatMap((phase) => phase.tasks.map((task) => `- [${task.status}] ${task.content}`)),
    '</system-reminder>',
  ].join('\n');
}

function activeGoal(sessionId) {
  try {
    const goal = readStoredGoalSnapshot({ dataDir: resolvePluginData(), sessionId });
    return goal?.status === 'active' ? goal : null;
  } catch {
    return null;
  }
}

function openItemsReminder(open, count) {
  return [
    '<system-reminder>',
    `You ended the turn with ${open.length} open todo item(s):`,
    ...open.map((task) => `- ${task.content}`),
    'Continue them, or close each with the todo tool (done, drop, or block with its reason).',
    `(Reminder ${count}/${MAX_TODO_REMINDERS})`,
    '</system-reminder>',
  ].join('\n');
}

const GOAL_AUDIT_REMINDER = [
  '<system-reminder>',
  'Every todo item is closed but the Goal is still active. Audit each user condition of the Goal objective against current evidence: when all are proven met, call goal with action complete; otherwise append the remaining work to todo and continue.',
  '</system-reminder>',
].join('\n');

/** The reminder to send before the turn may end, or null to let it end. */
export function todoCompletionReminder(session, { sessionId = null, sessionAgent = null, turnLimited = false } = {}) {
  if (!session || typeof session !== 'object' || turnLimited) return null;
  if (HIDDEN_AGENT_NAMES.has(sessionAgent)) return null;
  const id = String(sessionId || session.id || '');
  const phases = todoPhases(session);
  if (!phases.length) return null;
  const check = checkState(session);
  if (check.awaitingProgress || userWaits.has(id)) return null;
  const open = openTodoItems(session);
  if (open.length) {
    if (check.reminders >= MAX_TODO_REMINDERS) return null;
    if (awaitingBackgroundWork({ sessionId: id })) return null;
    check.reminders += 1;
    check.awaitingProgress = true;
    return openItemsReminder(open, check.reminders);
  }
  if (check.auditAsked || !id || !activeGoal(id)) return null;
  if (awaitingBackgroundWork({ sessionId: id })) return null;
  check.auditAsked = true;
  check.awaitingProgress = true;
  return GOAL_AUDIT_REMINDER;
}
