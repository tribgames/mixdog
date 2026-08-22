// Regression coverage for the three audited user-input-loss modes of the
// pending-message spool:
//   1. a FAILED durable commit must retry itself (an enqueue that reported
//      success may not stay process-local after transient lock contention),
//   2. a taken foreign injection must stay durable until the consumer owns it
//      (an owner crash in the handoff window must not lose accepted input),
//   3. shutdown must have a public, runtime-safe drain that actually flushes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Every env var must be set BEFORE the modules are loaded (lock timeout and
// handoff grace are captured at import time), so the module under test is
// imported dynamically.
const HANDOFF_GRACE_MS = 4000;
const root = mkdtempSync(join(tmpdir(), 'mixdog-pending-persist-'));
mkdirSync(root, { recursive: true });
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_LOCK_TIMEOUT_MS = '120';
process.env.MIXDOG_FOREIGN_HANDOFF_RELEASE_MS = String(HANDOFF_GRACE_MS);
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const {
    _dropPendingMessageState,
    _setPendingPersistTailForTest,
    _settlePendingMessageWrites,
    drainForeignUserInjections,
    enqueuePendingMessage,
    enqueueRemotePendingMessage,
    pendingMessagesSpoolPath,
    settlePendingMessageWrites,
} = await import('./pending-messages.mjs');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const moduleUrl = new URL('./pending-messages.mjs', import.meta.url).href;

// A REAL second live process against the same spool: the cross-process rules
// (double-take suppression, recovery hydrate) cannot be observed by faking
// module state inside one process.
function runInLiveChildProcess(source) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8',
        env: {
            ...process.env,
            MIXDOG_DATA_DIR: root,
            MIXDOG_LOCK_TIMEOUT_MS: '2000',
            MIXDOG_FOREIGN_HANDOFF_RELEASE_MS: String(HANDOFF_GRACE_MS),
        },
    });
    assert.equal(result.status, 0, `child process failed: ${result.stderr}`);
    const out = String(result.stdout || '').trim().split('\n').pop();
    return JSON.parse(out);
}

const childDrainSource = (sessionId) => `
const mod = await import(${JSON.stringify(moduleUrl)});
const taken = await mod.drainForeignUserInjections(${JSON.stringify(sessionId)});
process.stdout.write(JSON.stringify(taken.map((item) => item.id)));
`;

const childHydrateSource = (sessionId) => `
const mod = await import(${JSON.stringify(moduleUrl)});
const count = await mod.hydratePendingMessages(${JSON.stringify(sessionId)});
process.stdout.write(JSON.stringify(count));
`;

function spoolRows(sessionId) {
    try {
        const raw = JSON.parse(readFileSync(pendingMessagesSpoolPath(), 'utf8'));
        const rows = raw?.sessions?.[sessionId];
        return Array.isArray(rows) ? rows : [];
    } catch {
        return [];
    }
}

async function waitFor(predicate, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(25);
    }
    return Boolean(predicate());
}

test('a failed durable commit retries itself once the spool lock releases', async () => {
    const sessionId = `sess_persist_retry_${process.pid}`;
    const messageId = 'inj_persist_retry';
    const lockPath = `${pendingMessagesSpoolPath()}.lock`;
    // Live-holder lock (our pid + a foreign token is never reclaimed): every
    // commit attempt fails with ELOCKTIMEOUT exactly like the reproduced
    // cross-process contention.
    writeFileSync(lockPath, `${process.pid} ${Date.now()} deadbeefdeadbeefdeadbeef\n`, 'utf8');
    let lockHeld = true;
    try {
        // The submit reports success to the caller...
        assert.equal(enqueueRemotePendingMessage(sessionId, { id: messageId, content: 'final remote submit' }), 1);
        await sleep(350);
        // ...while nothing could reach the spool yet.
        assert.equal(spoolRows(sessionId).some((row) => row.id === messageId), false);

        unlinkSync(lockPath);
        lockHeld = false;
        // No explicit settle/flush and no further enqueue: the module itself
        // must retry the requeued batch.
        assert.ok(
            await waitFor(() => spoolRows(sessionId).some((row) => row.id === messageId)),
            'requeued batch was never retried after the lock released',
        );
        assert.equal(
            spoolRows(sessionId).find((row) => row.id === messageId)?.message,
            'final remote submit',
        );
    } finally {
        if (lockHeld) { try { unlinkSync(lockPath); } catch { /* ignore */ } }
        _dropPendingMessageState(sessionId);
        await settlePendingMessageWrites({ timeoutMs: 4000 });
    }
});

test('a taken foreign injection is never re-taken by a second live process', async () => {
    const sessionId = `sess_foreign_handoff_${process.pid}`;
    const messageId = 'inj_foreign_handoff';
    try {
        assert.equal(enqueueRemotePendingMessage(sessionId, { id: messageId, content: 'remote user submit' }), 1);
        assert.equal(await settlePendingMessageWrites({ timeoutMs: 4000 }), true);

        const taken = await drainForeignUserInjections(sessionId);
        assert.deepEqual(taken.map((item) => item.id), [messageId]);
        // The row survives the take: the consumer queues it in memory only
        // after this point, so a crash here must not lose the input.
        assert.ok(
            spoolRows(sessionId).some((row) => row.id === messageId),
            'taken injection must stay durable while the handoff is in flight',
        );

        // A SECOND LIVE PROCESS drains the same session inside the grace: the
        // parked row belongs to a live owner, so it must not be re-delivered.
        assert.deepEqual(runInLiveChildProcess(childDrainSource(sessionId)), []);
        // ...and this owner does not take it twice either.
        assert.deepEqual(await drainForeignUserInjections(sessionId), []);

        // A fresh process taking the session over still RECOVERS the input
        // through the ordinary hydrate path (at-least-once, never lost).
        assert.equal(runInLiveChildProcess(childHydrateSource(sessionId)), 1);
    } finally {
        _dropPendingMessageState(sessionId);
        await settlePendingMessageWrites({ timeoutMs: 4000 });
    }
});

test('an expired handoff parked by a DEAD owner is taken over', async () => {
    const sessionId = `sess_dead_owner_${process.pid}`;
    const messageId = 'inj_dead_owner';
    // A process that has already exited: its pid is a corpse owner.
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    assert.ok(deadPid > 0);
    try {
        const now = Date.now();
        writeFileSync(pendingMessagesSpoolPath(), `${JSON.stringify({
            version: 1,
            updatedAt: now,
            sessions: {
                [sessionId]: [{
                    id: messageId,
                    message: 'submit stranded by a crashed owner',
                    enqueuedAt: now,
                    handoffAt: now - HANDOFF_GRACE_MS - 1000,
                    handoffPid: deadPid,
                }],
            },
            sessionTouchedAt: { [sessionId]: now },
        })}\n`, 'utf8');

        const taken = await drainForeignUserInjections(sessionId);
        assert.deepEqual(taken.map((item) => item.id), [messageId]);
    } finally {
        _dropPendingMessageState(sessionId);
        await settlePendingMessageWrites({ timeoutMs: 4000 });
    }
});

test('a dead owner\'s row observed BEFORE expiry is still recovered after the grace', async () => {
    const sessionId = `sess_dead_owner_transition_${process.pid}`;
    const messageId = 'inj_dead_owner_transition';
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    assert.ok(deadPid > 0);
    const spoolPath = pendingMessagesSpoolPath();
    try {
        const now = Date.now();
        writeFileSync(spoolPath, `${JSON.stringify({
            version: 1,
            updatedAt: now,
            sessions: {
                [sessionId]: [{
                    id: messageId,
                    message: 'submit parked shortly before the owner died',
                    enqueuedAt: now,
                    // Expires ~1.2s from now: the successor below sees it first
                    // INSIDE the grace window.
                    handoffAt: now - (HANDOFF_GRACE_MS - 1200),
                    handoffPid: deadPid,
                }],
            },
            sessionTouchedAt: { [sessionId]: now },
        })}\n`, 'utf8');

        // A persistent successor observes the row while it is still respected.
        // This scan memoizes the spool mtime.
        assert.deepEqual(await drainForeignUserInjections(sessionId), []);
        const mtimeAfterFirstScan = statSync(spoolPath).mtimeMs;
        await sleep(1600);
        // Nothing wrote the spool in between — post-expiry recovery must not
        // depend on an incidental mtime change (nor on being a fresh process).
        assert.equal(
            statSync(spoolPath).mtimeMs,
            mtimeAfterFirstScan,
            'the spool must stay untouched for this regression to be meaningful',
        );
        assert.deepEqual(
            (await drainForeignUserInjections(sessionId)).map((item) => item.id),
            [messageId],
        );
    } finally {
        _dropPendingMessageState(sessionId);
        await settlePendingMessageWrites({ timeoutMs: 4000 });
    }
});

test('a parked handoff row is released on schedule, without any later spool write', async () => {
    const sessionId = `sess_handoff_release_${process.pid}`;
    const messageId = 'inj_handoff_release';
    try {
        assert.equal(enqueueRemotePendingMessage(sessionId, { id: messageId, content: 'released after grace' }), 1);
        assert.equal(await settlePendingMessageWrites({ timeoutMs: 4000 }), true);
        assert.deepEqual(
            (await drainForeignUserInjections(sessionId)).map((item) => item.id),
            [messageId],
        );
        assert.ok(spoolRows(sessionId).some((row) => row.id === messageId));

        // Nothing below writes the spool: the release must be SCHEDULED, not a
        // side effect of some incidental later transaction (the per-session
        // mtime memo suppresses the next scan of an otherwise idle spool).
        assert.ok(
            await waitFor(
                () => !spoolRows(sessionId).some((row) => row.id === messageId),
                HANDOFF_GRACE_MS + 6000,
            ),
            'parked handoff row was never released after the grace window',
        );
    } finally {
        _dropPendingMessageState(sessionId);
        await settlePendingMessageWrites({ timeoutMs: 4000 });
    }
});

test('a closed session never resurrects its persist retry', async () => {
    const sessionId = `sess_closed_retry_${process.pid}`;
    const lockPath = `${pendingMessagesSpoolPath()}.lock`;
    writeFileSync(lockPath, `${process.pid} ${Date.now()} deadbeefdeadbeefdeadbeef\n`, 'utf8');
    let lockHeld = true;
    try {
        assert.ok(enqueuePendingMessage(sessionId, 'input during contention') > 0);
        // At least one commit fails and requeues while the lock is held.
        await sleep(350);
        assert.equal(spoolRows(sessionId).length, 0);

        // Close tears the pending state down; in-flight failures must not
        // rebuild the buffer or re-arm the retry timer behind it.
        _dropPendingMessageState(sessionId);
        // ...and the fence must survive the state map's size trim: an evicted
        // entry that decays into "never closed" would let the in-flight failure
        // compare equal again (ABA) and resurrect the retry.
        for (let i = 0; i < 700; i += 1) {
            _dropPendingMessageState(`sess_evict_${process.pid}_${i}`, { clearPersisted: false });
        }
        unlinkSync(lockPath);
        lockHeld = false;
        await sleep(900);
        assert.deepEqual(spoolRows(sessionId), []);
    } finally {
        if (lockHeld) { try { unlinkSync(lockPath); } catch { /* ignore */ } }
        _dropPendingMessageState(sessionId);
        await settlePendingMessageWrites({ timeoutMs: 4000 });
    }
});

test('the manager facade exposes the shutdown drain under its public name', async () => {
    const facade = await import('../manager.mjs');
    assert.equal(typeof facade.settlePendingMessageWrites, 'function');
});

test('settlePendingMessageWrites is the public, runtime-safe shutdown drain', async () => {
    const sessionId = `sess_shutdown_drain_${process.pid}`;
    const stuckSessionId = `sess_shutdown_stuck_${process.pid}`;
    try {
        assert.equal(typeof settlePendingMessageWrites, 'function');
        assert.ok(enqueuePendingMessage(sessionId, 'queued right before exit') > 0);
        // Buffered-only so far: shutdown that exits without draining loses it.
        assert.equal(await settlePendingMessageWrites({ timeoutMs: 4000 }), true);
        assert.ok(spoolRows(sessionId).some((row) => row.message === 'queued right before exit'));

        // A stuck spool tail must not break (or hang) an exit path...
        _setPendingPersistTailForTest(stuckSessionId, new Promise(() => {}));
        assert.equal(await settlePendingMessageWrites({ timeoutMs: 80 }), false);
        // ...while the underscore alias keeps its strict test semantics, and a
        // caller cannot switch that strictness off through the options bag.
        await assert.rejects(
            () => _settlePendingMessageWrites({ timeoutMs: 80 }),
            /did not settle/,
        );
        await assert.rejects(
            () => _settlePendingMessageWrites({ timeoutMs: 80, throwOnTimeout: false }),
            /did not settle/,
        );
    } finally {
        _setPendingPersistTailForTest(stuckSessionId, Promise.resolve());
        _dropPendingMessageState(sessionId);
        await settlePendingMessageWrites({ timeoutMs: 4000 });
    }
});
