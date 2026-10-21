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
import {
  delegateApproval,
  delegatedApprovalsFor,
  registerApprovalQueue,
  withdrawDelegatedApproval,
} from '../../runtime/shared/delegated-approval-host.mjs';

/** Approvals a sub-agent shows in the top-level chat too; a question, a secret
 *  or a takeover stays in its own session (its answer or window is there). */
const DELEGATED_KINDS = new Set(['', 'approval', 'outbound', 'permission']);

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
    const requestTimeoutMs =
      input?.timeoutMs === null
        ? null
        : Number.isFinite(Number(input?.timeoutMs)) && Number(input.timeoutMs) > 0
          ? Number(input.timeoutMs)
          : defaultTimeoutMs;
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
  function settleToolApproval(entry, approved, reason, answers, reply, extra, device = '', forwarded = false) {
    if (entry?.timer) clearTimeout(entry.timer);
    const result = { approved, reason };
    if (answers !== undefined) result.answers = answers;
    if (reply !== undefined) result.reply = reply;
    // A human-kind request answers with its canonical response (never a value),
    // judged against what the answering place offered: this queue's own view,
    // or — answered on its copy — the full request the copy already narrowed.
    const answered = forwarded ? entry?.full || entry?.request : entry?.request;
    if (answered?.remember) {
      Object.assign(result, normalizeHumanResponse(answered, approved, extra));
      if (device) result.device = device;
    }
    if (extra?.timedOut === true) result.timedOut = true;
    // Settled here: its copy in the top-level chat goes away.
    if (entry?.delegated) withdrawDelegatedApproval(entry.id, { approved, device });
    try {
      entry.resolve(result);
    } catch {}
  }
  /** Hand a copy's answer to the queue that owns the request; false when the
   *  owner had already settled it. */
  function forwardToOwner(entry, approved, reason, device, answers, reply, extra) {
    try {
      return entry.mirror.answer(approved, reason, device, answers, reply, onlyOffered(entry.request, extra)) === true;
    } catch {
      return false;
    }
  }
  /** `request` as this session shows it: a remembering scope is offered only
   *  in the one session the request names for it (`rememberAt`, the bot's own
   *  chat); everywhere else — and when it names none — it asks once. */
  function viewFor(request) {
    if (!Array.isArray(request?.remember) || request.remember.length <= 1) return request;
    const here = ownSessionId();
    return here && request.rememberAt === here ? request : { ...request, remember: ['once'] };
  }
  /** `extra` without a remember scope `view` did not offer. */
  function onlyOffered(view, extra) {
    if (!extra || extra.remember === undefined) return extra;
    return (view?.remember || ['once']).includes(extra.remember) ? extra : { ...extra, remember: 'once' };
  }
  function offerDelegatedApproval(delegated) {
    if (getDisposed() || delegated.sessionId !== ownSessionId()) return;
    if (activeToolApproval?.id === delegated.id || toolApprovalQueue.some((entry) => entry.id === delegated.id)) return;
    toolApprovalQueue.push({ id: delegated.id, request: viewFor(delegated.request), mirror: delegated, timer: null });
    presentNextToolApproval();
  }
  function withdrawDelegatedCopy(id, result) {
    if (activeToolApproval?.mirror && activeToolApproval.id === id) {
      activeToolApproval = null;
      const device = String(result?.device || '');
      set({
        toolApproval: null,
        toolApprovalResult: device ? { id, approved: result.approved === true, device, at: Date.now() } : null,
      });
      presentNextToolApproval();
      return;
    }
    const index = toolApprovalQueue.findIndex((entry) => entry.mirror && entry.id === id);
    if (index >= 0) toolApprovalQueue.splice(index, 1);
  }
  /** Show the delegated approvals waiting for this session (it loaded, or its
   *  session id became the top-level one after the request was made). */
  function adoptDelegatedApprovals() {
    const sessionId = ownSessionId();
    if (!sessionId || typeof surfaceOf !== 'function') return;
    for (const delegated of delegatedApprovalsFor(sessionId)) offerDelegatedApproval(delegated);
  }
  function presentNextToolApproval() {
    if (activeToolApproval || getDisposed()) return;
    const entry = toolApprovalQueue.shift();
    if (!entry) {
      if (getState().toolApproval) set({ toolApproval: null });
      return;
    }
    activeToolApproval = entry;
    armToolApprovalTimeout(entry);
    set({ toolApproval: entry.request });
  }
  function finishToolApproval(
    id,
    approved,
    reason = '',
    device = '',
    answers = undefined,
    reply = undefined,
    extra = undefined,
    { forwarded = false } = {}
  ) {
    const targetId = String(id || '');
    if (activeToolApproval && activeToolApproval.id === targetId) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      // Only an answer from a known device is attributed; a timeout or an
      // interrupt names nobody.
      const toolApprovalResult = device
        ? { id: targetId, approved: approved === true, device: String(device), at: Date.now() }
        : null;
      set({ toolApproval: null, toolApprovalResult });
      let accepted = true;
      if (entry.mirror) {
        accepted = forwardToOwner(entry, approved, reason, device, answers, reply, extra);
      } else {
        settleToolApproval(
          entry,
          approved === true,
          String(reason || ''),
          answers,
          reply,
          extra,
          String(device || ''),
          forwarded
        );
      }
      presentNextToolApproval();
      return accepted;
    }
    const index = toolApprovalQueue.findIndex((entry) => entry.id === targetId);
    if (index >= 0) {
      const [entry] = toolApprovalQueue.splice(index, 1);
      if (entry.mirror) return forwardToOwner(entry, approved, reason, device, answers, reply, extra);
      settleToolApproval(
        entry,
        approved === true,
        String(reason || ''),
        answers,
        reply,
        extra,
        String(device || ''),
        forwarded
      );
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
      if (!entry.mirror) settleToolApproval(entry, false, reason);
    }
    const kept = [];
    while (toolApprovalQueue.length > 0) {
      const entry = toolApprovalQueue.shift();
      if (!entry.mirror) settleToolApproval(entry, false, reason);
      else if (!closing) kept.push(entry);
    }
    toolApprovalQueue.push(...kept);
    if (activeToolApproval) return;
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
      // `request` is what this session shows (and accepts answers against);
      // `full` what the copy in the top-level chat is made from.
      const entry = { id, request: viewFor(full), full, resolve, timer: null, delegated: Boolean(surface) };
      toolApprovalQueue.push(entry);
      armToolApprovalTimeout(entry);
      presentNextToolApproval();
      if (surface) {
        delegateApproval({
          id,
          sessionId: surface.sessionId,
          request: full,
          answer: (approved, reason, device, answers, reply, extra) =>
            finishToolApproval(id, approved, reason, device, answers, reply, extra, { forwarded: true }),
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

  return {
    presentNextToolApproval,
    finishToolApproval,
    denyAllToolApprovals,
    requestToolApproval,
    adoptDelegatedApprovals,
  };
}
