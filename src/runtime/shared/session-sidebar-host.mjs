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
 * `{ favorite: boolean }`, `{ archived: boolean }` (an archive takes the
 * session's sub-agent sessions with it, a restore brings back the ones it took),
 * `{ archived: true, cascade: false }` (that session alone)
 * or `{ forgotten: true }` (a session the store deleted: its records go).
 * `state()` answers the archive flags: `{ archived }`, session id → stamp.
 * @returns {() => void} Unregister.
 */
export function registerSessionSidebarHost(host, { state = null } = {}) {
  const entry = { host, state: typeof state === 'function' ? state : null };
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

/** The active desktop's flags, `{ archived, favorites? }` (session id →
 *  epoch-ms stamp; `favorites` only from a desktop that reports them); null
 *  when no desktop (or one without a state reader) is attached. */
export async function readSessionSidebarState() {
  const active = hosts().at(-1);
  if (!active?.state) return null;
  const state = await active.state();
  return {
    archived: { ...state?.archived },
    ...(state?.favorites && typeof state.favorites === 'object' ? { favorites: { ...state.favorites } } : {}),
  };
}
