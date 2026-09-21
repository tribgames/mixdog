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
import { appendTuiSteeringPersist } from '../tui-steering-persist.mjs';
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

export function createDrainLoop(bag, { queue, steering, submissions, flushDeferredClearedSessionUi }) {
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
    if (entry?.retryFailedTurn !== true) return;
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

  function renderBatchItems(batch) {
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
      const sender = String(entry.transcriptMeta?.sender || '')
        .trim()
        .toLowerCase();
      let itemExtras = sender ? { sender } : null;
      if (Array.isArray(entry.images) && entry.images.length) {
        itemExtras = { images: entry.images, ...(sender ? { sender } : {}) };
      }
      pushUserOrSyntheticItem(entry.text, entry.id, isQueuedEntryEditable(entry) ? 'user' : 'injected', itemExtras);
    }
  }

  function turnOptionsForBatch(batch) {
    const nonEditable = batch.filter((entry) => !isQueuedEntryEditable(entry));
    // A completion resume is owned by the completion that woke it. Esc
    // consumes that ownership; unlike ordinary notifications it must never
    // be requeued from an uncommitted turn. Keep normal task notifications
    // recoverable exactly as before.
    const discardOnAbort = nonEditable.filter(
      (entry) => entry?.abortDiscardOnAbort === true || entry?.mode === 'pending-resume'
    );
    return {
      promptSource: isGoalQueuedEntry(batch[0]) ? batch[0].mode : undefined,
      retryFailedTurn: batch[0]?.retryFailedTurn === true,
      displayText: batch
        .map((entry) => entry.text)
        .filter((text) => String(text || '').trim())
        .join('\n'),
      pastedImages: mergePastedImages(batch),
      pastedTexts: mergePastedTexts(batch),
      submittedAt: earliestSubmittedAt(batch),
      onCommitted: () => steering.commitSteeringQueueEntries(batch),
      submittedIds: [...new Set(batch.map((e) => e.id))],
      restorable: nonEditable.length === 0,
      requeueOnAbort: nonEditable.filter((entry) => !discardOnAbort.includes(entry)),
      discardExecutionPendingResumeKeys: discardOnAbort.flatMap((entry) =>
        Array.isArray(entry?.resumeCompletionKeys) ? entry.resumeCompletionKeys : []
      ),
      transcriptMeta: batch[0]?.transcriptMeta || null,
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

  async function drain() {
    if (flags.draining) return;
    // Bail while any session command holds commandBusy (auto-clear implies it,
    // but so do setModel/newSession/resume/etc). Running a turn concurrently
    // with a command that swaps or reroutes the live session is a race; the
    // commandBusy-release hook re-kicks drain once the command finishes.
    if (flags.autoClearRunning || getState().commandBusy) {
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
        tuiDebug(`busy-queue drain batch=${batch.length} remaining=${pending.length}`);
        const merged = mergePromptContents(batch);
        rewindFailedTurnRows(batch);
        renderBatchItems(batch);
        const turnStatus = await bag.runTurn(merged, turnOptionsForBatch(batch));
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
        if (hasModelDrainablePending()) void drain();
        else flushDeferredExecutionPendingResumeKick();
      }
    }
  }

  function enqueue(text, options = {}) {
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
    const needsDurableSteering =
      (getState().busy || getState().commandBusy || flags.autoClearRunning) &&
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
        if (index >= 0) pending.splice(index, 1);
        queue.removeQueuedEntries([entry]);
        if (submissionId) submissions.forget(submissionId);
        return false;
      });
    }
    return true;
  }

  return { drain, enqueue };
}
