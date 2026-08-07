// manager/session-lock.mjs
// Per-session mutex extracted verbatim from manager.mjs. Queues concurrent
// askSession calls (and their drained pending-message tail turns) to prevent
// message loss / interleaving.
import { abortReason } from '../../../../shared/abort-race.mjs';

const _sessionLocks = new Map();
export function acquireSessionLock(sessionId, signal = null) {
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
    const previousReady = prev.catch(() => {});
    let slotReleased = false;
    const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        entry.count--;
        if (entry.count === 0) _sessionLocks.delete(sessionId);
        release();
    };
    const unlock = () => releaseSlot();
    if (!signal) return previousReady.then(() => unlock);

    // A cancelled waiter must reject immediately without opening a hole in the
    // mutex. Its reserved slot is skipped only after the previous holder exits,
    // so later waiters still cannot overlap the live owner.
    return new Promise((resolve, reject) => {
        let settled = false;
        const removeAbort = () => {
            try { signal.removeEventListener('abort', onAbort); } catch {}
        };
        const onAbort = () => {
            if (settled) return;
            settled = true;
            removeAbort();
            void previousReady.then(releaseSlot);
            reject(abortReason(signal, `Session "${sessionId}" lock wait aborted`));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        previousReady.then(() => {
            if (settled) return;
            settled = true;
            removeAbort();
            resolve(unlock);
        });
    });
}
