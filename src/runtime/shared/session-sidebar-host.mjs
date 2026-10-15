// Runtime → desktop request channel for a session's sidebar metadata
// (favorite, archive). That metadata belongs to the desktop
// service hosted in this daemon: it registers a host here, and the Lead's
// `session` tool applies a change through it, so the sidebar republishes live.
//
// Deliberately dependency-free: the desktop service bundle imports this file
// too, and both copies share one registry through a global symbol.

const HOSTS_KEY = Symbol.for('mixdog.sessionSidebarHosts.v1');

function hosts() {
  globalThis[HOSTS_KEY] ??= [];
  return globalThis[HOSTS_KEY];
}

/**
 * Register a desktop host. `host(sessionId, change)` applies one change:
 * `{ favorite: boolean }` or `{ archived: boolean }`.
 * @returns {() => void} Unregister.
 */
export function registerSessionSidebarHost(host) {
  const entry = { host };
  hosts().push(entry);
  return () => {
    const list = hosts();
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

/** Apply one change through exactly one host: the most recently registered
 *  (active) desktop service. Never broadcast — each service writes the shared
 *  metadata file, so a second write would be redundant at best. */
export async function applySessionSidebarChange(sessionId, change) {
  const active = hosts().at(-1);
  if (!active) throw new Error('no desktop app is attached to this runtime');
  await active.host(sessionId, change);
}
