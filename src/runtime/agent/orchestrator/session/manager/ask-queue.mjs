// manager/ask-queue.mjs
// The follow-up prompt FIFO of one askSession call: which prompt the next
// turn runs (the caller's, a queued `agent type=send`, or a pre-drained
// group for an idle-resume kick) and the provenance it is stored with.
import { hasModelVisiblePromptContent } from './prompt-utils.mjs';
import {
  _groupPendingMessageEntries,
  PENDING_MODE_TASK_NOTIFICATION,
  drainPendingMessages,
  releasePendingMessages,
} from './pending-messages.mjs';

const SYNTHETIC_PROMPT_SOURCES = ['goal-continuation', 'goal-closeout'];

/** Prompt provenance for a drained queue turn: the source plus its execution when one exists. */
const promptSourceFields = (source, execution) => {
  if (!source) return null;
  return execution ? { source, execution } : { source };
};

// Provenance of a queue-fed turn: a task notification served as its own
// turn is stored as such (meta.source/execution), never as the user speaking.
const tailTurnFor = (group) => ({
  content: group.content,
  entries: group.entries,
  ...(group.mode === PENDING_MODE_TASK_NOTIFICATION
    ? promptSourceFields(PENDING_MODE_TASK_NOTIFICATION, group.execution)
    : {}),
});

// Queued follow-ups are plain user turns — no caller context / prefetch is
// re-applied (those belonged to the original ask).
const queuedTurnInput = (tailTurn) => ({
  prompt: tailTurn.content,
  context: null,
  explicitPrefetch: null,
  pendingEntries: tailTurn.entries,
  promptSource: promptSourceFields(tailTurn.source, tailTurn.execution),
});

export function createAskPromptQueue({ sessionId, promptSource }) {
  // Local FIFO of follow-up prompts drained from the pending-message queue
  // after each turn — keeps queued `agent type=send` messages in order.
  const tail = [];
  let initialPromptSource = SYNTHETIC_PROMPT_SOURCES.includes(promptSource)
    ? { source: promptSource, synthetic: true }
    : null;

  /** The next turn's input — prompt, caller context, consumed queue entries
   *  and provenance — or null when nothing model-visible is left to run. */
  const nextTurn = (original) => {
    const source = initialPromptSource;
    initialPromptSource = null;
    let input;
    if (tail.length > 0) {
      // After the first turn, the next prompt comes from the drained queue.
      input = queuedTurnInput(tail.shift());
    } else if (hasModelVisiblePromptContent(original.prompt)) {
      input = { ...original, pendingEntries: [], promptSource: source };
    } else {
      // Idle resume: TUI kicks an empty ask() after execution completions
      // mirror model-visible bodies into session pending. Drain that queue
      // here so we never synthesize an empty user turn for the model.
      // Modes are never mixed: the first group runs now, the rest queue
      // as their own follow-up turns (task notifications one each).
      const preDrained = drainPendingMessages(sessionId);
      if (preDrained.length === 0) return null;
      const groups = _groupPendingMessageEntries(preDrained);
      const first = groups[0];
      if (!first?.content) {
        releasePendingMessages(sessionId, preDrained);
        return null;
      }
      tail.unshift(...groups.slice(1).map(tailTurnFor));
      input = queuedTurnInput(tailTurnFor(first));
    }
    return hasModelVisiblePromptContent(input.prompt) ? input : null;
  };

  /** Queues drained pending-message entries as follow-up turns; true when
   *  at least one turn was queued. */
  const pushDrained = (drained) => {
    if (drained.length === 0) return false;
    // Same grouping as the mid-turn steering drain: queued PROMPT entries
    // in one batch are joined with "\n" and delivered as ONE follow-up
    // turn, while each task notification is its own turn (modes never
    // share a user message). Anything that arrives AFTER this drain
    // enqueues for the next loop pass.
    const groups = _groupPendingMessageEntries(drained);
    if (groups.length === 0) return false;
    tail.push(...groups.map(tailTurnFor));
    return true;
  };

  return { nextTurn, pushDrained };
}
