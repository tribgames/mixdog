/**
 * src/tui/session/tool-approval.mjs — session-owned tool-approval queue.
 *
 * These handlers drive a small FIFO of hook approval requests and reflect the
 * active one into store state (state.toolApproval). They need live session
 * state, so the closure identifiers (state/set/nextId/disposed/timeout) are
 * threaded through the factory argument via getters — never stale snapshots.
 *
 * Delegation (`surfaceOf`, human-gate/gate.mjs approvalSurface): a sub-agent's
 * approval is also offered to the top-level conversation the user watches
 * (runtime/shared/delegated-approval-host.mjs), labelled with the agent chain.
 * That session's queue holds a copy (`mirror`): it never times out, survives
 * that session's own turn ending, and its answer is forwarded to the owning
 * queue, so either place settles the one request once.
 */
import {
  delegateApproval,
  delegatedApprovalsFor,
  registerApprovalQueue,
} from '../../runtime/shared/delegated-approval-host.mjs';
import { defaultApprovalTimeoutMs, normalizeToolApprovalRequest } from './tool-approval-request.mjs';
import { copyOutcome, finishedOutcome, forwardToOwner, settleToolApproval } from './tool-approval-settle.mjs';
import { createApprovalDelegation } from './tool-approval-delegation.mjs';

/** The wait limit an approval has when its request names none, from
 *  MIXDOG_TOOL_APPROVAL_TIMEOUT_MS (milliseconds, one second at least): null —
 *  no limit — unless the variable sets one, which tests and ops use. An
 *  approval waits until the user answers, Stop/turn abort denies it, or its
 *  runtime closes. */
export function resolveToolApprovalTimeoutMs(env = process.env) {
  const value = Number(env.MIXDOG_TOOL_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.max(1000, Math.round(value)) : null;
}

export function createToolApproval({ getState, set, nextId, getDisposed, timeoutMs = null, surfaceOf = null }) {
  const defaultTimeoutMs = defaultApprovalTimeoutMs(timeoutMs);
  const toolApprovalQueue = [];
  let activeToolApproval = null;
  // Copies of the ask_user questions of sessions this chat handed work to
  // (`{ id, request, mirror }`): published as `handoffQuestions`, each shown
  // at its hand-off line for the user alone (no transcript row), outside the
  // queue so they never hold this chat's own requests back and several show
  // at once. Answered here, the answer goes to the asking session's queue.
  const handoffQuestions = [];
  const publishHandoffQuestions = () => set({ handoffQuestions: handoffQuestions.map((entry) => entry.request) });
  const ownSessionId = () => String(getState()?.sessionId || '');
  const { delegationSurface, handsOff, offerToHandoffs } = createApprovalDelegation({ surfaceOf, ownSessionId });
  const unregister =
    typeof surfaceOf === 'function'
      ? registerApprovalQueue({
          sessionId: ownSessionId,
          disposed: () => getDisposed(),
          offer: offerDelegatedApproval,
          withdraw: withdrawDelegatedCopy,
        })
      : () => {};

  // A request that has a limit expires from ITS OWN requestedAt, queued or
  // active. Arming the timer only on presentation let a queued request sit past
  // expiresAt (retaining its promise and surfacing an obsolete approval later).
  // One without a limit (expiresAt null — the default) arms nothing.
  function armToolApprovalTimeout(entry) {
    // A copy expires with its owner, which withdraws it.
    if (!entry || entry.mirror || entry.timer || !Number.isFinite(entry.request?.expiresAt)) return;
    const remainingMs = Math.max(0, entry.request.expiresAt - Date.now());
    entry.timer = setTimeout(() => {
      finishToolApproval(entry.id, false, 'approval timed out', '', undefined, undefined, { timedOut: true });
    }, remainingMs);
    entry.timer.unref?.();
  }
  function offerDelegatedApproval(delegated) {
    if (getDisposed() || delegated.sessionId !== ownSessionId()) return;
    if (delegated.request?.kind === 'question') {
      if (handoffQuestions.some((entry) => entry.id === delegated.id)) return;
      handoffQuestions.push({ id: delegated.id, request: delegated.request, mirror: delegated });
      publishHandoffQuestions();
      return;
    }
    if (activeToolApproval?.id === delegated.id || toolApprovalQueue.some((entry) => entry.id === delegated.id)) return;
    toolApprovalQueue.push({ id: delegated.id, request: delegated.request, mirror: delegated, timer: null });
    presentNextToolApproval();
  }
  function withdrawDelegatedCopy(id, result) {
    const question = handoffQuestions.findIndex((entry) => entry.id === id);
    if (question >= 0) {
      handoffQuestions.splice(question, 1);
      if (!getDisposed()) publishHandoffQuestions();
      return;
    }
    if (activeToolApproval?.mirror && activeToolApproval.id === id) {
      activeToolApproval = null;
      set({ toolApproval: null, toolApprovalResult: copyOutcome(id, result) });
      presentNextToolApproval();
      return;
    }
    const index = toolApprovalQueue.findIndex((entry) => entry.mirror && entry.id === id);
    if (index < 0) return;
    toolApprovalQueue.splice(index, 1);
    presentNextToolApproval();
  }
  /** Show the delegated approvals waiting for this session (it loaded, or its
   *  session id became the top-level one after the request was made). */
  function adoptDelegatedApprovals() {
    const sessionId = ownSessionId();
    if (!sessionId || typeof surfaceOf !== 'function') return;
    for (const delegated of delegatedApprovalsFor(sessionId)) offerDelegatedApproval(delegated);
  }
  /** Show the next request when none is shown, and publish how many wait
   *  behind the shown one (`toolApprovalsWaiting`: the dock's "1/N"). */
  function presentNextToolApproval() {
    if (getDisposed()) return;
    const patch = {};
    if (!activeToolApproval) {
      const entry = toolApprovalQueue.shift();
      if (entry) {
        activeToolApproval = entry;
        armToolApprovalTimeout(entry);
        patch.toolApproval = entry.request;
      } else if (getState().toolApproval) patch.toolApproval = null;
    }
    if ((getState().toolApprovalsWaiting ?? 0) !== toolApprovalQueue.length) {
      patch.toolApprovalsWaiting = toolApprovalQueue.length;
    }
    if (Object.keys(patch).length > 0) set(patch);
  }
  function finishToolApproval(
    id,
    approved,
    reason = '',
    device = '',
    answers = undefined,
    reply = undefined,
    extra = undefined
  ) {
    const targetId = String(id || '');
    if (activeToolApproval && activeToolApproval.id === targetId) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      set({ toolApproval: null, toolApprovalResult: finishedOutcome(targetId, approved, device, extra) });
      let accepted = true;
      if (entry.mirror) {
        accepted = forwardToOwner(entry, approved, reason, device, answers, reply, extra);
      } else {
        settleToolApproval(entry, approved === true, String(reason || ''), answers, reply, extra, String(device || ''));
      }
      presentNextToolApproval();
      return accepted;
    }
    const index = toolApprovalQueue.findIndex((entry) => entry.id === targetId);
    if (index >= 0) {
      const [entry] = toolApprovalQueue.splice(index, 1);
      presentNextToolApproval();
      if (entry.mirror) return forwardToOwner(entry, approved, reason, device, answers, reply, extra);
      settleToolApproval(entry, approved === true, String(reason || ''), answers, reply, extra, String(device || ''));
      return true;
    }
    const question = handoffQuestions.findIndex((entry) => entry.id === targetId);
    if (question >= 0) {
      const [entry] = handoffQuestions.splice(question, 1);
      publishHandoffQuestions();
      return forwardToOwner(entry, approved, reason, device, answers, reply, extra);
    }
    return false;
  }
  /** Deny this session's own requests. A copy of a sub-agent's request stays
   *  (that agent still waits) until this runtime closes, which drops it
   *  unanswered: the next runtime of this session adopts it again. */
  function denyAllToolApprovals(reason = 'approval cancelled') {
    const closing = getDisposed();
    if (closing) {
      unregister();
      // Dropped unanswered with this runtime: the next one adopts them again.
      handoffQuestions.length = 0;
    }
    if (activeToolApproval && !(activeToolApproval.mirror && !closing)) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      if (!entry.mirror) {
        settleToolApproval(entry, false, reason);
        // Stop/turn abort ended it: not a timeout, nobody answered.
        set({ toolApprovalResult: { id: entry.id, approved: false, device: '', interrupted: true, at: Date.now() } });
      }
    }
    const kept = [];
    while (toolApprovalQueue.length > 0) {
      const entry = toolApprovalQueue.shift();
      if (!entry.mirror) settleToolApproval(entry, false, reason);
      else if (!closing) kept.push(entry);
    }
    toolApprovalQueue.push(...kept);
    if (activeToolApproval) return presentNextToolApproval();
    if (getState().toolApproval) set({ toolApproval: null });
    presentNextToolApproval();
  }
  function requestToolApproval(input = {}) {
    if (getDisposed()) return Promise.resolve({ approved: false, reason: 'runtime disposed' });
    return new Promise((resolve) => {
      const id = nextId();
      const full = normalizeToolApprovalRequest(input, id, defaultTimeoutMs);
      const surface = delegationSurface(full);
      if (surface) {
        // Who asks, from the top-level chat down ("사무관 › Worker"), and where the copy is.
        full.chain = surface.chain;
        full.surfaceSessionId = surface.sessionId;
      }
      const handoffs = !surface && handsOff(full);
      const entry = { id, request: full, resolve, timer: null, delegated: Boolean(surface || handoffs) };
      toolApprovalQueue.push(entry);
      armToolApprovalTimeout(entry);
      presentNextToolApproval();
      const answer = (approved, reason, device, answers, reply, extra) =>
        finishToolApproval(id, approved, reason, device, answers, reply, extra);
      if (surface) delegateApproval({ id, sessionId: surface.sessionId, request: full, answer });
      if (handoffs) offerToHandoffs(id, full, answer);
    });
  }

  return {
    presentNextToolApproval,
    finishToolApproval,
    denyAllToolApprovals,
    requestToolApproval,
    adoptDelegatedApprovals,
  };
}
