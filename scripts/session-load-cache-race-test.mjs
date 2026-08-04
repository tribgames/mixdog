/**
 * session-load-cache-race-test.mjs — stat/read replacement race in the
 * session load cache (store/load-cache.mjs), driven by DETERMINISTIC fault
 * injection around the stat and read syscalls
 * (`_setSessionLoadFaultHook`). The hook performs REAL atomic renames /
 * unlinks between the two syscalls, so the reader observes exactly the
 * window an out-of-process writer produces.
 *
 * Invariants proven here:
 *   R1 a replacement landing between stat and read yields the NEW valid
 *      session (never {exists:true, session:null}).
 *   R2 a transient disappearance (unlink→rename window) never becomes false
 *      corruption or a null loadSession() once the replacement arrives.
 *   R3 a STABLE malformed file, and a stable id mismatch, stay invalid —
 *      external corruption keeps failing closed (loadSession → null).
 *   R4 a genuinely absent file reports {exists:false} after the bounded
 *      retries; a present-but-unreadable file reports {exists:true}.
 *   R5 cache signatures never pair new content with an old identity, and an
 *      unchanged file still reuses the parsed object.
 *   R6 a stat that fails with EACCES/EIO/EBUSY (present but unreadable) is
 *      never reported as absence — including for the stat that settles the
 *      bounded retries.
 *   R7 a replacement landing on the LAST boundary is parsed (or reported
 *      present-but-invalid), never false absence / null for readable bytes.
 *   R8 the fault-injection seam is structurally gated: without the explicit
 *      env gate a hook cannot be installed and an installed hook goes inert.
 *   R9 the race scenarios hold under repetition (no order/state dependence).
 *  R10 a read that ENOENTs on the LAST boundary while a replacement is
 *      already in place answers with the replacement, never present-null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-load-race-'));
process.env.MIXDOG_DATA_DIR = dataDir;
// Explicit fault-injection test mode. The load cache refuses to install (and
// refuses to run) its stat/read hooks unless this gate is set, so production
// cannot activate the seam by accident.
const FAULT_GATE = 'MIXDOG_SESSION_LOAD_FAULT_HOOKS';
process.env[FAULT_GATE] = '1';
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

const { _readStoredSessionCached, _setSessionLoadFaultHook, _inspectSessionLoadCache } =
    await import('../src/runtime/agent/orchestrator/session/store/load-cache.mjs');
const { loadSession } = await import('../src/runtime/agent/orchestrator/session/store.mjs');

const pathFor = (id) => join(sessionsDir, `${id}.json`);
const sessionOf = (id, text) => ({
    id,
    owner: 'user',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'assistant', content: text }],
});
const signatureOf = (path) => {
    const info = statSync(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
};
// Same shape as the store's own commit: write a scratch file, rename over
// the canonical path — a brand new inode replaces the old one.
const atomicWrite = (path, body) => {
    const tmp = `${path}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
    renameSync(tmp, path);
};
const cacheEntry = (path) => _inspectSessionLoadCache().find((row) => row.path === path);
const withHook = (hook, fn) => {
    const installed = _setSessionLoadFaultHook(hook);
    assert.equal(installed, true, 'the gated fault hook must install under the test gate');
    try { return fn(); } finally { _setSessionLoadFaultHook(null); }
};
const faultOf = (code) => Object.assign(new Error(`injected ${code}`), { code });

test('R1 a rename landing between stat and read returns the new valid session', () => {
    const id = 'sess_race_replace';
    const path = pathFor(id);
    atomicWrite(path, sessionOf(id, 'v1'));

    let replaced = false;
    const result = withHook(({ phase }) => {
        // The writer commits its rename after our stat, before our read.
        if (phase === 'read' && !replaced) {
            replaced = true;
            atomicWrite(path, sessionOf(id, 'v2'));
        }
    }, () => _readStoredSessionCached(id, path));

    assert.ok(replaced, 'the injected replacement actually ran');
    assert.equal(result.exists, true);
    assert.ok(result.session, 'a valid replacement must never read back as corruption');
    assert.equal(result.session.messages[0].content, 'v2', 'the NEW session content is returned');
    // R5: the cached signature describes the file the bytes came from.
    const entry = cacheEntry(path);
    assert.equal(entry.signature, signatureOf(path), 'cache signature matches the current inode');
    assert.equal(entry.session.messages[0].content, 'v2', 'no new content under an old identity');
});

test('R2 a transient disappearance is not corruption once the replacement arrives', () => {
    const id = 'sess_race_window';
    const path = pathFor(id);
    atomicWrite(path, sessionOf(id, 'v1'));

    let statCalls = 0;
    const result = withHook(({ phase }) => {
        if (phase !== 'stat') return;
        statCalls += 1;
        // Attempt 0 sees the unlink→rename hole; attempt 1 sees the new file.
        if (statCalls === 1) unlinkSync(path);
        else if (statCalls === 2 && !existsSync(path)) atomicWrite(path, sessionOf(id, 'v2'));
    }, () => _readStoredSessionCached(id, path));

    assert.equal(result.exists, true, 'a session present again must not report absent');
    assert.equal(result.session?.messages[0].content, 'v2');

    // Same window, observed through the public reader (store early gate).
    let statCalls2 = 0;
    const viaStore = withHook(({ phase }) => {
        if (phase !== 'stat') return;
        statCalls2 += 1;
        if (statCalls2 === 1) unlinkSync(path);
        else if (statCalls2 === 2 && !existsSync(path)) atomicWrite(path, sessionOf(id, 'v3'));
    }, () => loadSession(id));
    assert.ok(viaStore, 'loadSession must not go null across a replacement window');
    assert.equal(viaStore.messages[0].content, 'v3');
});

test('R3 stable malformed JSON and a stable id mismatch stay invalid (fail closed)', () => {
    const badId = 'sess_race_malformed';
    const badPath = pathFor(badId);
    atomicWrite(badPath, '{"id":"sess_race_malformed",'); // truncated by an external writer
    const malformed = _readStoredSessionCached(badId, badPath);
    assert.deepEqual(malformed, { exists: true, session: null }, 'stable corruption is still corruption');
    assert.equal(cacheEntry(badPath), undefined, 'invalid content is never cached');
    assert.equal(loadSession(badId), null, 'external corruption is not masked');

    const foreignId = 'sess_race_foreign';
    const foreignPath = pathFor(foreignId);
    atomicWrite(foreignPath, sessionOf('sess_someone_else', 'other'));
    const mismatch = _readStoredSessionCached(foreignId, foreignPath);
    assert.deepEqual(mismatch, { exists: true, session: null }, 'a foreign id owns the path, fail closed');
    assert.equal(loadSession(foreignId), null);
});

test('R4 absent stays absent; present-but-unreadable stays present', () => {
    const goneId = 'sess_race_absent';
    const gonePath = pathFor(goneId);
    assert.deepEqual(_readStoredSessionCached(goneId, gonePath), { exists: false, session: null });

    const id = 'sess_race_unreadable';
    const path = pathFor(id);
    atomicWrite(path, sessionOf(id, 'v1'));
    let reads = 0;
    const result = withHook(({ phase }) => {
        if (phase !== 'read') return undefined;
        reads += 1;
        return Object.assign(new Error('injected read fault'), { code: 'EIO' });
    }, () => _readStoredSessionCached(id, path));
    assert.ok(reads > 1, 'the read is retried a bounded number of times');
    assert.deepEqual(result, { exists: true, session: null }, 'an unreadable existing file owns its identity');
});

test('R5 an unchanged file reuses the cached object and a replaced one does not', () => {
    const id = 'sess_race_cache';
    const path = pathFor(id);
    atomicWrite(path, sessionOf(id, 'v1'));
    const first = _readStoredSessionCached(id, path);
    const second = _readStoredSessionCached(id, path);
    assert.equal(second.session, first.session, 'unchanged identity reuses the parsed object');

    atomicWrite(path, sessionOf(id, 'v2'));
    const third = _readStoredSessionCached(id, path);
    assert.equal(third.session.messages[0].content, 'v2', 'a new inode invalidates the cache');
    assert.equal(cacheEntry(path).signature, signatureOf(path));
});

test('R6 a stat failure that is not ENOENT is present-but-unreadable, never absence', () => {
    for (const code of ['EACCES', 'EIO', 'EBUSY']) {
        const id = `sess_race_stat_${code.toLowerCase()}`;
        const path = pathFor(id);
        atomicWrite(path, sessionOf(id, 'v1'));
        let stats = 0;
        const result = withHook(({ phase }) => {
            if (phase !== 'stat') return undefined;
            stats += 1;
            return faultOf(code);
        }, () => _readStoredSessionCached(id, path));
        assert.ok(stats > 1, `${code}: the stat is retried a bounded number of times`);
        assert.deepEqual(result, { exists: true, session: null }, `${code}: unreadable owns the identity`);
        assert.equal(cacheEntry(path), undefined, `${code}: nothing is cached from a failed stat`);
        const viaStore = withHook(({ phase }) => (phase === 'stat' ? faultOf(code) : undefined),
            () => loadSession(id));
        assert.equal(viaStore, null, `${code}: an unreadable file is not masked by live state`);

        // Same fault on a path with nothing at it: still fail closed. A stat
        // that could not answer must never be downgraded to {exists:false}.
        const ghostId = `sess_race_ghost_${code.toLowerCase()}`;
        const ghostPath = pathFor(ghostId);
        const ghost = withHook(({ phase }) => (phase === 'stat' ? faultOf(code) : undefined),
            () => _readStoredSessionCached(ghostId, ghostPath));
        assert.deepEqual(ghost, { exists: true, session: null }, `${code}: no live masking on an unanswerable stat`);
    }

    // ENOENT keeps its meaning: absence stays absence.
    const goneId = 'sess_race_stat_enoent';
    const gone = _readStoredSessionCached(goneId, pathFor(goneId));
    assert.deepEqual(gone, { exists: false, session: null }, 'ENOENT is real absence');
});

test('R7 a replacement landing on the last boundary is parsed, never false absence', () => {
    const id = 'sess_race_last_boundary';
    const path = pathFor(id);
    atomicWrite(path, sessionOf(id, 'v0'));

    // Every single attempt is destabilised: the writer commits a NEW inode
    // between this attempt's stat and its read, so no snapshot is ever stable
    // and the reader must decide on the final boundary.
    let reads = 0;
    const result = withHook(({ phase }) => {
        if (phase !== 'read') return undefined;
        reads += 1;
        atomicWrite(path, sessionOf(id, `v${reads}`));
        return undefined;
    }, () => _readStoredSessionCached(id, path));
    assert.ok(reads >= 5, 'every bounded attempt straddled a replacement');
    assert.equal(result.exists, true, 'a continuously replaced file is never absent');
    assert.ok(result.session, 'readable replacement bytes are parsed, not nulled');
    assert.equal(result.session.messages[0].content, `v${reads}`, 'the bytes actually read are returned');
    assert.equal(cacheEntry(path), undefined, 'an unverified identity is never cached');
    assert.ok(loadSession(id), 'the public reader does not go null across the last boundary');

    // Same last-boundary window, but the replacement is corrupt: conservative
    // present-but-invalid (fail closed), still not absence.
    const badId = 'sess_race_last_boundary_bad';
    const badPath = pathFor(badId);
    atomicWrite(badPath, sessionOf(badId, 'v0'));
    let badReads = 0;
    const bad = withHook(({ phase }) => {
        if (phase !== 'read') return undefined;
        badReads += 1;
        atomicWrite(badPath, `{"id":"${badId}",`);
        return undefined;
    }, () => _readStoredSessionCached(badId, badPath));
    assert.deepEqual(bad, { exists: true, session: null }, 'corrupt last-boundary bytes fail closed');
    assert.equal(cacheEntry(badPath), undefined, 'invalid content is never cached');

    // Deleted on the last boundary: settled from a real observation, so the
    // absence is reported without a second existence probe.
    const goneId = 'sess_race_last_boundary_gone';
    const gonePath = pathFor(goneId);
    atomicWrite(gonePath, sessionOf(goneId, 'v0'));
    const gone = withHook(({ phase }) => {
        if (phase === 'read' && existsSync(gonePath)) unlinkSync(gonePath);
        return undefined;
    }, () => _readStoredSessionCached(goneId, gonePath));
    assert.deepEqual(gone, { exists: false, session: null }, 'a real deletion settles as absent');
});

test('R8 fault hooks are structurally gated to explicit test mode', () => {
    const id = 'sess_race_gate';
    const path = pathFor(id);
    atomicWrite(path, sessionOf(id, 'v1'));

    let calls = 0;
    const hook = () => { calls += 1; return faultOf('EIO'); };

    // Gate off at install time: installation is refused outright.
    delete process.env[FAULT_GATE];
    try {
        assert.equal(_setSessionLoadFaultHook(hook), false, 'no hook can be installed without the gate');
        const result = _readStoredSessionCached(id, path);
        assert.equal(calls, 0, 'an ungated hook is never invoked');
        assert.equal(result.session?.messages[0].content, 'v1', 'production path reads normally');
    } finally {
        process.env[FAULT_GATE] = '1';
    }

    // Gate revoked AFTER a legitimate install: the seam goes inert instead of
    // staying armed in a process that is no longer in test mode.
    assert.equal(_setSessionLoadFaultHook(hook), true, 'install succeeds under the gate');
    delete process.env[FAULT_GATE];
    try {
        atomicWrite(path, sessionOf(id, 'v2'));
        const result = _readStoredSessionCached(id, path);
        assert.equal(calls, 0, 'a revoked gate disarms an already-installed hook');
        assert.equal(result.session?.messages[0].content, 'v2');
    } finally {
        process.env[FAULT_GATE] = '1';
        _setSessionLoadFaultHook(null);
    }

    // The disarm is permanent for that reference: re-enabling the gate does
    // not resurrect the dropped hook.
    const after = _readStoredSessionCached(id, path);
    assert.equal(calls, 0, 'the dropped hook stays dropped');
    assert.equal(after.exists, true);
});

test('R9 the race invariants hold under repetition', () => {
    for (let round = 0; round < 25; round++) {
        const id = `sess_race_repeat_${round}`;
        const path = pathFor(id);
        atomicWrite(path, sessionOf(id, 'v1'));

        // Replacement between stat and read.
        let replaced = false;
        const replacedResult = withHook(({ phase }) => {
            if (phase === 'read' && !replaced) {
                replaced = true;
                atomicWrite(path, sessionOf(id, 'v2'));
            }
            return undefined;
        }, () => _readStoredSessionCached(id, path));
        assert.equal(replacedResult.session?.messages[0].content, 'v2', `round ${round}: new content`);
        assert.equal(cacheEntry(path).signature, signatureOf(path), `round ${round}: signature matches inode`);

        // unlink → rename hole.
        let stats = 0;
        const windowResult = withHook(({ phase }) => {
            if (phase !== 'stat') return undefined;
            stats += 1;
            if (stats === 1) unlinkSync(path);
            else if (stats === 2 && !existsSync(path)) atomicWrite(path, sessionOf(id, 'v3'));
            return undefined;
        }, () => _readStoredSessionCached(id, path));
        assert.equal(windowResult.exists, true, `round ${round}: never false absence`);
        assert.equal(windowResult.session?.messages[0].content, 'v3', `round ${round}: replacement wins`);

        // Unreadable stat stays present.
        const unreadable = withHook(({ phase }) => (phase === 'stat' ? faultOf('EACCES') : undefined),
            () => _readStoredSessionCached(id, path));
        assert.deepEqual(unreadable, { exists: true, session: null }, `round ${round}: EACCES fails closed`);

        unlinkSync(path);
        assert.deepEqual(_readStoredSessionCached(id, path), { exists: false, session: null },
            `round ${round}: real absence after delete`);
    }
});

test('R10 a final-boundary read ENOENT with a replacement present returns the replacement', () => {
    const id = 'sess_race_final_enoent';
    const path = pathFor(id);
    atomicWrite(path, sessionOf(id, 'v0'));

    // Attempts 0-3 never stabilise (transient read faults). On the FINAL
    // attempt the inode vanishes under the read (ENOENT) and a valid
    // replacement lands before the decisive observation.
    let vanished = false;
    let replaced = false;
    const result = withHook(({ phase, attempt }) => {
        if (phase === 'read') {
            if (attempt < 4) return faultOf('EIO');
            if (!vanished) {
                vanished = true;
                unlinkSync(path);
            }
            return undefined;
        }
        if (phase === 'stat' && vanished && !replaced && !existsSync(path)) {
            replaced = true;
            atomicWrite(path, sessionOf(id, 'v-replacement'));
        }
        return undefined;
    }, () => _readStoredSessionCached(id, path));

    assert.ok(vanished && replaced, 'the injected vanish + replacement actually ran');
    assert.equal(result.exists, true, 'a present replacement is never absence');
    assert.ok(result.session, 'readable replacement bytes are parsed, not reported as corruption');
    assert.equal(result.session.messages[0].content, 'v-replacement');
    assert.equal(cacheEntry(path), undefined, 'an unverified identity is never cached');
    assert.ok(loadSession(id), 'the public reader does not go null on the last boundary');
});
