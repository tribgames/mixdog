// Regression coverage for the audited user-input-loss modes of the
// pending-message spool:
//   1. a FAILED durable commit must retry itself (an enqueue that reported
//      success may not stay process-local after transient lock contention),
//   2. shutdown must have a public, runtime-safe drain that actually flushes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

// Every env var must be set BEFORE the modules are loaded (the lock timeout
// is captured at import time), so the module under test is imported
// dynamically.
const root = mkdtempSync(join(tmpdir(), 'mixdog-pending-persist-'));
mkdirSync(root, { recursive: true });
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_LOCK_TIMEOUT_MS = '120';
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { _dropPendingMessageState, _setPendingPersistTailForTest, enqueuePendingMessage, settlePendingMessageWrites } =
  await import('./pending-messages.mjs');
const { pendingMessagesPath } = await import('./pending-spool-path.mjs');
const { flushPendingMessagePersistsSync } = await import('./pending-persist-queue.mjs');

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
// The shard directory exists before a test plants a held lock in it.
function spoolLockPath(sessionId) {
  const lockPath = `${pendingMessagesPath(sessionId)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  return lockPath;
}

function spoolRows(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(pendingMessagesPath(sessionId), 'utf8'));
    const rows = raw?.sessions?.[sessionId];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function spoolText(sessionId) {
  try {
    return readFileSync(pendingMessagesPath(sessionId), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
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
  const message = 'final remote submit';
  const lockPath = spoolLockPath(sessionId);
  // Live-holder lock (our pid + a foreign token is never reclaimed): every
  // commit attempt fails with ELOCKTIMEOUT exactly like the reproduced
  // cross-process contention.
  writeFileSync(lockPath, `${process.pid} ${Date.now()} deadbeefdeadbeefdeadbeef\n`, 'utf8');
  let lockHeld = true;
  try {
    // The submit reports success to the caller...
    assert.ok(enqueuePendingMessage(sessionId, message) > 0);
    await sleep(350);
    // ...while nothing could reach the spool yet.
    assert.equal(
      spoolRows(sessionId).some((row) => row.message === message),
      false
    );

    unlinkSync(lockPath);
    lockHeld = false;
    // No explicit settle/flush and no further enqueue: the module itself
    // must retry the requeued batch.
    assert.ok(
      await waitFor(() => spoolRows(sessionId).some((row) => row.message === message)),
      'requeued batch was never retried after the lock released'
    );
  } finally {
    if (lockHeld) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
    _dropPendingMessageState(sessionId);
    await settlePendingMessageWrites({ timeoutMs: 4000 });
  }
});

test('a closed session never resurrects its persist retry', async () => {
  const sessionId = `sess_closed_retry_${process.pid}`;
  const lockPath = spoolLockPath(sessionId);
  writeFileSync(lockPath, `${process.pid} ${Date.now()} deadbeefdeadbeefdeadbeef\n`, 'utf8');
  let lockHeld = true;
  try {
    assert.ok(enqueuePendingMessage(sessionId, 'input during contention') > 0);
    // At least one commit fails and requeues while the lock is held.
    await sleep(350);
    assert.equal(spoolRows(sessionId).length, 0);

    // Force the interleaving that used to race: a commit attempt is IN FLIGHT
    // (waiting on the lock) when the session closes. Whether the requeued
    // batch sits behind its retry timer or is already retrying, after this
    // flush exactly one attempt is in flight.
    flushPendingMessagePersistsSync();
    const spoolBeforeClose = spoolText(sessionId);

    // Close tears the pending state down; the in-flight commit must not land
    // after it, and in-flight failures must not rebuild the buffer or re-arm
    // the retry timer behind it.
    _dropPendingMessageState(sessionId);
    // ...and the fence must survive the state map's size trim: an evicted
    // entry that decays into "never closed" would let the in-flight failure
    // compare equal again (ABA) and resurrect the retry.
    for (let i = 0; i < 700; i += 1) {
      _dropPendingMessageState(`sess_evict_${process.pid}_${i}`, { clearPersisted: false });
    }
    unlinkSync(lockPath);
    lockHeld = false;
    // Await the ACTUAL completion of the in-flight commit and of the close's
    // clear chained behind it; the settle also flushes any buffer a failure
    // rebuilt, so a resurrected retry would write here too.
    assert.equal(await settlePendingMessageWrites({ timeoutMs: 4000, throwOnTimeout: true }), true);
    assert.equal(spoolText(sessionId), spoolBeforeClose, 'a pending-message write landed after the session closed');
    assert.deepEqual(spoolRows(sessionId), []);
  } finally {
    if (lockHeld) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
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
    // Tests and explicit callers can opt into strict timeout semantics.
    await assert.rejects(() => settlePendingMessageWrites({ timeoutMs: 80, throwOnTimeout: true }), /did not settle/);
  } finally {
    _setPendingPersistTailForTest(stuckSessionId, Promise.resolve());
    _dropPendingMessageState(sessionId);
    await settlePendingMessageWrites({ timeoutMs: 4000 });
  }
});
