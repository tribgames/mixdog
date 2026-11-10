// Delegated approvals: a sub-agent's approval request (tui/session/tool-approval.mjs)
// is also shown in the top-level conversation the user watches — the root bot's
// home chat, or the coding Lead's session (human-gate/gate.mjs approvalSurface).
// It stays ONE request: the sub-agent's queue owns it and its waiter; the
// top-level session's queue holds a copy whose answer is forwarded to that
// owner, and the copy is withdrawn as soon as the owner settles (answered in
// either place, timed out, its turn ended). Like held-request-host.mjs this
// registry is process-wide and dependency-free.
// Hand-offs take the same path: a session chats handed work to (`session`
// send / create from a bot conversation, agent-task-sessions.mjs) shows its
// own approvals in EVERY chat whose hand-off to it still owes its report, one
// copy per chat, all settling the one request. The report watch store
// (session-runtime/agent-home-delivery.mjs) notes and ends hand-offs as its
// watches come and go, whatever removes them; a chat
// whose last hand-off to the session ends loses its copy, the others keep
// theirs.

const KEY = Symbol.for('mixdog.delegatedApprovalHost.v1');

function registry() {
  globalThis[KEY] ??= { queues: new Set(), pending: new Map(), opener: null, handoffs: new Map(), ended: new Set() };
  return globalThis[KEY];
}

/** The chats with a live hand-off to `sessionId`, each once (in noting order)
 *  with the name its latest hand-off gave the session: Map chat → `{ title }`. */
export function handoffChatsOf(sessionId) {
  const chats = new Map();
  for (const handoff of registry().handoffs.values()) {
    if (handoff.sessionId !== sessionId) continue;
    chats.delete(handoff.surfaceSessionId);
    chats.set(handoff.surfaceSessionId, { title: handoff.title });
  }
  return chats;
}

/** Bring each pending request of `sessionId` that hand-offs reach to exactly
 *  the chats now handing it work: a new chat gets its copy, a chat whose
 *  hand-offs all ended loses only its own. */
function syncHandoffCopies(sessionId) {
  const { pending } = registry();
  const chats = handoffChatsOf(sessionId);
  for (const asked of pending.values()) {
    if (!asked.copies || asked.sessionId !== sessionId) continue;
    for (const [chat, copy] of asked.copies) {
      if (chats.has(chat)) continue;
      asked.copies.delete(chat);
      for (const queue of liveQueuesOf(chat)) queue.withdraw(copy.id, null);
    }
    for (const [chat, handoff] of chats) {
      if (asked.copies.has(chat)) continue;
      const copy = { id: asked.id, sessionId: chat, request: asked.copyFor(chat, handoff), answer: asked.answer };
      asked.copies.set(chat, copy);
      deliver(copy, () => pending.get(asked.id) === asked && asked.copies.get(chat) === copy);
    }
  }
}

// Run ids of hand-offs that ended: never noted again (a watch read before it
// was removed must not bring it back, however many hand-offs ended since).
// Run ids are never reused, so an ended id is final for the life of the
// process and there is nothing to age out: no count decides what is
// forgotten. One id string is kept per ended hand-off.

/** Chat `homeSessionId` handed session `taskSessionId` work (`title`: the
 *  target's name in that chat) under report watch `runId`. */
export function noteHandoff({ runId, taskSessionId, homeSessionId, title }) {
  if (!runId || !taskSessionId || !homeSessionId || taskSessionId === homeSessionId) return;
  if (registry().ended.has(String(runId))) return;
  registry().handoffs.set(String(runId), {
    sessionId: String(taskSessionId),
    surfaceSessionId: String(homeSessionId),
    title: String(title || ''),
  });
  syncHandoffCopies(String(taskSessionId));
}

/** The report watch `runId` is gone (its work reported back, was never
 *  taken, or the watch was retired): its hand-off ends for good. */
export function endHandoff(runId) {
  const { handoffs, ended } = registry();
  ended.add(String(runId));
  const handoff = handoffs.get(String(runId));
  if (!handoff) return;
  handoffs.delete(String(runId));
  syncHandoffCopies(handoff.sessionId);
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

/** Offer `copy` in its chat now, or once that chat loads while `current()`
 *  still holds. */
function deliver(copy, current) {
  const { opener } = registry();
  if (offerTo(copy.sessionId, copy) || typeof opener !== 'function') return;
  void Promise.resolve()
    .then(() => opener(copy.sessionId))
    .then(() => {
      if (current()) offerTo(copy.sessionId, copy);
    })
    .catch(() => {});
}

/** Show `delegated` (`{ id, sessionId, request, answer(...finishArgs) → boolean }`,
 *  `sessionId` being the top-level conversation) there, now or once it loads. */
export function delegateApproval(delegated) {
  const { pending } = registry();
  pending.set(delegated.id, delegated);
  deliver(delegated, () => pending.get(delegated.id) === delegated);
}

/** A top-level session's request (`{ id, sessionId, request, answer }`,
 *  `sessionId` being the asking session) that every chat handing it work
 *  shows too, now and while it waits: `copyFor(chat, { title })` is the
 *  request as that chat shows it. */
export function delegateToHandoffs(asked) {
  registry().pending.set(asked.id, { ...asked, copies: new Map() });
  syncHandoffCopies(asked.sessionId);
}

/** The owner settled `id`: every copy goes away. `result` (`{ approved, device }`)
 *  lets the copy say who answered. */
export function withdrawDelegatedApproval(id, result = null) {
  const { pending, queues } = registry();
  if (!pending.delete(id)) return;
  for (const queue of queues) queue.withdraw(id, result);
}

/** The pending delegated approvals (and hand-off copies) a top-level session
 *  should show. */
export function delegatedApprovalsFor(sessionId) {
  return [...registry().pending.values()].flatMap((delegated) => {
    if (delegated.copies) return delegated.copies.has(sessionId) ? [delegated.copies.get(sessionId)] : [];
    return delegated.sessionId === sessionId ? [delegated] : [];
  });
}
