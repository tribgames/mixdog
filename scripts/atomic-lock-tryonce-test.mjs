// Proves try-once (timeoutMs:0) lock behavior: when the lock is already held,
// withFileLockSync/withFileLock return IMMEDIATELY with ELOCKCONTENDED and
// never sleep (no Atomics.wait / setTimeout backoff). Also asserts sync+async
// lock interop: neither can enter the critical section while the other holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  withFileLockSync,
  withFileLock,
} from '../src/runtime/shared/atomic-file.mjs';

function tmpLock() {
  const dir = mkdtempSync(join(tmpdir(), 'mixlock-'));
  return { dir, lockPath: join(dir, 't.lock') };
}

test('try-once sync throws ELOCKCONTENDED without sleeping when held', () => {
  const { dir, lockPath } = tmpLock();
  try {
    withFileLockSync(lockPath, () => {
      const started = Date.now();
      assert.throws(
        () => withFileLockSync(lockPath, () => 'unreachable', { timeoutMs: 0 }),
        (e) => e?.code === 'ELOCKCONTENDED',
      );
      assert.ok(Date.now() - started < 20, `try-once slept ${Date.now() - started}ms`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('try-once async rejects ELOCKCONTENDED without sleeping when held', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    await withFileLockSync(lockPath, async () => {
      const started = Date.now();
      await assert.rejects(
        withFileLock(lockPath, () => 'unreachable', { timeoutMs: 0 }),
        (e) => e?.code === 'ELOCKCONTENDED',
      );
      assert.ok(Date.now() - started < 20, `try-once slept ${Date.now() - started}ms`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('async holder blocks sync try-once, then sync acquires after release', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    await withFileLock(lockPath, () => {
      assert.throws(
        () => withFileLockSync(lockPath, () => 'unreachable', { timeoutMs: 0 }),
        (e) => e?.code === 'ELOCKCONTENDED',
      );
    });
    const val = withFileLockSync(lockPath, () => 7, { timeoutMs: 0 });
    assert.equal(val, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
