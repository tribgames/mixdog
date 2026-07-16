// Proves try-once (timeoutMs:0) lock behavior: when the lock is already held,
// withFileLockSync/withFileLock return IMMEDIATELY with ELOCKCONTENDED and
// never sleep (no Atomics.wait / setTimeout backoff). Also asserts sync+async
// lock interop: neither can enter the critical section while the other holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

test('published reclaim guards are non-revocable regardless of owner, contents, or age', () => {
  for (const [name, content, aged] of [
    ['live', `${process.pid + 1} 1 live\n`, false],
    ['same-pid', `${process.pid} 1 sibling\n`, false],
    ['empty', '', false],
    ['malformed', 'not-a-guard', false],
    ['aged-dead', '2147483647 1 corpse\n', true],
  ]) {
    const { dir, lockPath } = tmpLock();
    try {
      const guardPath = `${lockPath}.reclaim`;
      writeFileSync(lockPath, '2147483647 1 dead-lock\n');
      writeFileSync(guardPath, content);
      if (aged) {
        const old = new Date(Date.now() - 60000);
        utimesSync(guardPath, old, old);
      }
      assert.throws(
        () => withFileLockSync(lockPath, () => 'unreachable', { timeoutMs: 5, staleMs: 1 }),
        (error) => error?.code === 'ELOCKTIMEOUT',
        name,
      );
      assert.equal(readFileSync(guardPath, 'utf8'), content, name);
      assert.equal(existsSync(lockPath), true, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('overlapping dead-guard contenders neither delete nor replace the guard', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    const guardPath = `${lockPath}.reclaim`;
    const guard = '2147483647 1 dead-guard\n';
    writeFileSync(lockPath, '2147483647 1 dead-lock\n');
    writeFileSync(guardPath, guard);
    const attempts = await Promise.allSettled([
      withFileLock(lockPath, () => 'unreachable', { timeoutMs: 10, staleMs: 1 }),
      withFileLock(lockPath, () => 'unreachable', { timeoutMs: 10, staleMs: 1 }),
    ]);
    assert.deepEqual(attempts.map(({ status, reason }) => [status, reason?.code]), [
      ['rejected', 'ELOCKTIMEOUT'],
      ['rejected', 'ELOCKTIMEOUT'],
    ]);
    assert.equal(readFileSync(guardPath, 'utf8'), guard);
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
