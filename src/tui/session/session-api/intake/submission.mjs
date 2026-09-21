// Prompt submission: mint the intake, decide between queueing now and queueing
// after idle auto-clear, and keep every still-accepting submission addressable
// so Esc can reclaim it before enqueue.
import { promptDisplayText } from '../../queue-helpers.mjs';

export function createSubmissionIntake(bag) {
  const { runtime, nextId, flags, getState, enqueue, autoClearBeforeSubmit } = bag;
  // submitAsync may be awaiting auto-clear while the renderer already owns an
  // optimistic user row. Keep that intake addressable so Esc can reclaim it
  // before enqueue()/busy publication without racing a delayed snapshot.
  const acceptingSubmissions = new Map();

  const submission = (text, options = {}) => {
    const displayText = promptDisplayText(text, options);
    if (!displayText.trim()) return null;
    const mode = options.mode || 'prompt';
    const intake = {
      text,
      queueOptions: {
        ...options,
        // Always mint a submission id so daemon retries / dual-path intake
        // can dedupe instead of booking the same prompt twice.
        id: String(options.id || '').trim() || nextId(),
        mode,
        displayText,
      },
    };
    acceptingSubmissions.set(intake.queueOptions.id, intake);
    return intake;
  };

  const enqueueSubmission = (intake) => {
    const submissionId = String(intake?.queueOptions?.id || '').trim();
    if (submissionId) acceptingSubmissions.delete(submissionId);
    if (intake?.cancelled === true) return false;
    const accepted = enqueue(intake.text, intake.queueOptions);
    // User input wakes a passive `task wait` without cancelling either the
    // turn or the background task. The returned running snapshot creates the
    // normal post-tool boundary, where this queued prompt is injected.
    if (accepted !== false) {
      if ((intake.queueOptions.mode || 'prompt') === 'prompt') {
        bag.cancelQueuedGoalContinuations?.();
        bag.archiveCompletedGoalOnUserInput?.();
      }
      try {
        runtime.interruptTaskWait?.('user-message');
      } catch {}
    }
    return accepted;
  };

  const submit = (text, options = {}) => {
    const intake = submission(text, options);
    if (!intake) return false;
    // Queue during auto-clear, a session command, or an active turn instead
    // of dropping the prompt. Drain waits for busy/commandBusy to clear, and
    // the command/turn release path kicks it once the session is ready.
    if (flags.autoClearRunning || getState().commandBusy || getState().busy) {
      return enqueueSubmission(intake) !== false;
    }
    // If autoClearBeforeSubmit rejects (e.g. compaction timeout throws), the
    // prompt must still be queued — swallow the rejection so enqueue always
    // runs and the submit is never silently lost.
    void autoClearBeforeSubmit()
      .catch(() => {})
      .then(() => enqueueSubmission(intake));
    return true;
  };

  const submitAsync = async (text, options = {}) => {
    const intake = submission(text, options);
    if (!intake) return false;
    intake.queueOptions.awaitPersistence = true;
    // Daemon intake needs an acknowledgement boundary stronger than the TUI's
    // synchronous submit(): by the time this Promise resolves, the prompt is
    // present either as a visible queue entry or as the first durable user row.
    // Start idle auto-clear first so commandBusy is raised synchronously, then
    // queue and ACK without waiting up to 60 s for compaction. drain() remains
    // blocked by commandBusy until the clear settles, so the new prompt still
    // runs only against the cleared conversation.
    if (!flags.autoClearRunning && !getState().commandBusy && !getState().busy) {
      void Promise.resolve(autoClearBeforeSubmit()).catch(() => {});
    }
    return (await Promise.resolve(enqueueSubmission(intake))) !== false;
  };

  const submitAndWait = async (text, options = {}) => {
    let resolveSettled;
    const settled = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    const accepted = await submitAsync(text, {
      ...options,
      onSettled: (detail) => {
        try {
          options.onSettled?.(detail);
        } catch {}
        resolveSettled(detail);
      },
    });
    if (!accepted) return { status: 'rejected', result: null, session: null };
    return await settled;
  };

  return { acceptingSubmissions, submit, submitAsync, submitAndWait };
}
