// Per-path mutex for concurrent Edit/Write operations. Maps absPath → Promise
// chain so that overlapping calls for the same file are serialised in-process.
const editLocks = new Map();

export function pathLockKey(absPath) {
    const text = String(absPath || '');
    return process.platform === 'win32' ? text.toLowerCase() : text;
}

export function withPathLock(absPath, fn) {
    const lockKey = pathLockKey(absPath);
    const prev = editLocks.get(lockKey) ?? Promise.resolve();
    const next = prev.then(fn, fn); // pass through errors so chain never stalls
    editLocks.set(lockKey, next.then(
        () => { if (editLocks.get(lockKey) === next) editLocks.delete(lockKey); },
        () => { if (editLocks.get(lockKey) === next) editLocks.delete(lockKey); },
    ));
    return next;
}

export function withBuiltinPathLocks(paths, fn) {
    const keyed = new Map();
    for (const p of Array.isArray(paths) ? paths : [paths]) {
        if (!p) continue;
        keyed.set(pathLockKey(p), String(p));
    }
    const sorted = [...keyed.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map((entry) => entry[1]);
    const run = (idx) => {
        if (idx >= sorted.length) return fn();
        return withPathLock(sorted[idx], () => run(idx + 1));
    };
    return run(0);
}
