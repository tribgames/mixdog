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
  humanRequestFields,
  normalizeHumanResponse,
} from '../../runtime/agent/orchestrator/session/human-gate/requests.mjs';
import { agentIdOfHomeSession } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../runtime/agent/orchestrator/session/agent-room.mjs';
import {
  delegateApproval,
  delegateToHandoffs,
  delegatedApprovalsFor,
  registerApprovalQueue,
  withdrawDelegatedApproval,
} from '../../runtime/shared/delegated-approval-host.mjs';

/** Requests a sub-agent (or a session a chat handed work to) shows in the
 *  conversation the user watches too. A secret and a takeover go there as
 *  well: the value goes to this PC by its request id and the sign-in window
 *  is bound to the asking session, wherever the card is answered. A question
 *  stays in its own session (its answer belongs to that conversation). */
const DELEGATED_KINDS = new Set(['', 'approval', 'outbound', 'permission', 'secret', 'takeover']);

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
  const defaultTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
  const toolApprovalQueue = [];
  let activeToolApproval = null;
  const ownSessionId = () => String(getState()?.sessionId || '');
  const unregister =
    typeof surfaceOf === 'function'
      ? registerApprovalQueue({
          sessionId: ownSessionId,
          disposed: () => getDisposed(),
          offer: offerDelegatedApproval,
          withdraw: withdrawDelegatedCopy,
        })
      : () => {};

  function normalizeToolApprovalRequest(input = {}, id = nextId()) {
    const now = Date.now();
    // An explicit `timeoutMs: null` means no wait limit (no timer, no expiry);
    // any other missing/invalid value falls back to the session default,
    // which is itself no limit unless the runtime configures one.
    let requestTimeoutMs = defaultTimeoutMs;
    if (input?.timeoutMs === null) requestTimeoutMs = null;
    else if (Number.isFinite(Number(input?.timeoutMs)) && Number(input.timeoutMs) > 0) {
      requestTimeoutMs = Number(input.timeoutMs);
    }
    return {
      id,
      name: String(input?.name || input?.tool_name || 'tool'),
      kind: typeof input?.kind === 'string' ? input.kind : '',
      args: input?.args ?? input?.tool_input ?? null,
      cwd: input?.cwd || null,
      sessionId: input?.sessionId || input?.session_id || null,
      toolCallId: input?.toolCallId || input?.tool_use_id || null,
      reason: String(input?.reason || input?.message || 'approval requested by hook').trim(),
      requestedAt: now,
      timeoutMs: requestTimeoutMs,
      expiresAt: requestTimeoutMs === null ? null : now + requestTimeoutMs,
      // outbound / secret / takeover / permission fields (human-gate/requests.mjs).
      ...humanRequestFields(input),
    };
  }
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
  // Settle one entry: drop its timeout, then hand the waiter its answer. The
  // resolve stays guarded — a waiter whose caller already went away must never
  // take the rest of the queue down with it.
  function settleToolApproval(entry, approved, reason, answers, reply, extra, device = '') {
    if (entry?.timer) clearTimeout(entry.timer);
    const result = { approved, reason };
    if (answers !== undefined) result.answers = answers;
    if (reply !== undefined) result.reply = reply;
    // A human-kind request answers with its canonical response (never a value).
    if (entry?.request?.remember) {
      Object.assign(result, normalizeHumanResponse(entry.request, approved, extra));
      if (device) result.device = device;
    }
    if (extra?.timedOut === true) result.timedOut = true;
    // Settled here: its copy in the top-level chat goes away.
    if (entry?.delegated) {
      withdrawDelegatedApproval(entry.id, { approved, device, ...(extra?.timedOut === true ? { expired: true } : {}) });
    }
    try {
      entry.resolve(result);
    } catch {
      // The requester's resolver must not break settling the queue.
    }
  }
  /** Hand a copy's answer to the queue that owns the request; false when the
   *  owner had already settled it. */
  function forwardToOwner(entry, approved, reason, device, answers, reply, extra) {
    try {
      return entry.mirror.answer(approved, reason, device, answers, reply, extra) === true;
    } catch {
      return false;
    }
  }
  function offerDelegatedApproval(delegated) {
    if (getDisposed() || delegated.sessionId !== ownSessionId()) return;
    if (activeToolApproval?.id === delegated.id || toolApprovalQueue.some((entry) => entry.id === delegated.id)) return;
    toolApprovalQueue.push({ id: delegated.id, request: delegated.request, mirror: delegated, timer: null });
    presentNextToolApproval();
  }
  /** How a copy ended, from the owner's settle: answered from a known device
   *  (who), a real timeout (`expired`), or taken away with no answer
   *  (`withdrawn`: the owner's turn ended, the hand-off copy was removed). */
  function copyOutcome(id, result) {
    const device = String(result?.device || '');
    const at = Date.now();
    if (device) return { id, approved: result.approved === true, device, at };
    if (result?.expired === true) return { id, approved: false, device: '', expired: true, at };
    return { id, approved: false, device: '', withdrawn: true, at };
  }
  function withdrawDelegatedCopy(id, result) {
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
      // Only an answer from a known device is attributed; a real timeout says
      // `expired`; any other unattributed end names nobody.
      let toolApprovalResult = null;
      if (device) {
        toolApprovalResult = { id: targetId, approved: approved === true, device: String(device), at: Date.now() };
      } else if (extra?.timedOut === true) {
        toolApprovalResult = { id: targetId, approved: false, device: '', expired: true, at: Date.now() };
      }
      set({ toolApproval: null, toolApprovalResult });
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
    return false;
  }
  /** Deny this session's own requests. A copy of a sub-agent's request stays
   *  (that agent still waits) until this runtime closes, which drops it
   *  unanswered: the next runtime of this session adopts it again. */
  function denyAllToolApprovals(reason = 'approval cancelled') {
    const closing = getDisposed();
    if (closing) unregister();
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
      const full = normalizeToolApprovalRequest(input, id);
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
      if (handoffs) {
        const own = ownSessionId();
        const agentId = agentIdOfHomeSession(own) || roomMemberOfSession(own)?.agentId || '';
        // Each chat handing this session work names it its own way.
        delegateToHandoffs({
          id,
          sessionId: own,
          request: full,
          answer,
          copyFor: (chat, { title }) => ({
            ...full,
            sessionId: full.sessionId || own,
            chain: [],
            surfaceSessionId: chat,
            handoff: { title, ...(agentId ? { agentId } : {}) },
          }),
        });
      }
    });
  }
  /** `{ sessionId, chain }` of the top-level chat a sub-agent's request also
   *  shows in, or null (no delegation, another kind, or this is the top). */
  function delegationSurface(request) {
    if (typeof surfaceOf !== 'function' || !DELEGATED_KINDS.has(request.kind)) return null;
    const own = String(request.sessionId || ownSessionId());
    let surface = null;
    try {
      surface = surfaceOf(own);
    } catch {
      return null;
    }
    const sessionId = String(surface?.sessionId || '');
    if (!sessionId || sessionId === own || sessionId === ownSessionId()) return null;
    return { sessionId, chain: Array.isArray(surface.chain) ? surface.chain.map(String) : [] };
  }
  /** Whether a request this (top-level) session itself makes also shows in
   *  the chats handing it work (delegated-approval-host.mjs), while it waits. */
  function handsOff(request) {
    if (typeof surfaceOf !== 'function' || !DELEGATED_KINDS.has(request.kind)) return false;
    const own = ownSessionId();
    return Boolean(own) && String(request.sessionId || own) === own;
  }

  return {
    presentNextToolApproval,
    finishToolApproval,
    denyAllToolApprovals,
    requestToolApproval,
    adoptDelegatedApprovals,
  };
}
