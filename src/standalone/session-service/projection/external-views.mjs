// External (agent) session views: a retained snapshot published through the
// ordinary frame machinery without a daemon runtime behind it. A daemon-owned
// runtime that materializes the same address takes over its viewers.

function createExternalViewRuntime({ sessionId, snapshot, externalSessionActions, invokeExternalSessionAction }) {
  let state = { ...snapshot, sessionId };
  const runtime = {
    isWireSafe: true,
    externalAction: typeof invokeExternalSessionAction === 'function',
    getState: () => state,
    setState: (next) => {
      state = next;
    },
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
  return runtime;
}

export function createExternalViews({
  externalViewEntries,
  pendingViewers,
  externalSessionActions,
  revisionEpoch,
  invokeExternalSessionAction,
  isClosed,
  adoptPendingViewers,
  index,
  advance,
  publishStep,
}) {
  function externalEntryForView(sessionId) {
    return externalViewEntries.get(String(sessionId || '')) || null;
  }

  function createExternalEntry(sessionId, snapshot) {
    const entry = {
      runtime: createExternalViewRuntime({ sessionId, snapshot, externalSessionActions, invokeExternalSessionAction }),
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
    return entry;
  }

  function publishExternalSessionState(update) {
    if (isClosed()) return;
    const sessionId = String(update?.sessionId || '');
    const snapshot = update?.snapshot;
    if (!sessionId || !snapshot || typeof snapshot !== 'object') return;
    // A daemon-owned runtime is the canonical owner if this address was
    // materialized. External agent projection frames can arrive one tick late
    // after that promotion and must not overwrite it.
    if (index.sessionOwner(sessionId)) return;
    let entry = externalViewEntries.get(sessionId);
    if (!entry) {
      if (!pendingViewers.has(sessionId)) return;
      entry = createExternalEntry(sessionId, snapshot);
    } else {
      entry.runtime.setState({ ...snapshot, sessionId });
    }
    const step = advance(entry);
    if (step.changed) publishStep(entry, step);
  }

  return { externalEntryForView, publishExternalSessionState };
}
