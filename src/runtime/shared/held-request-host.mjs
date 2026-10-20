// Runtime ↔ desktop-service channel for held requests of unattended runs
// (session-runtime/held-requests.mjs). The daemon's held-request registry
// registers the resolver; the desktop service hosted in this daemon registers
// a notifier that sends the sanitized phone push. The session API answers a
// held request through resolveHeldRequest, whatever session it was sent from.
//
// Deliberately dependency-free: the desktop service bundle imports this file
// too, and both copies share one registry through a global symbol.

const KEY = Symbol.for('mixdog.heldRequestHost.v1');

function registry() {
  globalThis[KEY] ??= { resolver: null, notifiers: [], runOwners: new Map() };
  return globalThis[KEY];
}

const RUN_OWNER_LIMIT = 500;
/** Remember which agent an unattended run session belongs to, so its pushes
 *  follow that agent's notification mute after the run ends (bounded, newest kept). */
export function recordRunOwner(sessionId, agentId) {
  const owners = registry().runOwners;
  owners.delete(sessionId);
  owners.set(String(sessionId), String(agentId));
  while (owners.size > RUN_OWNER_LIMIT) owners.delete(owners.keys().next().value);
}

export function runOwnerOf(sessionId) {
  return registry().runOwners.get(String(sessionId || '')) || '';
}

/** `resolver(id, decision) → boolean` (true when `id` was a pending held request). */
export function registerHeldRequestResolver(resolver) {
  registry().resolver = resolver;
  return () => {
    if (registry().resolver === resolver) registry().resolver = null;
  };
}

export function resolveHeldRequest(id, decision) {
  const { resolver } = registry();
  return typeof resolver === 'function' && String(id || '').startsWith('held_')
    ? resolver(id, decision) === true
    : false;
}

/** `notifier({ sessionId, agentId, agentName, requestId })`: one per desktop service. */
export function registerHeldRequestNotifier(notifier) {
  const entry = { notifier };
  registry().notifiers.push(entry);
  return () => {
    const list = registry().notifiers;
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

/** Hand one held request to every registered notifier. Carries ids and the
 *  agent's name only: never the tool, its arguments or any text. */
export function notifyHeldRequest({ sessionId, agentId, agentName, requestId }) {
  const event = {
    sessionId: String(sessionId || ''),
    agentId: String(agentId || ''),
    agentName: String(agentName || ''),
    requestId: String(requestId || ''),
  };
  for (const { notifier } of registry().notifiers) {
    try {
      notifier(event);
    } catch {}
  }
}
