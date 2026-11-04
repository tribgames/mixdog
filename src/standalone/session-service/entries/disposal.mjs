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
  idleStateChanged = () => {},
}) {
  // sessionId -> teardowns still running for that address. A runtime for the
  // same id (reopen) or a delete of its record waits on these, never races them.
  const teardownsById = new Map();

  /** Resolves once every teardown pending for `sessionId` has finished, with
   *  their results (`{ ok:false, error }` for a failed one, which is also
   *  logged where it runs). Never rejects. */
  async function settleTeardown(sessionId) {
    const pending = teardownsById.get(String(sessionId || ''));
    if (!pending) return [];
    const settled = await Promise.allSettled([...pending]);
    return settled.map((s) => (s.status === 'fulfilled' ? s.value : { ok: false, error: s.reason }));
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
    if (entry.indexedSessionId && sessionsById.get(entry.indexedSessionId) === entry) {
      sessionsById.delete(entry.indexedSessionId);
    }
    entry.busy = false;
    // Its session's eviction deadline goes with it.
    idleStateChanged(entry);
  }

  /** Detach `entry` and start its teardown without waiting for it. Throws
   *  (after the teardown is already running and tracked) only when the detach
   *  itself failed; otherwise returns the disposal promise, which never
   *  rejects — a failed teardown is logged and resolves `{ ok:false, error }`. */
  function release(entry, reason, { keepBackgroundWork = false, announce = true } = {}) {
    if (!entry || entry.disposed) return entry?.disposePromise || { ok: true };
    // Disposal must use the address already owned by this entry, not ask a
    // failed runtime for fresh state or accidentally address its replacement.
    const sessionId = String(entry.addressedSessionId || entry.indexedSessionId || '');
    // The teardown must start whatever the detach or the announcements do:
    // an entry marked disposed whose runtime never closes is a leak. A detach
    // failure is kept and rethrown to the caller once the teardown is tracked.
    let detachError = null;
    let detachFailed = false;
    try {
      retire(entry);
    } catch (err) {
      detachFailed = true;
      detachError = err;
      entry.disposed = true;
    }
    // Published before the runtime closes: a newly resumed incarnation must
    // never receive a delayed teardown belonging to this old runtime. These
    // callbacks are contained so a throwing sink cannot skip the teardown.
    const contained = (what, work) => {
      try {
        work();
      } catch (err) {
        log(`session ${what} failed session=${sessionId}: ${err?.message || err}`);
      }
    };
    if (sessionId) {
      contained('release notification', () => desktopServices.notifySessionRuntimeReleased(sessionId, reason));
    }
    if (announce && sessionId) {
      contained('gone announcement', () =>
        onFrame(
          {
            type: 'session-gone',
            key: `session-state:${sessionId}`,
            sessionId,
            reason,
          },
          entry.subscribers
        )
      );
    }
    const disposal = (async () => {
      let result = { ok: true };
      try {
        await entry.runtime.dispose?.(reason, { keepBackgroundWork });
      } catch (err) {
        log(`session dispose failed session=${sessionId}: ${err?.message || err}`);
        result = { ok: false, error: err };
      }
      log(`session disposed session=${sessionId || '(creating)'} (${reason})`);
      return result;
    })();
    entry.disposePromise = disposal;
    pendingDisposals.add(disposal);
    if (sessionId) {
      if (!teardownsById.has(sessionId)) teardownsById.set(sessionId, new Set());
      teardownsById.get(sessionId).add(disposal);
    }
    const released = () => {
      pendingDisposals.delete(disposal);
      const pending = teardownsById.get(sessionId);
      if (pending?.delete(disposal) && pending.size === 0) teardownsById.delete(sessionId);
    };
    void disposal.then(released, released);
    if (detachFailed) throw detachError;
    return disposal;
  }

  /** `release`, then wait for the teardown. */
  async function destroy(entry, reason, options) {
    return release(entry, reason, options);
  }

  return { destroy, release, settleTeardown };
}
