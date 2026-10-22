// Agent tool → session runtime channel for managed-worktree operations. The
// `git` tool (a builtin with no workspace authority of its own) reaches the
// runtime that hosts the calling Lead session through the host that runtime
// registers here; a caller no host claims (a delegated worker, a bare tool
// run) is no Lead and gets no worktree authority.
//
// Dependency-free, and shared through a global symbol like the sidebar host,
// so every bundle copy of this module sees one registry.

const HOSTS_KEY = Symbol.for('mixdog.worktreeToolHosts.v1');

function hosts() {
  globalThis[HOSTS_KEY] ??= [];
  return globalThis[HOSTS_KEY];
}

/**
 * Register a runtime's host: `sessionId()` is the Lead session it hosts now
 * (null before one exists); `run(request, context)` performs one operation
 * (session-runtime/workspace/worktree-tool.mjs).
 * @param {{ sessionId: () => string|null, run: (request: object, context: object) => Promise<object> }} host
 * @returns {() => void} Unregister.
 */
export function registerWorktreeToolHost(host) {
  const entry = { sessionId: host.sessionId, run: host.run };
  hosts().push(entry);
  return () => {
    const list = hosts();
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

/** The host of Lead session `sessionId` (the most recently registered), or null. */
export function worktreeToolHost(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  return hosts().findLast((entry) => entry.sessionId() === id) ?? null;
}
