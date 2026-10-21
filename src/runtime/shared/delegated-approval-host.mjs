// Delegated approvals: a sub-agent's approval request (tui/session/tool-approval.mjs)
// is also shown in the top-level conversation the user watches — the root bot's
// home chat, or the coding Lead's session (human-gate/gate.mjs approvalSurface).
// It stays ONE request: the sub-agent's queue owns it and its waiter; the
// top-level session's queue holds a copy whose answer is forwarded to that
// owner, and the copy is withdrawn as soon as the owner settles (answered in
// either place, timed out, its turn ended). Like held-request-host.mjs this
// registry is process-wide and dependency-free.

const KEY = Symbol.for('mixdog.delegatedApprovalHost.v1');

function registry() {
  globalThis[KEY] ??= { queues: new Set(), pending: new Map(), opener: null };
  return globalThis[KEY];
}

/** `queue`: `{ sessionId() → string, disposed() → boolean, offer(delegated),
 *  withdraw(id, result) }` — one session runtime's approval queue. */
export function registerApprovalQueue(queue) {
  registry().queues.add(queue);
  return () => registry().queues.delete(queue);
}

/** `open(sessionId) → Promise`: brings a session's runtime up (the daemon's
 *  session service), so a top-level chat that is not loaded can show the copy. */
export function registerDelegatedApprovalOpener(open) {
  registry().opener = open;
  return () => {
    if (registry().opener === open) registry().opener = null;
  };
}

function liveQueuesOf(sessionId) {
  const { queues } = registry();
  const live = [];
  for (const queue of queues) {
    if (queue.disposed()) queues.delete(queue);
    else if (queue.sessionId() === sessionId) live.push(queue);
  }
  return live;
}

function offerTo(sessionId, delegated) {
  const live = liveQueuesOf(sessionId);
  for (const queue of live) queue.offer(delegated);
  return live.length > 0;
}

/** Show `delegated` (`{ id, sessionId, request, answer(...finishArgs) → boolean }`,
 *  `sessionId` being the top-level conversation) there, now or once it loads. */
export function delegateApproval(delegated) {
  const { pending, opener } = registry();
  pending.set(delegated.id, delegated);
  if (offerTo(delegated.sessionId, delegated) || typeof opener !== 'function') return;
  void Promise.resolve()
    .then(() => opener(delegated.sessionId))
    .then(() => {
      if (pending.get(delegated.id) === delegated) offerTo(delegated.sessionId, delegated);
    })
    .catch(() => {});
}

/** The owner settled `id`: every copy goes away. `result` (`{ approved, device }`)
 *  lets the copy say who answered. */
export function withdrawDelegatedApproval(id, result = null) {
  const { pending, queues } = registry();
  if (!pending.delete(id)) return;
  for (const queue of queues) queue.withdraw(id, result);
}

/** The pending delegated approvals a top-level session should show. */
export function delegatedApprovalsFor(sessionId) {
  return [...registry().pending.values()].filter((delegated) => delegated.sessionId === sessionId);
}
