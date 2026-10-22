// A bot's saved model route reaches the chats it already has: its home thread
// and its group-room member sessions, from their next turn (the session route
// API's deferred pick, the one every model picker uses: a running turn finishes
// on the model it started on). The latest saved route wins. A thread no
// runtime hosts keeps its model until it is opened (the desktop refreshes it
// then, agent-home-sessions.ts).
import { subscribeAgentRouteChanges } from '../../session-runtime/agent-profile-changes.mjs';
import { agentHomeSessionId } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../runtime/agent/orchestrator/session/agent-room.mjs';

const ROUTE_KEYS = [
  'provider',
  'model',
  'effort',
  'fast',
  'autoEffort',
  'modelParameters',
  'contextPercent',
  'contextTokens',
];

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
        // A route the runtime refuses (provider signed out) leaves the chat on its model.
        log(`agent route change not applied to ${sessionId}: ${error?.message || error}`);
      });
  }

  function enqueue(sessionId, pick) {
    const queued = (tails.get(sessionId) || Promise.resolve()).then(() => apply(sessionId, pick));
    tails.set(sessionId, queued);
    queued.then(() => {
      if (tails.get(sessionId) === queued) tails.delete(sessionId);
    });
    return queued;
  }

  // Every matching chat is queued before the first await: publications queue in order.
  function follow(agentId, route) {
    const home = agentHomeSessionId(agentId);
    if (!home || !route?.provider || !route?.model) return Promise.resolve();
    const pick = sessionRoutePick(route);
    const queued = [...sessionsById.keys()]
      .filter((sessionId) => sessionId === home || roomMemberOfSession(sessionId)?.agentId === agentId)
      .map((sessionId) => enqueue(sessionId, pick));
    return Promise.all(queued);
  }
  return subscribeAgentRouteChanges(follow);
}
