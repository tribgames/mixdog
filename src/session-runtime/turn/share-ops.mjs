/**
 * src/session-runtime/turn/share-ops.mjs - cross-surface session sharing on
 * the owner side: pending-spool intake, presence beacon, and the viewer's
 * owner-liveness probe.
 */
export function createShareOps({ getSession, getActiveTurnCount, mgr }) {
  // Owner-side injection intake: foreign user messages persisted into the
  // shared spool by an attached surface. Engine pollers call this while
  // idle and run each returned text through the normal submit queue.
  async function takeRemoteInjections() {
    const session = getSession();
    if (!session?.id || session.remoteAttached) return [];
    if (getActiveTurnCount() > 0) return [];
    try {
      return (await mgr.drainForeignUserInjections?.(session.id)) || [];
    } catch {
      return [];
    }
  }

  // Absolute path of the shared pending spool file. Live-share owners
  // fs.watch it for instant cross-surface input pickup; empty string when
  // the store is unavailable (callers fall back to the poll tick).
  function pendingSpoolPath() {
    try {
      return mgr.pendingMessagesSpoolPath?.() || '';
    } catch {
      return '';
    }
  }

  // Interactive-presence beacon (engine share tick): mark the CURRENT
  // session as held open by this live surface — idle time included — so a
  // cross-open from another surface attaches as a viewer instead of
  // splitting ownership into two writers. No-op while THIS surface is the
  // viewer. Returns the held id so the caller can clear a previous
  // session's beacon after a switch.
  function publishSessionPresence() {
    const session = getSession();
    if (!session?.id || session.remoteAttached) return null;
    try {
      mgr.publishSessionPresence?.(session.id);
    } catch {
      /* best-effort */
    }
    return session.id;
  }

  function clearSessionPresence(id) {
    const target = id || getSession()?.id;
    if (!target) return;
    try {
      mgr.deleteSessionPresence?.(target);
    } catch {
      /* best-effort */
    }
  }

  // Live-owner liveness probe for the viewer self-heal tick: true when a
  // re-resume would no longer attach (owner pid dead or every liveness
  // signal stale) — i.e. nobody is draining this session's spool anymore.
  function sessionOwnerGone(id) {
    const target = id || getSession()?.id;
    if (!target) return false;
    try {
      return mgr.isSessionOwnerGone?.(target) === true;
    } catch {
      return false;
    }
  }

  return { takeRemoteInjections, pendingSpoolPath, publishSessionPresence, clearSessionPresence, sessionOwnerGone };
}
