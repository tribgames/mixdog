// session-calls/session-turns.mjs
// The execution side of the protocol: submitting a prompt, aborting, tool
// approval, and materializing a session for daemon ownership. Resuming the
// sessions that carry an active Goal after daemon replacement is wired in from
// ./goal-recovery.mjs.
import { createGoalRecovery } from './goal-recovery.mjs';
import {
  attachmentsForIntake,
  materializePromptSubmission,
  preparePromptSubmissionForProvider,
} from '../../../runtime/attachments/store.mjs';
import { providerNativePdf } from '../../../runtime/agent/orchestrator/providers/registry.mjs';
import { cancelBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';
import { isAgentModeSession } from '../../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { isAgentHomeSessionId } from '../../../runtime/agent/orchestrator/session/agent-home.mjs';
import { recognisedAgentRoomSlash } from '../../../tui/app/slash-commands.mjs';
import { promptContentText } from '../../../tui/session/queue-helpers.mjs';

/** Whether an abort on this session is an Agent cancelling its own turn: the
 *  catalog knows it, the runtime declares agent-only visibility, or it is a
 *  legacy agent child (agent owner, not the lead, with a distinct parent). */
function abortsAgentTurn(id, state, hasAgentSession) {
  const parentId = String(state.parentSessionId || state.ownerSessionId || '').trim();
  const isLegacyAgentChild =
    String(state.owner || '')
      .trim()
      .toLowerCase() === 'agent' &&
    String(state.agent || '')
      .trim()
      .toLowerCase() !== 'lead' &&
    parentId &&
    parentId !== id;
  return (
    hasAgentSession(id) ||
    String(state.visibility || '')
      .trim()
      .toLowerCase() === 'agent-only' ||
    isLegacyAgentChild
  );
}

/** A prompt the user typed: not an agent's send (`sender: 'lead'`), a hidden
 *  wake, a routine fire or any other runtime-made turn. */
export function isUserTurn(options = {}) {
  return (
    (options.mode || 'prompt') === 'prompt' &&
    options.kickoff !== true &&
    options.isMeta !== true &&
    options.transcriptMeta?.sender !== 'lead'
  );
}

export function createSessionTurnCalls(ctx) {
  const { log, readStoredGoal, listStoredActiveGoalSessionIds, hasAgentSession, sessionResult, advanceForCaller } = ctx;
  const { retainUnwatched } = ctx.retention;
  const { entryForSession } = ctx.entries;

  /** Publishes the step an action produced and keeps the entry on the retention clock. */
  const settleAction = (entry, reason) => {
    const step = advanceForCaller(entry);
    retainUnwatched(entry, reason);
    return step;
  };

  // Intakes in flight per session: an abort of the session also cancels an
  // attachment conversion that has not yet become a turn.
  const intakeAborts = new Map();

  async function submitSession({
    sessionId,
    prompt,
    options = {},
    open: openHints = {},
    baseRevision = null,
    signal = null,
  } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime.submitAsync;
    if (typeof target !== 'function') throw new TypeError('session runtime must implement submitAsync');
    const intakeAbort = new AbortController();
    const forwardAbort = () => intakeAbort.abort(signal.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.('abort', forwardAbort, { once: true });
    if (!intakeAborts.has(id)) intakeAborts.set(id, new Set());
    intakeAborts.get(id).add(intakeAbort);
    let intake;
    try {
      intake = await preparePromptSubmissionForProvider(
        materializePromptSubmission(prompt, options || {}),
        { nativePdf: providerNativePdf(entry.runtime.provider || entry.runtime.session?.provider || '') },
        { signal: intakeAbort.signal }
      );
    } finally {
      signal?.removeEventListener?.('abort', forwardAbort);
      intakeAborts.get(id)?.delete(intakeAbort);
      if (!intakeAborts.get(id)?.size) intakeAborts.delete(id);
    }
    // A cancel that landed after the last conversion step must not submit.
    intakeAbort.signal.throwIfAborted();
    // Await intake only: submitAsync resolves once the prompt is represented by
    // the queue/user row, while provider execution remains daemon-owned and
    // detached.
    let submissionOptions = intake.options;
    // Every send (desktop or paired device) reaches the engine here: the
    // message records its attachments by content hash, so any device can open
    // or download them by id later (and the store's census keeps the blobs).
    const attachments = attachmentsForIntake(intake.prompt, intake.options);
    if (attachments.length || entry.runtime.externalAction === true) {
      const transcriptMeta = intake.options?.transcriptMeta;
      const baseMeta = transcriptMeta && typeof transcriptMeta === 'object' ? transcriptMeta : {};
      submissionOptions = {
        ...intake.options,
        transcriptMeta: {
          ...baseMeta,
          ...(attachments.length ? { attachments } : {}),
          ...(entry.runtime.externalAction === true ? { sender: 'user' } : {}),
        },
      };
    }
    // A bot's conversation room runs only its own /compact and /clear (the
    // composer's rule): every other leading `/` is message text for the model.
    if (isAgentModeSession(entry.runtime.session ?? { id })) {
      const text = typeof intake.prompt === 'string' ? intake.prompt : promptContentText(intake.prompt);
      if (!recognisedAgentRoomSlash(text)) submissionOptions = { ...submissionOptions, skipSlashCommands: true };
    }
    const accepted = await Promise.resolve(target.call(entry.runtime, intake.prompt, submissionOptions));
    if (accepted === true) {
      entry.reservedOnly = false;
      if (isAgentHomeSessionId(id) && isUserTurn(submissionOptions)) {
        // The user spoke in this agent's home: its round trips with other
        // sessions count from zero again, so a capped thread wakes again.
        void import('../../../session-runtime/agent-home-delivery.mjs')
          .then(({ resetAgentTaskRounds }) => resetAgentTaskRounds(id))
          .catch((error) => log(`round reset of ${id} failed: ${error?.message || error}`));
      }
    }
    const step = settleAction(entry, 'headless session submit');
    log(`session submit session=${id} accepted=${accepted === true}`);
    return sessionResult(entry, step, baseRevision, { accepted: accepted === true });
  }

  async function materializeSession(sessionId, openHints = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    retainUnwatched(entry, 'daemon session owner');
    return entry.runtime;
  }

  const recoverActiveGoals = createGoalRecovery({
    log,
    readStoredGoal,
    listStoredActiveGoalSessionIds,
    materializeSession,
  });

  async function abortSession({ sessionId, open: openHints = {}, options = {}, baseRevision = null } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    for (const intakeAbort of intakeAborts.get(id) ?? []) intakeAbort.abort();
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime.abort;
    if (typeof target !== 'function') throw new TypeError('session action abort is unavailable');
    const state = entry.runtime.getState?.() || {};
    const cancelsAgentWork = abortsAgentTurn(id, state, hasAgentSession);
    let rawResult;
    try {
      rawResult = target.call(entry.runtime, options || {});
    } finally {
      // Lead cancellation must leave delegated work alive. An Agent cancelling
      // its own turn, however, is the live parent signal for Agent work nested
      // under that turn; task cancellation reaches the child's own controller
      // without enumerating durable sessions.
      if (cancelsAgentWork) {
        cancelBackgroundTasks({
          surface: 'agent',
          callerSessionId: id,
          reason: 'parent Agent turn aborted',
        });
      }
    }
    rawResult = await rawResult;
    const abortResult = rawResult && typeof rawResult === 'object' ? rawResult : { aborted: rawResult === true };
    const step = settleAction(entry, 'headless session abort');
    return sessionResult(entry, step, baseRevision, abortResult);
  }

  async function approveSession({ sessionId, approvalId, decision, open: openHints = {}, baseRevision = null } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime.resolveToolApproval;
    if (typeof target !== 'function') {
      throw new TypeError('session action resolveToolApproval is unavailable');
    }
    const approved = await target.call(entry.runtime, approvalId, decision);
    const step = settleAction(entry, 'headless session approval');
    return sessionResult(entry, step, baseRevision, { approved: approved === true });
  }

  return { submitSession, materializeSession, recoverActiveGoals, abortSession, approveSession };
}
