// session-calls/session-turns.mjs
// The execution side of the protocol: submitting a prompt, aborting, tool
// approval, materializing a session for daemon ownership, and resuming the
// sessions that carry an active Goal after daemon replacement.
import { SESSION_ID_PATTERN } from '../agent-tree.mjs';
import {
  materializePromptSubmission,
  preparePromptSubmissionForProvider,
} from '../../../runtime/attachments/store.mjs';
import { cancelBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';

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

  async function submitSession({ sessionId, prompt, options = {}, open: openHints = {}, baseRevision = null } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const entry = await entryForSession(id, openHints || {});
    const target = entry.runtime.submitAsync;
    if (typeof target !== 'function') throw new TypeError('session runtime must implement submitAsync');
    const intake = await preparePromptSubmissionForProvider(
      materializePromptSubmission(prompt, options || {}),
      entry.runtime.provider || entry.runtime.session?.provider || ''
    );
    // Await intake only: submitAsync resolves once the prompt is represented by
    // the queue/user row, while provider execution remains daemon-owned and
    // detached.
    let submissionOptions = intake.options;
    if (entry.runtime.externalAction === true) {
      const transcriptMeta = intake.options?.transcriptMeta;
      const baseMeta = transcriptMeta && typeof transcriptMeta === 'object' ? transcriptMeta : {};
      submissionOptions = { ...intake.options, transcriptMeta: { ...baseMeta, sender: 'user' } };
    }
    const accepted = await Promise.resolve(target.call(entry.runtime, intake.prompt, submissionOptions));
    if (accepted === true) {
      entry.reservedOnly = false;
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

  async function recoverActiveGoals() {
    if (typeof listStoredActiveGoalSessionIds !== 'function') {
      return { found: 0, resumed: 0, skipped: 0, failed: 0 };
    }
    let listed;
    try {
      listed = await listStoredActiveGoalSessionIds();
    } catch (err) {
      log(`active Goal discovery failed: ${err?.message || err}`);
      return { found: 0, resumed: 0, skipped: 0, failed: 1 };
    }
    const sessionIds = [...new Set(Array.isArray(listed) ? listed : [])]
      .map((sessionId) => String(sessionId || ''))
      .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId));
    let resumed = 0;
    let skipped = 0;
    let failed = 0;
    for (const sessionId of sessionIds) {
      try {
        if (typeof readStoredGoal === 'function') {
          const goal = await readStoredGoal(sessionId);
          if (goal?.status !== 'active') {
            skipped += 1;
            continue;
          }
        }
        await materializeSession(sessionId);
        resumed += 1;
      } catch (err) {
        failed += 1;
        log(`active Goal recovery failed session=${sessionId}: ${err?.message || err}`);
      }
    }
    return { found: sessionIds.length, resumed, skipped, failed };
  }

  async function abortSession({ sessionId, open: openHints = {}, options = {}, baseRevision = null } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
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
