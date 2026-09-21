/**
 * viewers.mjs — cross-client subscriptions of the session pool.
 *
 * A session runtime is shared by construction (terminal + desktop converge
 * on one runtime per session), but each client process only refcounts the
 * mirrors it holds ITSELF. Without a daemon-side viewer set, the first client
 * to quit destroyed a runtime the other one was still streaming — the turn
 * cut out mid-answer and the surviving view stalled. Viewers are keyed by
 * daemon CLIENT token, so "the last view left" is a machine-wide fact.
 *
 * Stored-session views: a stored session that is merely VISIBLE is served
 * from disk; only execution materializes a runtime. A client that subscribed
 * while the session was cold is remembered in pendingViewers and adopted by
 * the entry the moment one materializes, so its live frames start flowing
 * without a second subscribe round-trip.
 */

/**
 * @param {object} deps
 * @param {Set<object>} deps.sessions
 * @param {Map<string, Set<string>>} deps.pendingViewers  sessionId -> client tokens
 * @param {Map<string, object>} deps.externalViewEntries  sessionId -> projected entry
 * @param {(entry: object) => string} deps.currentSessionId  late-bound (projection)
 * @param {(entry: object, reason: string, options?: object) => Promise<object>} deps.destroy  late-bound (entries)
 */
export function createViewerRegistry({
  sessions,
  pendingViewers,
  externalViewEntries,
  desktopServices,
  log,
  startEvictionSweep,
  sessionBusy,
  currentSessionId,
  destroy,
}) {
  function subscriberToken(ctx) {
    return ctx?.clientToken ? String(ctx.clientToken) : '';
  }

  function addSubscriber(entry, ctx) {
    const token = subscriberToken(ctx);
    if (!entry || !token) return entry;
    entry.subscribers ??= new Set();
    entry.subscribers.add(token);
    entry.retainedAt = null;
    entry.headless = false;
    // A watched session carries a reclaimable projection, so the sweep has to
    // run even when nothing is retained/unwatched.
    startEvictionSweep();
    return entry;
  }

  function trackPendingViewer(sessionId, ctx) {
    const token = subscriberToken(ctx);
    if (!token) return;
    let tokens = pendingViewers.get(sessionId);
    if (!tokens) {
      tokens = new Set();
      pendingViewers.set(sessionId, tokens);
    }
    tokens.add(token);
  }

  function dropPendingViewer(sessionId, ctx) {
    const token = subscriberToken(ctx);
    const tokens = pendingViewers.get(sessionId);
    if (!token || !tokens) return;
    tokens.delete(token);
    if (tokens.size === 0) pendingViewers.delete(sessionId);
  }

  function adoptPendingViewers(entry, sessionId) {
    const tokens = pendingViewers.get(String(sessionId || ''));
    if (!tokens) return;
    pendingViewers.delete(String(sessionId || ''));
    for (const token of tokens) addSubscriber(entry, { clientToken: token });
  }

  /** A client that deregistered (or whose process died) stops being a viewer.
   *  Its session runtimes are never destroyed here: work outlives the client
   *  that walked away, so a runtime nobody watches goes back on the idle clock. */
  function releaseClient(clientToken) {
    const token = String(clientToken || '');
    if (!token) return { ok: true };
    for (const [pendingId, tokens] of [...pendingViewers]) {
      if (tokens.delete(token) && tokens.size === 0) pendingViewers.delete(pendingId);
    }
    for (const entry of sessions) {
      if (!entry.subscribers?.delete(token)) continue;
      if (entry.subscribers.size > 0) continue;
      if (entry.reservedOnly && !sessionBusy(entry)) {
        void destroy(entry, 'unclaimed session reservation', {
          keepBackgroundWork: true,
        });
        continue;
      }
      entry.retainedAt = Date.now();
      startEvictionSweep();
      log(`session ${currentSessionId(entry) || '(creating)'} unwatched (client ${token} gone) — retained`);
    }
    for (const [sessionId, entry] of [...externalViewEntries]) {
      entry.subscribers?.delete(token);
      if ((entry.subscribers?.size || 0) === 0) externalViewEntries.delete(sessionId);
    }
    desktopServices.releaseClient(token);
    return { ok: true };
  }

  return { subscriberToken, addSubscriber, trackPendingViewer, dropPendingViewer, adoptPendingViewers, releaseClient };
}
