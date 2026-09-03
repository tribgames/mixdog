/**
 * session-save-fault-store-test.mjs — atomic-save failure semantics of the
 * session store, driven by NON-DESTRUCTIVE commit-fault injection
 * (store/save-fault.mjs): the rename is refused BEFORE it runs, so the
 * canonical destination is never deleted or replaced by the test rig itself.
 * The seam is structurally gated to explicit test mode
 * (MIXDOG_SESSION_SAVE_FAULT_HOOKS=1) — there is no env-driven fault config.
 *
 * Invariants proven here (all regressions of a real fault-injection finding):
 *   C1 canonical integrity — a failed save leaves the last-good `<id>.json`
 *      byte-identical, and the failure is SURFACED (throws), never silent.
 *   C2 live read-after-failure — loadSession/getSession keep serving the
 *      newest same-process snapshot, including when the on-disk file is
 *      unreadable, because the save error proves disk is behind.
 *   C3 no idle eviction of that only-good in-memory state.
 *   C4 unrelated/external corruption is NOT masked by the live cache.
 *   C5 summary/generation ownership safety — a failed save neither bumps the
 *      on-disk generation/tombstone nor publishes its summary row.
 *   C6 later successful re-save clears the error and re-enables eviction.
 *   C7 no durable `sessions/<id>.json.*.tmp` orphan survives bounded cleanup;
 *      the sweeper only retries scratch paths THIS realm registered, matches
 *      only the store's exact scratch pattern, is bounded per pass, and never
 *      scans (so a foreign/worker ACTIVE scratch file is never touched).
 *   C8-C11 the same contract on the ASYNC paths: worker failures keep the
 *      original code/marker, are recorded BEFORE waiter rejection, pin live
 *      state, and are cleared ONLY by a landed (`saved === true`) write; an
 *      ownership-dropped write clears nothing; fault state is pushed to the
 *      long-lived worker (no spawn-time snapshot), clearing stops it, and
 *      without the structural gate the seam cannot be armed at all.
 *   C12 exit drain flushes the NEWEST (`queued || payload`) snapshot.
 *   C13 a failed durable lifecycle barrier (tombstone/detach commit) is never
 *      reported as a close: no checkpoint clear, no runtime close, no provider
 *      abort, and the cause is surfaced.
 *   C14 save identity — an OLDER worker write that lands after a NEWER save
 *      failed must not clear the id's error/drop markers (live pin survives,
 *      idle eviction still refuses to drop the newest transcript).
 *   C15 worker identity — a dead worker's late exit/error events cannot
 *      reject, clear or ref-count the pending writes of its replacement.
 *   C16 the exit drain honours ONE absolute deadline across every locked id
 *      (waits + commit acquisitions), failing loudly (live-pinned) instead of
 *      blocking process exit or paying that budget per session.
 *   C17 scratch cleanup drains the WHOLE registry in bounded chunks at exit,
 *      and a failing unlink retains retry ownership instead of leaking.
 *   C18 the drain ranks snapshots by SAVE EPOCH, not by source: an older
 *      deferred snapshot never outranks a newer pending save, and when it is
 *      the only candidate it is written under its OWN epoch, so it cannot
 *      clear a newer failure's markers or permit eviction (failed-newer
 *      control: nothing newer LANDED, so the older snapshot is still strict
 *      progress over the last-good file and may commit).
 *   C19 the worker-detach seam is structurally gated and settles in-flight
 *      work (waiter rejected, failure recorded, ref released) — no orphan.
 *   C20 write authority is fenced by the LANDED epoch: a drain payload older
 *      than a save that already succeeded is refused before it touches
 *      canonical bytes, so durable history is never reverted.
 *   C21 the same fence at the worker boundary — an older worker write that
 *      finishes after a newer sync write cannot rename over it.
 *   C22 a stale-epoch refusal is NOT an ownership drop: canonical bytes are
 *      unchanged, no drop marker, no save error, and the live snapshot stays
 *      immediately evictable.
 *   C23 the landed-epoch fence is stored/compared without wrapping: epochs
 *      past 2^31 and up to the practical (safe-integer) limit compare
 *      correctly, and a lower publish never lowers the bar.
 *   C24 a deferred usage-metrics snapshot has NO exit flush of its own: it is
 *      registered with the canonical drain, so it cannot overwrite a newer
 *      landed session, cannot resurrect past a lifecycle barrier, and a
 *      genuinely newest metrics snapshot still persists.
 *   C25 hard delete purges parked metrics state synchronously: neither the
 *      throttle timer nor the exit drain can resurrect the unlinked file.
 *   C26 a rejected metrics save re-parks the NEWEST snapshot (never the
 *      rejected closure) and retries under the PRESERVED identity, so it can
 *      never outrank a session save that landed in between.
 *   C27 a save settling AFTER a hard delete creates nothing — no deferred
 *      entry, no timer, no retry, no file — through drain and timer windows,
 *      and every marker (error/drop/live/pending/deferred) stays purged.
 *   C28 at equal issuance identity the drain keeps the newest DISTINCT
 *      payload (parked revision beats the in-flight one), never Map order;
 *      and the drain settlement is TERMINAL — no repark/retry may overwrite a
 *      save made after it.
 *   C29 a failed canonical unlink is not a delete: nothing is purged or
 *      closed, and the pending metrics identity stays persistable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Store scratch files ONLY (`<id>.json.<12 hex>.tmp`) — deliberately-foreign
// `.tmp` fixtures planted by the cleanup subtest must not count as orphans.
const listTmp = (dir) => readdirSync(dir).filter((f) => /^[A-Za-z0-9_-]+\.json\.[0-9a-f]{12}\.tmp$/.test(f));
// Structural gate for the commit-fault seam: without it the store refuses to
// arm a fault at all (proven in C11).
const FAULT_GATE = 'MIXDOG_SESSION_SAVE_FAULT_HOOKS';

test('a failed atomic save surfaces, preserves disk + live state, and leaks no scratch file', async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-save-fault-'));
    process.env.MIXDOG_DATA_DIR = dataDir;
    process.env[FAULT_GATE] = '1';
    try {
        const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
        const { _registerOrphanSaveTmp } = await import('../src/runtime/agent/orchestrator/session/store/save-fault.mjs');
        const { _nextSaveEpoch } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
        const {
            saveSession,
            saveSessionAsync,
            saveSessionAsyncDeferred,
            loadSession,
            setLiveSession,
            evictIdleLiveSessions,
            getSessionSaveError,
            getSessionLifecycleCommitError,
            readSessionLifecycleFromDisk,
            listStoredSessionSummaries,
            markSessionClosed,
            bumpSessionGeneration,
            drainSessionStore,
            _savePending,
            setSessionSaveFault,
            sweepOrphanSessionTmpFiles,
        } = store;
        const { deleteSession } = store;

        const sessionsDir = join(dataDir, 'sessions');
        const id = 'sess_save_fault_commit';
        const diskPath = join(sessionsDir, `${id}.json`);
        const now = Date.now();
        const session = {
            id,
            owner: 'user',
            status: 'idle',
            createdAt: now,
            updatedAt: now,
            messages: [
                { role: 'user', content: 'ask once' },
                { role: 'assistant', content: 'durable answer' },
            ],
        };

        // Baseline: one landed save is the last-good canonical JSON.
        saveSession(session, { sync: true });
        const canonical = readFileSync(diskPath, 'utf8');
        assert.equal(JSON.parse(canonical).messages.length, 2);
        const baselineRow = listStoredSessionSummaries({ refreshFromStorage: true })
            .find((row) => row.id === id);
        assert.ok(baselineRow, 'baseline summary row exists');

        // Newest turn, then a single injected commit fault for THIS id only.
        session.messages.push(
            { role: 'user', content: 'ask again' },
            { role: 'assistant', content: 'newest turn' },
        );
        session.updatedAt = Date.now();
        setSessionSaveFault({ ids: id, count: 1 });

        await t.test('C1 the failure surfaces and the canonical file is untouched', () => {
            assert.throws(
                () => saveSession(session, { sync: true }),
                /injected save commit fault/,
                'an impossible save must surface, not silently succeed',
            );
            assert.equal(readFileSync(diskPath, 'utf8'), canonical, 'last-good JSON preserved byte for byte');
            assert.equal(JSON.parse(readFileSync(diskPath, 'utf8')).messages.length, 2);
            assert.ok(getSessionSaveError(id), 'save error recorded for the id');
        });

        await t.test('C7 the failed save leaves no scratch orphan', () => {
            assert.deepEqual(listTmp(sessionsDir), [], 'no sessions/<id>.json.*.tmp survives the failure');
        });

        await t.test('C2 the newest live snapshot stays readable after the failure', () => {
            assert.equal(loadSession(id).messages.length, 4);
            assert.equal(loadSession(id).messages.at(-1).content, 'newest turn');
        });

        await t.test('C3 idle eviction cannot drop the only-good in-memory state', () => {
            evictIdleLiveSessions({ isSessionLive: () => false });
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(id).messages.length, 4, 'live snapshot survives the idle sweep');
        });

        await t.test('C5 a failed save owns neither generation nor summary row', () => {
            const lifecycle = readSessionLifecycleFromDisk(id);
            assert.equal(lifecycle.generation, 0, 'no ownership/generation bump from a failed save');
            assert.equal(lifecycle.closed, false, 'no tombstone planted by a failed save');
            const row = listStoredSessionSummaries().find((r) => r.id === id);
            assert.equal(row.messageCount, baselineRow.messageCount, 'summary row still reflects durable state');
            assert.equal(row.generation, 0);
        });

        await t.test('C2/C4 an unreadable file is masked ONLY by the snapshot whose own save failed', () => {
            // Torn/foreign bytes at the canonical path of the failed-save id:
            // the snapshot THIS process failed to write is the only good copy,
            // so readers must see it.
            writeFileSync(diskPath, '{"id":"sess_save_fault_commit","messa', 'utf8');
            assert.equal(loadSession(id).messages.length, 4, 'save failure lets the live snapshot serve reads');
            // The recovery is narrow: it never opens the DURABLE authorities.
            // Lifecycle/pending ownership still read the record itself and
            // must keep failing closed on the unreadable bytes.
            assert.equal(
                store.readSessionLifecycleStateFromDisk(id).state,
                'unreadable',
                'the durable lifecycle authority still sees an unreadable record',
            );

            // Control 1: same corruption, but NO local save failure — external
            // disk corruption must never be masked by in-memory state.
            const externalId = 'sess_external_corruption';
            const externalPath = join(sessionsDir, `${externalId}.json`);
            const external = {
                id: externalId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'external' }],
            };
            saveSession(external, { sync: true });
            assert.equal(getSessionSaveError(externalId), null);
            assert.equal(loadSession(externalId).messages.length, 1);
            writeFileSync(externalPath, 'not json at all', 'utf8');
            assert.equal(loadSession(externalId), null, 'unrelated corruption is reported, not masked');
            // The live snapshot for that id is still resident (setLiveSession
            // ran on the successful save) — generic in-memory state proves
            // nothing about disk and may not stand in for it.
            assert.equal(loadSession(externalId), null, 'a live snapshot alone never masks corruption');

            // Control 2: an id this process only ever held in memory (no save
            // attempt at all) plus an AMBIGUOUS record — still reported.
            const liveOnlyId = 'sess_live_only_ambiguous';
            const liveOnlyPath = join(sessionsDir, `${liveOnlyId}.json`);
            setLiveSession({
                id: liveOnlyId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'memory only' }],
            });
            writeFileSync(liveOnlyPath, `{"id":"${liveOnlyId}","closed":false,"closed":true,"generation":0}`, 'utf8');
            assert.equal(getSessionSaveError(liveOnlyId), null, 'no failed save was recorded for this id');
            assert.equal(loadSession(liveOnlyId), null, 'an ambiguous record is never masked by live state');
        });

        await t.test('C30 the recovery snapshot is an immutable point-in-time copy, retired by a hard delete', () => {
            // The canonical file is still the torn record written by C2/C4.
            // (a) MUTATION control: the live object keeps changing after the
            //     failure; the fallback must reproduce the payload that was
            //     actually attempted, never a later state disk never saw.
            session.messages.push({ role: 'user', content: 'mutated after the failed save' });
            const served = loadSession(id);
            assert.equal(served.messages.length, 4, 'the attempted payload is served, not the mutated live object');
            assert.doesNotMatch(JSON.stringify(served), /mutated after the failed save/);
            // A reader mutating what it got back cannot edit the evidence.
            served.messages.push({ role: 'assistant', content: 'reader mutation' });
            assert.equal(loadSession(id).messages.length, 4, 'the stored snapshot is not aliased to any reader');
            session.messages.pop();

            // (b) DELETE/REUSE control: a hard delete retires the snapshot with
            //     the file, so a re-created id can never inherit it.
            const reuseId = 'sess_delete_snapshot_reuse';
            const reusePath = join(sessionsDir, `${reuseId}.json`);
            const reuseSession = {
                id: reuseId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'first incarnation' }],
            };
            saveSession(reuseSession, { sync: true });
            setSessionSaveFault({ ids: reuseId, count: 1 });
            reuseSession.messages.push({ role: 'assistant', content: 'never landed' });
            assert.throws(() => saveSession(reuseSession, { sync: true }), /injected save commit fault/);
            setSessionSaveFault(null);
            assert.ok(getSessionSaveError(reuseId), 'the failed save recorded its snapshot');
            assert.equal(deleteSession(reuseId), true, 'the record is hard-deleted');
            assert.equal(getSessionSaveError(reuseId), null, 'the delete purged the failure evidence');

            const recreated = {
                id: reuseId,
                owner: 'user',
                status: 'idle',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [{ role: 'user', content: 'second incarnation' }],
            };
            saveSession(recreated, { sync: true });
            writeFileSync(reusePath, 'not json at all', 'utf8');
            assert.equal(loadSession(reuseId), null, 'a re-created id inherits no retired snapshot');
            rmSync(reusePath);
        });

        await t.test('C6 a repaired canonical path lets the next save land and clears the error', () => {
            // The record from C2/C4 is still unreadable, so ownership cannot be
            // established: an ordinary save must NOT rename over it, even
            // though the fault budget is spent and the write itself would work.
            const torn = readFileSync(diskPath, 'utf8');
            saveSession(session, { sync: true });
            assert.equal(readFileSync(diskPath, 'utf8'), torn, 'no save overwrites an unreadable record');
            assert.ok(getSessionSaveError(id), 'the failure marker survives a refused write');
            assert.equal(loadSession(id).messages.length, 4, 'and the only-good snapshot is still served');

            // Repair (operator/other writer removes the corrupt file): the
            // canonical path is now absent, so the same save creates it.
            rmSync(diskPath);
            saveSession(session, { sync: true });
            const stored = JSON.parse(readFileSync(diskPath, 'utf8'));
            assert.equal(stored.messages.length, 4);
            assert.equal(stored.messages.at(-1).content, 'newest turn');
            assert.equal(getSessionSaveError(id), null, 'save error cleared by the successful commit');
            assert.deepEqual(listTmp(sessionsDir), [], 'successful commit consumes its scratch file');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(id).messages.length, 4, 'durable disk copy serves reads after eviction');
        });

        await t.test('C7 bounded scratch cleanup: registry-only, exact pattern, no scan', () => {
            const registered = join(sessionsDir, `${id}.json.aaaaaaaaaaaa.tmp`);
            const foreignActive = join(sessionsDir, `${id}.json.bbbbbbbbbbbb.tmp`);
            const misnamed = join(sessionsDir, `${id}.json.notahexname.tmp`);
            const unrelated = join(sessionsDir, 'editor-scratch.txt');
            for (const p of [registered, foreignActive, misnamed, unrelated]) writeFileSync(p, 'scratch', 'utf8');

            // Only a path THIS realm minted and failed to unlink is reclaimed.
            _registerOrphanSaveTmp(registered);
            assert.equal(sweepOrphanSessionTmpFiles(), 1, 'the abandoned scratch file is reclaimed');
            assert.equal(existsSync(registered), false);

            // No directory scan: an unregistered scratch file may be the save
            // worker's or another process's ACTIVE commit.
            assert.equal(sweepOrphanSessionTmpFiles(), 0, 'nothing is discovered, nothing else is removed');
            assert.equal(existsSync(foreignActive), true, 'a possibly in-flight scratch file is left alone');
            assert.equal(existsSync(misnamed), true, 'non-store naming is never touched');
            assert.equal(existsSync(unrelated), true, 'unrelated files are never touched');

            // A registered path that is not the store's exact scratch naming
            // is dropped from the registry, never unlinked.
            _registerOrphanSaveTmp(misnamed);
            assert.equal(sweepOrphanSessionTmpFiles(), 0);
            assert.equal(existsSync(misnamed), true);

            // `limit` bounds the paths retried per pass.
            const capped = [];
            for (let i = 0; i < 4; i += 1) {
                const p = join(sessionsDir, `${id}.json.dddddddddd0${i}.tmp`);
                writeFileSync(p, 'scratch', 'utf8');
                _registerOrphanSaveTmp(p);
                capped.push(p);
            }
            assert.equal(sweepOrphanSessionTmpFiles({ limit: 2 }), 2, 'attempt cap bounds the pass');
            assert.equal(capped.filter((p) => existsSync(p)).length, 2);
            assert.equal(sweepOrphanSessionTmpFiles(), 2);
            assert.equal(existsSync(unrelated), true);
            // Leave the directory as the later subtests expect it.
            for (const p of [foreignActive, misnamed, unrelated]) rmSync(p, { force: true });
            assert.deepEqual(listTmp(sessionsDir), []);
        });

        await t.test('C8 async worker failure keeps identity, records before rejecting, pins live state', async () => {
            const asyncId = 'sess_save_fault_async';
            const asyncPath = join(sessionsDir, `${asyncId}.json`);
            const asyncSession = {
                id: asyncId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'a1' }],
            };
            await saveSessionAsync(asyncSession);
            const goodBytes = readFileSync(asyncPath, 'utf8');

            asyncSession.messages.push({ role: 'assistant', content: 'a2-live-only' });
            asyncSession.updatedAt = Date.now();
            setSessionSaveFault({ ids: asyncId, count: 1 });
            let recordedBeforeRejection = null;
            await assert.rejects(saveSessionAsync(asyncSession), (err) => {
                recordedBeforeRejection = getSessionSaveError(asyncId);
                assert.equal(err.code, 'EIO', 'worker error code survives the thread boundary');
                assert.equal(err.injectedSaveFault, true, 'injection marker survives the thread boundary');
                return /injected save commit fault/.test(err.message);
            });
            assert.ok(recordedBeforeRejection, 'failure recorded BEFORE the waiter was rejected');
            assert.equal(readFileSync(asyncPath, 'utf8'), goodBytes, 'canonical file untouched by the worker fault');
            assert.deepEqual(listTmp(sessionsDir), [], 'worker realm leaves no scratch orphan');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(asyncId).messages.length, 2, 'live snapshot pinned after the async failure');

            await saveSessionAsync(asyncSession);
            assert.equal(getSessionSaveError(asyncId), null, 'a landed worker write clears the failure');
            assert.equal(JSON.parse(readFileSync(asyncPath, 'utf8')).messages.length, 2);
        });

        await t.test('C9 an ownership-dropped (saved=false) write clears nothing', async () => {
            const dropId = 'sess_save_fault_dropped';
            const dropPath = join(sessionsDir, `${dropId}.json`);
            const dropSession = {
                id: dropId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'd1' }],
            };
            await saveSessionAsync(dropSession);
            assert.equal(bumpSessionGeneration(dropId, 'test-detach'), 1);
            setLiveSession(dropSession);
            const afterBump = readFileSync(dropPath, 'utf8');

            dropSession.messages.push({ role: 'assistant', content: 'd2-live-only' });
            setSessionSaveFault({ ids: dropId, count: 1 });
            await assert.rejects(saveSessionAsync(dropSession, { expectedGeneration: 1 }));
            assert.ok(getSessionSaveError(dropId), 'async failure recorded');
            assert.equal(readFileSync(dropPath, 'utf8'), afterBump);

            // Stale ownership: the worker DROPS the write (ok:true, saved:false).
            await saveSessionAsync(dropSession, { expectedGeneration: 0 });
            assert.ok(getSessionSaveError(dropId), 'a dropped write must not clear the save failure');
            assert.equal(readFileSync(dropPath, 'utf8'), afterBump, 'a dropped write writes nothing');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(dropId).messages.length, 2, 'live snapshot still pinned');

            await saveSessionAsync(dropSession, { expectedGeneration: 1 });
            assert.equal(getSessionSaveError(dropId), null, 'only a landed write clears it');
            assert.equal(JSON.parse(readFileSync(dropPath, 'utf8')).messages.length, 2);
        });

        await t.test('C10 deferred saves surface and record the fault', async () => {
            const defId = 'sess_save_fault_deferred';
            const defPath = join(sessionsDir, `${defId}.json`);
            const defSession = {
                id: defId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'f1' }],
            };
            await saveSessionAsyncDeferred(defSession);
            const goodBytes = readFileSync(defPath, 'utf8');
            defSession.messages.push({ role: 'assistant', content: 'f2-live-only' });
            setSessionSaveFault({ ids: defId, count: 1 });
            await assert.rejects(saveSessionAsyncDeferred(defSession), (err) => err.injectedSaveFault === true);
            assert.ok(getSessionSaveError(defId), 'deferred failure recorded');
            assert.equal(readFileSync(defPath, 'utf8'), goodBytes);
            await saveSessionAsyncDeferred(defSession);
            assert.equal(getSessionSaveError(defId), null);
            assert.equal(JSON.parse(readFileSync(defPath, 'utf8')).messages.length, 2);
        });

        await t.test('C11 worker fault state is pushed, clearing stops it, and the seam is gated', async () => {
            const syncId = 'sess_save_fault_sync';
            const syncPath = join(sessionsDir, `${syncId}.json`);
            const syncSession = {
                id: syncId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 's1' }],
            };
            await saveSessionAsync(syncSession);

            // Budget deliberately larger than the number of attempts: only an
            // explicit CLEAR may stop it.
            setSessionSaveFault({ ids: syncId, count: 5 });
            await assert.rejects(saveSessionAsync(syncSession));
            setSessionSaveFault(null);
            syncSession.messages.push({ role: 'assistant', content: 's2' });
            await saveSessionAsync(syncSession);
            assert.equal(getSessionSaveError(syncId), null, 'clearing stops worker-realm faults immediately');
            assert.equal(JSON.parse(readFileSync(syncPath, 'utf8')).messages.length, 2);

            // Structural gate: outside explicit test mode the seam cannot be
            // armed at all, in this realm or the worker's — no environment can
            // make a production save fail.
            delete process.env[FAULT_GATE];
            try {
                assert.equal(setSessionSaveFault({ ids: syncId, count: 1 }), false, 'ungated arming is refused');
                syncSession.messages.push({ role: 'user', content: 's3' });
                await saveSessionAsync(syncSession);
                assert.equal(getSessionSaveError(syncId), null, 'no fault is injectable without the gate');
                assert.equal(JSON.parse(readFileSync(syncPath, 'utf8')).messages.length, 3);
            } finally {
                process.env[FAULT_GATE] = '1';
            }
        });

        await t.test('C12 the exit drain flushes the NEWEST queued snapshot', () => {
            const drainId = 'sess_save_fault_drain';
            const drainPath = join(sessionsDir, `${drainId}.json`);
            const base = {
                id: drainId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'older-payload' }],
            };
            saveSession(base, { sync: true });
            const older = { session: { ...base, messages: [...base.messages] }, opts: null, summaryVersion: null };
            const newer = {
                session: { ...base, updatedAt: Date.now(), messages: [...base.messages, { role: 'assistant', content: 'newest-queued' }] },
                opts: null,
                summaryVersion: null,
            };
            // Slots carry their issue identity: the drain ranks by epoch, so
            // the queued follow-up must be issued AFTER the in-flight payload.
            older.epoch = _nextSaveEpoch();
            newer.epoch = _nextSaveEpoch();
            // Exactly the in-flight + latest-wins-queued shape saveSession
            // builds while a write is on disk.
            _savePending.set(drainId, { writing: true, payload: older, queued: newer });
            drainSessionStore();
            const drained = JSON.parse(readFileSync(drainPath, 'utf8'));
            assert.equal(drained.messages.length, 2, 'drain must not discard the queued snapshot');
            assert.equal(drained.messages.at(-1).content, 'newest-queued');
        });

        await t.test('C13 a failed durable lifecycle barrier is never reported as a close', async () => {
            const closeId = 'sess_save_fault_close';
            const closePath = join(sessionsDir, `${closeId}.json`);
            const { closeSession } = await import('../src/runtime/agent/orchestrator/session/manager/session-close.mjs');
            const { _touchRuntime } = await import('../src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');
            const closeTarget = {
                id: closeId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'c1' }],
            };
            saveSession(closeTarget, { sync: true });
            const goodBytes = readFileSync(closePath, 'utf8');
            const entry = _touchRuntime(closeId);
            const controller = new AbortController();
            entry.controller = controller;
            entry.session = closeTarget;

            setSessionSaveFault({ ids: closeId, count: 1 });
            assert.equal(closeSession(closeId, 'fault-test'), false, 'a failed barrier is not a close');
            assert.equal(controller.signal.aborted, false, 'provider/controller not aborted');
            assert.notEqual(entry.closed, true, 'runtime not marked closed');
            const commitError = getSessionLifecycleCommitError(closeId);
            assert.ok(commitError, 'the barrier failure is surfaced');
            assert.equal(commitError.code, 'EIO');
            assert.equal(readFileSync(closePath, 'utf8'), goodBytes, 'session file stays open and resumable');
            assert.equal(readSessionLifecycleFromDisk(closeId).closed, false);
            assert.equal(readSessionLifecycleFromDisk(closeId).generation, 0, 'no generation bump from a failed barrier');
            assert.ok(getSessionSaveError(closeId), 'live state pinned after the failed barrier');
            assert.deepEqual(listTmp(sessionsDir), [], 'failed barrier leaves no scratch orphan');

            // Detach barrier obeys the same contract.
            setSessionSaveFault({ ids: closeId, count: 1 });
            assert.equal(bumpSessionGeneration(closeId, 'fault-detach'), null);
            assert.ok(getSessionLifecycleCommitError(closeId), 'detach failure surfaced');
            assert.equal(readSessionLifecycleFromDisk(closeId).generation, 0);

            // Fault budget spent: the close now lands and reports success.
            assert.equal(closeSession(closeId, 'fault-test'), true);
            assert.equal(readSessionLifecycleFromDisk(closeId).closed, true);
            assert.equal(getSessionLifecycleCommitError(closeId), null);
            assert.equal(entry.closed, true);
        });

        await t.test('C14 an older landed worker write cannot clear a newer failure', async () => {
            const raceId = 'sess_save_epoch_race';
            const racePath = join(sessionsDir, `${raceId}.json`);
            const raceSession = {
                id: raceId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'r1' }],
            };
            await saveSessionAsync(raceSession);

            // Older payload: projected + posted NOW, still in the worker.
            raceSession.messages.push({ role: 'assistant', content: 'r2-worker' });
            const older = saveSessionAsync(raceSession);
            // Newer turn, whose own commit fails while that write is in flight.
            raceSession.messages.push({ role: 'user', content: 'r3-live-only' });
            setSessionSaveFault({ ids: raceId, count: 1 });
            assert.throws(() => saveSession(raceSession, { sync: true }), /injected save commit fault/);
            assert.ok(getSessionSaveError(raceId), 'the newer failure is recorded');

            await older; // the OLDER write lands afterwards
            assert.equal(JSON.parse(readFileSync(racePath, 'utf8')).messages.length, 2, 'the older write did land');
            assert.ok(getSessionSaveError(raceId), 'an older landed write must not clear a newer failure');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(raceId).messages.length, 3, 'the newest transcript stays pinned and readable');

            setSessionSaveFault(null);
            await saveSessionAsync(raceSession);
            assert.equal(getSessionSaveError(raceId), null, 'the newest landed write clears it');
            assert.equal(JSON.parse(readFileSync(racePath, 'utf8')).messages.length, 3);
        });

        await t.test('C15 a dead worker cannot settle its replacement\'s writes', async () => {
            const { _detachSaveWorkerForTest } = await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const staleId = 'sess_save_worker_restart';
            const stalePath = join(sessionsDir, `${staleId}.json`);
            const staleSession = {
                id: staleId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'w1' }],
            };
            await saveSessionAsync(staleSession);
            // Exactly the state a worker 'error' leaves behind: the module no
            // longer points at this instance, but the instance can still emit.
            const dead = _detachSaveWorkerForTest();
            assert.ok(dead, 'the live worker was detached');

            staleSession.messages.push({ role: 'assistant', content: 'w2' });
            const pending = saveSessionAsync(staleSession); // spawns the replacement
            // Late events from the DEAD instance, delivered while the
            // replacement owns the pending maps.
            dead.emit('exit', 1);
            dead.emit('error', new Error('stale worker error'));

            await pending; // must resolve: the stale worker owns none of this
            assert.equal(getSessionSaveError(staleId), null, 'a dead worker cannot fail a live write');
            assert.equal(JSON.parse(readFileSync(stalePath, 'utf8')).messages.length, 2);

            staleSession.messages.push({ role: 'user', content: 'w3' });
            await saveSessionAsync(staleSession);
            assert.equal(JSON.parse(readFileSync(stalePath, 'utf8')).messages.length, 3, 'bookkeeping survived intact');
            await dead.terminate();
        });

        await t.test('C16 the exit drain honours ONE deadline across every locked id', async () => {
            const { guardedSaveOptions, acquireWriteCommit, releaseWriteCommit } =
                await import('../src/runtime/agent/orchestrator/session/store/write-guards.mjs');
            // THREE contended ids: a per-id budget would multiply the cost.
            const lockIds = ['sess_drain_lock_a', 'sess_drain_lock_b', 'sess_drain_lock_c'];
            const lastGood = new Map();
            const held = [];
            for (const lockId of lockIds) {
                const lockSession = {
                    id: lockId,
                    owner: 'user',
                    status: 'idle',
                    createdAt: now,
                    updatedAt: now,
                    messages: [{ role: 'user', content: `${lockId}-1` }],
                };
                saveSession(lockSession, { sync: true });
                lastGood.set(lockId, readFileSync(join(sessionsDir, `${lockId}.json`), 'utf8'));
                lockSession.messages.push({ role: 'assistant', content: `${lockId}-2-live-only` });
                saveSession(lockSession); // debounced pending payload, real epoch
                // Another realm is inside its commit for this id and never lets go.
                held.push(acquireWriteCommit(guardedSaveOptions(lockId)));
            }
            assert.ok(held.every((control) => control !== false), 'the test holds every commit lock');

            const startedAt = Date.now();
            drainSessionStore();
            const elapsed = Date.now() - startedAt;
            for (const control of held) releaseWriteCommit(control);

            assert.ok(elapsed < 1200, `one shared deadline, not one per id (took ${elapsed}ms)`);
            for (const lockId of lockIds) {
                assert.equal(readFileSync(join(sessionsDir, `${lockId}.json`), 'utf8'), lastGood.get(lockId),
                    `${lockId}: the last-good file is untouched`);
                assert.ok(getSessionSaveError(lockId), `${lockId}: the unflushed newest state is surfaced`);
            }
            evictIdleLiveSessions({ isSessionLive: () => false });
            for (const lockId of lockIds) {
                assert.equal(loadSession(lockId).messages.length, 2, `${lockId}: the newest state stays pinned`);
            }
        });

        await t.test('C17 exit cleanup drains the whole registry and keeps retry ownership', () => {
            // More than one chunk (64) of registered scratch files.
            const many = [];
            for (let i = 0; i < 80; i += 1) {
                const p = join(sessionsDir, `${id}.json.${String(i).padStart(2, '0')}aaaaaaaaaa.tmp`);
                writeFileSync(p, 'scratch', 'utf8');
                _registerOrphanSaveTmp(p);
                many.push(p);
            }
            assert.equal(sweepOrphanSessionTmpFiles({ drain: true }), 80, 'every registered orphan is reclaimed');
            assert.equal(many.filter((p) => existsSync(p)).length, 0);
            assert.deepEqual(listTmp(sessionsDir), []);

            // A scratch path whose unlink cannot succeed keeps its registry
            // slot instead of becoming an orphan no realm owns.
            const blocked = join(sessionsDir, `${id}.json.ffffffffffff.tmp`);
            mkdirSync(blocked);
            _registerOrphanSaveTmp(blocked);
            assert.equal(sweepOrphanSessionTmpFiles({ drain: true }), 0, 'a failing unlink reclaims nothing');
            assert.equal(existsSync(blocked), true);
            rmSync(blocked, { recursive: true, force: true });
            writeFileSync(blocked, 'scratch', 'utf8');
            assert.equal(sweepOrphanSessionTmpFiles({ drain: true }), 1, 'retry ownership was retained');
            assert.equal(existsSync(blocked), false);
            assert.deepEqual(listTmp(sessionsDir), []);
        });

        await t.test('C18 the drain ranks snapshots by save epoch, not by source', async () => {
            const orderId = 'sess_drain_epoch_order';
            const orderPath = join(sessionsDir, `${orderId}.json`);
            const orderSession = {
                id: orderId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'o1' }],
            };
            saveSession(orderSession, { sync: true });
            // Deferred snapshot issued FIRST (older content), in the source the
            // old fixed-rank order always preferred.
            const deferredSnapshot = {
                ...orderSession,
                messages: [...orderSession.messages, { role: 'assistant', content: 'o2-deferred' }],
            };
            const deferred = saveSessionAsyncDeferred(deferredSnapshot);
            // Strictly NEWER save for the same id, in the lowest-ranked source.
            const newerSnapshot = {
                ...orderSession,
                updatedAt: Date.now(),
                messages: [...deferredSnapshot.messages, { role: 'user', content: 'o3-newest' }],
            };
            saveSession(newerSnapshot);
            drainSessionStore();
            const drained = JSON.parse(readFileSync(orderPath, 'utf8'));
            assert.equal(drained.messages.length, 3, 'the newest epoch wins over the deferred source rank');
            assert.equal(drained.messages.at(-1).content, 'o3-newest');
            await deferred;

            // An older deferred snapshot that IS the only candidate is written
            // under its own epoch — it may not clear a newer failure.
            const failId = 'sess_drain_epoch_failure';
            const failPath = join(sessionsDir, `${failId}.json`);
            const failSession = {
                id: failId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'f1' }],
            };
            saveSession(failSession, { sync: true });
            const failOlder = {
                ...failSession,
                messages: [...failSession.messages, { role: 'assistant', content: 'f2-deferred' }],
            };
            const deferredOlder = saveSessionAsyncDeferred(failOlder);
            // Newer turn, whose own commit fails AFTER the deferred snapshot
            // was issued. Nothing newer LANDS, so the fence (highest landed
            // epoch) still allows the older snapshot: it is strict progress
            // over the last-good file, and its own epoch keeps it from
            // clearing the newer failure's markers.
            failSession.messages.push(
                { role: 'assistant', content: 'f2-deferred' },
                { role: 'user', content: 'f3-live-only' },
            );
            setSessionSaveFault({ ids: failId, count: 1 });
            assert.throws(() => saveSession(failSession, { sync: true }), /injected save commit fault/);
            assert.ok(getSessionSaveError(failId), 'the newer failure is recorded');

            drainSessionStore();
            assert.equal(JSON.parse(readFileSync(failPath, 'utf8')).messages.length, 2,
                'the deferred snapshot is persisted under ITS OWN epoch');
            assert.ok(getSessionSaveError(failId), 'an older drained snapshot must not clear a newer failure');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(failId).messages.length, 3, 'the newest live state stays pinned');
            await deferredOlder;
            setSessionSaveFault(null);
        });

        await t.test('C20 a drain payload older than the LANDED write never reverts disk', async () => {
            const landedId = 'sess_drain_epoch_landed';
            const landedPath = join(sessionsDir, `${landedId}.json`);
            const landedSession = {
                id: landedId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'L1' }],
            };
            saveSession(landedSession, { sync: true });
            // Older snapshot, still outstanding when the drain runs.
            const olderSnapshot = {
                ...landedSession,
                messages: [...landedSession.messages, { role: 'assistant', content: 'L2-deferred' }],
            };
            const deferredStale = saveSessionAsyncDeferred(olderSnapshot);
            // A strictly NEWER save SUCCEEDS for the same id.
            const newestLanded = {
                ...landedSession,
                updatedAt: Date.now(),
                messages: [...olderSnapshot.messages, { role: 'user', content: 'L3-newest' }],
            };
            saveSession(newestLanded, { sync: true });
            assert.equal(JSON.parse(readFileSync(landedPath, 'utf8')).messages.length, 3, 'the newer save landed');

            drainSessionStore(); // only the OLDER deferred snapshot is outstanding
            const after = JSON.parse(readFileSync(landedPath, 'utf8'));
            assert.equal(after.messages.length, 3, 'an older drain payload must not revert durable history');
            assert.equal(after.messages.at(-1).content, 'L3-newest');
            assert.equal(getSessionSaveError(landedId), null, 'a refused stale write is not a failure');
            await deferredStale;
        });

        await t.test('C21 an older worker write cannot land after a newer sync write', async () => {
            // Repeated: whichever side wins the commit lock in a given round,
            // the durable result must be the NEWER content. Only the
            // landed-epoch fence makes that true when the worker renames last.
            for (let round = 0; round < 5; round += 1) {
                const raceId = `sess_worker_after_sync_${round}`;
                const racePath = join(sessionsDir, `${raceId}.json`);
                const raceSession = {
                    id: raceId,
                    owner: 'user',
                    status: 'idle',
                    createdAt: now,
                    updatedAt: now,
                    messages: [{ role: 'user', content: 'W1' }],
                };
                await saveSessionAsync(raceSession);

                // Older payload: projected and posted NOW, still inside the worker.
                raceSession.messages.push({ role: 'assistant', content: 'W2-worker' });
                const olderWorkerWrite = saveSessionAsync(raceSession);
                // A newer sync write lands while that one is in flight. The
                // commit lock serialises the two renames but does not order
                // them by content age — only the landed-epoch fence does.
                raceSession.messages.push({ role: 'user', content: 'W3-newest' });
                saveSession(raceSession, { sync: true });

                await olderWorkerWrite;
                const after = JSON.parse(readFileSync(racePath, 'utf8'));
                assert.equal(after.messages.length, 3, `round ${round}: no revert of the newer landed write`);
                assert.equal(after.messages.at(-1).content, 'W3-newest');
                assert.equal(getSessionSaveError(raceId), null, `round ${round}: a fenced write is not a failure`);

                // The id stays usable: the next save lands and clears the
                // split-brain marker a refused write leaves behind.
                raceSession.messages.push({ role: 'assistant', content: 'W4' });
                await saveSessionAsync(raceSession);
                assert.equal(JSON.parse(readFileSync(racePath, 'utf8')).messages.length, 4);
                evictIdleLiveSessions({ isSessionLive: () => false });
                assert.equal(loadSession(raceId).messages.length, 4, `round ${round}: newest state readable`);
            }
        });

        await t.test('C22 a stale-epoch worker refusal pins nothing and stays evictable', async () => {
            const { guardedSaveOptions, acquireWriteCommit, releaseWriteCommit, publishLandedWriteEpoch } =
                await import('../src/runtime/agent/orchestrator/session/store/write-guards.mjs');
            const { _droppedSaveIds } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const staleId = 'sess_worker_stale_refusal';
            const stalePath = join(sessionsDir, `${staleId}.json`);
            const staleSession = {
                id: staleId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'S1' }],
            };
            saveSession(staleSession, { sync: true });
            const canonical = readFileSync(stalePath, 'utf8');

            // Deterministic ordering: the test holds the id's commit lock, so
            // the worker write below cannot rename until a strictly newer save
            // has published its landed epoch.
            const held = acquireWriteCommit(guardedSaveOptions(staleId));
            assert.notEqual(held, false, 'the test holds the commit lock');
            staleSession.messages.push({ role: 'assistant', content: 'S2-worker' });
            const workerWrite = saveSessionAsync(staleSession);
            const newerEpoch = _nextSaveEpoch();
            publishLandedWriteEpoch(guardedSaveOptions(staleId, null, newerEpoch), newerEpoch);
            releaseWriteCommit(held);

            await workerWrite; // a fenced write settles, it is not a failure
            assert.equal(readFileSync(stalePath, 'utf8'), canonical, 'canonical bytes untouched by the refusal');
            assert.equal(getSessionSaveError(staleId), null, 'a stale refusal is not a save error');
            assert.equal(_droppedSaveIds.has(staleId), false, 'a stale refusal plants no split-brain drop marker');
            assert.deepEqual(listTmp(sessionsDir), [], 'the refused write leaves no scratch orphan');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(staleId).messages.length, 1,
                'nothing is pinned: reads fall back to the durable file immediately');
        });

        await t.test('C23 the landed-epoch fence does not wrap at 2^31 or below the safe limit', async () => {
            const { guardedSaveOptions, publishLandedWriteEpoch, isStaleWriteEpoch } =
                await import('../src/runtime/agent/orchestrator/session/store/write-guards.mjs');
            const boundaryId = 'sess_epoch_boundary';
            const stampedAt = (epoch) => guardedSaveOptions(boundaryId, null, epoch);
            const landAt = (epoch) => publishLandedWriteEpoch(stampedAt(epoch), epoch);

            // Beyond signed-int32 range: an int32 slot would read this back as
            // a negative number and mis-order every later comparison.
            const beyondInt32 = 2 ** 31 + 5;
            landAt(beyondInt32);
            assert.equal(isStaleWriteEpoch(stampedAt(beyondInt32 - 1)), true, 'older past 2^31 is stale');
            assert.equal(isStaleWriteEpoch(stampedAt(beyondInt32)), false, 'the landed epoch itself is not stale');
            assert.equal(isStaleWriteEpoch(stampedAt(beyondInt32 + 1)), false, 'newer is never stale');

            landAt(2 ** 32 + 7);
            assert.equal(isStaleWriteEpoch(stampedAt(beyondInt32)), true, 'no wrap-around past 2^32');

            // Practical representation limit: exact up to MAX_SAFE_INTEGER.
            const limit = Number.MAX_SAFE_INTEGER;
            landAt(limit);
            assert.equal(isStaleWriteEpoch(stampedAt(limit - 1)), true, 'exact at the safe-integer limit');
            assert.equal(isStaleWriteEpoch(stampedAt(limit)), false);

            // Monotonic: a lower publish can never lower the bar.
            landAt(5);
            assert.equal(isStaleWriteEpoch(stampedAt(limit - 1)), true, 'a lower publish does not lower the bar');

            // Beyond the exact range (or non-integer) means "no identity": the
            // write is never silently truncated into a wrong comparison.
            assert.equal(isStaleWriteEpoch(stampedAt(Number.MAX_SAFE_INTEGER + 2)), false);
            assert.equal(isStaleWriteEpoch(stampedAt(Number.NaN)), false);
            assert.equal(isStaleWriteEpoch(guardedSaveOptions(boundaryId)), false, 'lifecycle barriers are never fenced');
        });

        await t.test('C24 a deferred usage-metrics snapshot drains in the canonical ordering', async () => {
            const metrics = await import('../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs');
            const metricsSession = (metricsId) => ({
                id: metricsId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: `${metricsId}-1` }],
            });
            // Two iteration deltas: the first flushes immediately, the second
            // lands inside the 500 ms throttle window and is therefore PARKED
            // — the state this finding was about.
            const parkTwoDeltas = async (metricsId, session) => {
                metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session }) });
                await metrics.persistIterationMetrics({ sessionId: metricsId, iterationIndex: 1, deltaInput: 10, deltaOutput: 5 });
                await metrics.persistIterationMetrics({ sessionId: metricsId, iterationIndex: 2, deltaInput: 7, deltaOutput: 3 });
            };

            // (a) An older parked metrics snapshot vs a NEWER landed save.
            const staleId = 'sess_metrics_stale_park';
            const stalePath = join(sessionsDir, `${staleId}.json`);
            const staleSession = metricsSession(staleId);
            saveSession(staleSession, { sync: true });
            await parkTwoDeltas(staleId, staleSession);
            const newerLanded = {
                ...staleSession,
                updatedAt: Date.now(),
                messages: [...staleSession.messages, { role: 'assistant', content: 'newer-landed' }],
            };
            saveSession(newerLanded, { sync: true });
            drainSessionStore();
            const afterStale = JSON.parse(readFileSync(stalePath, 'utf8'));
            assert.equal(afterStale.messages.length, 2, 'a metrics-only older snapshot never overwrites a newer landed session');
            assert.equal(afterStale.messages.at(-1).content, 'newer-landed');

            // (b) A lifecycle barrier planted while the snapshot is parked.
            const barrierId = 'sess_metrics_barrier_park';
            const barrierSession = metricsSession(barrierId);
            saveSession(barrierSession, { sync: true });
            await parkTwoDeltas(barrierId, barrierSession);
            const closedGen = markSessionClosed(barrierId, 'metrics-barrier');
            assert.equal(typeof closedGen, 'number', 'the tombstone landed');
            drainSessionStore();
            const lifecycle = readSessionLifecycleFromDisk(barrierId);
            assert.equal(lifecycle.closed, true, 'a parked metrics snapshot cannot resurrect a closed session');
            assert.equal(lifecycle.generation, closedGen, 'no generation regression from the parked write');

            // (c) Control: nothing newer landed, so the newest metrics
            // snapshot must still reach disk through the canonical drain.
            const newestId = 'sess_metrics_newest_park';
            const newestPath = join(sessionsDir, `${newestId}.json`);
            const newestSession = metricsSession(newestId);
            saveSession(newestSession, { sync: true });
            await parkTwoDeltas(newestId, newestSession);
            assert.equal(newestSession.totalInputTokens, 17, 'both deltas applied in memory');
            drainSessionStore();
            const persisted = JSON.parse(readFileSync(newestPath, 'utf8'));
            assert.equal(persisted.totalInputTokens, 17, 'the newest metrics snapshot still persists');
            assert.equal(persisted.totalOutputTokens, 8);

            for (const metricsId of [staleId, barrierId, newestId]) metrics.dropMetricSeenState(metricsId);
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => null });

            // (d) End-to-end at REAL process exit — the path the removed
            // metrics exit hook used to run on, after the store's own drain.
            const exitId = 'sess_metrics_exit_child';
            const childPath = join(dataDir, 'metrics-exit-child.mjs');
            const storeUrl = pathToFileURL(join(REPO_ROOT, 'src/runtime/agent/orchestrator/session/store.mjs')).href;
            const metricsUrl = pathToFileURL(join(REPO_ROOT, 'src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs')).href;
            writeFileSync(childPath, `
const store = await import(${JSON.stringify(storeUrl)});
const metrics = await import(${JSON.stringify(metricsUrl)});
const id = process.argv[2];
const nowMs = Date.now();
const session = { id, owner: 'user', status: 'idle', createdAt: nowMs, updatedAt: nowMs, messages: [{ role: 'user', content: 'e1' }] };
store.saveSession(session, { sync: true });
metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session }) });
await metrics.persistIterationMetrics({ sessionId: id, iterationIndex: 1, deltaInput: 10, deltaOutput: 5 });
await metrics.persistIterationMetrics({ sessionId: id, iterationIndex: 2, deltaInput: 7, deltaOutput: 3 });
// A newer save LANDS for the same id while the metrics snapshot is parked.
const newer = { ...session, updatedAt: Date.now(), messages: [...session.messages, { role: 'assistant', content: 'newer-landed' }] };
store.saveSession(newer, { sync: true });
process.exit(0);
`, 'utf8');
            const child = spawnSync(process.execPath, [childPath, exitId], {
                env: { ...process.env, MIXDOG_DATA_DIR: dataDir },
                encoding: 'utf8',
            });
            assert.equal(child.status, 0, `child exited cleanly (${child.stderr})`);
            const afterExit = JSON.parse(readFileSync(join(sessionsDir, `${exitId}.json`), 'utf8'));
            assert.equal(afterExit.messages.length, 2, 'no post-drain metrics flush reverted the newer landed session');
            assert.equal(afterExit.messages.at(-1).content, 'newer-landed');
            assert.equal(afterExit.totalInputTokens, 17, 'the metrics deltas are still durable');
        });

        await t.test('C25 hard delete purges parked metrics timers, parks and drain entries', async () => {
            const metrics = await import('../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs');
            const delId = 'sess_metrics_hard_delete';
            const delPath = join(sessionsDir, `${delId}.json`);
            const delSession = {
                id: delId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'd1' }],
            };
            saveSession(delSession, { sync: true });
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: delSession }) });
            await metrics.persistIterationMetrics({ sessionId: delId, iterationIndex: 1, deltaInput: 3, deltaOutput: 1 });
            // Let that save settle so the NEXT delta parks with a live
            // throttle timer (the retry path a hard delete must disarm).
            await new Promise((resolve) => setTimeout(resolve, 80));
            await metrics.persistIterationMetrics({ sessionId: delId, iterationIndex: 2, deltaInput: 3, deltaOutput: 1 });

            assert.equal(deleteSession(delId), true, 'the session file is unlinked');
            assert.equal(existsSync(delPath), false);

            drainSessionStore();
            assert.equal(existsSync(delPath), false, 'the exit drain cannot resurrect a hard-deleted session');

            await new Promise((resolve) => setTimeout(resolve, 600)); // past the 500 ms throttle timer
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(existsSync(delPath), false, 'a parked metrics timer cannot resurrect it either');
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => null });
        });

        await t.test('C26 a rejected metrics save keeps the newest snapshot and its identity', async () => {
            const metrics = await import('../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs');
            const { guardedSaveOptions, publishLandedWriteEpoch } =
                await import('../src/runtime/agent/orchestrator/session/store/write-guards.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const rejId = 'sess_metrics_reject_identity';
            const rejPath = join(sessionsDir, `${rejId}.json`);
            const olderRef = {
                id: rejId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'r1' }],
            };
            saveSession(olderRef, { sync: true });

            // The first metrics save fails at the commit edge...
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: olderRef }) });
            setSessionSaveFault({ ids: rejId, count: 1 });
            await metrics.persistIterationMetrics({ sessionId: rejId, iterationIndex: 1, deltaInput: 10, deltaOutput: 5 });
            // ...while a NEWER snapshot (a distinct object, as after a
            // detach-resume) parks behind it.
            const newerRef = {
                ...olderRef,
                updatedAt: Date.now(),
                messages: [...olderRef.messages, { role: 'assistant', content: 'metrics-newest' }],
            };
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: newerRef }) });
            await metrics.persistIterationMetrics({ sessionId: rejId, iterationIndex: 2, deltaInput: 7, deltaOutput: 3 });
            await sleep(250); // rejection + retry settle

            const persisted = JSON.parse(readFileSync(rejPath, 'utf8'));
            assert.ok(persisted.messages.some((m) => m.content === 'metrics-newest'),
                'the rejection re-parked the NEWEST snapshot, not the rejected closure');
            assert.equal(persisted.totalInputTokens, 17, 'both deltas are durable');
            assert.equal(persisted.totalOutputTokens, 8);
            assert.equal(getSessionSaveError(rejId), null, 'the retry landed');

            // Identity: this delta parks inside the throttle window, so its
            // identity is assigned NOW; a session save landing before the
            // timer fires must fence the retry. A retry that minted fresh
            // authority would instead outrank that landed save and revert it.
            newerRef.messages.push({ role: 'user', content: 'never-durable' });
            await metrics.persistIterationMetrics({ sessionId: rejId, iterationIndex: 3, deltaInput: 1, deltaOutput: 1 });
            const canonicalBefore = readFileSync(rejPath, 'utf8');
            const landedEpoch = _nextSaveEpoch();
            publishLandedWriteEpoch(guardedSaveOptions(rejId, null, landedEpoch), landedEpoch);
            await sleep(500); // the parked timer fires inside this window
            assert.equal(readFileSync(rejPath, 'utf8'), canonicalBefore,
                'a retry under the preserved identity cannot outrank an intervening landed save');

            setSessionSaveFault(null);
            metrics.dropMetricSeenState(rejId);
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => null });
        });

        await t.test('C27 a rejection settling after hard delete creates nothing', async () => {
            const metrics = await import('../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs');
            const { _droppedSaveIds, _liveSessions } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const { _deferredSessionSaves, _saveAsyncInflight } =
                await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const raceId = 'sess_metrics_delete_race';
            const racePath = join(sessionsDir, `${raceId}.json`);
            const raceSession = {
                id: raceId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'x1' }],
            };
            saveSession(raceSession, { sync: true });
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: raceSession }) });
            setSessionSaveFault({ ids: raceId, count: 1 }); // the in-flight metrics save WILL reject
            // Settle boundary, not a guard drop: block the main thread until
            // the worker has certainly RUN the write and posted its FAILURE
            // reply (queued, not yet dispatched), then delete. The failure
            // therefore settles AFTER the delete.
            const originalStderrWrite = process.stderr.write.bind(process.stderr);
            let sawFailureSettlement = false;
            process.stderr.write = (chunk, ...rest) => {
                if (String(chunk).includes('iteration save failed')) sawFailureSettlement = true;
                return originalStderrWrite(chunk, ...rest);
            };
            let inFlight;
            try {
                inFlight = metrics.persistIterationMetrics({ sessionId: raceId, iterationIndex: 1, deltaInput: 5, deltaOutput: 2 });
                const block = new Int32Array(new SharedArrayBuffer(4));
                Atomics.wait(block, 0, 0, 300); // worker runs + replies while we block
                assert.equal(deleteSession(raceId), true, 'the hard delete lands before the failure settles');
                assert.equal(existsSync(racePath), false);
                await inFlight;
                await sleep(200); // dispatch the queued failure reply
            } finally {
                process.stderr.write = originalStderrWrite;
            }
            assert.equal(sawFailureSettlement, true, 'the write settled as a FAILURE, not a cancellation drop');
            // Synchronize on the worker boundary: the write was posted in the
            // same tick as the delete, so its reply (the injected commit
            // fault) can only settle AFTER the delete completed.
            const settleDeadline = Date.now() + 5000;
            while (_saveAsyncInflight.has(raceId) && Date.now() < settleDeadline) await sleep(10);
            assert.equal(_saveAsyncInflight.has(raceId), false, 'the in-flight write settled after the delete');
            await sleep(200); // rejection handlers + any retry window

            drainSessionStore(); // the exit window
            assert.equal(existsSync(racePath), false, 'no deferred entry or retry re-creates a deleted session');
            await sleep(650); // past the metrics throttle timer window
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(existsSync(racePath), false, 'no timer re-creates it either');

            // Every marker the late completion could have moved stays purged.
            assert.equal(getSessionSaveError(raceId), null, 'no save-failure marker for a deleted session');
            assert.equal(_droppedSaveIds.has(raceId), false, 'no split-brain drop marker');
            assert.equal(_liveSessions.has(raceId), false, 'no live pin');
            assert.equal(_savePending.has(raceId), false, 'no pending bookkeeping');
            assert.equal([..._deferredSessionSaves.values()].some((entry) => entry.session?.id === raceId), false,
                'no deferred/parked entry survived the delete');
            const { getFailedSaveSnapshot } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            assert.equal(getFailedSaveSnapshot(raceId), null, 'no failed-save recovery snapshot survives the delete');
            assert.equal(
                listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === raceId),
                false,
                'no summary row for a deleted session',
            );

            setSessionSaveFault(null);
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => null });
        });

        await t.test('C30 stale completions stay inert after >512 deletes and id reuse', async () => {
            const { _droppedSaveIds } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            // Churn well past any bounded generation table: an incarnation is
            // an object identity, so there is nothing to wrap or reset.
            for (let i = 0; i < 520; i += 1) {
                const churnId = `sess_churn_${i}`;
                saveSession({
                    id: churnId,
                    owner: 'user',
                    status: 'idle',
                    createdAt: now,
                    updatedAt: now,
                    messages: [{ role: 'user', content: 'c' }],
                }, { sync: true });
                assert.equal(deleteSession(churnId), true);
            }
            const churnedId = 'sess_churn_target';
            const churnedPath = join(sessionsDir, `${churnedId}.json`);
            const churnedSession = {
                id: churnedId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 's1' }],
            };
            saveSession(churnedSession, { sync: true });
            churnedSession.messages.push({ role: 'assistant', content: 's2' });
            const inFlight = saveSessionAsync(churnedSession);
            assert.equal(deleteSession(churnedId), true);
            await inFlight; // settles inert
            assert.equal(existsSync(churnedPath), false, 'no resurrection after 520 deletes');
            assert.equal(getSessionSaveError(churnedId), null, 'no failure marker from pre-delete work');
            assert.equal(_droppedSaveIds.has(churnedId), false, 'no drop marker from pre-delete work');
        });

        await t.test('C31 a stale queued completion never touches a re-created id', async () => {
            const { _droppedSaveIds } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const reuseId = 'sess_reuse_after_delete';
            const reusePath = join(sessionsDir, `${reuseId}.json`);
            const oldSession = {
                id: reuseId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'old-1' }],
            };
            saveSession(oldSession, { sync: true });
            oldSession.messages.push({ role: 'assistant', content: 'old-2' });
            const firstWrite = saveSessionAsync(oldSession);  // in flight
            oldSession.messages.push({ role: 'user', content: 'old-3' });
            const queuedWrite = saveSessionAsync(oldSession); // queued behind it
            assert.equal(deleteSession(reuseId), true);

            // The SAME id is re-created immediately: it must post its own
            // write instead of queueing behind the dead incarnation.
            const reborn = {
                id: reuseId,
                owner: 'user',
                status: 'idle',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [{ role: 'user', content: 'reborn-1' }],
            };
            const rebornWrite = saveSessionAsync(reborn);
            await Promise.all([firstWrite, queuedWrite, rebornWrite]); // each settles exactly once

            const persisted = JSON.parse(readFileSync(reusePath, 'utf8'));
            assert.equal(persisted.messages.length, 1, 'the re-created session owns the file');
            assert.equal(persisted.messages[0].content, 'reborn-1');
            assert.equal(getSessionSaveError(reuseId), null, 'no stale failure marker');
            assert.equal(_droppedSaveIds.has(reuseId), false, 'no stale drop marker');

            reborn.messages.push({ role: 'assistant', content: 'reborn-2' });
            await saveSessionAsync(reborn);
            assert.equal(JSON.parse(readFileSync(reusePath, 'utf8')).messages.length, 2,
                'the re-created id saves normally');
        });

        await t.test('C32 a delayed in-process save settling after delete moves no marker', async () => {
            const { _droppedSaveIds } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const inProcId = 'sess_inprocess_after_delete';
            const inProcPath = join(sessionsDir, `${inProcId}.json`);
            const inProcSession = {
                id: inProcId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'p1' }],
            };
            saveSession(inProcSession, { sync: true });
            inProcSession.messages.push({ role: 'assistant', content: 'p2' });
            saveSession(inProcSession, { immediate: true }); // non-worker _doSave starts now
            assert.equal(deleteSession(inProcId), true, 'the delete lands while that write awaits fs');
            await sleep(250);
            assert.equal(existsSync(inProcPath), false, 'the in-process save cannot resurrect the file');
            assert.equal(getSessionSaveError(inProcId), null, 'no failure marker for a deleted id');
            assert.equal(_droppedSaveIds.has(inProcId), false, 'no drop marker for a deleted id');
            assert.equal(_savePending.has(inProcId), false, 'no pending bookkeeping');
        });

        await t.test('C33 worker detach/error settlement after delete moves no marker', async () => {
            const { _detachSaveWorkerForTest } = await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const { _droppedSaveIds } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const detachId = 'sess_detach_after_delete';
            const detachPath = join(sessionsDir, `${detachId}.json`);
            const detachSession = {
                id: detachId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'd1' }],
            };
            saveSession(detachSession, { sync: true });
            detachSession.messages.push({ role: 'assistant', content: 'd2' });
            const pending = saveSessionAsync(detachSession);
            assert.equal(deleteSession(detachId), true);
            const dead = _detachSaveWorkerForTest(); // settles pendings via the error path
            assert.ok(dead, 'the worker was detached with the stale write in flight');
            await assert.rejects(pending, /detached before this write settled/);
            assert.equal(getSessionSaveError(detachId), null, 'a stale detach rejection records no failure');
            assert.equal(_droppedSaveIds.has(detachId), false, 'and plants no drop marker');
            assert.equal(existsSync(detachPath), false, 'the deleted file stays deleted');
            await dead.terminate();

            const reborn = {
                id: detachId,
                owner: 'user',
                status: 'idle',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [{ role: 'user', content: 'r1' }],
            };
            await saveSessionAsync(reborn); // replacement worker, re-created id
            assert.equal(JSON.parse(readFileSync(detachPath, 'utf8')).messages.length, 1);
            assert.equal(getSessionSaveError(detachId), null);
        });

        await t.test('C28 the drain keeps the newest payload at equal issuance identity', async () => {
            const metrics = await import('../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs');
            const { _deferredSessionSaves } =
                await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const overlapId = 'sess_metrics_drain_overlap';
            const overlapPath = join(sessionsDir, `${overlapId}.json`);
            const olderRef = {
                id: overlapId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'o1' }],
            };
            saveSession(olderRef, { sync: true });
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: olderRef }) });
            // Posted to the worker under identity E, payload = olderRef.
            metrics.persistIterationMetrics({ sessionId: overlapId, iterationIndex: 1, deltaInput: 4, deltaOutput: 2 });
            // A DISTINCT newer payload parks under the SAME identity E.
            const newerRef = {
                ...olderRef,
                updatedAt: Date.now(),
                messages: [...olderRef.messages, { role: 'assistant', content: 'drain-newest' }],
            };
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: newerRef }) });
            metrics.persistIterationMetrics({ sessionId: overlapId, iterationIndex: 2, deltaInput: 3, deltaOutput: 1 });
            // Same tick: the in-flight write has NOT settled yet.
            drainSessionStore();

            const drained = JSON.parse(readFileSync(overlapPath, 'utf8'));
            assert.ok(drained.messages.some((m) => m.content === 'drain-newest'),
                'the newer parked payload outranks the in-flight one at equal identity');
            assert.equal(drained.totalInputTokens, 7, 'both deltas are durable');

            // The drain settlement is a TERMINAL ownership transfer: a newer
            // sync save made right after it (same tick, before any repark or
            // retry could run) must survive every metrics settle path.
            const postDrain = {
                ...newerRef,
                updatedAt: Date.now(),
                messages: [...newerRef.messages, { role: 'user', content: 'post-drain-newest' }],
            };
            saveSession(postDrain, { sync: true });
            const bytesAfterSync = readFileSync(overlapPath, 'utf8');
            await sleep(750); // repark/retry + throttle timer window
            assert.equal(readFileSync(overlapPath, 'utf8'), bytesAfterSync,
                'no repark or retry may overwrite a save made after the drain');
            const afterAll = JSON.parse(bytesAfterSync);
            assert.ok(afterAll.messages.some((m) => m.content === 'drain-newest'),
                'the drained newest payload is still part of the durable state');
            assert.equal([..._deferredSessionSaves.values()].some((entry) => entry.session?.id === overlapId), false,
                'the drain-settled identity was released, not re-parked');
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => null });
        });

        await t.test('C29 a failed unlink is not a delete and keeps metrics state usable', async () => {
            const metrics = await import('../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const failId = 'sess_delete_unlink_fail';
            const failPath = join(sessionsDir, `${failId}.json`);
            const failSession = {
                id: failId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'u1' }],
            };
            saveSession(failSession, { sync: true });
            const canonical = readFileSync(failPath, 'utf8');
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: failSession }) });
            metrics.persistIterationMetrics({ sessionId: failId, iterationIndex: 1, deltaInput: 6, deltaOutput: 3 });
            await sleep(150); // that save lands
            metrics.persistIterationMetrics({ sessionId: failId, iterationIndex: 2, deltaInput: 4, deltaOutput: 1 });
            // Parked with a live timer + drain identity. Now make the unlink
            // fail: a directory owns the canonical path.
            rmSync(failPath);
            mkdirSync(failPath);
            assert.equal(deleteSession(failId), false, 'a failed unlink is not a delete');
            assert.equal(existsSync(failPath), true, 'nothing was removed');

            // Restore the canonical file: the pending metrics identity must
            // still be registered, uncancelled and persistable.
            rmSync(failPath, { recursive: true, force: true });
            writeFileSync(failPath, canonical, 'utf8');
            drainSessionStore();
            const persisted = JSON.parse(readFileSync(failPath, 'utf8'));
            assert.equal(persisted.totalInputTokens, 10, 'the parked metrics snapshot is still persistable');
            assert.equal(persisted.totalOutputTokens, 4);
            metrics.dropMetricSeenState(failId);
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => null });
        });

        await t.test('C19 detaching the worker with a write in flight orphans nothing', async () => {
            const { _detachSaveWorkerForTest } = await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const flightId = 'sess_worker_detach_inflight';
            const flightPath = join(sessionsDir, `${flightId}.json`);
            const flightSession = {
                id: flightId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'i1' }],
            };
            await saveSessionAsync(flightSession);

            // Structural gate: unreachable outside explicit test mode.
            delete process.env[FAULT_GATE];
            try {
                assert.equal(_detachSaveWorkerForTest(), null, 'the seam is refused without the gate');
            } finally {
                process.env[FAULT_GATE] = '1';
            }

            flightSession.messages.push({ role: 'assistant', content: 'i2-live-only' });
            // Ownership moves on first, so the in-flight write below can never
            // reach a rename (the worker drops it): terminating the detached
            // instance afterwards can never strand a commit lock.
            assert.equal(bumpSessionGeneration(flightId, 'detach-test'), 1);
            const inFlight = saveSessionAsync(flightSession, { expectedGeneration: 0 }); // inside the worker
            const dead = _detachSaveWorkerForTest();
            assert.ok(dead, 'the worker was detached with work in flight');
            await assert.rejects(inFlight, /detached before this write settled/,
                'the in-flight waiter settles instead of hanging forever');
            assert.ok(getSessionSaveError(flightId), 'the unsettled write is recorded, not silently dropped');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(flightId).messages.length, 2, 'live snapshot pinned after the detach');
            await dead.terminate(); // no further writes from the detached instance

            flightSession.messages.push({ role: 'user', content: 'i3' });
            await saveSessionAsync(flightSession); // replacement worker, clean bookkeeping
            assert.equal(getSessionSaveError(flightId), null, 'a landed write on the replacement clears it');
            assert.equal(JSON.parse(readFileSync(flightPath, 'utf8')).messages.length, 3);
        });

        await t.test('C34 work stamped BEFORE >512 deletes and id reuse settles inert', async () => {
            const { _droppedSaveIds, getFailedSaveSnapshot } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const preId = 'sess_pre_churn_stamp';
            const prePath = join(sessionsDir, `${preId}.json`);
            const preSession = {
                id: preId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'pre-1' }],
            };
            saveSession(preSession, { sync: true });
            preSession.messages.push({ role: 'assistant', content: 'pre-2' });
            // Stamped NOW — long before the churn and the reuse below.
            const staleWrite = saveSessionAsync(preSession);
            assert.equal(deleteSession(preId), true);
            // Everything below runs synchronously, so the stale completion can
            // only settle AFTER the id has been re-created.
            for (let i = 0; i < 520; i += 1) {
                const churnId = `sess_stamp_churn_${i}`;
                saveSession({
                    id: churnId,
                    owner: 'user',
                    status: 'idle',
                    createdAt: now,
                    updatedAt: now,
                    messages: [{ role: 'user', content: 'c' }],
                }, { sync: true });
                assert.equal(deleteSession(churnId), true);
            }
            const reborn = {
                id: preId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: Date.now(),
                messages: [{ role: 'user', content: 'reborn-after-churn' }],
            };
            saveSession(reborn, { sync: true });

            await staleWrite; // settles now, against a brand new incarnation
            const persisted = JSON.parse(readFileSync(prePath, 'utf8'));
            assert.equal(persisted.messages.length, 1, 'the stale completion never touched the re-created record');
            assert.equal(persisted.messages[0].content, 'reborn-after-churn');
            assert.equal(getSessionSaveError(preId), null, 'no stale failure marker');
            assert.equal(_droppedSaveIds.has(preId), false, 'no stale drop marker');
            assert.equal(getFailedSaveSnapshot(preId), null, 'no stale recovery snapshot');
        });

        await t.test('C35 every incarnation reference is released exactly once', async () => {
            const { _sessionIncarnationRefs } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const balId = 'sess_incarnation_balance';
            const balSession = {
                id: balId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'b1' }],
            };
            saveSession(balSession, { sync: true });
            // Coalesced payload replacement (debounce slot overwritten twice).
            saveSession(balSession);
            saveSession(balSession);
            saveSession(balSession);
            // Async coalescing: in-flight + latest-wins queued replacement.
            await Promise.all([
                saveSessionAsync(balSession),
                saveSessionAsync(balSession),
                saveSessionAsync(balSession),
            ]);
            await sleep(300); // the debounced payload flushes
            assert.equal(_sessionIncarnationRefs(balId), 0, 'coalesced + settled work leaks no reference');

            await saveSessionAsyncDeferred(balSession); // deferred payload path
            await sleep(50);
            assert.equal(_sessionIncarnationRefs(balId), 0, 'deferred payloads release their stamp');

            // Drain retires whatever is outstanding — also without leaking.
            saveSession(balSession);
            saveSessionAsync(balSession).catch(() => {});
            drainSessionStore();
            await sleep(100);
            assert.equal(_sessionIncarnationRefs(balId), 0, 'the drain releases everything it retires');
        });

        await t.test('C36 a stale in-process completion never promotes a reused queue', async () => {
            const { _droppedSaveIds } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const queueId = 'sess_inprocess_queue_reuse';
            const queuePath = join(sessionsDir, `${queueId}.json`);
            const oldSession = {
                id: queueId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'old-1' }],
            };
            saveSession(oldSession, { sync: true });
            oldSession.messages.push({ role: 'assistant', content: 'old-2' });
            saveSession(oldSession, { immediate: true }); // _doSave in flight (awaiting fs)
            oldSession.messages.push({ role: 'user', content: 'old-3' });
            saveSession(oldSession, { immediate: true }); // queued behind it
            assert.equal(deleteSession(queueId), true);

            // The re-created id owns the pending bookkeeping from here on.
            const reborn = {
                id: queueId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: Date.now(),
                messages: [{ role: 'user', content: 'reborn-1' }],
            };
            saveSession(reborn); // debounced payload for the NEW incarnation
            await sleep(450);    // stale completion settles, then the new payload flushes

            const persisted = JSON.parse(readFileSync(queuePath, 'utf8'));
            assert.equal(persisted.messages.length, 1,
                'the stale completion neither promoted nor clobbered the reused queue');
            assert.equal(persisted.messages[0].content, 'reborn-1');
            assert.equal(getSessionSaveError(queueId), null, 'no stale failure marker');
            assert.equal(_droppedSaveIds.has(queueId), false, 'no stale drop marker');
        });

        await t.test('C37 an old metrics callback never erases a re-created snapshot', async () => {
            const metrics = await import('../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs');
            const { _deferredSessionSaves } =
                await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const reuseId = 'sess_metrics_map_reuse';
            const reusePath = join(sessionsDir, `${reuseId}.json`);
            const oldSession = {
                id: reuseId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'old' }],
            };
            saveSession(oldSession, { sync: true });
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: oldSession }) });
            // In-flight metrics save for the OLD incarnation...
            metrics.persistIterationMetrics({ sessionId: reuseId, iterationIndex: 1, deltaInput: 4, deltaOutput: 2 });
            assert.equal(deleteSession(reuseId), true); // ...closed by the hard delete

            // Re-create the id and give it its OWN metrics state + park, all in
            // one synchronous run so the old callback can only settle after.
            const reborn = {
                id: reuseId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: Date.now(),
                messages: [{ role: 'user', content: 'reborn' }],
            };
            saveSession(reborn, { sync: true });
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => ({ session: reborn }) });
            metrics.persistIterationMetrics({ sessionId: reuseId, iterationIndex: 1, deltaInput: 9, deltaOutput: 1 });
            metrics.persistIterationMetrics({ sessionId: reuseId, iterationIndex: 2, deltaInput: 5, deltaOutput: 1 });
            // While the re-created snapshot is still parked (its first save is
            // in flight), the OLD closed callback settles: it may not erase the
            // map entry the new state owns.
            const parkedNow = [..._deferredSessionSaves.values()].filter((entry) => entry.session?.id === reuseId);
            assert.equal(parkedNow.length, 1, 'the re-created session owns exactly one parked snapshot');
            assert.equal(parkedNow[0].session, reborn, 'and it is the NEW snapshot, not the deleted one');

            await sleep(300); // the OLD callback settles in this window
            drainSessionStore();
            const persisted = JSON.parse(readFileSync(reusePath, 'utf8'));
            assert.equal(persisted.messages[0].content, 'reborn');
            assert.equal(persisted.totalInputTokens, 14, 'both re-created deltas survived the old callback');
            assert.equal(persisted.totalOutputTokens, 2);
            assert.equal(getSessionSaveError(reuseId), null, 'the old callback left no marker on the reused id');
            metrics.dropMetricSeenState(reuseId);
            metrics.configureUsageMetricsRuntime({ getRuntimeEntry: () => null });
        });

        await t.test('A1 an async/worker save on a foreign record publishes no owned state', async () => {
            const { _liveSessions } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const foreignId = 'sess_async_authority';
            const foreignPath = join(sessionsDir, `${foreignId}.json`);
            writeFileSync(foreignPath, JSON.stringify({
                id: 'sess_someone_else',
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'theirs' }],
            }), 'utf8');
            const bytes = readFileSync(foreignPath, 'utf8');
            const mine = {
                id: foreignId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'mine' }],
            };
            await assert.rejects(saveSessionAsync(mine), (err) => err.code === 'ESESSIONNOTOWNED');
            assert.equal(_liveSessions.has(foreignId), false, 'no live snapshot was published');
            assert.equal(
                listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === foreignId),
                false,
                'no optimistic summary row was published',
            );
            assert.equal(readFileSync(foreignPath, 'utf8'), bytes, 'the foreign record is untouched');
            await assert.rejects(saveSessionAsyncDeferred(mine), (err) => err.code === 'ESESSIONNOTOWNED');
            assert.equal(_liveSessions.has(foreignId), false, 'the deferred path publishes nothing either');
            rmSync(foreignPath, { force: true });
        });

        await t.test('A2 failure evidence is the attempted payload, not the later live session', async () => {
            const { getFailedSaveSnapshot } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const workerId = 'sess_attempt_snapshot_worker';
            const workerSession = {
                id: workerId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'w1' }],
            };
            saveSession(workerSession, { sync: true });
            workerSession.messages.push({ role: 'assistant', content: 'attempted' });
            setSessionSaveFault({ ids: workerId, count: 1 });
            const pending = saveSessionAsync(workerSession);
            workerSession.messages.push({ role: 'user', content: 'mutated-after-post' });
            await assert.rejects(pending);
            const workerSnapshot = getFailedSaveSnapshot(workerId);
            assert.ok(workerSnapshot, 'the failure recorded evidence');
            assert.equal(workerSnapshot.messages.length, 2, 'exactly the attempted payload');
            assert.equal(workerSnapshot.messages.at(-1).content, 'attempted');

            const inProcId = 'sess_attempt_snapshot_inproc';
            const inProcSession = {
                id: inProcId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'p1' }],
            };
            saveSession(inProcSession, { sync: true });
            inProcSession.messages.push({ role: 'assistant', content: 'attempted' });
            setSessionSaveFault({ ids: inProcId, count: 1 });
            saveSession(inProcSession, { immediate: true });
            inProcSession.messages.push({ role: 'user', content: 'mutated-after-post' });
            await new Promise((resolve) => setTimeout(resolve, 250));
            const inProcSnapshot = getFailedSaveSnapshot(inProcId);
            assert.ok(inProcSnapshot, 'the in-process failure recorded evidence');
            assert.equal(inProcSnapshot.messages.length, 2, 'serialized before the await, not at settlement');
            assert.equal(inProcSnapshot.messages.at(-1).content, 'attempted');
            setSessionSaveFault(null);
        });

        await t.test('A3 every refusal branch releases its incarnation exactly once', async () => {
            const { _sessionIncarnationRefs, _acquireSessionIncarnation, _releaseSessionIncarnation } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            // Cap pressure: thousands of REFERENCED tokens are held while the
            // branches below run, so eviction cannot mask a missing release.
            const held = [];
            for (let i = 0; i < 4200; i += 1) held.push(_acquireSessionIncarnation(`sess_cap_${i}`));
            try {
                const branchId = 'sess_ref_branches';
                const branchSession = {
                    id: branchId,
                    owner: 'user',
                    status: 'idle',
                    createdAt: now,
                    updatedAt: now,
                    messages: [{ role: 'user', content: 'b1' }],
                };
                saveSession(branchSession, { sync: true });
                assert.equal(_sessionIncarnationRefs(branchId), 0, 'saved branch released');
                assert.equal(bumpSessionGeneration(branchId, 'ref-branch'), 1);
                saveSession(branchSession, { sync: true, expectedGeneration: 0 });
                assert.equal(_sessionIncarnationRefs(branchId), 0, 'ownership-drop branch released');
                setSessionSaveFault({ ids: branchId, count: 1 });
                assert.throws(() => saveSession(branchSession, { sync: true }));
                assert.equal(_sessionIncarnationRefs(branchId), 0, 'failure branch released');
                setSessionSaveFault(null);
                await saveSessionAsync(branchSession);
                await saveSessionAsyncDeferred(branchSession);
                assert.equal(_sessionIncarnationRefs(branchId), 0, 'async + deferred branches released');
            } finally {
                for (const token of held) _releaseSessionIncarnation(token);
            }
        });

        await t.test('A4 a non-serializable save rejected after delete leaves no marker', async () => {
            const { _droppedSaveIds, getFailedSaveSnapshot } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const circId = 'sess_circular_after_delete';
            const circPath = join(sessionsDir, `${circId}.json`);
            const circSession = {
                id: circId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'c1' }],
            };
            saveSession(circSession, { sync: true });
            circSession.selfRef = circSession; // JSON.stringify throws
            saveSession(circSession, { immediate: true });
            assert.equal(deleteSession(circId), true, 'the delete lands while that save is in flight');
            const reborn = {
                id: circId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: Date.now(),
                messages: [{ role: 'user', content: 'reborn' }],
            };
            saveSession(reborn, { sync: true });
            await new Promise((resolve) => setTimeout(resolve, 250));
            assert.equal(getSessionSaveError(circId), null, 'no error marker on the re-created id');
            assert.equal(_droppedSaveIds.has(circId), false, 'no drop marker');
            assert.equal(getFailedSaveSnapshot(circId), null, 'no failed-save snapshot');
            assert.equal(JSON.parse(readFileSync(circPath, 'utf8')).messages[0].content, 'reborn');
        });

        await t.test('A5 a present-but-unreadable summary sidecar fails closed', async () => {
            const { summaryIndexPath } =
                await import('../src/runtime/agent/orchestrator/session/store-summary-index.mjs');
            const keepId = 'sess_summary_read_fault';
            saveSession({
                id: keepId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'row' }],
            }, { sync: true });
            assert.ok(listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === keepId),
                'the row is indexed');
            const indexPath = summaryIndexPath();
            const indexBytes = existsSync(indexPath) ? readFileSync(indexPath) : null;
            rmSync(indexPath, { force: true });
            mkdirSync(indexPath); // stat says PRESENT, every read fails
            try {
                const during = listStoredSessionSummaries({ refreshFromStorage: true });
                assert.ok(during.some((row) => row.id === keepId),
                    'a stat-success + read-fault retains the cached rows instead of emitting none');
                assert.equal(existsSync(indexPath), true, 'the unreadable sidecar is never removed');
            } finally {
                rmSync(indexPath, { recursive: true, force: true });
                if (indexBytes !== null) writeFileSync(indexPath, indexBytes);
            }
        });

        await t.test('A6 pre-admission fails closed on every entry mode', async () => {
            const { _liveSessions } = await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const gateId = 'sess_preadmission_modes';
            const gatePath = join(sessionsDir, `${gateId}.json`);
            // A directory at the canonical path: stat says PRESENT and every
            // read fails (EIO/EACCES class) — the check must FAIL CLOSED.
            mkdirSync(gatePath);
            const mine = {
                id: gateId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'mine' }],
            };
            try {
                for (const opts of [{ sync: true }, { immediate: true }, undefined]) {
                    try { saveSession(mine, opts); } catch { /* refusal surfaces or is dropped downstream */ }
                    assert.equal(_liveSessions.has(gateId), false,
                        `no live publication for ${JSON.stringify(opts) || 'debounced'} mode`);
                }
                await assert.rejects(saveSessionAsync(mine), (err) => err.code === 'ESESSIONNOTOWNED');
                await assert.rejects(saveSessionAsyncDeferred(mine), (err) => err.code === 'ESESSIONNOTOWNED');
                assert.equal(_liveSessions.has(gateId), false, 'worker/deferred modes publish nothing either');
                assert.equal(
                    listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === gateId),
                    false,
                    'no optimistic summary row for an unreadable record',
                );
                assert.equal(existsSync(gatePath), true, 'the unreadable record is never replaced');
            } finally {
                rmSync(gatePath, { recursive: true, force: true });
            }
            // True absence stays creatable.
            saveSession(mine, { sync: true });
            assert.equal(JSON.parse(readFileSync(gatePath, 'utf8')).messages.length, 1);
        });

        await t.test('A7 incarnation registry stays capped with no release underflow', async () => {
            const { _sessionIncarnationStats, _acquireSessionIncarnation, _releaseSessionIncarnation } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const before = _sessionIncarnationStats();
            const held = [];
            for (let i = 0; i < 4300; i += 1) held.push(_acquireSessionIncarnation(`sess_pressure_${i}`));
            const staleId = 'sess_stale_sync_refusal';
            const staleSession = {
                id: staleId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 's1' }],
            };
            saveSession(staleSession, { sync: true });
            // Stale sync refusal branch (a newer epoch already landed).
            const { guardedSaveOptions, publishLandedWriteEpoch } =
                await import('../src/runtime/agent/orchestrator/session/store/write-guards.mjs');
            const newerEpoch = _nextSaveEpoch();
            publishLandedWriteEpoch(guardedSaveOptions(staleId, null, newerEpoch), newerEpoch);
            saveSession(staleSession, { sync: true }); // refused as stale
            // Worker post + reset + error/exit release branches.
            await saveSessionAsync(staleSession);
            saveSession(staleSession);
            drainSessionStore();
            for (const token of held) _releaseSessionIncarnation(token);
            const after = _sessionIncarnationStats();
            assert.equal(after.releaseUnderflows, before.releaseUnderflows,
                'no branch released a token it did not own');
            assert.ok(after.size <= after.max, `registry stays capped (${after.size} <= ${after.max})`);
        });

        await t.test('A8 a worker commit failure records evidence under cap pressure', async () => {
            const { getFailedSaveSnapshot, _acquireSessionIncarnation, _releaseSessionIncarnation, _sessionIncarnationStats } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const before = _sessionIncarnationStats();
            const pinned = [];
            for (let i = 0; i < 4400; i += 1) pinned.push(_acquireSessionIncarnation(`sess_pin_${i}`));
            const capId = 'sess_worker_fail_under_cap';
            const capPath = join(sessionsDir, `${capId}.json`);
            const capSession = {
                id: capId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'k1' }],
            };
            try {
                await saveSessionAsync(capSession);
                const good = readFileSync(capPath, 'utf8');
                capSession.messages.push({ role: 'assistant', content: 'k2-live-only' });
                setSessionSaveFault({ ids: capId, count: 1 });
                await assert.rejects(saveSessionAsync(capSession), (err) => err.injectedSaveFault === true);
                assert.ok(getSessionSaveError(capId), 'a real failure still records its marker under cap pressure');
                const snapshot = getFailedSaveSnapshot(capId);
                assert.ok(snapshot, 'and its immutable failure evidence');
                assert.equal(snapshot.messages.length, 2);
                assert.equal(readFileSync(capPath, 'utf8'), good, 'canonical bytes untouched');
                evictIdleLiveSessions({ isSessionLive: () => false });
                assert.equal(loadSession(capId).messages.length, 2, 'live state stays pinned');
                setSessionSaveFault(null);
                await saveSessionAsync(capSession);
                assert.equal(getSessionSaveError(capId), null, 'a landed write clears it again');
            } finally {
                for (const token of pinned) _releaseSessionIncarnation(token);
            }
            const after = _sessionIncarnationStats();
            assert.equal(after.releaseUnderflows, before.releaseUnderflows, 'no double release');
            assert.ok(after.size <= after.max, 'registry stays capped');
        });

        await t.test('A9 post-failure evidence is the projected attempt, or none', async () => {
            const { getFailedSaveSnapshot } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            // (a) projection SUCCEEDS, postMessage clone fails (unclonable opt).
            const postId = 'sess_post_clone_fail';
            const postSession = {
                id: postId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'q1' }],
            };
            saveSession(postSession, { sync: true });
            postSession.messages.push({ role: 'assistant', content: 'attempted' });
            await assert.rejects(saveSessionAsync(postSession, { probe: () => {} }));
            postSession.messages.push({ role: 'user', content: 'mutated-after-post' });
            const posted = getFailedSaveSnapshot(postId);
            assert.ok(posted, 'a posted-but-unsent attempt records its projected payload');
            assert.equal(posted.messages.length, 2, 'exactly what projection produced');
            assert.equal(posted.messages.at(-1).content, 'attempted');

            // (b) projection itself fails: nothing was attempted, so no evidence.
            const circId = 'sess_projection_fail';
            const circSession = {
                id: circId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'z1' }],
            };
            saveSession(circSession, { sync: true });
            circSession.messages.push({ role: 'assistant', content: 'z2' });
            circSession.messages.at(-1).selfRef = circSession.messages.at(-1);
            await assert.rejects(saveSessionAsync(circSession));
            assert.equal(getFailedSaveSnapshot(circId), null,
                'an unattempted payload records no failed-save snapshot');
        });

        await t.test('A10 delta failure evidence is the reconstructed wire payload', async () => {
            const { getFailedSaveSnapshot } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const deltaId = 'sess_delta_evidence';
            const deltaSession = {
                id: deltaId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'd1', meta: { tag: 'original' } }],
            };
            await saveSessionAsync(deltaSession); // full baseline send
            // Pure append → the next post is a DELTA, and this in-place edit of
            // an already-sent message is NOT part of it.
            deltaSession.messages[0].meta.tag = 'mutated-in-place';
            deltaSession.messages.push({ role: 'assistant', content: 'd2-appended' });
            setSessionSaveFault({ ids: deltaId, count: 1 });
            await assert.rejects(saveSessionAsync(deltaSession), (err) => err.injectedSaveFault === true);
            const evidence = getFailedSaveSnapshot(deltaId);
            assert.ok(evidence, 'the delta failure recorded evidence');
            assert.equal(evidence.messages.length, 2, 'baseline + applied delta');
            assert.equal(evidence.messages.at(-1).content, 'd2-appended');
            assert.equal(evidence.messages[0].meta.tag, 'original',
                'an in-place edit the delta never shipped is absent from the evidence');
            setSessionSaveFault(null);
        });

        await t.test('B1 a never-posted queued payload is settled but never used as evidence', async () => {
            const { _detachSaveWorkerForTest } =
                await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const { getFailedSaveSnapshot } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const queuedId = 'sess_queued_no_evidence';
            const queuedPath = join(sessionsDir, `${queuedId}.json`);
            const queuedSession = {
                id: queuedId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'q1' }],
            };
            await saveSessionAsync(queuedSession);
            // Ownership moves on first: the posted write is then refused by the
            // worker BEFORE it can take the commit lock, so terminating the
            // detached instance later can never strand that lock.
            assert.equal(bumpSessionGeneration(queuedId, 'b1-detach'), 1);
            const good = readFileSync(queuedPath, 'utf8');
            queuedSession.messages.push({ role: 'assistant', content: 'attempted' });
            const inFlight = saveSessionAsync(queuedSession, { expectedGeneration: 0 }); // posted (projected)
            queuedSession.messages.push({ role: 'user', content: 'queued-only' });
            const queued = saveSessionAsync(queuedSession, { expectedGeneration: 0 }); // QUEUED: never projected
            // Mutate again before the detach settles both.
            queuedSession.messages.push({ role: 'user', content: 'mutated-before-detach' });

            const dead = _detachSaveWorkerForTest();
            assert.ok(dead, 'the worker was detached with one posted and one queued write');
            await assert.rejects(inFlight, /detached before this write settled/);
            await assert.rejects(queued, /detached before this write settled/);

            assert.ok(getSessionSaveError(queuedId), 'the operational error is recorded');
            const evidence = getFailedSaveSnapshot(queuedId);
            assert.ok(evidence, 'the POSTED attempt still provides evidence');
            assert.equal(evidence.messages.length, 2,
                'evidence is the projected posted payload, never the queued/mutated live session');
            assert.equal(evidence.messages.at(-1).content, 'attempted');
            evictIdleLiveSessions({ isSessionLive: () => false });
            assert.equal(loadSession(queuedId).messages.length, 4, 'live state stays pinned');
            assert.equal(readFileSync(queuedPath, 'utf8'), good, 'canonical bytes untouched');
            await dead.terminate();
            await saveSessionAsync(queuedSession);
            assert.equal(getSessionSaveError(queuedId), null, 'a landed write on the replacement clears it');
        });

        await t.test('B2 a delta-miss full retry records only its own attempt', async () => {
            const { _evictWorkerDeltaBaseForTest, _probeWorkerDeltaBaseForTest, _saveAsyncInflight, _saveAsyncQueued, _saveWorkerPending } =
                await import('../src/runtime/agent/orchestrator/session/store/save-worker.mjs');
            const { getFailedSaveSnapshot, _sessionIncarnationStats, _sessionIncarnationRefs } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const refsBefore = _sessionIncarnationStats();
            const missId = 'sess_delta_miss_retry';
            const missPath = join(sessionsDir, `${missId}.json`);
            const missSession = {
                id: missId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'm1' }],
            };
            // A CONTROL id with its own delta baseline: the eviction seam must
            // not touch it (an accidental _baseMessages.clear() would).
            const controlId = 'sess_delta_miss_control';
            const controlPath = join(sessionsDir, `${controlId}.json`);
            const controlSession = {
                id: controlId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'ctl-1' }],
            };
            await saveSessionAsync(missSession); // full send: the worker owns a base
            await saveSessionAsync(controlSession);
            const goodBytes = readFileSync(missPath, 'utf8');
            assert.equal(await _probeWorkerDeltaBaseForTest(missId), true, 'the worker holds a base for the target');
            assert.equal(await _probeWorkerDeltaBaseForTest(controlId), true, 'and one for the control');
            // Narrow seam: ONLY the worker-realm base for this id is dropped.
            // The parent's delta baseline and the worker instance stay as they
            // are, so the next post really is a DELTA that really misses.
            assert.equal(_evictWorkerDeltaBaseForTest(missId), true, 'the gated seam is available');
            assert.equal(await _probeWorkerDeltaBaseForTest(missId), false, 'exactly this id lost its base');
            assert.equal(await _probeWorkerDeltaBaseForTest(controlId), true,
                'the control base survives — the seam never clears the map');

            missSession.messages.push({ role: 'assistant', content: 'delta-tail' });
            const pending = saveSessionAsync(missSession); // delta → deltaMiss → FULL retry
            // The full retry re-projects the LIVE session at retry time: make
            // that payload unprojectable/unclonable, so the retry attempts
            // nothing and can offer no snapshot of its own.
            missSession.messages.at(-1).unclonable = () => {};
            await assert.rejects(pending);
            await new Promise((resolve) => setImmediate(resolve));
            // Direct bookkeeping cleanup, not a self-referential promise count.
            assert.equal(_saveAsyncInflight.has(missId), false, 'no in-flight slot survives the retry failure');
            assert.equal(_saveAsyncQueued.has(missId), false, 'no queued follow-up survives it');
            assert.equal([..._saveWorkerPending.values()].some((entry) => entry.id === missId), false,
                'no pending worker request survives it');
            assert.equal(_sessionIncarnationRefs(missId), 0, 'the retry released its reference exactly once');
            assert.equal(getFailedSaveSnapshot(missId), null,
                'a retry that attempted nothing records NO evidence — never the delta snapshot');
            assert.ok(getSessionSaveError(missId), 'the retry failure is still surfaced');
            assert.equal(readFileSync(missPath, 'utf8'), goodBytes, 'canonical bytes untouched');

            // The worker instance and every other id are unaffected.
            delete missSession.messages.at(-1).unclonable;
            await saveSessionAsync(missSession);
            assert.equal(getSessionSaveError(missId), null, 'the next landed write clears it');
            assert.equal(JSON.parse(readFileSync(missPath, 'utf8')).messages.length, 2);
            // The control's own delta path still works end to end.
            controlSession.messages.push({ role: 'assistant', content: 'ctl-2' });
            await saveSessionAsync(controlSession);
            assert.equal(JSON.parse(readFileSync(controlPath, 'utf8')).messages.length, 2,
                'the control session still saves through its intact delta path');
            assert.equal(_sessionIncarnationRefs(missId), 0, 'and no reference leaks behind');
            const refsAfter = _sessionIncarnationStats();
            assert.equal(refsAfter.releaseUnderflows, refsBefore.releaseUnderflows, 'refs balanced');
            assert.ok(refsAfter.size <= refsAfter.max, 'registry stays capped');
            await saveSessionAsync(missSession);
            assert.equal(getSessionSaveError(missId), null, 'the next landed write clears it');
        });

        await t.test('B3 a failing queued promotion records evidence under cap pressure', async () => {
            const { getFailedSaveSnapshot, _acquireSessionIncarnation, _releaseSessionIncarnation, _sessionIncarnationStats } =
                await import('../src/runtime/agent/orchestrator/session/store/live-state.mjs');
            const before = _sessionIncarnationStats();
            const pinned = [];
            for (let i = 0; i < 4400; i += 1) pinned.push(_acquireSessionIncarnation(`sess_qpin_${i}`));
            const promoId = 'sess_queued_promotion_fail';
            const promoPath = join(sessionsDir, `${promoId}.json`);
            const promoSession = {
                id: promoId,
                owner: 'user',
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [{ role: 'user', content: 'p1' }],
            };
            let settlements = 0;
            try {
                await saveSessionAsync(promoSession);
                promoSession.messages.push({ role: 'assistant', content: 'inflight' });
                const inFlight = saveSessionAsync(promoSession);
                promoSession.messages.push({ role: 'user', content: 'queued-attempt' });
                // Queued behind it, with an UNCLONABLE option: projection will
                // succeed on promotion, the postMessage clone will not.
                const queued = saveSessionAsync(promoSession, { probe: () => {} });
                queued.then(() => { settlements += 1; }, () => { settlements += 1; });
                await inFlight; // its settlement promotes the queued write
                await assert.rejects(queued);
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(settlements, 1, 'the queued caller settles exactly once');

                assert.ok(getSessionSaveError(promoId), 'the promotion failure is recorded under cap pressure');
                const evidence = getFailedSaveSnapshot(promoId);
                assert.ok(evidence, 'with the promotion\'s own projected attempt');
                assert.equal(evidence.messages.at(-1).content, 'queued-attempt');
                const attemptedLength = evidence.messages.length;
                // A mutation AFTER settlement cannot rewrite the evidence.
                promoSession.messages.push({ role: 'assistant', content: 'after-settlement' });
                assert.equal(getFailedSaveSnapshot(promoId).messages.length, attemptedLength);
                evictIdleLiveSessions({ isSessionLive: () => false });
                assert.equal(loadSession(promoId).messages.length, 4, 'live state stays pinned');
                assert.equal(JSON.parse(readFileSync(promoPath, 'utf8')).messages.length, 2,
                    'only the landed in-flight write is on disk');
                await saveSessionAsync(promoSession);
                assert.equal(getSessionSaveError(promoId), null, 'a landed write clears it again');
            } finally {
                for (const token of pinned) _releaseSessionIncarnation(token);
            }
            const after = _sessionIncarnationStats();
            assert.equal(after.releaseUnderflows, before.releaseUnderflows, 'no double release');
            assert.ok(after.size <= after.max, 'registry stays capped');
        });

        await t.test('B4 the eviction seam is inert without the structural gate', async () => {
            // A FRESH process without MIXDOG_SESSION_SAVE_FAULT_HOOKS: the seam
            // must refuse (false) and be unable to evict anything, while normal
            // saves keep working.
            const gateId = 'sess_seam_gate_child';
            const childPath = join(dataDir, 'seam-gate-child.mjs');
            const storeUrl = pathToFileURL(join(REPO_ROOT, 'src/runtime/agent/orchestrator/session/store.mjs')).href;
            const workerUrl = pathToFileURL(join(REPO_ROOT, 'src/runtime/agent/orchestrator/session/store/save-worker.mjs')).href;
            writeFileSync(childPath, `
import assert from 'node:assert/strict';
const store = await import(${JSON.stringify(storeUrl)});
const worker = await import(${JSON.stringify(workerUrl)});
const id = process.argv[2];
const nowMs = Date.now();
const session = { id, owner: 'user', status: 'idle', createdAt: nowMs, updatedAt: nowMs, messages: [{ role: 'user', content: 's1' }] };
await store.saveSessionAsync(session);
assert.equal(worker._evictWorkerDeltaBaseForTest(id), false, 'ungated eviction is refused');
assert.equal(await worker._probeWorkerDeltaBaseForTest(id), null, 'ungated probing is refused');
session.messages.push({ role: 'assistant', content: 's2' });
await store.saveSessionAsync(session);
process.exit(0);
`, 'utf8');
            const childEnv = { ...process.env, MIXDOG_DATA_DIR: dataDir };
            delete childEnv[FAULT_GATE];
            const child = spawnSync(process.execPath, [childPath, gateId], { env: childEnv, encoding: 'utf8' });
            assert.equal(child.status, 0, `ungated child passed (${child.stderr})`);
            assert.equal(JSON.parse(readFileSync(join(sessionsDir, `${gateId}.json`), 'utf8')).messages.length, 2,
                'saves still work in a process where the seam is unavailable');
        });

        setSessionSaveFault(null);
    } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
        delete process.env.MIXDOG_DATA_DIR;
        delete process.env[FAULT_GATE];
    }
});
