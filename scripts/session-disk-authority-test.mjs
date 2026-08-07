/**
 * session-disk-authority-test.mjs — the canonical session record is the ONLY
 * write/delete authority, and a stat that could not be made is never read as
 * absence.
 *
 * A1 an ordinary save (NO expectedGeneration) refuses to rename over a
 *    foreign / identity-less / ambiguous canonical record; a truly absent
 *    path still creates.
 * A2 the sweep requires record.id === row id: a foreign tombstone (however
 *    mature) is preserved, never deleted or upserted; an OWNED mature
 *    tombstone still reaps.
 * A3 markSessionClosed / bumpSessionGeneration refuse ambiguous or foreign
 *    bytes instead of rewriting them, and surface the cause.
 * A4 EACCES/EIO stat probes are classified as unreadable, not absent: the
 *    summary row survives, nothing is queued for deletion, and the file is
 *    not swept. Only ENOENT retires a row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-disk-authority-'));
process.env.MIXDOG_DATA_DIR = DATA_DIR;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
// Structural gate for the stat-probe fault seam (A4).
process.env.MIXDOG_SESSION_LOAD_FAULT_HOOKS = '1';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');
mkdirSync(SESSIONS_DIR, { recursive: true });

const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
const { _setStatProbeFaultHook } = await import('../src/runtime/agent/orchestrator/session/store/fs-probe.mjs');

const recordPath = (id) => join(SESSIONS_DIR, `${id}.json`);
const newSession = (id, extra = {}) => ({
    id,
    owner: 'user',
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ role: 'user', content: `content for ${id}` }],
    tools: [],
    ...extra,
});

test('A1 an unguarded save never overwrites a record it does not own', () => {
    const id = 'sess_authority_unguarded';
    const path = recordPath(id);
    const session = newSession(id);

    for (const [label, bytes] of [
        ['foreign identity', '{"id":"sess_some_other_owner","closed":false,"generation":0,"messages":[]}'],
        ['identity-less', '{"closed":false,"generation":0,"messages":[]}'],
        ['empty identity', '{"id":"","closed":false,"generation":0,"messages":[]}'],
        ['ambiguous lifecycle', `{"id":${JSON.stringify(id)},"closed":false,"closed":true,"generation":0}`],
        ['ambiguous status', `{"id":${JSON.stringify(id)},"status":"idle","status":"closed","messages":[]}`],
        ['ambiguous updatedAt', `{"id":${JSON.stringify(id)},"updatedAt":1,"updatedAt":2,"messages":[]}`],
        ['ambiguous messages', `{"id":${JSON.stringify(id)},"messages":[],"messages":[{"role":"user","content":"x"}]}`],
        ['malformed', '{"id":"sess_authority_unguarded","messa'],
    ]) {
        writeFileSync(path, bytes, 'utf8');
        // NO expectedGeneration: the ownership check is not opt-in.
        store.saveSession(session, { sync: true });
        assert.equal(readFileSync(path, 'utf8'), bytes, `${label}: canonical bytes untouched`);
        // ...and there is no opt-out either: the removed `allowClosed` bypass
        // must not be honoured by any surviving caller.
        store.saveSession(session, { sync: true, allowClosed: true });
        assert.equal(readFileSync(path, 'utf8'), bytes, `${label}: allowClosed cannot bypass ownership`);
    }

    // Control: a genuinely absent path is still created by the same call.
    rmSync(path);
    store.saveSession(session, { sync: true });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).id, id, 'absent → created');
});

test('A2 the sweep reaps an owned tombstone and preserves a foreign one', () => {
    const matured = Date.now() - 60 * 60 * 1000;
    const ownedId = 'sess_authority_owned_tombstone';
    const foreignId = 'sess_authority_foreign_tombstone';
    const owned = `{"id":"${ownedId}","closed":true,"generation":1,"updatedAt":${matured},"messages":[],"tools":[]}`;
    // Same mature-tombstone shape, but the record names a DIFFERENT session:
    // the file is not this id's record and may not be deleted or republished.
    const foreign = `{"id":"sess_authority_other_owner","closed":true,"generation":1,"updatedAt":${matured},"messages":[],"tools":[]}`;
    writeFileSync(recordPath(ownedId), owned, 'utf8');
    writeFileSync(recordPath(foreignId), foreign, 'utf8');

    const underTest = new Set([ownedId, foreignId]);
    // A record whose top-level keys are ambiguous is equally untouchable, even
    // when the duplicate is a non-lifecycle field the sweep acts on.
    const ambiguousId = 'sess_authority_ambiguous_status_tombstone';
    const ambiguous = `{"id":"${ambiguousId}","closed":true,"generation":1,"status":"closed","status":"idle","updatedAt":${matured},"messages":[]}`;
    writeFileSync(recordPath(ambiguousId), ambiguous, 'utf8');
    underTest.add(ambiguousId);
    store.sweepStaleSessions({
        ttlMs: 1,
        sweepIdle: true,
        sweepTombstones: true,
        tombstoneMaxAgeMs: 1,
        retainOpenSessions: false,
        isSessionLive: (id) => !underTest.has(id),
    });

    assert.equal(existsSync(recordPath(ownedId)), false, 'the owned mature tombstone is reaped');
    assert.equal(existsSync(recordPath(foreignId)), true, 'the foreign tombstone survives');
    assert.equal(readFileSync(recordPath(foreignId), 'utf8'), foreign, 'and is not rewritten');
    assert.equal(existsSync(recordPath(ambiguousId)), true, 'the duplicate-status tombstone survives');
    assert.equal(readFileSync(recordPath(ambiguousId), 'utf8'), ambiguous, 'and is not rewritten');
});

test('A3 the lifecycle barriers refuse ambiguous or foreign bytes', () => {
    for (const [id, bytes] of [
        ['sess_authority_close_ambiguous', '{"id":"sess_authority_close_ambiguous","closed":false,"generation":0,"generation":1,"messages":[]}'],
        ['sess_authority_close_foreign', '{"id":"sess_authority_close_other","closed":false,"generation":0,"messages":[]}'],
        ['sess_authority_close_torn', '{"id":"sess_authority_close_torn","closed":fals'],
    ]) {
        const path = recordPath(id);
        writeFileSync(path, bytes, 'utf8');
        assert.equal(store.markSessionClosed(id, 'authority-test'), null, `${id}: close refused`);
        assert.equal(readFileSync(path, 'utf8'), bytes, `${id}: bytes never rewritten by the tombstone`);
        assert.ok(store.getSessionLifecycleCommitError(id), `${id}: the refusal is surfaced, not silent`);
        assert.equal(store.bumpSessionGeneration(id, 'authority-test'), null, `${id}: detach refused`);
        assert.equal(readFileSync(path, 'utf8'), bytes, `${id}: bytes never rewritten by the detach`);
        store.clearSessionLifecycleCommitError(id);
    }
});

test('A4 an EACCES/EIO stat is unreadable, not absent', () => {
    const id = 'sess_authority_probe_fault';
    store.saveSession(newSession(id), { sync: true });
    const hasRow = (rows) => rows.some((row) => row.id === id);
    assert.equal(hasRow(store.listStoredSessionSummaries({ refreshFromStorage: true })), true, 'baseline row');

    const armed = _setStatProbeFaultHook((path) => (
        String(path).endsWith(`${id}.json`)
            ? Object.assign(new Error('injected stat fault'), { code: 'EIO' })
            : null
    ));
    assert.equal(armed, true, 'the probe fault seam is armed under its structural gate');
    try {
        // The row must NOT be dropped: an unreadable stat is not a deletion.
        assert.equal(
            hasRow(store.listStoredSessionSummaries({ refreshFromStorage: true })),
            true,
            'the summary row survives an unreadable stat',
        );
        // ...and the sweep must not delete the file or retire its row.
        store.sweepStaleSessions({
            ttlMs: 1,
            sweepIdle: true,
            sweepTombstones: true,
            tombstoneMaxAgeMs: 1,
            retainOpenSessions: false,
            isSessionLive: (candidate) => candidate !== id,
        });
        assert.equal(existsSync(recordPath(id)), true, 'an unreadable probe never authorizes a delete');
        assert.equal(
            hasRow(store.listStoredSessionSummaries({ refreshFromStorage: true })),
            true,
            'no summary removal was queued for it',
        );
    } finally {
        _setStatProbeFaultHook(null);
    }

    // Control: real absence (ENOENT) does retire the row.
    rmSync(recordPath(id));
    assert.equal(hasRow(store.listStoredSessionSummaries({ refreshFromStorage: true })), false, 'ENOENT retires the row');
});

test('A5 deleteSession refuses bytes that were replaced at the commit edge', () => {
    const id = 'sess_authority_delete_commit_edge';
    const path = recordPath(id);
    const foreign = '{"id":"sess_authority_delete_other","closed":false,"generation":0,"messages":[]}';
    const ambiguous = `{"id":"${id}","closed":false,"closed":true,"generation":0,"messages":[]}`;

    for (const [label, replacement] of [['foreign', foreign], ['ambiguous', ambiguous]]) {
        store.saveSession(newSession(id), { sync: true });
        assert.equal(existsSync(path), true, `${label}: own record in place`);
        // Swap the canonical bytes in the window between deleteSession's stat
        // probe and its strict re-read under the commit lock — the exact race
        // an unlink can never take back.
        let swaps = 0;
        const armed = _setStatProbeFaultHook((probed, phase) => {
            if (phase !== 'stat' || String(probed) !== path || swaps > 0) return null;
            swaps += 1;
            writeFileSync(path, replacement, 'utf8');
            return null; // the stat itself still succeeds
        });
        assert.equal(armed, true, 'commit-edge seam armed');
        let removed;
        try { removed = store.deleteSession(id); }
        finally { _setStatProbeFaultHook(null); }

        assert.equal(swaps, 1, `${label}: the commit-edge window was exercised`);
        assert.equal(removed, false, `${label}: nothing is deleted`);
        assert.equal(readFileSync(path, 'utf8'), replacement, `${label}: the replacement record survives`);
        rmSync(path);
    }

    // Control: an unswapped own record is still deleted by the same call.
    store.saveSession(newSession(id), { sync: true });
    assert.equal(store.deleteSession(id), true, 'an owned record still deletes');
    assert.equal(existsSync(path), false);
});

test('A6 the cold summary reader keeps its authority when storage cannot be read', async () => {
    const reader = await import('../src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
    // Own data dir: the store's best-effort summary-index writer must not
    // rewrite the sidecar this test uses as the retained authority.
    const coldDir = mkdtempSync(join(tmpdir(), 'mixdog-cold-reader-'));
    const coldSessions = join(coldDir, 'sessions');
    mkdirSync(coldSessions, { recursive: true });
    const previousDataDir = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = coldDir;
    try {
    const id = 'sess_cold_reader_authority';
    const path = join(coldSessions, `${id}.json`);
    const indexPath = join(coldDir, 'session-summaries.json');
    const now = Date.now();
    writeFileSync(path, JSON.stringify({
        id,
        owner: 'user',
        agent: 'lead',
        status: 'idle',
        closed: false,
        generation: 0,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
        messages: [{ role: 'user', content: 'cold reader row' }],
        tools: [],
    }), 'utf8');
    // Give the canonical bytes an older, stable fingerprint before recording
    // that exact fingerprint in the durable summary row.
    utimesSync(path, new Date(now - 10_000), new Date(now - 10_000));
    const initialFile = statSync(path);
    writeFileSync(indexPath, JSON.stringify({
        version: 2,
        rows: [{
            id,
            owner: 'user',
            agent: 'lead',
            status: 'idle',
            updatedAt: now,
            lastUsedAt: now,
            createdAt: now,
            messageCount: 1,
            preview: 'cold reader row',
            storageMtimeMs: initialFile.mtimeMs,
            storageSize: initialFile.size,
        }],
    }), 'utf8');
    utimesSync(indexPath, new Date(now), new Date(now));
    const hasRow = (rows) => rows.some((row) => row.id === id);
    assert.equal(hasRow(reader.listStoredSessionSummaries()), true, 'baseline: the row is catalogued');
    assert.equal(hasRow(reader.listStoredSessionSummaries({ refreshFromStorage: true })), true, 'baseline: scan sees it');

    let unchangedReads = 0;
    assert.equal(_setStatProbeFaultHook((probed, phase) => {
        if (phase === 'read' && String(probed) === path) unchangedReads += 1;
        return null;
    }), true, 'incremental read counter armed');
    try {
        assert.equal(hasRow(reader.listStoredSessionSummaries()), true);
    } finally {
        _setStatProbeFaultHook(null);
    }
    assert.equal(unchangedReads, 0, 'unchanged transcript bytes are not reopened');

    const withFault = (hook, run) => {
        assert.equal(_setStatProbeFaultHook(hook), true, 'cold-read seam armed');
        try { return run(); } finally { _setStatProbeFaultHook(null); }
    };
    const eio = () => Object.assign(new Error('injected cold-read fault'), { code: 'EIO' });

    // 1. The session FILE cannot be read: its last known row is retained.
    assert.equal(
        hasRow(withFault(
            (probed, phase) => (phase === 'read' && String(probed) === path ? eio() : null),
            () => reader.listStoredSessionSummaries({ refreshFromStorage: true }),
        )),
        true,
        'an unreadable session file retains its row instead of vanishing',
    );

    // 2. The sessions DIR cannot be enumerated: the index stays the authority.
    assert.equal(
        hasRow(withFault(
            (probed, phase) => (phase === 'stat' && String(probed) === coldSessions ? eio() : null),
            () => reader.listStoredSessionSummaries({ refreshFromStorage: true }),
        )),
        true,
        'an unreadable session dir never publishes an empty catalog',
    );

    // 3. The INDEX cannot be read: the authoritative files still answer, and
    //    the unreadable index is never treated as "missing/older" either.
    assert.equal(
        hasRow(withFault(
            (probed, phase) => (String(probed) === indexPath && (phase === 'read' || phase === 'stat') ? eio() : null),
            () => reader.listStoredSessionSummaries(),
        )),
        true,
        'an unreadable index falls back to the files, not to nothing',
    );

    // 4. A file newer than the index is the only row reparsed.
    writeFileSync(path, JSON.stringify({
        id,
        owner: 'user',
        agent: 'lead',
        status: 'idle',
        closed: false,
        generation: 0,
        createdAt: now,
        updatedAt: now + 20_000,
        lastUsedAt: now + 20_000,
        messages: [{ role: 'user', content: 'incremental reader changed row' }],
        tools: [],
    }), 'utf8');
    utimesSync(path, new Date(now + 20_000), new Date(now + 20_000));
    let changedReads = 0;
    assert.equal(_setStatProbeFaultHook((probed, phase) => {
        if (phase === 'read' && String(probed) === path) changedReads += 1;
        return null;
    }), true, 'changed read counter armed');
    let changedRows;
    try {
        changedRows = reader.listStoredSessionSummaries();
    } finally {
        _setStatProbeFaultHook(null);
    }
    assert.equal(changedReads, 1, 'the changed transcript is read exactly once');
    assert.match(changedRows.find((row) => row.id === id)?.preview || '', /incremental reader changed row/);

    // 5. Control: proven absence (ENOENT) does drop the row from the scan.
    rmSync(path);
    assert.equal(
        hasRow(reader.listStoredSessionSummaries({ refreshFromStorage: true })),
        false,
        'a genuinely deleted session leaves the catalog',
    );
    } finally {
        if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previousDataDir;
        rmSync(coldDir, { recursive: true, force: true });
    }
});
