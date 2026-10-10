// Prompt submission: mint the intake and queue it at once, starting idle
// auto-clear first when the session is idle. Queued prompts are reclaimed by
// Esc through restoreQueued.
import { promptDisplayText } from '../../queue-helpers.mjs';

export function createSubmissionIntake(bag) {
  const { runtime, nextId, flags, getState, enqueue, autoClearBeforeSubmit } = bag;

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
    return intake;
  };

  const enqueueSubmission = (intake) => {
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
    // Start idle auto-clear first so commandBusy is raised synchronously, then
    // queue right away: drain stays blocked until the clear settles, so the
    // prompt still runs against the cleared conversation, and a later submit
    // can never be queued ahead of this one. A rejection or synchronous throw
    // must never lose the prompt.
    try {
      void Promise.resolve(autoClearBeforeSubmit()).catch(() => {});
    } catch {
      /* the prompt is queued below regardless */
    }
    return enqueueSubmission(intake) !== false;
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
    return (await enqueueSubmission(intake)) !== false;
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

  return { submit, submitAsync, submitAndWait };
}
