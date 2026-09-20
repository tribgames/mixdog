// Creation and disposal of one daemon-owned execution entry around an injected
// runtime. Entries are never addressed by clients; sessionId is the only
// identity outside the service.

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

  // Detach the entry from every live structure synchronously, before the
  // asynchronous runtime disposal starts.
  function retire(entry) {
    entry.disposed = true;
    releaseProjection(entry);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      entry.unsubscribe?.();
    } catch {}
    sessions.delete(entry);
    stopEvictionSweepIfIdle();
    if (entry.indexedSessionId && sessionsById.get(entry.indexedSessionId) === entry) {
      sessionsById.delete(entry.indexedSessionId);
    }
    entry.busy = false;
  }

  async function destroy(entry, reason, { keepBackgroundWork = false, announce = true } = {}) {
    if (!entry || entry.disposed) return entry?.disposePromise || { ok: true };
    // Disposal must use the address already owned by this entry, not ask a
    // failed runtime for fresh state or accidentally address its replacement.
    const sessionId = String(entry.addressedSessionId || entry.indexedSessionId || '');
    retire(entry);
    // Publish before asynchronous disposal: a newly resumed incarnation must
    // never receive a delayed teardown belonging to this old runtime.
    if (sessionId) desktopServices.notifySessionRuntimeReleased(sessionId, reason);
    if (announce && sessionId) {
      onFrame(
        {
          type: 'session-gone',
          key: `session-state:${sessionId}`,
          sessionId,
          reason,
        },
        entry.subscribers
      );
    }
    const disposal = (async () => {
      try {
        await entry.runtime.dispose?.(reason, { keepBackgroundWork });
      } catch (err) {
        log(`session dispose failed session=${sessionId}: ${err?.message || err}`);
      }
      log(`session disposed session=${sessionId || '(creating)'} (${reason})`);
      return { ok: true };
    })();
    entry.disposePromise = disposal;
    pendingDisposals.add(disposal);
    const released = () => pendingDisposals.delete(disposal);
    void disposal.then(released, released);
    return disposal;
  }

  return { assertAvailable, createEntry, destroy };
}
