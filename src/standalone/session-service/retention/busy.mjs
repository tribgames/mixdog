/**
 * busy.mjs — whether a session entry is still doing work.
 *
 * Busy is what makes a runtime unreclaimable, so it is deliberately
 * conservative: detached background tasks count, and a runtime whose state
 * cannot be read is treated as busy rather than risking the loss of a live
 * turn. The eviction sweep that consumes this lives in ../retention.mjs.
 */
import { activeBackgroundTaskSessionIds, hasActiveBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';
import { emitSessionApprovalCardChange } from '../../../runtime/shared/session-activity-signal.mjs';
import { roomMemberOfSession } from '../../../runtime/agent/orchestrator/session/agent-room.mjs';

/** A room member session's copies of the questions of sessions it handed work
 *  to (tui/session/tool-approval.mjs `handoffQuestions`); empty for any other
 *  session. The room shows them from the member's catalog row (agent-rooms.ts),
 *  as no view watches a member session. */
function roomHandoffQuestionsOf(sessionId, state) {
  if (!roomMemberOfSession(sessionId)) return [];
  return Array.isArray(state?.handoffQuestions) ? state.handoffQuestions : [];
}

export function createBusyTracker({ sessions, currentSessionId }) {
  function stateBusy(state) {
    return (
      state?.busy === true || state?.commandBusy === true || (Array.isArray(state?.queued) && state.queued.length > 0)
    );
  }

  function updateEntryBusy(entry, state) {
    const next = stateBusy(state);
    entry.busy = next;
    // Every runtime state change passes here, watched or headless: a session
    // that starts or stops showing an approval card (any kind, a sub-agent's
    // delegated copy included) announces it, so the session catalog — the one
    // status source every list row has, open pane or not — re-reads it.
    const awaitingApproval = Boolean(state?.toolApproval);
    const awaitingQuestion = state?.toolApproval?.kind === 'question';
    // A room member's handed-off questions coming and going re-read it too.
    const sessionId = currentSessionId(entry) || '';
    const handoffQuestions = roomHandoffQuestionsOf(sessionId, state)
      .map((question) => String(question?.id ?? ''))
      .join('\n');
    if (
      awaitingApproval !== (entry.awaitingApproval === true) ||
      awaitingQuestion !== (entry.awaitingQuestion === true) ||
      handoffQuestions !== (entry.handoffQuestions ?? '')
    ) {
      entry.awaitingApproval = awaitingApproval;
      entry.awaitingQuestion = awaitingQuestion;
      entry.handoffQuestions = handoffQuestions;
      emitSessionApprovalCardChange(sessionId);
    }
    return next;
  }

  /** Room member session id -> its pending handed-off question copies, for
   *  every live member runtime holding one. */
  function roomHandoffQuestions() {
    const byMember = new Map();
    for (const entry of sessions) {
      const sessionId = currentSessionId(entry);
      const questions = sessionId ? roomHandoffQuestionsOf(sessionId, entry.runtime?.getState?.()) : [];
      if (questions.length) byMember.set(sessionId, questions);
    }
    return byMember;
  }

  /** Session id -> the kind of its pending card ('approval' | 'question') for
   *  every session whose live runtime shows one waiting on the user. */
  function awaitingApprovalSessionKinds() {
    const kinds = new Map();
    for (const entry of sessions) {
      const sessionId = currentSessionId(entry);
      const pending = sessionId ? entry.runtime?.getState?.()?.toolApproval : null;
      if (pending) kinds.set(sessionId, pending.kind === 'question' ? 'question' : 'approval');
    }
    return kinds;
  }

  function sessionBusy(entry) {
    const sessionId = currentSessionId(entry);
    // Detached views do not make their background commands disposable. Keep
    // the owner runtime (and daemon self-shutdown guard) live until the task
    // reaches a terminal state and its completion can be delivered back into
    // this session.
    if (sessionId && hasActiveBackgroundTasks({ callerSessionId: sessionId })) return true;
    return sessionTurnBusy(entry);
  }

  // A turn is running (provider stream / tool call / queued input). Background
  // tasks are deliberately not counted: they run outside the heap-churning turn.
  function sessionTurnBusy(entry) {
    if (typeof entry?.busy === 'boolean') return entry.busy;
    try {
      return updateEntryBusy(entry, entry.runtime.getState?.() || {});
    } catch {
      // A session runtime we cannot read is never assumed idle — losing a live
      // turn is far worse than holding an extra process for one sweep.
      return true;
    }
  }

  // sessionBusy for every entry, with the background tasks scanned once: the
  // owner heartbeat, telemetry and status ask this every few seconds, and a
  // scan per session made it sessions × tasks on the event loop.
  function liveBusyCount() {
    const withTasks = activeBackgroundTaskSessionIds();
    let count = 0;
    for (const entry of sessions) {
      const sessionId = currentSessionId(entry);
      if ((sessionId && withTasks.has(sessionId)) || sessionTurnBusy(entry)) count += 1;
    }
    return count;
  }

  function liveTurnBusyCount() {
    let count = 0;
    for (const entry of sessions) {
      if (sessionTurnBusy(entry)) count += 1;
    }
    return count;
  }

  return {
    stateBusy,
    updateEntryBusy,
    awaitingApprovalSessionKinds,
    roomHandoffQuestions,
    sessionBusy,
    liveBusyCount,
    liveTurnBusyCount,
  };
}
