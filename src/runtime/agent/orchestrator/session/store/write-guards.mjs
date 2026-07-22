/** Module-level map tracking per-session cancellation generations and commit locks. */
const _writeControls = new Map();

function writeControl(id) {
    let control = _writeControls.get(id);
    if (!control) {
        // [0] cancellation generation, [1] commit lock
        control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
        _writeControls.set(id, control);
    }
    return control;
}

export function guardedSaveOptions(id, opts) {
    const control = writeControl(id);
    return {
        ...(opts || {}),
        _sessionWriteGuard: { buffer: control.buffer, version: Atomics.load(control, 0) },
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

export function acquireWriteCommit(opts) {
    const guard = opts?._sessionWriteGuard;
    if (!guard?.buffer) return null;
    const control = new Int32Array(guard.buffer);
    while (Atomics.compareExchange(control, 1, 0, 1) !== 0) {
        Atomics.wait(control, 1, 1, 25);
    }
    if (isCancelledWrite(opts)) {
        Atomics.store(control, 1, 0);
        Atomics.notify(control, 1);
        return false;
    }
    return control;
}

export function releaseWriteCommit(control) {
    if (!control) return;
    Atomics.store(control, 1, 0);
    Atomics.notify(control, 1);
}

export function waitForWriteCommit(id) {
    const control = writeControl(id);
    while (Atomics.load(control, 1) !== 0) {
        Atomics.wait(control, 1, 1, 25);
    }
}
