// Post-compaction Goal reminder.
//
// Compaction drops the Goal's own tool results out of context, so the durable
// task snapshot silently disappears mid-objective and the model keeps working
// without its checklist. This marks ONE pending reminder that renders into the
// next turn's tail block and clears only when the provider accepts that turn.
//
// Lifecycle mirrors deferred-tool-delta.mjs exactly (mark → snapshot →
// acknowledge on acceptance), so a cancelled or failed turn re-sends it instead
// of losing it. Deliberately event-driven: no per-turn injection.
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import { readStoredGoalSnapshot } from './goal-runtime.mjs';
import { goalStateReminder } from './goal-text.mjs';
import { clean } from './session-text.mjs';

function pendingRevision(session) {
  return Math.max(0, Number(session?.pendingGoalReminder?.revision) || 0);
}

export function markPendingGoalReminder(session, reason = 'compaction') {
  if (!session || typeof session !== 'object') return null;
  const revision = Math.max(
    pendingRevision(session),
    Math.max(0, Number(session.goalReminderRevision) || 0),
  ) + 1;
  session.goalReminderRevision = revision;
  session.pendingGoalReminder = {
    version: 1,
    type: 'goal_state',
    revision,
    reason: clean(reason) || 'compaction',
  };
  session.updatedAt = Date.now();
  return session.pendingGoalReminder;
}

export function clearPendingGoalReminder(session) {
  if (!session || typeof session !== 'object' || !session.pendingGoalReminder) return false;
  delete session.pendingGoalReminder;
  session.updatedAt = Date.now();
  return true;
}

export function snapshotPendingGoalReminder(session, { dataDir = null, readGoal = null } = {}) {
  const revision = pendingRevision(session);
  if (!revision) return null;
  const sessionId = clean(session?.id);
  if (!sessionId) return null;
  let goal = null;
  try {
    goal = typeof readGoal === 'function'
      ? readGoal(sessionId)
      : readStoredGoalSnapshot({ dataDir: clean(dataDir) || resolvePluginData(), sessionId });
  } catch {
    goal = null;
  }
  // Nothing left to remind about (no Goal, or it already finished): drop the
  // marker instead of re-reading the same file on every later turn.
  if (!goal || goal.status === 'complete') {
    clearPendingGoalReminder(session);
    return null;
  }
  const reason = clean(session.pendingGoalReminder?.reason);
  const content = goalStateReminder(goal, { reason });
  if (!content) {
    clearPendingGoalReminder(session);
    return null;
  }
  return { revision, reason, goal, content };
}

export function acknowledgePendingGoalReminder(session, revision) {
  if (!session || typeof session !== 'object') return false;
  const current = pendingRevision(session);
  if (!current || current !== Number(revision)) return false;
  delete session.pendingGoalReminder;
  session.updatedAt = Date.now();
  return true;
}

export function prependGoalReminderToLatestUserMessage(messages, content) {
  const reminder = clean(content);
  const out = Array.isArray(messages) ? [...messages] : [];
  if (!reminder) return out;
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index];
    if (message?.role !== 'user') continue;
    const current = message.content;
    const nextContent = Array.isArray(current)
      ? [{ type: 'text', text: `${reminder}\n\n` }, ...current]
      : `${reminder}\n\n${String(current ?? '')}`;
    out[index] = { ...message, content: nextContent };
    return out;
  }
  out.push({ role: 'user', content: reminder });
  return out;
}
