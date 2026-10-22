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

// A bot's saved model route: the hosts of its chats (the session service)
// move them onto it from their next turn.
const routeListeners = new Set();

export function subscribeAgentRouteChanges(listener) {
  routeListeners.add(listener);
  return { unsubscribe: () => routeListeners.delete(listener) };
}

/** Settles once every host has taken the route; one failing host never fails the save. */
export async function publishAgentRouteChange(agentId, route) {
  await Promise.allSettled(
    [...routeListeners].map((listener) => Promise.resolve().then(() => listener(agentId, route)))
  );
}

/** Settles once every runtime has applied the edit; one failing runtime never fails the save. */
export async function publishAgentProfileChange() {
  invalidateRoleInstructionsCache();
  await Promise.allSettled([...listeners].map((listener) => Promise.resolve().then(() => listener())));
}
