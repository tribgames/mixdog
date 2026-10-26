/**
 * src/tui/session/tool-approval-delegation.mjs — where else a tool-approval
 * request shows: the top-level chat above a sub-agent (`delegationSurface`) or
 * the chats handing this session work (`handsOff`, `offerToHandoffs`;
 * runtime/shared/delegated-approval-host.mjs).
 */
import { agentIdOfHomeSession } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../runtime/agent/orchestrator/session/agent-room.mjs';
import { delegateToHandoffs } from '../../runtime/shared/delegated-approval-host.mjs';

/** Requests a sub-agent (or a session a chat handed work to) shows in the
 *  conversation the user watches too. A secret and a takeover go there as
 *  well: the value goes to this PC by its request id and the sign-in window
 *  is bound to the asking session, wherever the card is answered. A question
 *  stays in its own session (its answer belongs to that conversation). */
const DELEGATED_KINDS = new Set(['', 'approval', 'outbound', 'permission', 'secret', 'takeover']);

export function createApprovalDelegation({ surfaceOf, ownSessionId }) {
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
  function offerToHandoffs(id, request, answer) {
    const own = ownSessionId();
    const agentId = agentIdOfHomeSession(own) || roomMemberOfSession(own)?.agentId || '';
    // Each chat handing this session work names it its own way.
    delegateToHandoffs({
      id,
      sessionId: own,
      request,
      answer,
      copyFor: (chat, { title }) => ({
        ...request,
        sessionId: request.sessionId || own,
        chain: [],
        surfaceSessionId: chat,
        handoff: { title, ...(agentId ? { agentId } : {}) },
      }),
    });
  }
  return { delegationSurface, handsOff, offerToHandoffs };
}
