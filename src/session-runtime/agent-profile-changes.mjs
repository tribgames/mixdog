// In-process fan-out of bot changes that reach prompts: a profile edit
// (PERSONA.md, AGENT.md, name) and a bot created, archived or restored (the
// roster Lead prompts list). The daemon hosts every session runtime in one
// process; the change tells each of them, the saving one included, and a
// runtime whose thread embeds what changed rebuilds its prompt for the next
// turn (tool-policy-refresh.mjs refreshAgentProfile). A thread no runtime
// holds catches up when reopened.
import { invalidateRoleInstructionsCache } from '../runtime/agent/orchestrator/context/role-instructions.mjs';

const listeners = new Set();

export function subscribeAgentProfileChanges(listener) {
  listeners.add(listener);
  return { unsubscribe: () => listeners.delete(listener) };
}

/** The keys of a saved agent route its chats and reused workers follow. */
export const AGENT_ROUTE_KEYS = Object.freeze([
  'provider',
  'model',
  'effort',
  'fast',
  'autoEffort',
  'modelParameters',
  'contextPercent',
  'contextTokens',
]);

// A bot's saved model route: the hosts of its chats (the session service)
// move them onto it from their next turn.
const routeListeners = new Set();

export function subscribeAgentRouteChanges(listener) {
  routeListeners.add(listener);
  return { unsubscribe: () => routeListeners.delete(listener) };
}

// Per bot, the route every host of this process took last (recorded only once
// all of them took it), and the publication in flight.
const publishedRoutes = new Map();
const publishingRoutes = new Map();

/** Every host takes the route; rejects with the hosts' failures. A
 *  publication of the same route already in flight is joined, not repeated. */
function deliverAgentRoute(agentId, route) {
  const key = JSON.stringify(route ?? null);
  const inFlight = publishingRoutes.get(agentId);
  if (inFlight?.key === key) return inFlight.done;
  const done = Promise.allSettled(
    [...routeListeners].map((listener) => Promise.resolve().then(() => listener(agentId, route)))
  ).then((results) => {
    if (publishingRoutes.get(agentId)?.done === done) publishingRoutes.delete(agentId);
    const failures = results.filter((one) => one.status === 'rejected').map((one) => one.reason);
    if (failures.length) {
      throw new AggregateError(
        failures,
        `the ${agentId} route reached ${results.length - failures.length} of ${results.length} hosts`
      );
    }
    publishedRoutes.set(agentId, key);
  });
  publishingRoutes.set(agentId, { key, done });
  return done;
}

/** Settles once every host has taken the route; one failing host never fails
 *  the save (the change step that follows it publishes the route again). */
export async function publishAgentRouteChange(agentId, route) {
  try {
    await deliverAgentRoute(agentId, route);
  } catch {}
}

/** A bot route read from a changed config (saved by another process, edited
 *  by hand, or this process's own save): every runtime of the process applies
 *  the same change, so the hosts hear each route once, unless one failed to
 *  take it. Rejects when a host failed, so the change step retries it. */
export function publishStoredAgentRoute(agentId, route) {
  const inFlight = publishingRoutes.get(agentId);
  if (!inFlight && publishedRoutes.get(agentId) === JSON.stringify(route ?? null)) return Promise.resolve();
  return deliverAgentRoute(agentId, route);
}

/** Settles once every runtime has applied the edit; one failing runtime never fails the save. */
export async function publishAgentProfileChange() {
  invalidateRoleInstructionsCache();
  await Promise.allSettled([...listeners].map((listener) => Promise.resolve().then(() => listener())));
}
