// Disposal of one daemon-owned execution entry: detaching it from every live
// structure, announcing the loss to its subscribers, and awaiting the runtime's
// own teardown. Creation lives in ./lifecycle.mjs.

export function createEntryDisposal({
  sessions,
  sessionsById,
  pendingDisposals,
  desktopServices,
  onFrame,
  log,
  releaseProjection,
  stopEvictionSweepIfIdle,
}) {
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

  return { destroy };
}
