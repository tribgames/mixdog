/**
 * src/tui/session/session-flow/drain.mjs - unified prompt queue: idempotent
 * enqueue intake and the between-turns drain loop that runs one priority/mode
 * bucket per turn.
 */
import {
  isGoalQueuedEntry,
  isQueuedEntryEditable,
  isQueuedEntryVisible,
  isSlashQueuedEntry,
  mergePromptContents,
  mergePastedImages,
  mergePastedTexts,
} from '../queue-helpers.mjs';
import { appendTuiSteeringPersist, dropTuiSteeringPersist } from '../tui-steering-persist.mjs';
import { parseModelVisibleCompletionWrapper } from '../agent-envelope.mjs';
import { rewoundFailedTurnItems } from './failed-turn-rewind.mjs';

// Re-check cadence for a drain that found a gate closed. A gate is state, not
// an event: the queue re-reads it instead of trusting that whoever closes it
// will remember to kick the queue on the way out. Both timers exist only while
// the queue actually holds work, so an idle session never polls.
const BLOCKED_DRAIN_RETRY_MS = 50;
// Session commands (setModel/newSession/resume/auto-clear) release in seconds;
// an active turn can run for many minutes, so its gate is re-read coarsely.
const ACTIVE_TURN_RECHECK_MS = 2_000;

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
        } catch {}
      }
    },
    onSettled: (detail) => {
      for (const entry of batch) {
        try {
          entry.onSettled?.(detail);
        } catch {}
      }
    },
  };
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

  // A failed-turn retry: drop the failed turn's rows when it produced no
  // output, so the resubmitted prompt renders once (the session rewinds the
  // matching message under its own lock).
  function rewindFailedTurnRows(batch) {
    const entry = batch[0];
    if (entry?.retryFailedTurn !== true || entry.retryTurnId) return;
    const rewound = rewoundFailedTurnItems(getState().items, entry.text);
    if (!rewound) return;
    set({
      items: replaceItems(rewound, { preserveStreamingTail: true, preserveSpill: true, preserveTranscriptView: true }),
    });
  }

  function scheduleBlockedDrainRetry(delayMs = BLOCKED_DRAIN_RETRY_MS) {
    if (pending.length === 0 || flags.disposed) return;
    if (flags.blockedDrainRetryTimer) return;
    const timer = setTimeout(() => {
      flags.blockedDrainRetryTimer = null;
      if (pending.length > 0) void drain();
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    flags.blockedDrainRetryTimer = timer;
  }

  function clearBlockedDrainRetry() {
    if (!flags.blockedDrainRetryTimer) return;
    clearTimeout(flags.blockedDrainRetryTimer);
    flags.blockedDrainRetryTimer = null;
  }

  function hasModelDrainablePending() {
    return pending.some((entry) => !isSlashQueuedEntry(entry));
  }

  const admission = () => flags.admission || 'open';

  // Canonical close settled: nothing queued can ever run. Every accepted
  // submission is settled explicitly (rejected), never silently dropped, and
  // its durable steering mirror is released so a restart cannot resurrect it
  // into the closed conversation.
  function settleClosedQueue() {
    const entries = pending.splice(0);
    pendingNotificationKeys.clear();
    clearBlockedDrainRetry();
    if (entries.length === 0) return;
    queue.removeQueuedEntries(entries);
    const mirrored = entries.filter((entry) => steering.shouldMirrorSteeringEntry(entry) && entry.steeringPersistId);
    if (mirrored.length > 0) {
      void Promise.resolve(dropTuiSteeringPersist(steering.leadSessionId(), mirrored)).catch(() => {});
    }
    for (const entry of entries) {
      if (entry.id) submissions.forget(entry.id);
      try {
        entry.onSettled?.({ status: 'rejected', reason: 'session-closed', result: null, session: null });
      } catch {}
    }
  }

  async function drain() {
    // Execution admission fence: a closing session starts nothing (the close
    // path re-kicks the queue if the durable close fails); a closed one
    // settles what was queued.
    if (admission() === 'closing') return;
    if (admission() === 'terminal') {
      settleClosedQueue();
      return;
    }
    if (flags.draining) return;
    // Bail while any session command holds commandBusy (auto-clear implies it,
    // but so do setModel/newSession/resume/etc). Running a turn concurrently
    // with a command that swaps or reroutes the live session is a race; the
    // commandBusy-release hook re-kicks drain once the command finishes.
    if (flags.autoClearRunning || flags.quotaResumePending || getState().commandBusy) {
      scheduleBlockedDrainRetry();
      return;
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
      return;
    }
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
        const batch = queue.dequeueQueueBatch('later', {
          limit: firstBatch ? 1 : Infinity,
          // Slash commands must run through the TUI command dispatcher, not be
          // delivered to the model as plain text, so slash entries are handled
          // outside the queued-command drain.
          predicate: (entry) => !isSlashQueuedEntry(entry),
        });
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
        tuiDebug(`busy-queue drain batch=${batch.length} remaining=${pending.length}`);
        const merged = mergePromptContents(batch);
        rewindFailedTurnRows(batch);
        renderBatchItems(batch, pushUserOrSyntheticItem);
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
      if (flags.drainEpoch === drainEpoch) {
        flags.draining = false;
        flushDeferredClearedSessionUi();
        if (admission() === 'terminal') settleClosedQueue();
        else if (hasModelDrainablePending()) void drain();
        else flushDeferredExecutionPendingResumeKick();
      }
    }
  }

  function enqueue(text, options = {}) {
    // Admission fence. While closing, only user prompts are accepted (retained
    // so a failed close loses nothing); notification-driven/model-visible
    // enqueues are refused. A closed session accepts nothing.
    const state = admission();
    const mode = options.mode || 'prompt';
    if (state !== 'open' && (state === 'terminal' || mode !== 'prompt')) {
      tuiDebug(`enqueue refused: session admission=${state} mode=${mode}`);
      return false;
    }
    const submissionId = String(options.id || '').trim();
    // Idempotent intake: a transport that re-sent this exact submission (its
    // first attempt landed but the response was lost) must not double-post.
    if (submissionId && submissions.has(submissionId)) {
      tuiDebug(`prompt-duplicate id=${submissionId} ignored`);
      // This is an idempotent success, not a rejected submit. Returning false
      // makes Desktop restore and retry a message that is already queued.
      return true;
    }
    const entry = queue.makeQueueEntry(text, options);
    if (entry.mode === 'task-notification' && entry.key) {
      if (pendingNotificationKeys.has(entry.key)) return false;
      pendingNotificationKeys.add(entry.key);
    }
    submissions.remember(submissionId);
    pending.push(entry);
    // Typed input or a deliverable notification ends a passive task wait or
    // shell hold so the next boundary hands it to the model now.
    const wake = steering.taskWaitWakeForEntry(entry);
    if (wake) {
      try {
        bag.runtime?.interruptTaskWait?.(wake, wake === 'notification' ? entry.execution?.id || null : null);
      } catch {}
    }
    const needsDurableSteering =
      (getState().busy || getState().commandBusy || flags.autoClearRunning || flags.quotaResumePending) &&
      steering.shouldMirrorSteeringEntry(entry);
    const persistence = needsDurableSteering ? appendTuiSteeringPersist(steering.leadSessionId(), entry) : null;
    if (isQueuedEntryVisible(entry)) {
      set({ queued: [...getState().queued, entry] });
      if (isQueuedEntryEditable(entry)) flushEmitImmediate?.();
    }
    const queueAgeMs = Math.max(0, Date.now() - Number(entry.submittedAt || Date.now()));
    tuiDebug(`prompt-queued id=${String(entry.id)} busy=${getState().busy ? 1 : 0} ageMs=${queueAgeMs}`);
    if (getState().busy) tuiDebug(`busy-queue enqueue mode=${entry.mode} pending=${pending.length}`);
    void drain();
    if (options.awaitPersistence === true && persistence) {
      return Promise.resolve(persistence).then((persisted) => {
        if (persisted !== false) return true;
        const index = pending.indexOf(entry);
        // A turn already took the prompt while its durable mirror was being
        // written: it was delivered, so rejecting it would hand the sender a
        // copy of a message the model already has.
        if (index < 0) return true;
        pending.splice(index, 1);
        queue.removeQueuedEntries([entry]);
        if (submissionId) submissions.forget(submissionId);
        return false;
      });
    }
    return true;
  }

  return { drain, enqueue, settleClosedQueue };
}
