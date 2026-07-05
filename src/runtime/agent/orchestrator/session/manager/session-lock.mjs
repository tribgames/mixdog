// manager/session-lock.mjs
// Per-session mutex extracted verbatim from manager.mjs. Queues concurrent
// askSession calls (and their drained pending-message tail turns) to prevent
// message loss / interleaving.
const _sessionLocks = new Map();
export function acquireSessionLock(sessionId) {
    let entry = _sessionLocks.get(sessionId);
    if (!entry) {
        entry = { promise: Promise.resolve(), count: 0 };
        _sessionLocks.set(sessionId, entry);
    }
    entry.count++;
    const prev = entry.promise;
    let release;
    entry.promise = new Promise(r => { release = r; });
    // Self-heal: if the previous holder rejected, swallow so subsequent
    // queued waiters don't propagate that rejection and brick the lock chain.
    return prev.catch(() => {}).then(() => () => {
        entry.count--;
        if (entry.count === 0) _sessionLocks.delete(sessionId);
        release();
    });
}
