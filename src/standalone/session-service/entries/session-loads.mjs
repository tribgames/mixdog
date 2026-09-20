// Session-addressed loads. Views are RENDERERS: a desktop pane (or a TUI tab)
// must be able to hand the service a prompt for any session it can see,
// without owning a runtime for it first. The daemon loads an existing durable
// session when it has no live owner, so opening a cold view does not prevent
// addressed execution. One load per session at a time — concurrent panes
// converge on one runtime.

export function createSessionLoads({
  sessionExists,
  log,
  assertAvailable,
  createEntry,
  destroy,
  bindExternalSessionView,
  advance,
  sessionOwner,
  adoptPendingViewers,
  retainUnwatched,
}) {
  const sessionLoads = new Map(); // sessionId -> Promise<entry>

  function getOrCreateSessionEntry(sessionId, create) {
    const owner = sessionOwner(sessionId);
    if (owner) return Promise.resolve(owner);
    const inFlight = sessionLoads.get(sessionId);
    if (inFlight) return inFlight;
    const loading = Promise.resolve()
      .then(create)
      .finally(() => {
        if (sessionLoads.get(sessionId) === loading) sessionLoads.delete(sessionId);
      });
    sessionLoads.set(sessionId, loading);
    return loading;
  }

  async function loadSessionRuntime(sessionId, hints) {
    const entry = await createEntry({
      sessionId,
      cwd: hints.cwd,
      provider: hints.provider,
      model: hints.model,
      toolMode: hints.toolMode,
      desktopSession: hints.desktopSession ?? null,
    });
    // Nothing is watching this runtime yet: it is the daemon's own load, so the
    // idle sweep must be able to reclaim it if no view ever attaches.
    entry.headless = true;
    let resumed = false;
    try {
      resumed = (await entry.runtime.resume?.(sessionId, hints.resumeOptions || undefined)) === true;
      assertAvailable(entry);
    } catch (err) {
      await destroy(entry, 'session load failed');
      throw err;
    }
    const state = entry.runtime.getState?.() || {};
    const loaded = String(state.sessionId || '');
    // Fork-on-resume names its origin; any other id is a failed load.
    const forkedFrom = String(state.sessionForkedFrom || '');
    if (!resumed || (loaded !== sessionId && forkedFrom !== sessionId)) {
      await destroy(entry, 'session load mismatch');
      throw new Error(`session ${sessionId} could not be resumed`);
    }
    // Publish/index the resumed identity before sessionLoads releases its
    // single-flight promise. A second pane arriving in the next microtask must
    // find this owner in O(1), not create a duplicate runtime.
    advance(entry);
    adoptPendingViewers(entry, sessionId);
    retainUnwatched(entry, 'headless session load');
    log(`session ${sessionId} loaded on demand`);
    return entry;
  }

  /** The runtime hosting sessionId: the existing owner, or a fresh load. */
  async function entryForSession(sessionId, hints = {}) {
    assertAvailable();
    const owner = sessionOwner(sessionId);
    if (owner) return owner;
    const external = await bindExternalSessionView(sessionId);
    const acquiredOwner = sessionOwner(sessionId);
    if (acquiredOwner) return acquiredOwner;
    if (external?.runtime?.externalAction === true) return external;
    return getOrCreateSessionEntry(sessionId, async () => {
      if (typeof sessionExists === 'function' && (await sessionExists(sessionId)) !== true) {
        // A session may have been created while the durable check was in
        // flight. Reuse that owner, but never materialize an unknown address
        // merely because a stale pane subscribed to it.
        const lateOwner = sessionOwner(sessionId);
        if (lateOwner) return lateOwner;
        throw new Error(`session ${sessionId} is not available`);
      }
      return loadSessionRuntime(sessionId, hints);
    });
  }

  /** Entry that is live NOW. Views never start a load themselves, and they
   *  never wait for one either: an in-flight load (daemon-boot remote restore,
   *  a competing submit) can take runtime-boot time, and awaiting it blanked
   *  the pane for exactly that session while every other session rendered
   *  instantly from its disk projection (user report). The caller falls
   *  through to the projection path, which registers a pending viewer /
   *  re-checks the owner, so the completed load still adopts the view and
   *  promotes it to live frames. */
  function liveEntryForView(sessionId) {
    return sessionOwner(sessionId) || null;
  }

  return { getOrCreateSessionEntry, loadSessionRuntime, entryForSession, liveEntryForView };
}
