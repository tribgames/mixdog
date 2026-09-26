/**
 * session-calls.mjs — the durable session protocol served over the transport.
 *
 * A connection is only a subscription. Session execution is accepted,
 * queued, and owned by the daemon; unsubscribe/client death never calls abort
 * or dispose. The client addresses a durable session id instead of a
 * client-owned runtime handle. Every handler resolves the entry for an id
 * (live owner, external view or on-demand load), applies one runtime call,
 * advances/publishes the projection and returns the caller's body. The
 * handlers live in session-calls/ by lane: the generic action lane
 * (session-action), the subscription side (session-views) and execution
 * (session-turns); this file composes them over one shared context.
 */
import { createSessionActionCalls } from './session-calls/session-action.mjs';
import { createSessionTurnCalls } from './session-calls/session-turns.mjs';
import { createSessionViewCalls } from './session-calls/session-views.mjs';

/**
 * @param {object} deps
 * @param {() => boolean} deps.isClosed
 * @param {(sessionId: string) => boolean} deps.hasAgentSession  late-bound (agent tree)
 */
export function createSessionCalls(deps) {
  const { advance, currentSessionId, publishStep, bodyForClient } = deps.projection;

  /** `prepend`: the caller announced transcriptPrepend (see frameBody). */
  function sessionResult(entry, step, baseRevision = null, extra = {}, { prepend = false } = {}) {
    return {
      sessionId: currentSessionId(entry),
      reservedOnly: entry.reservedOnly === true,
      ...extra,
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null, prepend),
    };
  }

  /** Advance for a caller-only reply (read/subscribe/create) AND deliver the
   *  same step to the views already attached. `advance` moves the entry's
   *  published baseline, so a step consumed only by the caller left every
   *  subscriber one revision behind; when it was the turn's LAST change
   *  (busy→false), the next publish saw "unchanged" and the pane kept its
   *  spinner and stop button until it re-subscribed (user: 턴 끝났는데
   *  턴중단이 안되는 버그, 나갔다 들어오니 끝나있긴 하네). */
  function advanceForCaller(entry) {
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
    return step;
  }

  const ctx = { ...deps, sessionResult, advanceForCaller };
  const actions = createSessionActionCalls(ctx);
  const views = createSessionViewCalls({ ...ctx, runSessionAction: actions.runSessionAction });
  const turns = createSessionTurnCalls(ctx);

  return {
    listSessionCatalog: actions.listSessionCatalog,
    configureSession: actions.configureSession,
    ...views,
    ...turns,
  };
}
