import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHostForegroundLock,
  FOREGROUND_LOCK_REPLY_PREFIX,
  nativeFallbackUnlock,
  nativeForegroundLease,
  nativeLeaseThread,
} from './foreground-lock-host.ts';

// The lease state machine (deadline, unlock retries, answer and outcome states,
// quarantine) is the Rust module's and is tested there
// (native/mixdog-window/src/foreground_lease.rs). These tests run the host's
// line protocol and its loader over a stand-in for the module's functions.

/** The module's lease functions, scripted: what they answer, what they were asked. */
function fakeModule() {
  let lease = 0;
  let onEvent;
  const fake = {
    calls: [],
    startError: '',
    requestError: '',
    endError: '',
    disposeOutcome: 'none',
    unlock: { outcome: 'released' },
    /** The next acquire's answer, or undefined for a granted lease. */
    next: undefined,
    leaseStart(callback) {
      fake.calls.push(['start']);
      if (fake.startError) throw new Error(fake.startError);
      onEvent = callback;
    },
    leaseRequest(request) {
      fake.calls.push(['request', request]);
      if (fake.requestError) throw new Error(fake.requestError);
      if (fake.next) return fake.next;
      lease += 1;
      return {
        holding: true,
        lease,
        answer: 'locked',
        deadlineAt: 1234.5,
        facts: JSON.stringify({ lease, answer: 'locked', host_pid: 1, worker_pid: request.pid }),
      };
    },
    leaseEnd(end) {
      fake.calls.push(['end', end]);
      if (fake.endError) throw new Error(fake.endError);
    },
    leaseGone(instance) {
      fake.calls.push(['gone', instance]);
    },
    leaseDispose() {
      fake.calls.push(['dispose']);
      return fake.disposeOutcome;
    },
    leaseUnlock() {
      fake.calls.push(['unlock']);
      return fake.unlock;
    },
    /** A lease end the thread reports, as the module's JSON. */
    emit(event) {
      onEvent(JSON.stringify(event));
    },
    count: (name) => fake.calls.filter(([called]) => called === name).length,
  };
  return fake;
}

/** The host's lease channel over the stand-in module, and one worker whose stdin lines are collected. */
function leases(t, fake = fakeModule()) {
  const lines = [];
  const lock = createHostForegroundLock(nativeForegroundLease(() => fake));
  t.after(() => lock.dispose());
  const worker = {
    instance: 1,
    pid: 321,
    owns: (action) => action === 7 || action === 8,
    write: (line) => lines.push(line),
  };
  const send = (message) => lock.handle(JSON.stringify(message), worker);
  return {
    fake,
    lock,
    lines,
    acquire: (action, seq, holdMs = 100, answerBy = 5_000) =>
      send({ op: 'acquire', action, seq, hold_ms: holdMs, answer_by: answerBy }),
    release: (action, seq, lease) => send({ op: 'release', action, seq, lease }),
    /** The worker's lines so far, without their prefix, and forgotten. */
    taken: () => lines.splice(0).map((line) => line.slice(FOREGROUND_LOCK_REPLY_PREFIX.length).trim()),
  };
}

const ended = (fields) => ({
  holding: false,
  instance: 1,
  action: 7,
  seq: 1,
  lease: 1,
  outcome: 'released',
  reply: false,
  facts: null,
  ...fields,
});

test('an acquire goes to the lease thread and its answer reaches the worker with the lease and deadline', (t) => {
  const { fake, lock, acquire, taken } = leases(t);
  acquire(7, 1, 100, 5_000);
  assert.deepEqual(fake.calls, [
    ['start'],
    ['request', { type: 'acquire', instance: 1, pid: 321, action: 7, seq: 1, holdMs: 100, answerBy: 5_000 }],
  ]);
  assert.deepEqual(taken(), ['ack 7 1 1 locked 1234.500']);
  // The facts are kept for the reply of the action, once.
  assert.deepEqual(lock.takeFacts(1, 7), { lease: 1, answer: 'locked', host_pid: 1, worker_pid: 321 });
  assert.equal(lock.takeFacts(1, 7), undefined);
  // The thread answers each state as it is: refused and quarantined take no lease.
  fake.next = { holding: false, lease: 0, answer: 'refused', deadlineAt: 0, facts: '{"lease":0,"answer":"refused"}' };
  acquire(8, 1);
  fake.next = { holding: true, lease: 0, answer: 'quarantined', deadlineAt: 0, facts: '{"lease":0,"answer":"quarantined"}' };
  acquire(8, 2);
  assert.deepEqual(taken(), ['ack 8 1 0 refused 0.000', 'ack 8 2 0 quarantined 0.000']);
  assert.equal(lock.takeFacts(1, 8).answer, 'quarantined');
});

test('a release names its own lease to the thread, and the reply waits for the thread’s account of the end', (t) => {
  const { fake, lock, release, acquire, taken } = leases(t);
  acquire(7, 1);
  taken();
  release(7, 1, 1);
  assert.deepEqual(fake.calls.at(-1), ['end', { type: 'release', instance: 1, action: 7, seq: 1, lease: 1 }]);
  assert.deepEqual(taken(), [], 'no reply until the thread says the lease ended');
  // An end nobody asked for (the deadline) updates the facts and writes nothing.
  fake.emit(ended({ facts: { lease: 1, release: 'released', released_by: 'deadline' } }));
  assert.deepEqual(taken(), []);
  assert.equal(lock.takeFacts(1, 7).released_by, 'deadline');
  // The end a release asked for is the worker's reply, with the outcome as the thread gave it.
  acquire(7, 2);
  taken();
  release(7, 2, 2);
  for (const outcome of ['released', 'unknown', 'failed', 'none']) {
    fake.emit(ended({ seq: 2, lease: 2, outcome, reply: true, facts: { lease: 2, release: outcome } }));
    assert.deepEqual(taken(), [`released 7 2 2 ${outcome}`]);
  }
  // A late end of an older lease does not replace the facts of the action's own.
  fake.emit(ended({ seq: 2, lease: 1, facts: { lease: 1, release: 'old' } }));
  assert.equal(lock.takeFacts(1, 7).release, 'none');
});

test('a thread that cannot take a request is down: the worker is answered unavailable and main unlocks once', (t) => {
  const { fake, lock, acquire, release, taken } = leases(t);
  acquire(7, 1, 1_000);
  assert.deepEqual(taken(), ['ack 7 1 1 locked 1234.500']);
  fake.requestError = 'boom';
  acquire(8, 1);
  assert.deepEqual(taken(), ['ack 8 1 0 unavailable 0.000']);
  assert.match(lock.takeFacts(1, 8).reason, /boom/);
  // The thread may have held the lock: main made its one unlock call, recorded on the action's facts.
  assert.equal(fake.count('unlock'), 1);
  const facts = lock.takeFacts(1, 7);
  assert.equal(facts.lease_thread.holding, true);
  assert.equal(facts.lease_thread.fallback_unlock, 'released');
  assert.match(facts.lease_thread.reason, /boom/);
  // A release asked now gets that unlock's account, not an unproven unknown.
  release(7, 1, 1);
  assert.deepEqual(taken(), ['released 7 1 1 released']);
  // No thread answers any more, and no second unlock or start follows.
  acquire(8, 2);
  assert.deepEqual(taken(), ['ack 8 2 0 unavailable 0.000']);
  assert.equal(fake.count('unlock'), 1);
  assert.equal(fake.count('start'), 1);
});

test('a release the thread cannot take is answered at once from main’s unlock, and a thread that held nothing says none', (t) => {
  const holding = leases(t);
  holding.acquire(7, 1);
  holding.taken();
  holding.fake.endError = 'gone';
  holding.release(7, 1, 1);
  assert.deepEqual(holding.taken(), ['released 7 1 1 released']);
  assert.equal(holding.fake.count('unlock'), 1);

  const idle = leases(t);
  idle.fake.next = { holding: false, lease: 0, answer: 'refused', deadlineAt: 0, facts: '{}' };
  idle.acquire(7, 1);
  idle.taken();
  idle.fake.endError = 'gone';
  idle.release(7, 1, 0);
  assert.deepEqual(idle.taken(), ['released 7 1 0 none']);
  assert.equal(idle.fake.count('unlock'), 0);
});

test('a lease module that does not start answers every request unavailable with the reason, once', (t) => {
  const fake = fakeModule();
  fake.startError = 'already running';
  const { lock, acquire, taken } = leases(t, fake);
  acquire(7, 1);
  acquire(7, 2);
  assert.deepEqual(taken(), ['ack 7 1 0 unavailable 0.000', 'ack 7 2 0 unavailable 0.000']);
  assert.match(lock.takeFacts(1, 7).reason, /could not start: already running/);
  assert.equal(fake.count('start'), 1);
  assert.equal(fake.count('unlock'), 0);
});

test('a worker that is gone ends its lease on the thread, and its facts are dropped', (t) => {
  const { fake, lock, acquire, taken } = leases(t);
  lock.workerGone(1);
  assert.equal(fake.count('gone'), 0, 'a worker the channel never saw changes nothing');
  acquire(7, 1);
  taken();
  lock.workerGone(1);
  assert.deepEqual(fake.calls.at(-1), ['gone', 1]);
  assert.equal(lock.takeFacts(1, 7), undefined);
});

test('dispose reports how the thread ended the lock, and main unlocks unless that was released or none', async (t) => {
  const failing = leases(t);
  failing.acquire(7, 1);
  failing.fake.disposeOutcome = 'failed';
  assert.deepEqual(await failing.lock.dispose(), { thread_release: 'failed', fallback_unlock: 'released' });
  assert.equal(failing.fake.count('unlock'), 1);
  // Disposed: nothing is taken or answered any more, and a second dispose is nothing.
  failing.acquire(7, 2);
  assert.deepEqual(failing.taken(), ['ack 7 1 1 locked 1234.500']);
  assert.equal(await failing.lock.dispose(), undefined);

  const unknown = leases(t);
  unknown.acquire(7, 1);
  unknown.fake.disposeOutcome = 'unknown';
  assert.deepEqual(await unknown.lock.dispose(), { thread_release: 'unknown', fallback_unlock: 'released' });

  const clean = leases(t);
  clean.acquire(7, 1);
  clean.fake.disposeOutcome = 'released';
  assert.deepEqual(await clean.lock.dispose(), { thread_release: 'released' });
  assert.equal(clean.fake.count('unlock'), 0);

  const none = leases(t);
  none.acquire(7, 1);
  none.fake.disposeOutcome = 'none';
  assert.deepEqual(await none.lock.dispose(), { thread_release: 'none' });
  assert.equal(none.fake.count('unlock'), 0);

  const never = leases(t);
  assert.equal(await never.lock.dispose(), undefined, 'no thread was ever started');
  assert.equal(never.fake.count('start'), 0);
});

test('the thread is stopped once: by its dispose, or by stop alone', () => {
  const disposed = fakeModule();
  const thread = nativeLeaseThread(disposed)({ message() {}, exit() {} });
  thread.post({ type: 'dispose' });
  thread.stop();
  assert.equal(disposed.count('dispose'), 1);

  const stopped = fakeModule();
  const other = nativeLeaseThread(stopped)({ message() {}, exit() {} });
  other.stop();
  other.stop();
  assert.equal(stopped.count('dispose'), 1);
});

test('the main-thread unlock maps the module’s answer: released, unknown with its error, or failed', () => {
  const fake = fakeModule();
  const unlock = nativeFallbackUnlock(() => fake);
  assert.deepEqual(unlock(), { outcome: 'released' });
  fake.unlock = { outcome: 'unknown', error: 5 };
  assert.deepEqual(unlock(), { outcome: 'unknown', error: 5 });
  fake.unlock = { outcome: 'unknown', error: null };
  assert.deepEqual(unlock(), { outcome: 'unknown' });
  fake.leaseUnlock = () => {
    throw new Error('no module');
  };
  assert.deepEqual(unlock(), { outcome: 'failed', error: 'no module' });
});

test('a module that cannot be loaded is reported once at error level and takes no lease', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  let loads = 0;
  const runtime = nativeForegroundLease(() => {
    loads++;
    throw new Error('missing');
  });
  const events = { message() {}, exit() {} };
  assert.throws(() => runtime.startThread(events), /could not be loaded: missing/);
  assert.throws(() => runtime.startThread(events), /could not be loaded: missing/);
  const unlocked = runtime.fallbackUnlock();
  assert.equal(unlocked.outcome, 'failed');
  assert.match(unlocked.error, /could not be loaded: missing/);
  assert.equal(loads, 1);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[0], /Computer Use runs without foreground-lock leases/);

  // Through the host: every request is answered unavailable with the reason.
  const lines = [];
  const lock = createHostForegroundLock(runtime);
  t.after(() => lock.dispose());
  const worker = { instance: 1, pid: 1, owns: () => true, write: (line) => lines.push(line) };
  lock.handle(JSON.stringify({ op: 'acquire', action: 7, seq: 1, hold_ms: 100, answer_by: 1 }), worker);
  assert.deepEqual(lines, [`${FOREGROUND_LOCK_REPLY_PREFIX}ack 7 1 0 unavailable 0.000\n`]);
  assert.match(lock.takeFacts(1, 7).reason, /could not be loaded: missing/);
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
