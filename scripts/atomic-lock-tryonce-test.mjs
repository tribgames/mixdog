// Proves try-once (timeoutMs:0) lock behavior: when the lock is already held,
// withFileLockSync/withFileLock return IMMEDIATELY with ELOCKCONTENDED and
// never sleep (no Atomics.wait / setTimeout backoff), except that one guarded
// attempt may reclaim an already-stale corpse. Also asserts sync+async lock
// interop: neither can enter the critical section while the other holds.
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
  updateJsonAtomic,
} from '../src/runtime/shared/atomic-file.mjs';

function tmpLock() {
  const dir = mkdtempSync(join(tmpdir(), 'mixlock-'));
  return { dir, lockPath: join(dir, 't.lock') };
}

// One process now hosts every session (engine daemon) plus its channels and
// config writers, so same-process contention is the COMMON case. The OS lock
// cannot express "already mine": contenders spun to ELOCKTIMEOUT and a nested
// call waited for itself forever. These pin the in-process queue instead.
test('same-process writers on one path serialize instead of timing out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixlock-inproc-'));
  const file = join(dir, 'state.json');
  try {
    const writes = Array.from({ length: 12 }, (_, index) => updateJsonAtomic(
      file,
      (current) => ({ hits: [...(current?.hits || []), index] }),
      // A timeout short enough that spinning contenders would fail.
      { timeoutMs: 300, lock: true, compact: true },
    ));
    await Promise.all(writes);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(stored.hits.length, 12, 'every writer applied its update');
    assert.deepEqual([...stored.hits].sort((a, b) => a - b),
      Array.from({ length: 12 }, (_, index) => index));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nested lock on the same path runs through instead of self-deadlocking', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    const order = [];
    await withFileLock(lockPath, async () => {
      order.push('outer');
      await withFileLock(lockPath, async () => { order.push('inner'); }, { timeoutMs: 300 });
      order.push('outer-end');
    }, { timeoutMs: 300 });
    assert.deepEqual(order, ['outer', 'inner', 'outer-end']);
    assert.equal(existsSync(lockPath), false, 'the lock is released after the outermost holder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('try-once reclaims stale pidless locks but never fresh empty locks', async () => {
  for (const asyncMode of [false, true]) {
    const { dir, lockPath } = tmpLock();
    try {
      writeFileSync(lockPath, '');
      assert.equal(
        asyncMode
          ? await withFileLock(lockPath, () => 'fresh', { timeoutMs: 0, staleMs: 30_000 })
              .then(() => 'acquired', (error) => error?.code)
          : (() => {
              try {
                withFileLockSync(lockPath, () => 'fresh', { timeoutMs: 0, staleMs: 30_000 });
                return 'acquired';
              } catch (error) {
                return error?.code;
              }
            })(),
        'ELOCKCONTENDED',
      );
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);
      const value = asyncMode
        ? await withFileLock(lockPath, () => 'recovered', { timeoutMs: 0, staleMs: 30_000 })
        : withFileLockSync(lockPath, () => 'recovered', { timeoutMs: 0, staleMs: 30_000 });
      assert.equal(value, 'recovered');
      assert.equal(existsSync(lockPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

test('async atomic update preserves read-modify-write behavior', async () => {
  const { dir } = tmpLock();
  const filePath = join(dir, 'state.json');
  try {
    writeFileSync(filePath, JSON.stringify({ count: 1 }));
    const updated = await updateJsonAtomic(filePath, (current) => ({
      ...current,
      count: Number(current?.count || 0) + 1,
    }), { compact: true, timeoutMs: 0 });
    assert.equal(updated.count, 2);
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { count: 2 });
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
