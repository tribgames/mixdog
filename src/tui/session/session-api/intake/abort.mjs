// Abort: Esc while idle hands a queued or still-accepting submission back to
// the draft; Esc during a turn cancels it and, unless a steering prompt is
// already queued, reclaims the in-flight prompt, its history slot and its
// requeue entries.
import { hydratePastedAttachments } from '../../../../runtime/attachments/store.mjs';
import { promptHistoryKey } from '../../../prompt-history-store.mjs';
import { abortGoalTurn } from '../../goal-turn-state.mjs';
import { isQueuedEntryEditable } from '../../queue-helpers.mjs';

export function createAbortAction(bag, { acceptingSubmissions }) {
  const {
    runtime,
    flags,
    pending,
    getState,
    set,
    replaceItems,
    denyAllToolApprovals,
    requeueEntriesFront,
    restoreQueued,
    drain,
    discardExecutionPendingResume,
  } = bag;

  // Esc while idle: hand a queued (or still-accepting) submission back to the
  // draft instead of interrupting anything.
  const reclaimIdleSubmission = (submissionId) => {
    if (!submissionId) return false;
    const restored = restoreQueued('', submissionId);
    if (!restored || Number(restored.count) < 1) {
      const intake = acceptingSubmissions.get(submissionId);
      if (!intake) return false;
      intake.cancelled = true;
      const attachments = hydratePastedAttachments(intake.queueOptions.pastedImages, intake.queueOptions.pastedTexts);
      return {
        aborted: false,
        restoreText: String(intake.queueOptions.displayText || '').trim(),
        pastedImages: attachments.pastedImages,
        pastedTexts: attachments.pastedTexts,
        restoredSubmissionIds: [submissionId],
      };
    }
    return {
      aborted: false,
      restoreText: restored.text,
      pastedImages: restored.pastedImages,
      pastedTexts: restored.pastedTexts,
      restoredSubmissionIds: restored.ids,
    };
  };

  // Pull the interrupted prompt back out of the transcript and history and
  // put its unsent requeue entries at the front of the queue.
  const reclaimInFlightPrompt = (restoreState, { restoreText, requeueEntries }) => {
    restoreState.reclaimed = true;
    const idSet = new Set((restoreState.submittedIds || []).filter((id) => id != null));
    const patch = { spinner: null, thinking: null, lastTurn: null };
    if (restoreText) {
      const restoreKey = promptHistoryKey(restoreText);
      patch.promptHistoryList = (getState().promptHistoryList || []).filter(
        (entry) => promptHistoryKey(entry) !== restoreKey
      );
    }
    if (idSet.size > 0) {
      const items = getState().items.filter((item) => !idSet.has(item?.id));
      if (items.length !== getState().items.length) {
        patch.items = replaceItems(items, {
          preserveSpill: true,
          preserveTranscriptView: true,
        });
      }
    }
    set(patch);
    if (requeueEntries.length > 0) requeueEntriesFront(requeueEntries);
  };

  // Queued work must never strand behind a cancelled turn (abort preserves
  // pending input for the next turn, and the command queue survives cancel
  // and fires when idle). The drain loop that owns a normal turn continues
  // on its own; this bounded kick covers unwinds where no drain owner
  // re-checks pending after busy clears. drain() self-guards
  // (busy/draining/commandBusy), so the drain-owned path is unchanged and a
  // duplicate kick is a no-op.
  const kickDrainAfterAbort = () => {
    const pendingAfterAbortKick = setTimeout(() => {
      try {
        if (flags.disposed) return;
        if (getState().busy) return;
        if (pending.length > 0 && typeof drain === 'function') void drain();
      } catch {
        /* best-effort */
      }
    }, 150);
    pendingAfterAbortKick.unref?.();
  };

  const abort = (options = {}) => {
    const submissionId = String(options?.submissionId || '').trim();
    if (!getState().busy) return reclaimIdleSubmission(submissionId);
    denyAllToolApprovals('interrupted by user');
    const restoreState = flags.activePromptRestore;
    // A queued steering prompt means the user already redirected the turn:
    // interrupting should just cancel the running turn and let the steering
    // prompt run next, NOT resurrect the in-flight prompt back into the draft.
    const hasPendingSteering = pending.some((entry) => isQueuedEntryEditable(entry));
    const canRestore = options?.restorePrompt !== false && restoreState?.restorable && !hasPendingSteering;
    const restoreText = canRestore ? restoreState.text : '';
    const restorePastedImages = canRestore && restoreState?.pastedImages ? restoreState.pastedImages : null;
    const restorePastedTexts = canRestore && restoreState?.pastedTexts ? restoreState.pastedTexts : null;
    // When steering suppresses the restore, the interrupted prompt's pasted
    // images never get committed (onCommitted won't fire) nor re-installed into
    // the draft, so hand them back for cleanup to avoid a stale `[Image #id]`
    // lingering in the paste snapshot.
    const discardPastedImages =
      restoreState?.restorable && hasPendingSteering && restoreState?.pastedImages ? restoreState.pastedImages : null;
    const discardPastedTexts =
      restoreState?.restorable && hasPendingSteering && restoreState?.pastedTexts ? restoreState.pastedTexts : null;
    const requeueEntries =
      restoreState && !restoreState.committed && Array.isArray(restoreState.requeueEntries)
        ? restoreState.requeueEntries.filter(
            (entry) => entry?.abortDiscardOnAbort !== true && entry?.mode !== 'pending-resume'
          )
        : [];
    const aborted = abortGoalTurn(runtime, flags, hasPendingSteering);
    if (restoreState) {
      if (aborted !== false && Array.isArray(restoreState.discardExecutionPendingResumeKeys)) {
        discardExecutionPendingResume?.(restoreState.discardExecutionPendingResumeKeys);
      }
      if ((restoreText || requeueEntries.length > 0) && aborted !== false) {
        reclaimInFlightPrompt(restoreState, { restoreText, requeueEntries });
      }
      restoreState.restorable = false;
      restoreState.requeueEntries = [];
      restoreState.discardExecutionPendingResumeKeys = [];
    }
    kickDrainAfterAbort();
    const restored = hydratePastedAttachments(restorePastedImages, restorePastedTexts);
    return {
      aborted,
      restoreText,
      pastedImages: restored.pastedImages,
      discardPastedImages,
      pastedTexts: restored.pastedTexts,
      discardPastedTexts,
      restoredSubmissionIds: restoreText ? (restoreState?.submittedIds || []).map(String).filter(Boolean) : [],
    };
  };

  return { abort };
}
