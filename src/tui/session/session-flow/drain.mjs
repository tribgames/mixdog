/**
 * src/tui/session/session-flow/drain.mjs - unified prompt queue: idempotent
 * enqueue intake and the between-turns drain loop that runs one priority/mode
 * bucket per turn.
 */
import {
  isGoalQueuedEntry,
  isQueuedEntryEditable,
  isSlashQueuedEntry,
  mergePromptContents,
  mergePastedImages,
  mergePastedTexts,
} from '../queue-helpers.mjs';
import { parseModelVisibleCompletionWrapper } from '../agent-envelope.mjs';
import { rewoundFailedTurnItems } from './failed-turn-rewind.mjs';
import { PROMPT_ORIGIN_AGENT_REPORT, PROMPT_ORIGIN_CHANNEL } from '../../../runtime/shared/prompt-origin.mjs';
import { ACTIVE_TURN_RECHECK_MS, createBlockedDrainRetry } from './drain-retry.mjs';
import { createClosedQueueSettler } from './drain-closed-queue.mjs';
import { createEnqueue } from './drain-enqueue.mjs';

function earliestSubmittedAt(batch) {
  const earliest = batch.reduce((min, entry) => {
    const value = Number(entry.submittedAt);
    return Number.isFinite(value) && value > 0 ? Math.min(min, value) : min;
  }, Infinity);
  return Number.isFinite(earliest) ? earliest : Date.now();
}

function renderBatchItems(batch, pushUserOrSyntheticItem) {
  for (const entry of batch) {
    // Async-completion twins (queued model-visible wrapper) used to be
    // display-skipped here on the assumption the live notification push
    // already rendered a card. That push is event-ephemeral and can be
    // missed (listener race, dedupe state from another surface, daemon
    // restart), which left completions with NO transcript card at all
    // (2026-08-17 field report: bench shell output never appeared).
    // Render the wrapper through the synthetic path instead — the
    // task_id upsert in upsertSyntheticToolItem patches an
    // already-rendered card, so the double-delivery case stays
    // duplicate-free. Non-wrapper entries keep the old skip.
    if (entry.mode === 'pending-resume' || entry.suppressDisplay) {
      const twin = typeof entry.content === 'string' ? entry.content : String(entry.text || '');
      if (parseModelVisibleCompletionWrapper(twin)) {
        pushUserOrSyntheticItem(twin, entry.id, 'injected');
      }
      continue;
    }
    // A routine fire paints as the routine's marker row, not a user bubble.
    if (entry.mode === 'routine') {
      pushUserOrSyntheticItem(entry.text, entry.id, 'routine', {
        routineTrigger: entry.transcriptMeta?.routineTrigger,
      });
      continue;
    }
    const sender = String(entry.transcriptMeta?.sender || '')
      .trim()
      .toLowerCase();
    const device = typeof entry.transcriptMeta?.device === 'string' ? entry.transcriptMeta.device : '';
    const fromAgent = typeof entry.transcriptMeta?.fromAgent === 'string' ? entry.transcriptMeta.fromAgent : '';
    const attribution = {
      ...(sender ? { sender } : {}),
      ...(device ? { device } : {}),
      ...(fromAgent ? { fromAgent } : {}),
    };
    let itemExtras = sender || device || fromAgent ? attribution : null;
    if (Array.isArray(entry.images) && entry.images.length) {
      itemExtras = { images: entry.images, ...attribution };
    }
    pushUserOrSyntheticItem(entry.text, entry.id, isQueuedEntryEditable(entry) ? 'user' : 'injected', itemExtras);
  }
}

const COMPLETION_WAKE_MODES = new Set(['task-notification', 'pending-resume']);

// Trusted provenance of a drained batch: Goal turns keep their own source; a
// batch made only of completion wakes (task notifications, pending resumes)
// is the runtime reporting, carried as a task notification so the runtime
// stores it as one and never treats its text as a user skill selection.
function batchPromptSource(batch) {
  if (isGoalQueuedEntry(batch[0])) return batch[0].mode;
  if (batch.length > 0 && batch.every((entry) => COMPLETION_WAKE_MODES.has(entry?.mode))) return 'task-notification';
  return undefined;
}

// The batch's provenance for the prompt-cache warmer (cache-warm.mjs
// cacheWarmTurnKind): one inbound channel message makes it real external
// activity whatever its presentation; it is an agent report only when every
// entry is one (a user prompt merged into it is the user speaking).
function batchPromptOrigin(batch) {
  if (batch.some((entry) => entry?.origin === PROMPT_ORIGIN_CHANNEL)) return { promptOrigin: PROMPT_ORIGIN_CHANNEL };
  if (batch.length > 0 && batch.every((entry) => entry?.origin === PROMPT_ORIGIN_AGENT_REPORT)) {
    return { promptOrigin: PROMPT_ORIGIN_AGENT_REPORT };
  }
  return {};
}

/** The batch's transcript metadata; a batch of completion wakes also records
 *  the execution ids it delivers (`consumedExecutionIds`, from each entry's
 *  execution or resume keys; null for one with neither), the structured
 *  provenance a task session's report follows (agent-task-sessions.mjs). */
function completionWakeTranscriptMeta(batch) {
  const meta = batch[0]?.transcriptMeta || null;
  if (batchPromptSource(batch) !== 'task-notification') return meta;
  const consumed = batch.flatMap((entry) => {
    if (entry?.execution?.id) return [String(entry.execution.id)];
    const keys = (Array.isArray(entry?.resumeCompletionKeys) ? entry.resumeCompletionKeys : []).map(String);
    return keys.length
      ? keys.map((key) => (key.startsWith('execution:') ? key.slice('execution:'.length) : null))
      : [null];
  });
  return { ...(meta || {}), consumedExecutionIds: consumed };
}

export function turnOptionsForBatch(batch, steering) {
  const nonEditable = batch.filter((entry) => !isQueuedEntryEditable(entry));
  // A completion resume is owned by the completion that woke it. Esc
  // consumes that ownership; unlike ordinary notifications it must never
  // be requeued from an uncommitted turn. Keep normal task notifications
  // recoverable exactly as before.
  const discardOnAbort = nonEditable.filter(
    (entry) => entry?.abortDiscardOnAbort === true || entry?.mode === 'pending-resume'
  );
  return {
    promptSource: batchPromptSource(batch),
    ...batchPromptOrigin(batch),
    retryFailedTurn: batch[0]?.retryFailedTurn === true,
    retryTurnId: batch[0]?.retryTurnId || null,
    retryAttemptId: batch[0]?.retryAttemptId || null,
    displayText: batch
      .map((entry) => entry.text)
      .filter((text) => String(text || '').trim())
      .join('\n'),
    pastedImages: mergePastedImages(batch),
    pastedTexts: mergePastedTexts(batch),
    submittedAt: earliestSubmittedAt(batch),
    onCommitted: () => steering.commitSteeringQueueEntries(batch),
    // Cancelling typed input consumes its queue copy with or without draft
    // restoration, without signalling successful delivery to onCommitted.
    onAborted: () => steering.releaseSteeringQueueEntries(batch),
    submittedIds: [...new Set(batch.map((e) => e.id))],
    restorable: nonEditable.length === 0,
    requeueOnAbort: nonEditable.filter((entry) => !discardOnAbort.includes(entry)),
    discardExecutionPendingResumeKeys: discardOnAbort.flatMap((entry) =>
      Array.isArray(entry?.resumeCompletionKeys) ? entry.resumeCompletionKeys : []
    ),
    transcriptMeta: completionWakeTranscriptMeta(batch),
    // Only a routine turn names its selection text (never its payload).
    ...(batch[0]?.mode === 'routine' && typeof batch[0].skillSelection === 'string'
      ? { skillSelection: batch[0].skillSelection }
      : {}),
    context:
      batch
        .map((entry) => String(entry.context || '').trim())
        .filter(Boolean)
        .join('\n\n') || null,
    onToolResult: (message) => {
      for (const entry of batch) {
        try {
          entry.onToolResult?.(message);
        } catch {
          // One submitter's callback must not stop the batch's other entries.
        }
      }
    },
    onSettled: (detail) => {
      for (const entry of batch) {
        try {
          entry.onSettled?.(detail);
        } catch {
          // One submitter's callback must not stop the batch's other entries.
        }
      }
    },
  };
}

// A failed-turn retry: drop the failed turn's rows when it produced no
// output, so the resubmitted prompt renders once (the session rewinds the
// matching message under its own lock).
function rewindFailedTurnRows(batch, { getState, set, replaceItems }) {
  const entry = batch[0];
  if (entry?.retryFailedTurn !== true || entry.retryTurnId) return;
  const rewound = rewoundFailedTurnItems(getState().items, entry.text);
  if (!rewound) return;
  set({
    items: replaceItems(rewound, { preserveStreamingTail: true, preserveSpill: true, preserveTranscriptView: true }),
  });
}

export function createDrainLoop(
  bag,
  { queue, steering, submissions, flushDeferredClearedSessionUi, autoClearBeforeWake }
) {
  const {
    tuiDebug,
    flags,
    pending,
    pendingNotificationKeys,
    getState,
    set,
    replaceItems,
    flushEmitImmediate,
    pushUserOrSyntheticItem,
    flushDeferredExecutionPendingResumeKick,
  } = bag;

  const { scheduleBlockedDrainRetry, clearBlockedDrainRetry } = createBlockedDrainRetry({ flags, pending, drain });

  function hasModelDrainablePending() {
    return pending.some((entry) => !isSlashQueuedEntry(entry));
  }

  const admission = () => flags.admission || 'open';

  const settleClosedQueue = createClosedQueueSettler({
    pending,
    pendingNotificationKeys,
    clearBlockedDrainRetry,
    queue,
    steering,
    submissions,
  });

  // Whether a drain may start now. A closed gate either settles (terminal),
  // waits for its own release edge, or schedules a re-check of itself.
  function mayStartDrain() {
    // Execution admission fence: a closing session starts nothing (the close
    // path re-kicks the queue if the durable close fails); a closed one
    // settles what was queued.
    if (admission() === 'closing') return false;
    if (admission() === 'terminal') {
      settleClosedQueue();
      return false;
    }
    if (flags.draining) return false;
    // Bail while any session command holds commandBusy (auto-clear implies it,
    // but so do setModel/newSession/resume/etc). Running a turn concurrently
    // with a command that swaps or reroutes the live session is a race; the
    // commandBusy-release hook re-kicks drain once the command finishes.
    if (flags.autoClearRunning || flags.quotaResumePending || getState().commandBusy) {
      scheduleBlockedDrainRetry();
      return false;
    }
    // A queued prompt/notification can arrive while a
    // provider turn is already in flight (scheduled message, webhook, agent
    // completion, or user input), but the unified queue only runs BETWEEN
    // turns. Do NOT start a second Lead runTurn from the post-turn drain in
    // that window: the active runtime.ask owns the session mutex/transcript.
    // Starting a parallel run here is what tangles turn order and can
    // abort/interleave the active turn.
    if (getState().busy) {
      tuiDebug(`busy-queue drain deferred while active pending=${pending.length}`);
      // The turn-settled edges (the busy-release hook and this loop's own
      // finally) are one-shot events. A completion that lands after the running
      // turn took its last look at the queue has no edge left to ride, and the
      // queue then sits until the next user message — field report 2026-09-21:
      // a lead idled 24 minutes on ten queued agent completions and only moved
      // when the user typed. Queued work re-reads this gate on its own.
      scheduleBlockedDrainRetry(ACTIVE_TURN_RECHECK_MS);
      return false;
    }
    return true;
  }

  // Slash commands must run through the TUI command dispatcher, not be
  // delivered to the model as plain text, so slash entries are handled
  // outside the queued-command drain.
  function dequeueModelBatch(firstBatch) {
    return queue.dequeueQueueBatch('later', {
      limit: firstBatch ? 1 : Infinity,
      predicate: (entry) => !isSlashQueuedEntry(entry),
    });
  }

  // The batch's rows go on the transcript before its turn starts; returns the
  // merged prompt the turn sends.
  function presentBatch(batch) {
    tuiDebug(`busy-queue drain batch=${batch.length} remaining=${pending.length}`);
    const merged = mergePromptContents(batch);
    rewindFailedTurnRows(batch, { getState, set, replaceItems });
    renderBatchItems(batch, pushUserOrSyntheticItem);
    return merged;
  }

  // The drain that still owns the loop hands off: settle a closed queue, run
  // again for model work that arrived meanwhile, or release the deferred
  // pending-resume kick.
  function finishDrain() {
    flags.draining = false;
    flushDeferredClearedSessionUi();
    if (admission() === 'terminal') settleClosedQueue();
    else if (hasModelDrainablePending()) void drain();
    else flushDeferredExecutionPendingResumeKick();
  }

  async function drain() {
    if (!mayStartDrain()) return;
    clearBlockedDrainRetry();
    const drainEpoch = (Number(flags.drainEpoch) || 0) + 1;
    flags.drainEpoch = drainEpoch;
    flags.draining = true;
    let firstBatch = true;
    try {
      while (pending.length > 0) {
        if (flags.drainEpoch !== drainEpoch) return;
        if (admission() !== 'open') return;
        // Admission is rechecked before every batch: a command that took the
        // lock while the previous turn settled (an in-place model switch and
        // its pre-compaction, a reset) runs before the next turn starts. The
        // finally below re-enters drain(), which waits on the same gate, and
        // the commandBusy release re-kicks the queue.
        if (flags.autoClearRunning || flags.quotaResumePending || getState().commandBusy) return;
        // Drain one priority/mode bucket at a time (unified command queue):
        // prompt steering stays editable and task notifications stay
        // non-editable but model-visible.
        const batch = dequeueModelBatch(firstBatch);
        firstBatch = false;
        if (batch.length === 0) break;
        if (isGoalQueuedEntry(batch[0]) && bag.shouldRunGoalContinuation?.(batch[0]) !== true) {
          continue;
        }
        // A completion wake calls the model like a user turn, so a cold cache
        // after a long idle is compacted first; the wake runs regardless.
        if (autoClearBeforeWake && batch.every((entry) => COMPLETION_WAKE_MODES.has(entry.mode))) {
          await autoClearBeforeWake();
          if (flags.drainEpoch !== drainEpoch || admission() !== 'open' || getState().commandBusy) {
            queue.requeueEntriesFront(batch);
            return;
          }
        }
        const merged = presentBatch(batch);
        const turnStatus = await bag.runTurn(merged, turnOptionsForBatch(batch, steering));
        if (flags.drainEpoch !== drainEpoch) return;
        // A deferred cleared-session UI sync (from a late-settling abandoned
        // compacting clear) applies here now that this turn has settled.
        flushDeferredClearedSessionUi();
        // If the user re-submits the reclaimed prompt while the cancelled turn
        // is still unwinding, enqueue() cannot start another drain because this
        // drain loop is still active. Continue when pending work appeared during
        // cancellation so the fresh submit does not get stuck in queued getState().
        if (turnStatus === 'cancelled' && pending.length === 0) break;
      }
    } finally {
      if (flags.drainEpoch === drainEpoch) finishDrain();
    }
  }

  const enqueue = createEnqueue({
    admission,
    tuiDebug,
    flags,
    pending,
    pendingNotificationKeys,
    getState,
    set,
    flushEmitImmediate,
    getRuntime: () => bag.runtime,
    queue,
    steering,
    submissions,
    drain,
  });

  return { drain, enqueue, settleClosedQueue };
}
