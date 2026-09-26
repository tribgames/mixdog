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

import { requestLiveTranscriptWindow } from './projection/transcript-window.mjs';

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
  forgetStoredSession,
  releaseProjection = () => {},
}) {
  // Client tokens whose reads/subscriptions announced `transcriptPrepend`:
  // their frames may carry an older-history page as `patch.itemsPrepend`.
  const prependViewers = new Set();
  // sessionId -> (token -> transcript window it subscribed with, null for a
  // legacy whole-transcript view). A cold view's window must survive the
  // session going live: an entry adopted without one published the runtime's
  // WHOLE transcript to a 32-item / 1 MB tail view (9-20 MB first frames).
  const pendingWindows = new Map();

  function subscriberToken(ctx) {
    return ctx?.clientToken ? String(ctx.clientToken) : '';
  }

  function notePrependViewer(ctx, params) {
    const token = subscriberToken(ctx);
    if (token && params?.transcriptPrepend === true) prependViewers.add(token);
  }

  const prependViewer = (token) => prependViewers.has(String(token || ''));

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

  function forgetPendingWindow(sessionId, token) {
    const windows = pendingWindows.get(sessionId);
    if (!windows) return;
    windows.delete(token);
    if (windows.size === 0) pendingWindows.delete(sessionId);
  }

  /** `window`: the transcript window this cold view subscribed with
   *  (requestedTranscriptWindow; null for a legacy whole-transcript view). */
  function trackPendingViewer(sessionId, ctx, window = null) {
    const token = subscriberToken(ctx);
    if (!token) return;
    let tokens = pendingViewers.get(sessionId);
    if (!tokens) {
      tokens = new Set();
      pendingViewers.set(sessionId, tokens);
    }
    tokens.add(token);
    let windows = pendingWindows.get(sessionId);
    if (!windows) {
      windows = new Map();
      pendingWindows.set(sessionId, windows);
    }
    windows.set(token, window);
  }

  /** Returns whether any cold viewer of this session remains. */
  function dropPendingViewer(sessionId, ctx) {
    const token = subscriberToken(ctx);
    const tokens = pendingViewers.get(sessionId);
    if (!token || !tokens) return Boolean(tokens);
    tokens.delete(token);
    forgetPendingWindow(sessionId, token);
    if (tokens.size === 0) pendingViewers.delete(sessionId);
    return tokens.size > 0;
  }

  /** The entry now hosting `sessionId` takes over its cold viewers, each
   *  with the transcript window it subscribed with. */
  function adoptPendingViewers(entry, sessionId) {
    const id = String(sessionId || '');
    const tokens = pendingViewers.get(id);
    const windows = pendingWindows.get(id);
    pendingWindows.delete(id);
    if (!tokens) return;
    pendingViewers.delete(id);
    for (const token of tokens) {
      addSubscriber(entry, { clientToken: token });
      if (windows?.has(token)) requestLiveTranscriptWindow(entry, windows.get(token));
    }
  }

  /** A client that deregistered (or whose process died) stops being a viewer.
   *  Its session runtimes are never destroyed here: work outlives the client
   *  that walked away, so a runtime nobody watches goes back on the idle clock. */
  function releaseClient(clientToken) {
    const token = String(clientToken || '');
    if (!token) return { ok: true };
    prependViewers.delete(token);
    for (const [pendingId, tokens] of [...pendingViewers]) {
      forgetPendingWindow(pendingId, token);
      if (tokens.delete(token) && tokens.size === 0) {
        pendingViewers.delete(pendingId);
        // The last cold view left: its disk projection is no longer needed.
        forgetStoredSession(pendingId);
      }
    }
    for (const entry of sessions) {
      if (!entry.subscribers?.delete(token)) continue;
      if (entry.subscribers.size > 0) continue;
      entry.transcriptView = null;
      if (entry.reservedOnly && !sessionBusy(entry)) {
        void destroy(entry, 'unclaimed session reservation', {
          keepBackgroundWork: true,
        });
        continue;
      }
      entry.retainedAt = Date.now();
      // Same as the last unsubscribe: nobody reads the wire projection of an
      // unwatched session, and a client that vanished never sends one. It
      // stayed pinned (~1 MB per open session) until the runtime's eviction.
      releaseProjection(entry);
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

  return {
    subscriberToken,
    addSubscriber,
    trackPendingViewer,
    dropPendingViewer,
    adoptPendingViewers,
    releaseClient,
    notePrependViewer,
    prependViewer,
  };
}
