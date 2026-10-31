// A bot's saved model route reaches the chats it already has: its home thread
// and its group-room member sessions, from their next turn (the session route
// API's deferred pick, the one every model picker uses: a running turn finishes
// on the model it started on). The latest saved route wins. A thread no
// runtime hosts keeps its model until it is opened (the desktop refreshes it
// then, agent-home-sessions.ts).
import {
  AGENT_ROUTE_KEYS as ROUTE_KEYS,
  subscribeAgentRouteChanges,
} from '../../session-runtime/agent-profile-changes.mjs';
import { agentHomeSessionId } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../runtime/agent/orchestrator/session/agent-room.mjs';

/** The pick the session route API takes for a saved route. */
function sessionRoutePick(route) {
  const pick = { sessionOnly: true };
  for (const key of ROUTE_KEYS) if (route?.[key] !== undefined && route[key] !== null) pick[key] = route[key];
  return pick;
}

export function createAgentRouteFollow({ sessionsById, sessionOwner, advance, publishStep, log }) {
  // Each chat takes its updates one at a time, in the order they were
  // published: a slow chat never lets an older route land after a newer one.
  const tails = new Map(); // sessionId -> Promise of its last queued update

  function apply(sessionId, pick) {
    const entry = sessionOwner(sessionId);
    if (typeof entry?.runtime?.setRoute !== 'function') return Promise.resolve();
    return Promise.resolve()
      .then(async () => {
        await entry.runtime.setRoute(pick);
        const step = advance(entry);
        if (step.changed) publishStep(entry, step);
      })
      .catch((error) => {
        // A route the runtime refuses (provider signed out) leaves the chat on
        // its model; the publication fails, so a retrying publisher sends it again.
        log(`agent route change not applied to ${sessionId}: ${error?.message || error}`);
        throw error;
      });
  }

  function enqueue(sessionId, pick) {
    const queued = (tails.get(sessionId) || Promise.resolve()).then(() => apply(sessionId, pick));
    // A refused update never holds back the chat's later ones.
    const tail = queued.catch(() => {});
    tails.set(sessionId, tail);
    tail.then(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    return queued;
  }

  // Every matching chat is queued before the first await: publications queue
  // in order. Rejects once every chat settled when any refused the route.
  async function follow(agentId, route) {
    const home = agentHomeSessionId(agentId);
    if (!home || !route?.provider || !route?.model) return;
    const pick = sessionRoutePick(route);
    const queued = [...sessionsById.keys()]
      .filter((sessionId) => sessionId === home || roomMemberOfSession(sessionId)?.agentId === agentId)
      .map((sessionId) => enqueue(sessionId, pick));
    const failures = (await Promise.allSettled(queued)).filter((one) => one.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(
        failures.map((one) => one.reason),
        `${failures.length} chat(s) of ${agentId} did not take the route`
      );
    }
  }
  return subscribeAgentRouteChanges(follow);
}
