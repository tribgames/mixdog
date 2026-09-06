/**
 * src/standalone/session-service/projection.mjs - wire projection and frame
 * publication for daemon-owned session entries: identity-cached snapshots,
 * revision steps with deltas, session-address indexing, and external (agent)
 * session views. Extracted from session-service.mjs.
 */
import { diffSessionState } from '../session-state-patch.mjs';
import { projectSessionState } from '../session-state-projection.mjs';

export function createSessionProjection({
  sessionsById,
  externalViewEntries,
  pendingViewers,
  externalSessionActions,
  revisionEpoch,
  publishIntervalMs,
  invokeExternalSessionAction = null,
  onFrame,
  log,
  isClosed,
  addSubscriber,
  adoptPendingViewers,
  updateEntryBusy,
  releaseProjection,
}) {
  // One clock owns every snapshot served by this daemon, including stored
  // views and replacement runtimes. Per-entry counters restarted after idle
  // eviction, so clients retaining the old baseline discarded new turns.
  let revision = revisionEpoch;
  const nextRevision = () => ++revision;

  function projectionResult(sessionId, projection, {
    baseRevision = null,
    baseProjectionStamp = null,
    allowUnchanged = false,
  } = {}) {
    const stamp = typeof projection?.projectionStamp === 'string'
      ? projection.projectionStamp : '';
    // A stamp alone identifies content, not the caller's wire baseline.
    // Preserve a known baseline; otherwise return a full, freshly ordered body.
    const unchanged = allowUnchanged && stamp && stamp === baseProjectionStamp
      && Number.isSafeInteger(baseRevision)
      && baseRevision > revisionEpoch && baseRevision <= revision;
    return {
      sessionId,
      reservedOnly: false,
      projection: true,
      revision: unchanged ? baseRevision : nextRevision(),
      ...(stamp ? { projectionStamp: stamp } : {}),
      ...(unchanged ? { unchanged: true } : { full: projection }),
    };
  }

  function snapshotOf(entry) {
    const raw = entry.runtime.getState?.() ?? null;
    // Store states are immutable snapshots (every mutation makes a new object),
    // so identity is a sound cache key. Without this the whole transcript was
    // re-sanitized on every call AND every published frame.
    if (raw && entry.snapshotSource === raw) return entry.snapshotCache;
    // Runtime-worker IPC has already produced a wire-safe graph. Reusing it
    // removes the daemon's second full transcript clone; in-process runtimes
    // keep the sanitizer boundary below.
    const cloned = entry.runtime?.isWireSafe === true ? raw : projectSessionState(entry, raw);
    entry.snapshotSource = raw;
    entry.snapshotCache = cloned;
    return cloned;
  }

  /** Advance the session runtime's published revision one step. */
  function advance(entry) {
    const snapshot = snapshotOf(entry);
    const projectedSessionId = String(snapshot?.sessionId || '');
    const addressedSessionId = String(entry.addressedSessionId || '');
    if (addressedSessionId
      && projectedSessionId
      && projectedSessionId !== addressedSessionId) {
      throw new Error(
        `session ${addressedSessionId} changed its durable address to ${projectedSessionId}`,
      );
    }
    if (!addressedSessionId && projectedSessionId) {
      entry.addressedSessionId = projectedSessionId;
    }
    indexSessionEntry(entry, projectedSessionId);
    updateEntryBusy(entry, snapshot);
    const previous = entry.publishedSnapshot;
    const previousRevision = entry.revision || 0;
    if (snapshot === previous) {
      return { changed: false, snapshot, revision: previousRevision, previousRevision, patch: null };
    }
    entry.publishedSnapshot = snapshot;
    entry.revision = nextRevision();
    return {
      changed: true,
      snapshot,
      revision: entry.revision,
      previousRevision,
      patch: previous ? diffSessionState(previous, snapshot) : null,
    };
  }

  /** Broadcast body: every attached view is, by construction, at the previous
   *  revision — one that is not resyncs itself off the revision gap. */
  function frameBody(step) {
    return step.patch
      ? { revision: step.revision, baseRevision: step.previousRevision, patch: step.patch }
      : { revision: step.revision, full: step.snapshot };
  }

  function currentSessionId(entry) {
    return String(entry?.runtime?.getState?.()?.sessionId || '');
  }

  function indexSessionEntry(entry, sessionId = currentSessionId(entry)) {
    const nextId = String(sessionId || '');
    const previousId = String(entry?.indexedSessionId || '');
    if (previousId && previousId !== nextId && sessionsById.get(previousId) === entry) {
      sessionsById.delete(previousId);
    }
    if (!entry || entry.disposed || !nextId) {
      if (entry) entry.indexedSessionId = '';
      return '';
    }
    // External agent projections use the same frame machinery but are not a
    // daemon execution owner. Keeping them out of sessionsById lets a later
    // ordinary session materialization adopt the viewers and take authority.
    if (entry.externalView === true) return nextId;
    const existing = sessionsById.get(nextId);
    if (existing && existing !== entry && !existing.disposed) {
      // Do not redirect an established address to a second session runtime. The load
      throw new Error(`duplicate session address: ${nextId}`);
    }
    const external = externalViewEntries.get(nextId);
    if (external) {
      externalViewEntries.delete(nextId);
      for (const token of external.subscribers || []) {
        addSubscriber(entry, { clientToken: token });
      }
    }
    sessionsById.set(nextId, entry);
    entry.indexedSessionId = nextId;
    return nextId;
  }

  /** Publish one durable session-addressed frame. The runtime pool is a daemon
   *  implementation detail and never enters the client contract. */
  function publishStep(entry, step) {
    const sessionId = currentSessionId(entry);
    if (!sessionId) return;
    // Session runtime revisions may predate the session address (a reservation becomes
    // a materialized session during newSession/resume). A session subscriber
    // has no copy of that session runtime-only base, so the first frame for each session
    // address must be FULL; only later frames may use session runtime revision deltas.
    const body = entry.publishedSessionId === sessionId
      ? frameBody(step)
      : { revision: step.revision, full: step.snapshot };
    entry.publishedSessionId = sessionId;
    entry.lastPublishedAt = Date.now();
    onFrame({
      type: 'session-state',
      key: `session-state:${sessionId}`,
      sessionId,
      ...body,
    }, entry.subscribers);
  }

  function externalEntryForView(sessionId) {
    return externalViewEntries.get(String(sessionId || '')) || null;
  }

  function publishExternalSessionState(update) {
    const sessionId = String(update?.sessionId || '');
    const snapshot = update?.snapshot;
    if (!sessionId || !snapshot || typeof snapshot !== 'object') return;
    // A daemon-owned runtime is the canonical owner if this address was
    // materialized. External agent projection frames can arrive one tick late
    // after that promotion and must not overwrite it.
    if (sessionOwner(sessionId)) return;
    let entry = externalViewEntries.get(sessionId);
    if (!entry) {
      if (!pendingViewers.has(sessionId)) return;
      let state = { ...snapshot, sessionId };
      const runtime = {
        isWireSafe: true,
        externalAction: typeof invokeExternalSessionAction === 'function',
        getState: () => state,
        setState: (next) => { state = next; },
      };
      Object.defineProperties(runtime, {
        id: { get: () => sessionId },
        provider: { get: () => String(state.provider || '') },
        model: { get: () => String(state.model || '') },
        session: {
          get: () => ({
            id: sessionId,
            provider: String(state.provider || ''),
            model: String(state.model || ''),
          }),
        },
      });
      if (typeof invokeExternalSessionAction === 'function') {
        for (const name of externalSessionActions) {
          runtime[name] = (...args) => invokeExternalSessionAction(sessionId, name, args);
        }
      }
      entry = {
        runtime,
        subscribers: new Set(),
        disposed: false,
        timer: null,
        lastPublishedAt: 0,
        publishedSessionId: '',
        indexedSessionId: '',
        addressedSessionId: sessionId,
        revision: revisionEpoch,
        busy: null,
        externalView: true,
      };
      externalViewEntries.set(sessionId, entry);
      adoptPendingViewers(entry, sessionId);
    } else {
      entry.runtime.setState({ ...snapshot, sessionId });
    }
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
  }

  /** Response body for the CALLER, which announced the revision it holds. */
  function bodyForClient(step, baseRevision) {
    if (!step.changed && baseRevision === step.revision) return { revision: step.revision };
    if (step.patch && baseRevision === step.previousRevision) return frameBody(step);
    return { revision: step.revision, full: step.snapshot };
  }

  /** Entry that currently holds a session live. */
  function sessionOwner(sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    const entry = sessionsById.get(id) || null;
    if (!entry || entry.disposed) {
      if (entry) sessionsById.delete(id);
      return null;
    }
    return entry;
  }

  function publish(entry) {
    if (isClosed() || entry.disposed) return;
    try {
      if ((entry.subscribers?.size || 0) === 0) {
        // A headless turn still needs busy/index liveness, but no client can
        // consume a wire projection. Avoid cloning the growing transcript on
        // every token; the next subscriber receives a fresh full snapshot.
        const raw = entry.runtime.getState?.() || {};
        indexSessionEntry(entry, raw.sessionId);
        updateEntryBusy(entry, raw);
        releaseProjection(entry);
        return;
      }
      // Identical state produces no frame at all; a changed one travels as a
      // DELTA against the revision every attached view already holds.
      const step = advance(entry);
      if (!step.changed) return;
      publishStep(entry, step);
    } catch (err) {
      log(`publish failed session=${currentSessionId(entry) || '(creating)'}: ${err?.message || err}`);
    }
  }

  /** Session runtime events fire per streamed token. Publish immediately after an idle
   *  interval, then coalesce the rest of the burst to one display-frame clock.
   *  This avoids charging every first token a fixed delay. */
  function schedulePublish(entry) {
    if (entry.timer || entry.disposed || isClosed()) return;
    const elapsed = Date.now() - (entry.lastPublishedAt || 0);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      publish(entry);
    }, Math.max(0, publishIntervalMs - elapsed));
    entry.timer.unref?.();
  }

  return {
    advance,
    projectionResult,
    currentSessionId,
    indexSessionEntry,
    publishStep,
    externalEntryForView,
    publishExternalSessionState,
    bodyForClient,
    sessionOwner,
    schedulePublish,
  };
}
