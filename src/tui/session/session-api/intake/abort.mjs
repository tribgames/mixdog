// Abort: Esc while idle hands a queued submission back to the draft; Esc during a turn cancels it and, unless a steering prompt is
// already queued, reclaims the in-flight prompt, its history slot and its
// requeue entries.
import { hydratePastedAttachments, hydrateRestorableFileParts } from '../../../../runtime/attachments/store.mjs';
import { abortGoalTurn } from '../../goal-turn-state.mjs';
import { promptHistoryWithout } from '../../prompt-history.mjs';
import { isQueuedEntryEditable } from '../../queue-helpers.mjs';

// An attachment whose blob is gone is dropped alone; the prompt is kept.
function hydrateTolerantly(pastedImages, pastedTexts, content = null) {
  let unreadable = 0;
  const onUnreadable = () => {
    unreadable += 1;
  };
  const hydrated = hydratePastedAttachments(pastedImages, pastedTexts, { onUnreadable });
  const files = hydrateRestorableFileParts(content, { onUnreadable });
  return {
    ...hydrated,
    ...(files.length ? { content: files } : {}),
    notice: unreadable
      ? `${unreadable} attachment${unreadable === 1 ? ' was' : 's were'} no longer available and dropped.`
      : '',
  };
}

export function createAbortAction(bag) {
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

  // Esc while idle: hand a queued submission back to the draft instead of
  // interrupting anything.
  const reclaimIdleSubmission = (submissionId) => {
    if (!submissionId) return false;
    const restored = restoreQueued('', submissionId);
    if (!restored || Number(restored.count) < 1) return false;
    return {
      aborted: false,
      restoreText: restored.text,
      pastedImages: restored.pastedImages,
      pastedTexts: restored.pastedTexts,
      ...(restored.content ? { content: restored.content } : {}),
      ...(restored.notice ? { notice: restored.notice } : {}),
      restoredSubmissionIds: restored.ids,
    };
  };

  // Pull the interrupted prompt back out of the transcript and history and
  // put its unsent requeue entries at the front of the queue.
  const reclaimInFlightPrompt = (restoreState, { restoreText, requeueEntries, handoff = false }) => {
    restoreState.reclaimed = true;
    const idSet = new Set((restoreState.submittedIds || []).filter((id) => id != null));
    const patch = { spinner: null, thinking: null, lastTurn: null };
    // Another device cancelled this turn: the prompt travels to the device that
    // sent it through the state, never through the canceller's reply.
    if (handoff && restoreText) {
      patch.promptRestore = {
        id: `restore-${Date.now()}-${[...idSet].join(',')}`,
        ids: [...idSet].map(String),
        text: restoreText,
        device: restoreState.device,
        at: Date.now(),
      };
    }
    if (restoreText) patch.promptHistoryList = promptHistoryWithout(getState().promptHistoryList, restoreText);
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
    // Non-user callers (the agent progress watchdog) name their own reason so
    // the transcript marker and tool denials never claim a user cancel.
    const reason = String(options?.reason || '').trim() || 'user-cancel';
    denyAllToolApprovals(reason === 'user-cancel' ? 'interrupted by user' : `interrupted (${reason})`);
    const restoreState = flags.activePromptRestore;
    // A queued steering prompt means the user already redirected the turn:
    // interrupting should just cancel the running turn and let the steering
    // prompt run next, NOT resurrect the in-flight prompt back into the draft.
    const hasPendingSteering = pending.some((entry) => isQueuedEntryEditable(entry));
    // A different device than the one that sent the prompt is cancelling. Only
    // plain text can be handed over through the state; a prompt carrying
    // attachments stays in the transcript instead of landing in the wrong
    // composer.
    const canceller = typeof options?.device === 'string' ? options.device : '';
    const crossDevice = Boolean(canceller && restoreState?.device && canceller !== restoreState.device);
    const hasAttachments = Boolean(restoreState?.pastedImages || restoreState?.pastedTexts || restoreState?.content);
    const canRestore =
      options?.restorePrompt !== false &&
      restoreState?.restorable &&
      !hasPendingSteering &&
      !(crossDevice && hasAttachments);
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
    const aborted = abortGoalTurn(runtime, flags, hasPendingSteering, reason);
    if (restoreState) {
      if (aborted !== false && Array.isArray(restoreState.discardExecutionPendingResumeKeys)) {
        discardExecutionPendingResume?.(restoreState.discardExecutionPendingResumeKeys);
      }
      if ((restoreText || requeueEntries.length > 0) && aborted !== false) {
        reclaimInFlightPrompt(restoreState, { restoreText, requeueEntries, handoff: crossDevice });
      }
      restoreState.restorable = false;
      restoreState.requeueEntries = [];
      restoreState.discardExecutionPendingResumeKeys = [];
    }
    kickDrainAfterAbort();
    const restored = hydrateTolerantly(
      restorePastedImages,
      restorePastedTexts,
      canRestore ? restoreState?.content : null
    );
    // The canceller never receives another device's prompt.
    const handedOver = crossDevice && Boolean(restoreText) && aborted !== false;
    return {
      aborted,
      restoreText: handedOver ? '' : restoreText,
      ...(restored.content ? { content: restored.content } : {}),
      ...(restored.notice ? { notice: restored.notice } : {}),
      pastedImages: restored.pastedImages,
      discardPastedImages,
      pastedTexts: restored.pastedTexts,
      discardPastedTexts,
      restoredSubmissionIds:
        restoreText && !handedOver ? (restoreState?.submittedIds || []).map(String).filter(Boolean) : [],
    };
  };

  return { abort };
}
