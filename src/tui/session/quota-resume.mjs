/**
 * quota-resume.mjs — one Lead session's side of the quota auto-resume: it
 * queues a resume when a turn stops on exhausted provider quota, cancels it on
 * the inputs that supersede it, owns the one "retry failed turn" operation,
 * and runs the resume when the daemon scheduler fires it.
 *
 * The durable queue itself lives in the daemon-wide store
 * (runtime/shared/quota-resume-store.mjs); this lane never keeps a timer, so an
 * evicted session waits exactly like a live one.
 */
import {
  cancelQuotaResumeEntry,
  forgetQuotaSuspendedGoal,
  noteQuotaSuspendedGoal,
  publicQuotaResume,
  quotaAutoResumeEnabled,
  quotaResumeEntry,
  quotaSuspendedGoal,
  rekeyQuotaResumeTurn,
  scheduleQuotaResumeEntry,
  subscribeQuotaResume,
} from '../../runtime/shared/quota-resume-store.mjs';

export const RETRY_CONTINUE_INSTRUCTION = 'Continue from where you left off.';
import { transcriptTurnKeys } from '../../runtime/shared/transcript-turn-keys.mjs';
export { transcriptTurnKeys };

// Rows that frame a turn rather than carry its output (desktop transcript-rows).
const TURN_CHROME_KINDS = new Set(['user', 'turndone', 'statusdone', 'notice']);

/** The failed turndone that ended the transcript on exhausted provider quota,
 *  when no later turn has begun: { turnKey, quota: { provider, model, resetAt|null } }. */
export function latestQuotaFailure(items) {
  const transcript = Array.isArray(items) ? items : [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    // A turn a compaction archived is no longer the model's to resume.
    if (item?.kind === 'user' || item?.archived === true) return null;
    if (item?.kind !== 'turndone') continue;
    const quota = item.quota;
    if (String(item.status || '').toLowerCase() !== 'failed' || !quota || typeof quota.provider !== 'string') {
      return null;
    }
    const turnKey = transcriptTurnKeys(transcript)[index] || '';
    if (!turnKey) return null;
    return {
      turnKey,
      quota: {
        provider: quota.provider,
        model: typeof quota.model === 'string' ? quota.model : '',
        resetAt: typeof quota.resetAt === 'number' && Number.isFinite(quota.resetAt) ? quota.resetAt : null,
      },
    };
  }
  return null;
}

/** The turn key of the failed turndone that ends the transcript, when no
 *  later turn has begun; '' otherwise. */
export function latestFailedTurnKey(items) {
  const transcript = Array.isArray(items) ? items : [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === 'user' || item?.archived === true) return '';
    if (item?.kind !== 'turndone') continue;
    if (String(item.status || '').toLowerCase() !== 'failed') return '';
    return transcriptTurnKeys(transcript)[index] || '';
  }
  return '';
}

/** What retrying the turn submits: its prompt when it produced no output, the
 *  continuation instruction when it did, null when the prompt carried no text
 *  (a media/attachment-only prompt cannot be replayed). */
export function failedTurnRetryPrompt(items, turnKey) {
  const transcript = Array.isArray(items) ? items : [];
  const keys = transcriptTurnKeys(transcript);
  let prompt = '';
  let sampled = false;
  let hasAttachments = false;
  for (let index = 0; index < transcript.length; index += 1) {
    if (keys[index] !== turnKey) continue;
    const item = transcript[index];
    if (item?.kind === 'user' && !prompt) {
      prompt = String(item.text ?? '').trim();
      hasAttachments = Array.isArray(item.images) && item.images.length > 0;
    }
    if (!TURN_CHROME_KINDS.has(String(item?.kind || ''))) sampled = true;
  }
  if (!prompt) return sampled ? RETRY_CONTINUE_INSTRUCTION : null;
  // Transcript rows keep only attachment metadata, so a text-only replay
  // would drop the attachments and the rewind would delete the original row.
  if (hasAttachments && !sampled) return null;
  return sampled ? RETRY_CONTINUE_INSTRUCTION : prompt;
}

export function createQuotaResumeLane(bag) {
  const { runtime, flags, getState, set, pending } = bag;
  const currentId = () => String(getState().sessionId || '');

  const publishQuotaResume = () => {
    const next = publicQuotaResume(quotaResumeEntry(currentId()));
    if ((getState().quotaResume ?? null) !== next) set({ quotaResume: next });
  };
  const unsubscribe = subscribeQuotaResume((sessionId) => {
    if (flags.disposed) return;
    if (sessionId === null || sessionId === currentId()) publishQuotaResume();
  });

  const requireAddressed = (sessionId) => {
    if (!sessionId || currentId() !== sessionId) throw new Error('session is not the active session');
  };

  // The session's own route (the selected route only before it has one).
  const sessionRoute = () => ({
    routeProvider: String(runtime.sessionProvider ?? runtime.provider ?? ''),
    routeModel: String(runtime.sessionModel ?? runtime.model ?? ''),
  });
  const queueResume = (sessionId, failure) =>
    scheduleQuotaResumeEntry({ sessionId, turnKey: failure.turnKey, ...failure.quota, ...sessionRoute() });

  // A failed turn is settling between its failed turndone (where the resume is
  // queued) and its Goal settlement (where the suspended Goal is recorded).
  // Every superseding cancel bumps the epoch, so a cancel that lands inside
  // that window also keeps the settlement from recording the Goal.
  let settlement = null;
  let cancelEpoch = 0;
  let retryClaim = '';

  const cancelFor = (sessionId) => {
    cancelEpoch += 1;
    cancelQuotaResumeEntry(sessionId);
    forgetQuotaSuspendedGoal(sessionId);
  };

  // Anything running, settling, closing or queued owns the session first.
  const retryBlocked = () => {
    const state = getState();
    return (
      flags.disposed ||
      settlement !== null ||
      (flags.admission || 'open') !== 'open' ||
      state.busy ||
      state.commandBusy ||
      flags.autoClearRunning ||
      flags.draining ||
      flags.quotaResumePending ||
      pending.length > 0
    );
  };

  /** A resume preserves its history rather than running idle auto-clear. */
  function retainedRetryInput() {
    const messages = runtime.readModelMessages?.().messages;
    const message = Array.isArray(messages) ? messages.findLast((item) => item?.role !== 'system') : null;
    const transcript = message?.meta?.transcript;
    if (message?.role !== 'user' || !transcript?.messageId || transcript?.completion?.status !== 'failed') return null;
    return { content: message.content, messageId: transcript.messageId, attemptId: transcript.completion.attemptId };
  }

  function retryFailedTurn(turnKey) {
    const retained = retainedRetryInput();
    if (retained) {
      return bag.enqueue(retained.content, {
        mode: 'prompt',
        id: bag.nextId(),
        retryFailedTurn: true,
        retryTurnId: retained.messageId,
        retryAttemptId: retained.attemptId,
        suppressDisplay: true,
        skipSlashCommands: true,
      });
    }
    const prompt = failedTurnRetryPrompt(getState().items, turnKey);
    if (!prompt) return false;
    return bag.enqueue(prompt, { mode: 'prompt', id: bag.nextId(), displayText: prompt, retryFailedTurn: true });
  }

  function finishResume(id, entry, goalId = '') {
    if (entry) cancelQuotaResumeEntry(id, { generation: entry.generation });
    if (goalId && quotaSuspendedGoal(id, entry?.turnKey || latestFailedTurnKey(getState().items)) === goalId) {
      forgetQuotaSuspendedGoal(id);
    }
  }

  async function resumeGoal(id, key, goalId, entry, claim) {
    const token = { epoch: cancelEpoch, admitted: false };
    const generation = entry?.generation ?? null;
    const current = () =>
      currentId() === id &&
      cancelEpoch === token.epoch &&
      !flags.disposed &&
      (flags.admission || 'open') === 'open' &&
      latestFailedTurnKey(getState().items) === key &&
      (quotaResumeEntry(id)?.generation ?? null) === generation;
    const prompt = failedTurnRetryPrompt(getState().items, key);
    const retained = retainedRetryInput();
    flags.quotaResumePending = token;
    let accepted = false;
    let recoveryFailed = false;
    try {
      if (typeof runtime.reactivateUsageLimitedGoal !== 'function') throw new Error('Goal resume is unavailable.');
      const goal = await runtime.reactivateUsageLimitedGoal(goalId, {
        isCurrent: current,
        accept: () => {
          if (!current()) return false;
          if ((retained || prompt) && retryFailedTurn(key) === false) return false;
          token.admitted = true;
          return true;
        },
      });
      accepted = goal?.status === 'active' && token.admitted;
      if (accepted) finishResume(id, entry, goalId);
      return accepted;
    } catch (error) {
      recoveryFailed = error?.quotaResumeRollbackFailed === true;
      bag.pushNotice?.(`Goal resume failed: ${error?.message || error}`, 'warn', { transcript: true });
      throw error;
    } finally {
      if (!accepted && retryClaim === claim) retryClaim = '';
      if (!recoveryFailed && flags.quotaResumePending === token) {
        flags.quotaResumePending = null;
        void bag.drain?.();
        if (accepted && !retained && !prompt) bag.scheduleGoalContinuation?.();
      }
    }
  }

  function hasResumeInput(key) {
    if (retainedRetryInput()) return true;
    if (failedTurnRetryPrompt(getState().items, key)) return true;
    if (key.startsWith('turn:')) return false;
    return Boolean(
      quotaSuspendedGoal(currentId(), key) ||
        (runtime.goalStatus?.()?.id && typeof runtime.reactivateUsageLimitedGoal === 'function')
    );
  }

  return {
    publishQuotaResume,
    reconcileQuotaResume() {
      const items = getState().items;
      const key = latestFailedTurnKey(items);
      const failure = items?.findLast((item) => item?.kind === 'turndone');
      if (!key || failure?.attemptId || !failure?.checkpointId) return false;
      return rekeyQuotaResumeTurn(currentId(), `turn:${failure.checkpointId}`, key);
    },
    disposeQuotaResume: unsubscribe,

    /** Turn close, synchronously with the failed turndone: with a known reset
     *  and the setting on, queues the resume, so the same publication that
     *  shows the failure carries `quotaResume`. */
    beginQuotaSettlement() {
      const id = currentId();
      const failure = latestQuotaFailure(getState().items);
      settlement = null;
      if (!id || !failure) return null;
      settlement = { sessionId: id, turnKey: failure.turnKey, epoch: cancelEpoch };
      if (failure.quota.resetAt === null || !quotaAutoResumeEnabled()) return null;
      if (!hasResumeInput(failure.turnKey)) {
        bag.pushNotice?.('This turn cannot be resumed automatically. Send a new message to continue.', 'warn', {
          transcript: true,
        });
        return null;
      }
      return queueResume(id, failure);
    },

    /** After the Goal settled: records the Goal this failure suspended, unless
     *  a superseding cancel landed since the turn closed. */
    finishQuotaSettlement({ suspendedGoalId = '' } = {}) {
      const current = settlement;
      settlement = null;
      if (!current || current.epoch !== cancelEpoch || !suspendedGoalId) return false;
      return noteQuotaSuspendedGoal(current.sessionId, current.turnKey, suspendedGoalId);
    },

    /** New user input supersedes the stopped turn. */
    cancelQuotaResumeOnUserInput() {
      const id = currentId();
      if (id) cancelFor(id);
    },

    /** Explicit request to auto-resume the latest quota-failed turn. */
    scheduleQuotaResume(sessionId) {
      requireAddressed(sessionId);
      const failure = latestQuotaFailure(getState().items);
      if (!failure || failure.quota.resetAt === null) {
        throw new Error('latest turn did not fail on exhausted provider quota with a known reset time');
      }
      if (!hasResumeInput(failure.turnKey))
        throw new Error('This turn cannot be resumed automatically. Send a new message to continue.');
      queueResume(sessionId, failure);
      return true;
    },

    cancelQuotaResume(sessionId) {
      requireAddressed(sessionId);
      cancelEpoch += 1;
      cancelQuotaResumeEntry(sessionId);
      return true;
    },

    /** A session clear/delete supersedes the wait. */
    supersedeQuotaResume(sessionId) {
      if (sessionId) cancelFor(String(sessionId));
    },

    /** A deferred retry request (the desktop's switch-model flow): checked
     *  against the session's own state when it arrives, so it runs only while
     *  `turnKey` is still the latest failed turn and nothing is running,
     *  settling or queued. False when refused. */
    async retryFailedTurn(sessionId, turnKey) {
      requireAddressed(sessionId);
      const key = String(turnKey || '');
      if (!key || retryBlocked() || latestFailedTurnKey(getState().items) !== key) return false;
      const claim = `${sessionId}\u0000${key}`;
      if (retryClaim === claim) return false;
      const goalId = quotaSuspendedGoal(sessionId, key);
      if (!retainedRetryInput() && !failedTurnRetryPrompt(getState().items, key) && !goalId) {
        return false;
      }
      retryClaim = claim;
      const entry = quotaResumeEntry(sessionId);
      if (goalId) return resumeGoal(sessionId, key, goalId, entry, claim);
      let accepted = false;
      try {
        accepted = retryFailedTurn(key) !== false;
        if (accepted) finishResume(sessionId, entry);
        return accepted;
      } finally {
        if (!accepted && retryClaim === claim) retryClaim = '';
      }
    },

    /** Scheduler fire for the entry of `generation`, after a usable reading.
     *  Synchronous from the generation check to the admitted retry, so no
     *  cancellation can land between them. Returns the outcome. */
    fireQuotaResume({ generation } = {}) {
      const id = currentId();
      const entry = quotaResumeEntry(id);
      if (!id || !entry || entry.generation !== generation) return 'stale';
      const state = getState();
      if (retryBlocked()) return 'busy';
      const failure = latestQuotaFailure(state.items);
      if (!failure || failure.turnKey !== entry.turnKey) {
        cancelQuotaResumeEntry(id, { generation });
        return 'superseded';
      }
      const goalId = quotaSuspendedGoal(id, entry.turnKey);
      // A user turn replays its prompt; an automatic Goal turn has no user row
      // and resumes as its Goal's next continuation.
      if (!retainedRetryInput() && !failedTurnRetryPrompt(state.items, entry.turnKey) && !goalId) {
        bag.pushNotice?.('This turn cannot be resumed automatically. Send a new message to continue.', 'warn', {
          transcript: true,
        });
        cancelQuotaResumeEntry(id, { generation });
        return 'unreplayable';
      }
      const claim = `${id}\u0000${entry.turnKey}`;
      if (retryClaim === claim) return 'stale';
      retryClaim = claim;
      if (goalId)
        return resumeGoal(id, entry.turnKey, goalId, entry, claim).then((accepted) =>
          accepted ? 'fired' : 'rejected'
        );
      if (retryFailedTurn(entry.turnKey) === false) {
        retryClaim = '';
        return 'rejected';
      }
      finishResume(id, entry);
      return 'fired';
    },
  };
}
