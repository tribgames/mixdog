// Creation of one daemon-owned execution entry around an injected runtime;
// disposal lives in ./disposal.mjs. Entries are never addressed by clients;
// sessionId is the only identity outside the service.
import { createEntryDisposal } from './disposal.mjs';

export function createEntryLifecycle({
  createRuntime,
  revisionEpoch,
  sessions,
  sessionsById,
  pendingDisposals,
  desktopServices,
  onFrame,
  log,
  isClosed,
  indexSessionEntry,
  schedulePublish,
  subscriberToken,
  addSubscriber,
  updateEntryBusy,
  releaseProjection,
  stopEvictionSweepIfIdle,
}) {
  const { destroy } = createEntryDisposal({
    sessions,
    sessionsById,
    pendingDisposals,
    desktopServices,
    onFrame,
    log,
    releaseProjection,
    stopEvictionSweepIfIdle,
  });

  function assertAvailable(entry) {
    if (isClosed()) throw new Error('session service is closed');
    if (entry?.disposed) throw new Error('session runtime is disposed');
  }

  async function createEntry(params = {}, ctx = null) {
    assertAvailable();
    const runtime = await createRuntime({
      sessionId: params.sessionId,
      cwd: params.cwd || process.cwd(),
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      fast: params.fast,
      modelParameters: params.modelParameters,
      toolMode: params.toolMode || 'full',
      remote: params.remote === true,
      desktopSession: params.desktopSession ?? null,
      sessionProfile: params.sessionProfile ?? null,
    });
    const entry = {
      runtime,
      cwd: params.cwd || process.cwd(),
      timer: null,
      disposed: false,
      unsubscribe: null,
      subscribers: new Set(),
      reservedOnly: false,
      lastPublishedAt: 0,
      indexedSessionId: '',
      addressedSessionId: '',
      busy: null,
      headless: !subscriberToken(ctx),
      retainedAt: null,
      revision: revisionEpoch,
    };
    try {
      assertAvailable(entry);
      sessions.add(entry);
      let initialState;
      try {
        initialState = runtime.getState?.() || {};
      } catch {
        initialState = { busy: true };
      }
      indexSessionEntry(entry, initialState.sessionId);
      updateEntryBusy(entry, initialState);
      addSubscriber(entry, ctx);
      try {
        entry.unsubscribe = runtime.subscribe?.(() => schedulePublish(entry)) ?? null;
      } catch (err) {
        log(`session subscribe failed: ${err?.message || err}`);
      }
      return entry;
    } catch (error) {
      await destroy(entry, 'session creation failed', { keepBackgroundWork: !isClosed(), announce: false });
      throw error;
    }
  }

  return { assertAvailable, createEntry, destroy };
}
