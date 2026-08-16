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
        entry.resolve(releaseFor(key, state, 'write'));
        return;
    }
    while (state.queue[0]?.mode === 'read' && !state.writer) {
        const entry = state.queue.shift();
        state.readers++;
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

function acquire(repo, mode) {
    const key = keyFor(repo);
    const state = stateFor(key);
    return new Promise((resolveLock) => {
        state.queue.push({ mode, resolve: resolveLock });
        drain(key, state);
    });
}

async function withLock(repo, mode, fn) {
    const release = await acquire(repo, mode);
    try {
        return await fn();
    } finally {
        release();
    }
}

export function withGitRepoReadLock(repo, fn) {
    return withLock(repo, 'read', fn);
}

export function withGitRepoWriteLock(repo, fn) {
    return withLock(repo, 'write', fn);
}
