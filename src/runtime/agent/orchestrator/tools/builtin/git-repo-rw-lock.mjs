import { resolve } from 'node:path';

const states = new Map();

function keyFor(repo) {
    const key = resolve(String(repo || '.'));
    return process.platform === 'win32' ? key.toLowerCase() : key;
}

function stateFor(key) {
    let state = states.get(key);
    if (!state) {
        state = { readers: 0, writer: false, queue: [] };
        states.set(key, state);
    }
    return state;
}

function drain(key, state) {
    if (state.writer) return;
    if (state.readers > 0 && state.queue[0]?.mode === 'write') return;
    if (state.queue.length === 0) {
        if (state.readers === 0) states.delete(key);
        return;
    }
    if (state.readers === 0 && state.queue[0].mode === 'write') {
        const entry = state.queue.shift();
        state.writer = true;
        entry.granted = true;
        entry.signal?.removeEventListener?.('abort', entry.onAbort);
        entry.resolve(releaseFor(key, state, 'write'));
        return;
    }
    while (state.queue[0]?.mode === 'read' && !state.writer) {
        const entry = state.queue.shift();
        state.readers++;
        entry.granted = true;
        entry.signal?.removeEventListener?.('abort', entry.onAbort);
        entry.resolve(releaseFor(key, state, 'read'));
    }
}

function releaseFor(key, state, mode) {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (mode === 'write') state.writer = false;
        else state.readers = Math.max(0, state.readers - 1);
        drain(key, state);
    };
}

function abortError(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    return Object.assign(new Error('git repository lock aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function acquire(repo, mode, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const key = keyFor(repo);
    const state = stateFor(key);
    return new Promise((resolveLock, rejectLock) => {
        const entry = { mode, resolve: resolveLock, reject: rejectLock, signal, onAbort: null, granted: false };
        entry.onAbort = () => {
            if (entry.granted) return;
            const index = state.queue.indexOf(entry);
            if (index >= 0) state.queue.splice(index, 1);
            signal?.removeEventListener?.('abort', entry.onAbort);
            rejectLock(abortError(signal));
            drain(key, state);
        };
        state.queue.push(entry);
        signal?.addEventListener?.('abort', entry.onAbort, { once: true });
        drain(key, state);
    });
}

async function withLock(repo, mode, fn, options = {}) {
    const signal = options?.signal || null;
    const release = await acquire(repo, mode, signal);
    try {
        if (signal?.aborted) throw abortError(signal);
        return await fn();
    } finally {
        release();
    }
}

export function withGitRepoReadLock(repo, fn, options = {}) {
    return withLock(repo, 'read', fn, options);
}

export function withGitRepoWriteLock(repo, fn, options = {}) {
    return withLock(repo, 'write', fn, options);
}
