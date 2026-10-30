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
import { HIDDEN_AGENT_NAMES } from '../hidden-agents.mjs';

export const MAX_TODO_REMINDERS = 3;

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

/** A tool batch ran: the last reminder produced progress. */
export function noteTodoProgress(session) {
  if (session?.todoCheck?.awaitingProgress) session.todoCheck.awaitingProgress = false;
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
