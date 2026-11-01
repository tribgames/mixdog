import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHostForegroundLock, FOREGROUND_LOCK_REPLY_PREFIX, leaseThreadStarter } from './foreground-lock-host.ts';

const FAKE_NATIVE = fileURLToPath(new URL('./fixtures/fake-lease-native.cjs', import.meta.url));
// Slots of the stand-in's shared buffer (fixtures/fake-lease-native.cjs).
const [LOCKS, UNLOCKS, UNLOCK_CALLS, , UNLOCK_MODE, CLOCK_MODE] = [0, 1, 2, 3, 4, 5];
const [LOCK_AT, UNLOCK_AT] = [0, 1];
const UNLOCK_TRUE = 0;
const UNLOCK_FALSE = 1;
const UNLOCK_THROWS = 2;
const UNLOCK_ENDS_THREAD = 3;
/** The clock the stand-in reads on the lease thread. */
const now = () => Number(process.hrtime.bigint()) / 1e6;

/** The host's lease channel over a real lease thread with a stand-in user32,
 *  and one worker whose stdin lines are collected. */
function leases(t) {
  const shared = new SharedArrayBuffer(48);
  const counts = new Int32Array(shared, 0, 8);
  const times = new Float64Array(shared, 32, 2);
  const lines = [];
  // Main's own unlock call, recorded rather than made.
  const fallbacks = [];
  const lock = createHostForegroundLock({
    startThread: leaseThreadStarter({ nativeModule: FAKE_NATIVE, shared }),
    fallbackUnlock: () => {
      fallbacks.push(now());
      return { outcome: 'released' };
    },
  });
  t.after(() => lock.dispose());
  const worker = { instance: 1, pid: 321, owns: (action) => action === 7 || action === 8, write: (line) => lines.push(line) };
  const send = (message) => lock.handle(JSON.stringify(message), worker);
  return {
    lock,
    counts,
    times,
    lines,
    fallbacks,
    acquire: (action, seq, holdMs = 100, answerBy = now() + 250) =>
      send({ op: 'acquire', action, seq, hold_ms: holdMs, answer_by: answerBy }),
    release: (action, seq, lease) => send({ op: 'release', action, seq, lease: Number(lease) }),
    /** The worker's next answer of `kind` for `action` and `seq`, as its fields. */
    async answer(kind, action, seq) {
      const head = `${FOREGROUND_LOCK_REPLY_PREFIX}${kind} ${action} ${seq} `;
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        const index = lines.findIndex((line) => line.startsWith(head));
        if (index >= 0) return lines.splice(index, 1)[0].slice(FOREGROUND_LOCK_REPLY_PREFIX.length).trim().split(' ');
        await sleep(5);
      }
      throw new Error(`no ${kind} answer for ${action}/${seq}: ${JSON.stringify(lines)}`);
    },
  };
}

test('a lease ends at its deadline on the lease thread while the main event loop is blocked', { timeout: 20_000 }, async (t) => {
  const { lock, counts, times, acquire, answer } = leases(t);
  acquire(7, 1, 250);
  const [, , , lease, said, deadline] = await answer('ack', 7, 1);
  assert.equal(said, 'locked');
  assert.equal(Atomics.load(counts, UNLOCKS), 0);
  // Seconds of a blocked loop: no timer, message or I/O of this thread runs.
  const blockedAt = now();
  let seenAt = 0;
  while (now() - blockedAt < 3_000) {
    if (!seenAt && Atomics.load(counts, UNLOCKS) === 1) seenAt = now();
  }
  assert.ok(seenAt > 0, 'the lock was still held after 3 s of a blocked loop');
  const hold = Number(deadline) - times[LOCK_AT];
  assert.ok(hold >= 249.99 && hold < 251, `deadline ${hold} ms after the lock`);
  const late = times[UNLOCK_AT] - Number(deadline);
  assert.ok(late >= -0.01 && late < 50, `unlocked ${late} ms after the deadline`);
  t.diagnostic(`unlocked ${late.toFixed(1)} ms after the deadline, seen ${(seenAt - blockedAt).toFixed(1)} ms into the block`);
  // The thread's account arrives once this loop runs again.
  await sleep(50);
  const facts = lock.takeFacts(1, 7);
  assert.deepEqual([facts.lease, facts.answer, facts.release, facts.released_by], [Number(lease), 'locked', 'released', 'deadline']);
  assert.equal(facts.foreground_pid, 4242);
  assert.ok(facts.held_ms >= 250 && facts.held_ms < 300, JSON.stringify(facts));
});

test('a release names its own lease: a stale one leaves a newer lease alone', { timeout: 20_000 }, async (t) => {
  const { counts, acquire, release, answer } = leases(t);
  acquire(7, 1);
  const first = (await answer('ack', 7, 1))[3];
  release(7, 1, first);
  assert.deepEqual((await answer('released', 7, 1)).slice(3), [first, 'released']);
  acquire(7, 2, 1_000);
  const [, , , second, said] = await answer('ack', 7, 2);
  assert.equal(said, 'locked');
  // The first lease's release once more, and the newer request naming the old lease.
  release(7, 1, first);
  assert.deepEqual((await answer('released', 7, 1)).slice(3), [first, 'released']);
  release(7, 2, first);
  assert.deepEqual((await answer('released', 7, 2)).slice(3), [first, 'none']);
  assert.equal(Atomics.load(counts, UNLOCKS), 1, 'the newer lease still holds the lock');
  release(7, 2, second);
  assert.deepEqual((await answer('released', 7, 2)).slice(3), [second, 'released']);
  assert.equal(Atomics.load(counts, UNLOCKS), 2);
});

test('a request whose worker stopped waiting is refused before any lock is taken', { timeout: 20_000 }, async (t) => {
  const { lock, counts, acquire, answer } = leases(t);
  acquire(7, 1, 100, now() - 1);
  assert.deepEqual((await answer('ack', 7, 1)).slice(3, 5), ['0', 'expired']);
  assert.equal(Atomics.load(counts, LOCKS), 0);
  assert.equal(lock.takeFacts(1, 7).answer, 'expired');
});

test('an unlock that is not proven is retried, never reported released, and holds off new leases', { timeout: 20_000 }, async (t) => {
  const { lock, counts, lines, acquire, release, answer } = leases(t);
  // A false unlock: Windows may have lifted the lock already, so it is unknown.
  Atomics.store(counts, UNLOCK_MODE, UNLOCK_FALSE);
  acquire(7, 1);
  const unknown = (await answer('ack', 7, 1))[3];
  release(7, 1, unknown);
  // Asked while the unlock is still being retried.
  acquire(8, 1);
  assert.equal((await answer('ack', 8, 1))[4], 'quarantined');
  assert.deepEqual((await answer('released', 7, 1)).slice(3), [unknown, 'unknown']);
  assert.equal(Atomics.load(counts, UNLOCK_CALLS), 4, 'the unlock was tried again');
  const facts = lock.takeFacts(1, 7);
  assert.deepEqual([facts.release, facts.unlock_attempts], ['unknown', 4]);
  // Once those retries settle, a lock Windows grants may begin a new lease.
  Atomics.store(counts, UNLOCK_MODE, UNLOCK_TRUE);
  acquire(8, 2);
  const next = await answer('ack', 8, 2);
  assert.equal(next[4], 'locked');
  release(8, 2, next[3]);
  assert.equal((await answer('released', 8, 2))[4], 'released');

  // Unlock calls that fail outright: failed, and no lease until one answers.
  Atomics.store(counts, UNLOCK_MODE, UNLOCK_THROWS);
  acquire(7, 3);
  const failing = (await answer('ack', 7, 3))[3];
  release(7, 3, failing);
  assert.deepEqual((await answer('released', 7, 3)).slice(3), [failing, 'failed']);
  acquire(8, 4);
  assert.equal((await answer('ack', 8, 4))[4], 'quarantined');
  Atomics.store(counts, UNLOCK_MODE, UNLOCK_TRUE);
  await sleep(1_300);
  acquire(8, 5);
  assert.equal((await answer('ack', 8, 5))[4], 'locked');
  assert.deepEqual(lines, [], 'no other answer reached the worker');
});

/** Waits until `ready` holds, polling this loop. */
async function until(ready, what) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test('a clock that throws at the deadline still ends the lease, and the thread lives on retrying', { timeout: 20_000 }, async (t) => {
  const { lock, counts, acquire, answer } = leases(t);
  acquire(7, 1, 100);
  assert.equal((await answer('ack', 7, 1))[4], 'locked');
  // From here every clock read on the lease thread throws, and the unlock is unproven.
  Atomics.store(counts, CLOCK_MODE, 1);
  Atomics.store(counts, UNLOCK_MODE, UNLOCK_FALSE);
  await until(() => Atomics.load(counts, UNLOCK_CALLS) === 4, 'the deadline unlock and its retries');
  await sleep(50);
  const facts = lock.takeFacts(1, 7);
  assert.deepEqual([facts.release, facts.released_by, facts.unlock_attempts], ['unknown', 'deadline', 4]);
  assert.match(facts.clock_error, /QueryPerformanceCounter failed/);
  // The thread is alive: with the clock back it answers the next request.
  Atomics.store(counts, CLOCK_MODE, 0);
  Atomics.store(counts, UNLOCK_MODE, UNLOCK_TRUE);
  acquire(8, 1);
  assert.equal((await answer('ack', 8, 1))[4], 'locked');
});

test('a lease thread that ends while holding a lease gets one unlock call from main', { timeout: 20_000 }, async (t) => {
  const { lock, counts, fallbacks, acquire, release, answer } = leases(t);
  acquire(7, 1, 1_000);
  const lease = (await answer('ack', 7, 1))[3];
  // The unlock call itself ends the thread.
  Atomics.store(counts, UNLOCK_MODE, UNLOCK_ENDS_THREAD);
  release(7, 1, lease);
  await until(() => fallbacks.length === 1, "main's fallback unlock");
  const facts = lock.takeFacts(1, 7);
  assert.equal(facts.lease_thread.holding, true);
  assert.equal(facts.lease_thread.fallback_unlock, 'released');
  assert.match(facts.lease_thread.reason, /exited \(3\)/);
  // A release asked again gets that unlock's account, not an unproven unknown.
  release(7, 1, lease);
  assert.deepEqual((await answer('released', 7, 1)).slice(3), [lease, 'released']);
  // No thread answers any more, and no second unlock follows.
  acquire(8, 1);
  assert.equal((await answer('ack', 8, 1))[4], 'unavailable');
  assert.equal(fallbacks.length, 1);
});

test('dispose reports how the thread ended the lock, and main unlocks unless that was released', { timeout: 20_000 }, async (t) => {
  const failing = leases(t);
  failing.acquire(7, 1, 1_000);
  assert.equal((await failing.answer('ack', 7, 1))[4], 'locked');
  Atomics.store(failing.counts, UNLOCK_MODE, UNLOCK_THROWS);
  assert.deepEqual(await failing.lock.dispose(), { thread_release: 'failed', fallback_unlock: 'released' });
  assert.equal(failing.fallbacks.length, 1);

  const clean = leases(t);
  clean.acquire(7, 1, 1_000);
  assert.equal((await clean.answer('ack', 7, 1))[4], 'locked');
  assert.deepEqual(await clean.lock.dispose(), { thread_release: 'released' });
  assert.equal(clean.fallbacks.length, 0);
});

test('a line that is not a well-formed request of the worker’s own action reaches no lease and never throws', () => {
  const posted = [];
  const lock = createHostForegroundLock({
    startThread: () => ({ post: (message) => posted.push(message), stop() {} }),
    fallbackUnlock: () => ({ outcome: 'released' }),
  });
  const worker = {
    instance: 1,
    pid: 1,
    owns: (action) => action === 7,
    write() {
      throw new Error('stdin closed');
    },
  };
  const request = { op: 'acquire', action: 7, seq: 1, hold_ms: 100, answer_by: 1 };
  for (const payload of [
    'null',
    '[]',
    '7',
    '"acquire"',
    '{"op":',
    '{"op":"acquire"}',
    JSON.stringify({ ...request, hold_ms: 5_000 }),
    JSON.stringify({ ...request, hold_ms: 0 }),
    JSON.stringify({ ...request, seq: 0 }),
    JSON.stringify({ ...request, seq: 2 ** 40 }),
    JSON.stringify({ ...request, answer_by: 'soon' }),
    JSON.stringify({ ...request, op: 'grab' }),
    JSON.stringify({ op: 'release', action: 7, seq: 1, lease: -1 }),
    JSON.stringify({ ...request, action: 9 }),
  ]) {
    lock.handle(payload, worker);
  }
  assert.deepEqual(posted, []);
  lock.handle(JSON.stringify(request), worker);
  assert.deepEqual(posted, [{ type: 'acquire', instance: 1, pid: 1, action: 7, seq: 1, holdMs: 100, answerBy: 1 }]);
  lock.dispose();
});
