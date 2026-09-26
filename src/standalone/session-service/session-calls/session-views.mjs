// session-calls/session-views.mjs
// The subscription side of the protocol: creating (reserving) a session,
// reading it live or from the store, and attaching / detaching a view.
import { randomUUID } from 'node:crypto';
import { SESSION_READ_ACTION_SET } from '../../session-protocol.mjs';
import { SESSION_ID_PATTERN } from '../agent-tree.mjs';
import {
  loadLiveTranscriptHead,
  rebudgetTranscriptWindow,
  requestedHeldTranscript,
  requestedTranscriptWindow,
  requestLiveTranscriptWindow,
  transcriptPageBody,
} from '../projection/transcript-window.mjs';

export function createSessionViewCalls(ctx) {
  const { log, readStoredSession, externalViewEntries, runSessionAction, sessionResult, advanceForCaller } = ctx;
  const { currentSessionId, externalEntryForView, projectionResult, unchangedProjectionResult, sessionOwner } =
    ctx.projection;
  /** The owner a concurrent materialization may have produced while a disk
   *  read was in flight: a daemon-owned runtime outranks an external view. */
  const lateOwnerFor = (id) => sessionOwner(id) || externalEntryForView(id);
  const {
    subscriberToken,
    addSubscriber,
    trackPendingViewer,
    dropPendingViewer,
    adoptPendingViewers,
    notePrependViewer,
  } = ctx.viewers;
  const { sessionBusy, retainUnwatched, releaseProjection, startEvictionSweep } = ctx.retention;
  const {
    assertAvailable,
    createEntry,
    getOrCreateSessionEntry,
    entryForSession,
    liveEntryForView,
    bindExternalSessionView,
    destroy,
  } = ctx.entries;
  const { storedSessionProjection, storedProjectionUnchanged, requestedMessageSlice, forgetStoredSession } =
    ctx.storedReader;

  /** A read/subscribe names the transcript window its view wants (none: the
   *  whole transcript). A window grown past what a resumed runtime holds is
   *  completed from durable history, which a live session never keeps cached. */
  async function applyTranscriptRequest(entry, params, sessionId) {
    const request = requestedTranscriptWindow(params);
    // A model-message read (messageStart) is not a view and leaves the window.
    if (request || !Number.isInteger(params.messageStart)) requestLiveTranscriptWindow(entry, request);
    // No baseline the next step can patch: this caller receives the window
    // whole, so it goes out within its byte budget.
    if (request && params.baseRevision !== entry.revision) rebudgetTranscriptWindow(entry);
    if (await loadLiveTranscriptHead(entry, sessionId, readStoredSession)) forgetStoredSession(sessionId);
    assertAvailable(entry);
  }

  async function createReservedSession(params, viewer, reservedSessionId) {
    const entry = await createEntry({ ...params, sessionId: reservedSessionId }, viewer);
    try {
      let sessionId = currentSessionId(entry);
      if (!sessionId) {
        sessionId = reservedSessionId;
        if (!SESSION_ID_PATTERN.test(sessionId)) throw new TypeError('sessionId is invalid');
        const target = entry.runtime.reserveSession;
        if (typeof target !== 'function') {
          throw new TypeError('session action reserveSession is unavailable');
        }
        await target.call(entry.runtime, sessionId);
        assertAvailable(entry);
        entry.reservedOnly = true;
        sessionId = currentSessionId(entry);
      }
      if (!sessionId) throw new Error('session creation returned no sessionId');
      adoptPendingViewers(entry, sessionId);
      advanceForCaller(entry);
      log(`session created session=${sessionId}`);
      retainUnwatched(entry, 'headless session create');
      return entry;
    } catch (error) {
      await destroy(entry, 'session creation failed', { keepBackgroundWork: true });
      throw error;
    }
  }

  async function createSession(params = {}, viewer = null) {
    assertAvailable();
    const requestedId = String(params.sessionId || '').trim();
    if (requestedId && !SESSION_ID_PATTERN.test(requestedId)) throw new TypeError('sessionId is invalid');
    const reservedSessionId = requestedId || `sess_daemon_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
    const entry = await getOrCreateSessionEntry(reservedSessionId, () =>
      createReservedSession(params, viewer, reservedSessionId)
    );
    assertAvailable(entry);
    const step = advanceForCaller(entry);
    addSubscriber(entry, viewer);
    return sessionResult(entry, step);
  }

  async function liveSessionReadResult(entry, params, sessionId, baseRevision) {
    assertAvailable(entry);
    await applyTranscriptRequest(entry, params, sessionId);
    const step = advanceForCaller(entry);
    retainUnwatched(entry, 'headless session read');
    const messages = await requestedMessageSlice(params, sessionId);
    assertAvailable(entry);
    const prepend = params.transcriptPrepend === true;
    return transcriptPageBody(
      sessionResult(entry, step, baseRevision, messages, { prepend }),
      requestedHeldTranscript(params)
    );
  }

  /** The live entry a view can attach to: the owner, an external view, or a
   *  freshly bound external session. */
  const liveEntryFor = async (id) =>
    liveEntryForView(id) || externalEntryForView(id) || (await bindExternalSessionView(id));

  async function readSession(params = {}, viewer = null) {
    assertAvailable();
    const { sessionId, open: openHints = {}, baseRevision = null, baseProjectionStamp = null } = params;
    if (params.action != null) {
      return runSessionAction(params, SESSION_READ_ACTION_SET);
    }
    notePrependViewer(viewer, params);
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const live = await liveEntryFor(id);
    assertAvailable(live);
    if (live) {
      return liveSessionReadResult(live, params, id, baseRevision);
    }
    if (typeof readStoredSession === 'function') {
      const window = requestedTranscriptWindow(params);
      // The cold-view refresh re-asks with the projection it holds. While the
      // session's files keep the settled identity that projection was built
      // from, nothing is read and the caller keeps its baseline.
      const held = Number.isInteger(params.messageStart)
        ? null
        : unchangedProjectionResult(id, baseProjectionStamp, baseRevision);
      if (held && (await storedProjectionUnchanged(id, openHints, window, baseProjectionStamp))) {
        assertAvailable();
        const lateOwner = lateOwnerFor(id);
        return lateOwner ? liveSessionReadResult(lateOwner, params, id, baseRevision) : held;
      }
      const projection = await storedSessionProjection(id, openHints, window);
      assertAvailable();
      const lateOwner = lateOwnerFor(id);
      if (lateOwner) {
        return liveSessionReadResult(lateOwner, params, id, baseRevision);
      }
      if (!projection) throw new Error(`session ${id} is not available`);
      // Allocate the snapshot's revision before an optional history read can
      // yield to a newer live publication. Matching content keeps the caller's
      // baseline and carries no body.
      const result = projectionResult(id, projection, {
        baseRevision,
        baseProjectionStamp,
        allowUnchanged: !Number.isInteger(params.messageStart),
      });
      const messages = await requestedMessageSlice(params, id);
      assertAvailable();
      return { ...transcriptPageBody(result, requestedHeldTranscript(params)), ...messages };
    }
    // Embedders without a store reader keep the legacy load-on-read seam.
    const entry = await entryForSession(id, openHints || {});
    return liveSessionReadResult(entry, params, id, baseRevision);
  }

  /** Publish BEFORE attaching: the views already there get the frame, the new
   *  one gets the same revision once in its reply. */
  const subscribeLive = async (entry, params, viewer, baseRevision) => {
    await applyTranscriptRequest(entry, params, currentSessionId(entry) || String(params.sessionId || ''));
    const step = advanceForCaller(entry);
    addSubscriber(entry, viewer);
    return sessionResult(entry, step, baseRevision, { subscribed: true }, { prepend: params.transcriptPrepend === true });
  };

  async function subscribeSession(params = {}, viewer = null) {
    const { sessionId, open: openHints = {}, baseRevision = null } = params;
    assertAvailable();
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    notePrependViewer(viewer, params);
    const live = await liveEntryFor(id);
    assertAvailable(live);
    if (live) return subscribeLive(live, params, viewer, baseRevision);
    if (typeof readStoredSession === 'function') {
      // Register BEFORE the disk read: a concurrent materialization adopts
      // pending viewers only after its runtime is indexed, so this order
      // guarantees either adoption or the live re-check below.
      // The view's window goes with it: the entry that later adopts this
      // viewer serves it the same bounded tail, never the whole transcript.
      const window = requestedTranscriptWindow(params);
      trackPendingViewer(id, viewer, window);
      const projection = await storedSessionProjection(id, openHints, window);
      assertAvailable();
      const lateOwner = lateOwnerFor(id);
      if (lateOwner) {
        dropPendingViewer(id, viewer);
        return subscribeLive(lateOwner, params, viewer, baseRevision);
      }
      if (!projection) {
        dropPendingViewer(id, viewer);
        throw new Error(`session ${id} is not available`);
      }
      return { ...projectionResult(id, projection), subscribed: true };
    }
    const entry = await entryForSession(id, openHints || {});
    assertAvailable(entry);
    return subscribeLive(entry, params, viewer, baseRevision);
  }

  async function unsubscribeSession({ sessionId } = {}, viewer = null) {
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const coldViewers = dropPendingViewer(id, viewer);
    const owner = sessionOwner(id);
    if (!owner) {
      const external = externalEntryForView(id);
      if (external) {
        const token = subscriberToken(viewer);
        if (token) external.subscribers?.delete(token);
        if ((external.subscribers?.size || 0) === 0) externalViewEntries.delete(id);
      }
      // The last cold view left: its disk projection is no longer needed.
      if (!coldViewers) forgetStoredSession(id);
      return { sessionId: id, unsubscribed: true };
    }
    const entry = owner;
    const token = subscriberToken(viewer);
    if (token) entry.subscribers?.delete(token);
    if ((entry.subscribers?.size || 0) === 0) {
      entry.transcriptView = null;
      if (entry.reservedOnly && !sessionBusy(entry)) {
        await destroy(entry, 'unclaimed session reservation', {
          keepBackgroundWork: true,
        });
        return { sessionId: id, unsubscribed: true };
      }
      entry.retainedAt = Date.now();
      releaseProjection(entry);
      startEvictionSweep();
    }
    log(`session unsubscribed session=${id}${token ? ` client=${token}` : ''}`);
    return { sessionId: id, unsubscribed: true };
  }

  return { createSession, readSession, subscribeSession, unsubscribeSession };
}
