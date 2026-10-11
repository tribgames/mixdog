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
  scheduleQuotaResumeEntry,
  subscribeQuotaResume,
} from '../../runtime/shared/quota-resume-store.mjs';
import { createSubmissionIntake } from './session-api/intake/submission.mjs';

export const RETRY_CONTINUE_INSTRUCTION = 'Continue from where you left off.';

// Rows that frame a turn rather than carry its output (desktop transcript-rows).
const TURN_CHROME_KINDS = new Set(['user', 'turndone', 'statusdone', 'notice']);

function stableItemKey(item, index) {
  if (item?.id !== undefined && item?.id !== null) return String(item.id);
  return `${item?.kind || 'item'}:${item?.text || item?.label || item?.status || ''}:${index}`;
}

/** Turn identity per transcript row — the same keys the desktop derives. */
export function transcriptTurnKeys(items) {
  const transcript = Array.isArray(items) ? items : [];
  const keys = [];
  let activeTurn = null;
  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item?.kind === 'user') activeTurn = `turn:${stableItemKey(item, index)}`;
    if (!activeTurn) activeTurn = `segment:${stableItemKey(item, index)}`;
    keys.push(activeTurn);
    if (item?.kind === 'turndone') activeTurn = null;
  }
  return keys;
}

/** The failed turndone that ended the transcript on exhausted provider quota,
 *  when no later turn has begun: { turnKey, quota: { provider, model, resetAt|null } }. */
export function latestQuotaFailure(items) {
  const transcript = Array.isArray(items) ? items : [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === 'user') return null;
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
  if (!prompt) return null;
  // Transcript rows keep only attachment metadata, so a text-only replay
  // would drop the attachments and the rewind would delete the original row.
  if (hasAttachments && !sampled) return null;
  return sampled ? RETRY_CONTINUE_INSTRUCTION : prompt;
}

export function createQuotaResumeLane(bag) {
  const { runtime, flags, getState, set, pending } = bag;
  const currentId = () => String(getState().sessionId || '');
  let intake = null;
  const submitAsync = (...args) => {
    intake ??= createSubmissionIntake(bag);
    return intake.submitAsync(...args);
  };

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

  const cancelFor = (sessionId) => {
    cancelEpoch += 1;
    cancelQuotaResumeEntry(sessionId);
    forgetQuotaSuspendedGoal(sessionId);
  };

  /** The one retry operation. `automatic` is the scheduler's resume: it
   *  enqueues directly, because the hours it waited must not trigger the idle
   *  auto-clear a user submission starts. */
  function retryFailedTurn(turnKey, { automatic = false } = {}) {
    const prompt = failedTurnRetryPrompt(getState().items, turnKey);
    if (!prompt) return false;
    if (automatic) {
      return bag.enqueue(prompt, { mode: 'prompt', id: bag.nextId(), displayText: prompt, retryFailedTurn: true });
    }
    return submitAsync(prompt, { retryFailedTurn: true });
  }

  return {
    publishQuotaResume,
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
      queueResume(sessionId, failure);
      return true;
    },

    cancelQuotaResume(sessionId) {
      requireAddressed(sessionId);
      cancelQuotaResumeEntry(sessionId);
      return true;
    },

    /** A route change or a session clear/delete supersedes the wait. */
    supersedeQuotaResume(sessionId) {
      if (sessionId) cancelFor(String(sessionId));
    },

    async retryFailedTurn(sessionId, turnKey) {
      requireAddressed(sessionId);
      return (await retryFailedTurn(String(turnKey || ''))) === true;
    },

    /** Scheduler fire for the entry of `generation`, after a usable reading.
     *  Synchronous from the generation check to the admitted retry, so no
     *  cancellation can land between them. Returns the outcome. */
    fireQuotaResume({ generation } = {}) {
      const id = currentId();
      const entry = quotaResumeEntry(id);
      if (!id || !entry || entry.generation !== generation) return 'stale';
      const state = getState();
      if (
        flags.disposed ||
        settlement !== null ||
        (flags.admission || 'open') !== 'open' ||
        state.busy ||
        state.commandBusy ||
        flags.autoClearRunning ||
        flags.draining ||
        pending.length > 0
      ) {
        return 'busy';
      }
      const failure = latestQuotaFailure(state.items);
      if (!failure || failure.turnKey !== entry.turnKey) {
        cancelQuotaResumeEntry(id, { generation });
        return 'superseded';
      }
      const route = sessionRoute();
      if (route.routeProvider !== entry.routeProvider || route.routeModel !== entry.routeModel) {
        cancelQuotaResumeEntry(id, { generation });
        return 'route-changed';
      }
      const goalId = quotaSuspendedGoal(id, entry.turnKey);
      // A user turn replays its prompt; an automatic Goal turn has no user row
      // and resumes as its Goal's next continuation.
      const userTurn = entry.turnKey.startsWith('turn:');
      if (userTurn ? !failedTurnRetryPrompt(state.items, entry.turnKey) : !goalId) {
        cancelQuotaResumeEntry(id, { generation });
        return 'unreplayable';
      }
      if (!cancelQuotaResumeEntry(id, { generation })) return 'stale';
      forgetQuotaSuspendedGoal(id);
      // Queued on the Goal's mutation chain ahead of the retry turn's own
      // start, so that turn opens on the revived Goal; the retry is busy
      // before the revived Goal's continuation check runs, so it queues none.
      // Without a retry the revived Goal's continuation is the one turn.
      if (goalId) void Promise.resolve(runtime.reactivateUsageLimitedGoal?.(goalId)).catch(() => {});
      if (!userTurn) return 'fired';
      return retryFailedTurn(entry.turnKey, { automatic: true }) !== false ? 'fired' : 'rejected';
    },
  };
}
