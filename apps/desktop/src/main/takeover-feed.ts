/**
 * The takeover feed of the core (protocol connection events), as the state updates the window process already acts on
 * (takeover-state.ts). The core owns a takeover card as a server request: `serverRequest` with `kind: 'takeover'`
 * starts it for the session (`threadId`) that asked, and `serverRequest/resolved` ends it however it was settled -
 * answered, withdrawn or timed out. The 15-minute expiry is the card's own deadline in the core (`expiresAt`), which
 * resolves it `timedOut`; that resolution is what ends the takeover page here, so nothing in this process times a
 * takeover out for the core.
 */
import type { ConnectionClientEvent } from './protocol/connection';
import type { TakeoverStateUpdate } from './takeover-state';

export function createTakeoverFeed(deliver: (update: TakeoverStateUpdate) => void): (event: ConnectionClientEvent) => void {
  /** requestId -> the session that asked. */
  const open = new Map<string, string>();
  /** session -> its current takeover request: a replaced one's late resolution must not end the new one. */
  const current = new Map<string, string>();
  return (event) => {
    if (event.type === 'serverRequest') {
      const request = (event as { request: { id: string | number; params: unknown } }).request;
      const params = (request.params ?? {}) as Record<string, unknown>;
      if (params.kind !== 'takeover') return;
      const sessionId = String(params.threadId ?? '');
      if (!sessionId) return;
      const id = String(request.id);
      open.set(id, sessionId);
      current.set(sessionId, id);
      const takeover = params.takeover && typeof params.takeover === 'object' ? (params.takeover as Record<string, unknown>) : null;
      deliver({ sessionId, snapshot: { toolApproval: { id, kind: 'takeover', takeover } } });
    } else if (event.type === 'serverRequestResolved') {
      const params = ((event as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
      const id = String(params.requestId ?? '');
      const sessionId = open.get(id);
      if (sessionId === undefined) return;
      open.delete(id);
      if (current.get(sessionId) !== id) return;
      current.delete(sessionId);
      deliver({ sessionId, snapshot: { toolApproval: null } });
    }
  };
}