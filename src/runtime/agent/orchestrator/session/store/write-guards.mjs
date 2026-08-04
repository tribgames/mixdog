/**
 * Module-level map tracking per-session cancellation generations, commit locks
 * and the highest save epoch that actually LANDED for the id. All three live
 * in one SharedArrayBuffer per id, so the save worker (which receives the
 * buffer inside the write guard) observes the same state as the parent.
 */
const _writeControls = new Map();

// Layout of the per-id SharedArrayBuffer:
//   int32  [0] cancellation generation (equality-compared, wrap-safe)
//   int32  [1] commit lock
//   int64  @8 highest LANDED save epoch — 64-bit and 8-byte aligned so the
//             fence can never wrap or read back negative, unlike an int32
//             slot which a long-lived process could in principle overflow.
const CONTROL_I32_LENGTH = 2;
const LANDED_EPOCH_BYTE_OFFSET = 8;
const CONTROL_BYTES = LANDED_EPOCH_BYTE_OFFSET + BigInt64Array.BYTES_PER_ELEMENT;

function writeControl(id) {
    let control = _writeControls.get(id);
    if (!control) {
        control = new Int32Array(new SharedArrayBuffer(CONTROL_BYTES), 0, CONTROL_I32_LENGTH);
        _writeControls.set(id, control);
    }
    return control;
}

// Both realms build this view over the SAME SharedArrayBuffer they received in
// the guard, so parent and save worker observe one landed-epoch value.
function landedEpochView(buffer) {
    return new BigInt64Array(buffer, LANDED_EPOCH_BYTE_OFFSET, 1);
}

export function guardedSaveOptions(id, opts, epoch = null) {
    const control = writeControl(id);
    // Only exact integers may fence a commit; anything else is treated as
    // "no identity" rather than silently truncated.
    const issued = Number.isSafeInteger(epoch) ? epoch : null;
    return {
        ...(opts || {}),
        _sessionWriteGuard: {
            buffer: control.buffer,
            version: Atomics.load(control, 0),
            // Identity of the snapshot this write carries. Absent for the
            // lifecycle barriers (tombstone/detach/delete), which are
            // authoritative by construction and never epoch-fenced.
            ...(issued === null ? {} : { epoch: issued }),
        },
    };
}

export function cancelSessionWrites(id) {
    Atomics.add(writeControl(id), 0, 1);
}

export function isCancelledWrite(opts) {
    const guard = opts?._sessionWriteGuard;
    if (!guard?.buffer || !Number.isInteger(guard.version)) return false;
    try {
        return Atomics.load(new Int32Array(guard.buffer), 0) !== guard.version;
    } catch {
        return true;
    }
}

/**
 * Publish the epoch of a write that just renamed onto the canonical path.
 * Monotonic max, so a late/older commit can never lower the bar.
 */
export function publishLandedWriteEpoch(opts, epoch) {
    const guard = opts?._sessionWriteGuard;
    if (!guard?.buffer || !Number.isSafeInteger(epoch)) return;
    try {
        const view = landedEpochView(guard.buffer);
        const next = BigInt(epoch);
        let current = Atomics.load(view, 0);
        while (next > current) {
            const previous = Atomics.compareExchange(view, 0, current, next);
            if (previous === current) return;
            current = previous;
        }
    } catch { /* buffer gone: nothing to fence */ }
}

/**
 * True when a STRICTLY NEWER save already landed on disk for this id, i.e.
 * committing this snapshot would revert durable history. Covers the exit
 * drain of an outstanding older payload and an older worker write finishing
 * after a newer sync/async write (the commit lock serialises renames, it does
 * not order them by content age).
 */
export function isStaleWriteEpoch(opts) {
    const guard = opts?._sessionWriteGuard;
    if (!guard?.buffer || !Number.isSafeInteger(guard.epoch)) return false;
    try {
        return BigInt(guard.epoch) < Atomics.load(landedEpochView(guard.buffer), 0);
    } catch {
        return false;
    }
}

/**
 * Sentinel returned when `timeoutMs` elapsed before the id's commit lock could
 * be taken. Distinct from `false` (cancelled): nothing is wrong with the
 * write, this realm simply may not block any longer (exit drain).
 */
export const WRITE_COMMIT_TIMEOUT = Symbol('session-write-commit-timeout');

/**
 * Sentinel returned when a newer write for the id landed while this one waited
 * for the lock: the caller must discard its scratch file and commit nothing.
 */
export const WRITE_COMMIT_STALE = Symbol('session-write-commit-stale');

export function acquireWriteCommit(opts, options = {}) {
    const guard = opts?._sessionWriteGuard;
    if (!guard?.buffer) return null;
    const control = new Int32Array(guard.buffer);
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
        ? options.timeoutMs
        : Infinity;
    const deadline = timeoutMs === Infinity ? Infinity : Date.now() + timeoutMs;
    while (Atomics.compareExchange(control, 1, 0, 1) !== 0) {
        if (Date.now() >= deadline) return WRITE_COMMIT_TIMEOUT;
        const slice = deadline === Infinity ? 25 : Math.min(25, Math.max(1, deadline - Date.now()));
        Atomics.wait(control, 1, 1, slice);
    }
    if (isCancelledWrite(opts)) {
        Atomics.store(control, 1, 0);
        Atomics.notify(control, 1);
        return false;
    }
    // Re-checked UNDER the lock: the newer write may have landed while this
    // one was waiting for it.
    if (isStaleWriteEpoch(opts)) {
        Atomics.store(control, 1, 0);
        Atomics.notify(control, 1);
        return WRITE_COMMIT_STALE;
    }
    return control;
}

export function releaseWriteCommit(control) {
    if (!control) return;
    Atomics.store(control, 1, 0);
    Atomics.notify(control, 1);
}

/**
 * Wait until no commit holds this id's rename lock. `timeoutMs` bounds the
 * wait: the exit drain must never hang behind a worker/thread that is stuck
 * inside its commit, and a timeout is safe — the caller's own write still
 * serialises on the same Atomics lock. Returns true when the lock was
 * observed free, false on timeout.
 */
export function waitForWriteCommit(id, opts = {}) {
    const control = writeControl(id);
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0 ? opts.timeoutMs : Infinity;
    const deadline = timeoutMs === Infinity ? Infinity : Date.now() + timeoutMs;
    while (Atomics.load(control, 1) !== 0) {
        if (Date.now() >= deadline) return false;
        const slice = deadline === Infinity ? 25 : Math.min(25, Math.max(1, deadline - Date.now()));
        Atomics.wait(control, 1, 1, slice);
    }
    return true;
}
