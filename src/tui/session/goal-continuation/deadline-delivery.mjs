// Deadline notices for the running Goal: the advance warning and the closeout
// once the duration is reached.
import { clean } from '../../../runtime/shared/clean.mjs';
import { goalDeadlineReached, goalDeadlineWarning } from '../../../session-runtime/goal-text.mjs';
import { isGoalQueuedEntry } from '../queue-helpers.mjs';

export function createDeadlineDelivery({ runtime, getState, getPending, enqueue, halted }) {
  let watchedGoalId = '';
  let deliveredWarningRevision = 0;

  // Advance notice prepares bounded work and verification. It neither ends
  // the turn nor claims that the Goal has stopped.
  const deliverGoalDeadlineWarning = (goal) => {
    const revision = Math.max(0, Number(goal?.warningRevision) || 0);
    const goalId = clean(goal?.id);
    // Warnings this Goal earned before this controller existed were delivered
    // by whoever ran the session then, so the first sighting only sets the
    // watermark. Watching from the Goal's own start keeps the first crossing.
    if (goalId && goalId !== watchedGoalId) {
      watchedGoalId = goalId;
      deliveredWarningRevision = revision;
      return;
    }
    if (!revision || revision <= deliveredWarningRevision) return;
    deliveredWarningRevision = revision;
    if (clean(goal?.status) !== 'active' || !(Number(goal?.remainingMs) > 0)) return;
    const text = goalDeadlineWarning(goal);
    if (!clean(text)) return;
    const state = getState();
    if (state.busy || state.commandBusy) {
      // A queued prompt is the only entry shape the loop attaches mid-turn,
      // so the warning rides that contract: `isMeta` keeps it out of the
      // queued-command list and `suppressDisplay` renders no user bubble while
      // the model still receives the reminder content.
      enqueue(text, {
        mode: 'prompt',
        priority: 'next',
        isMeta: true,
        suppressDisplay: true,
        skipSlashCommands: true,
        restorable: false,
        goalId: clean(goal.id),
        displayText: '',
      });
      return;
    }
    try {
      runtime.markGoalReminder?.('deadline-soon');
    } catch {
      /* best-effort: a reminder must never break the session */
    }
  };

  const deliverGoalCloseout = (goal) => {
    if (halted()) return;
    const state = getState();
    if (state.sessionRemoteAttached) return;
    if (!state.busy && getPending().some((entry) => !isGoalQueuedEntry(entry))) {
      runtime.markGoalReminder?.('deadline-reached');
      return;
    }
    enqueue(goalDeadlineReached(goal), {
      mode: 'goal-closeout',
      priority: state.busy ? 'next' : 'later',
      isMeta: true,
      suppressDisplay: true,
      skipSlashCommands: true,
      restorable: false,
      abortDiscardOnAbort: true,
      goalId: clean(goal.id),
      displayText: '',
    });
  };

  return { deliverGoalDeadlineWarning, deliverGoalCloseout };
}
