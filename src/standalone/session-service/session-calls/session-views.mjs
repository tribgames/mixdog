// session-calls/session-views.mjs
// The subscription side of the protocol: creating (reserving) a session,
// reading it live or from the store, and attaching / detaching a view.
import { randomUUID } from 'node:crypto';
import { SESSION_READ_ACTION_SET } from '../../session-protocol.mjs';
import { SESSION_ID_PATTERN } from '../agent-tree.mjs';
import {
  loadLiveTranscriptHead,
  readTranscriptHistory,
  readTranscriptRange,
  rebudgetTranscriptWindow,
  requestedTranscriptHistory,
  requestedHeldTranscript,
  requestedTranscriptWindow,
  requestLiveTranscriptWindow,
  restartTranscriptWindow,
  transcriptAnswerBounds,
  transcriptPageBody,
  transcriptWindowOversized,
} from '../projection/transcript-window.mjs';

/** Creating (reserving) a session. */
function createSessionCreation(ctx) {
  const { log, sessionResult, advanceForCaller } = ctx;
  const { currentSessionId } = ctx.projection;
  const { addSubscriber, adoptPendingViewers } = ctx.viewers;
  const { retainUnwatched } = ctx.retention;
  const { assertAvailable, createEntry, getOrCreateSessionEntry, destroy } = ctx.entries;

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

  return { createSession };
}

/** The transcript window a live view is answered through: requesting it,
 *  bounding the answer, and attaching a subscriber to a live entry. */
function createLiveTranscriptAnswers(ctx) {
  const { readStoredSession, sessionResult, advanceForCaller } = ctx;
  const { currentSessionId } = ctx.projection;
  const { addSubscriber } = ctx.viewers;
  const { assertAvailable } = ctx.entries;

  /** A read/subscribe names the transcript window its view wants (none: the
   *  whole transcript). A window grown past what a resumed runtime holds is
   *  completed from durable history, sliced from the store's cached display
   *  history of the record's content. */
  async function applyTranscriptRequest(entry, params, sessionId) {
    const request = requestedTranscriptWindow(params);
    // A model-message read (messageStart) is not a view and leaves the window.
    if (request || !Number.isInteger(params.messageStart)) requestLiveTranscriptWindow(entry, request);
    // No baseline the next step can patch: this caller receives the window
    // whole, so it goes out within its byte budget.
    if (request && params.baseRevision !== entry.revision) rebudgetTranscriptWindow(entry);
    await loadLiveTranscriptHead(entry, sessionId, readStoredSession);
    assertAvailable(entry);
  }

  /** The caller's answer for `step`, reduced to a page when it proves the rows
   *  it holds and they fit one answer. A window that would go out whole past
   *  the request's bounds (transcriptAnswerBounds) does not: a caller already
   *  at this revision needs no body; any other gets a bounded recovery
   *  snapshot — the window restarts from a fresh tail, which the views
   *  attached receive as a step too. */
  function boundedSessionResult(entry, step, params, baseRevision, extra) {
    const prepend = params.transcriptPrepend === true;
    const bounds = transcriptAnswerBounds(requestedTranscriptWindow(params));
    const result = transcriptPageBody(
      sessionResult(entry, step, baseRevision, extra, { prepend }),
      requestedHeldTranscript(params),
      { byteBudget: bounds.byteBudget }
    );
    if (!transcriptWindowOversized(entry, result.full, bounds)) return result;
    if (baseRevision === step.revision) {
      const { full: _full, ...bodiless } = result;
      return bodiless;
    }
    restartTranscriptWindow(entry, bounds.maxItems);
    return sessionResult(entry, advanceForCaller(entry), baseRevision, extra, { prepend });
  }

  /** Publish BEFORE attaching: the views already there get the frame, the new
   *  one gets the same revision once in its reply. */
  const subscribeLive = async (entry, params, viewer, baseRevision) => {
    await applyTranscriptRequest(entry, params, currentSessionId(entry) || String(params.sessionId || ''));
    const prepend = params.transcriptPrepend === true;
    let step = advanceForCaller(entry);
    // Bounded like a read (boundedSessionResult), before attaching: the new
    // view receives the restarted tail once, in its reply.
    const bounds = transcriptAnswerBounds(requestedTranscriptWindow(params));
    if (transcriptWindowOversized(entry, sessionResult(entry, step, baseRevision, {}, { prepend }).full, bounds)) {
      restartTranscriptWindow(entry, bounds.maxItems);
      step = advanceForCaller(entry);
    }
    addSubscriber(entry, viewer);
    return sessionResult(entry, step, baseRevision, { subscribed: true }, { prepend });
  };

  return { applyTranscriptRequest, boundedSessionResult, subscribeLive };
}

/** Detaching a view from a live or cold session. */
function createSessionUnsubscribe(ctx) {
  const { log, externalViewEntries } = ctx;
  const { externalEntryForView, sessionOwner } = ctx.projection;
  const { subscriberToken, dropPendingViewer } = ctx.viewers;
  const { sessionBusy, releaseProjection, startEvictionSweep } = ctx.retention;
  const { destroy } = ctx.entries;
  const { releaseStoredSession } = ctx.storedReader;

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
      // The last cold view left: its disk projection turns idle, kept within
      // the store's idle budget so a revisit skips the parse.
      if (!coldViewers) releaseStoredSession(id);
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

  return { unsubscribeSession };
}

export function createSessionViewCalls(ctx) {
  const { readStoredSession, runSessionAction, advanceForCaller } = ctx;
  const { externalEntryForView, projectionResult, unchangedProjectionResult, sessionOwner } = ctx.projection;
  /** The owner a concurrent materialization may have produced while a disk
   *  read was in flight: a daemon-owned runtime outranks an external view. */
  const lateOwnerFor = (id) => sessionOwner(id) || externalEntryForView(id);
  const { trackPendingViewer, dropPendingViewer, notePrependViewer } = ctx.viewers;
  const { retainUnwatched } = ctx.retention;
  const { assertAvailable, entryForSession, liveEntryForView, bindExternalSessionView } = ctx.entries;
  const { storedSessionProjection, storedProjectionUnchanged, storedPageOnly, requestedMessageSlice } =
    ctx.storedReader;
  const { createSession } = createSessionCreation(ctx);
  const { applyTranscriptRequest, boundedSessionResult, subscribeLive } = createLiveTranscriptAnswers(ctx);
  const { unsubscribeSession } = createSessionUnsubscribe(ctx);

  async function liveSessionReadResult(entry, params, sessionId, baseRevision) {
    assertAvailable(entry);
    await applyTranscriptRequest(entry, params, sessionId);
    const step = advanceForCaller(entry);
    retainUnwatched(entry, 'headless session read');
    const messages = await requestedMessageSlice(params, sessionId);
    assertAvailable(entry);
    return boundedSessionResult(entry, step, params, baseRevision, messages);
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
    if (params.attachmentHistory === true) {
      // Apart from every window: nothing here reads, fills or replaces a
      // transcript projection.
      const stored =
        typeof readStoredSession === 'function' ? await readStoredSession(id, { attachmentHistory: true }) : null;
      assertAvailable();
      return { history: stored ? { items: stored.items } : null };
    }
    const live = await liveEntryFor(id);
    assertAvailable(live);
    if (params.transcriptRange) {
      const range = await readTranscriptRange(live, id, readStoredSession, params.transcriptRange);
      assertAvailable(live);
      return { range };
    }
    const historyRequest = requestedTranscriptHistory(params);
    if (historyRequest) {
      // Read-only: no window, baseline or revision of any view moves.
      const history = await readTranscriptHistory(live, id, readStoredSession, historyRequest);
      assertAvailable(live);
      return { history };
    }
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
      const heldRows = requestedHeldTranscript(params);
      const projection = await storedSessionProjection(id, openHints, window, heldRows, baseProjectionStamp);
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
      // The stored reader already proved (or disproved) the held rows, and
      // its projection then carries only the page above them.
      const page = storedPageOnly(projection)
        ? transcriptPageBody(result, heldRows, { proven: true, byteBudget: window?.byteBudget, pageOnly: true })
        : result;
      return { ...page, ...messages };
    }
    // Embedders without a store reader keep the legacy load-on-read seam.
    const entry = await entryForSession(id, openHints || {});
    return liveSessionReadResult(entry, params, id, baseRevision);
  }

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

  return { createSession, readSession, subscribeSession, unsubscribeSession };
}
