import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeForegroundLease } from '../computer/backend/foreground-lock-host.ts';
import { registerComputerLease } from './computer-lease.ts';

const now = () => Number(process.hrtime.bigint()) / 1e6;

/** The lease functions of mixdog_window.node, scripted: a request is granted, a release of a lease it holds ends it
 *  (reported on the lease callback, as the module's thread does) and anything else ends with none. The lease
 *  deadlines and unlock retries are the Rust module's (native/mixdog-window/src/foreground_lease.rs) and tested there. */
function fakeModule() {
  let next = 0;
  let onEvent;
  const held = new Map();
  const fake = {
    calls: [],
    leaseStart(callback) {
      fake.calls.push('start');
      onEvent = callback;
    },
    leaseRequest(request) {
      fake.calls.push('request');
      next += 1;
      held.set(next, request);
      const facts = { lease: next, answer: 'locked', host_pid: process.pid, worker_pid: request.pid };
      return { holding: true, lease: next, answer: 'locked', deadlineAt: now() + request.holdMs, facts: JSON.stringify(facts) };
    },
    leaseEnd(end) {
      fake.calls.push('end');
      const outcome = held.delete(end.lease) ? 'released' : 'none';
      const event = { holding: false, instance: end.instance, action: end.action, seq: end.seq, lease: end.lease, outcome, reply: true };
      const facts = { lease: end.lease, answer: 'locked', host_pid: process.pid, release: outcome };
      queueMicrotask(() => onEvent?.(JSON.stringify({ ...event, facts })));
    },
    leaseGone(instance) {
      fake.calls.push('gone');
      void instance;
    },
    leaseDispose() {
      fake.calls.push('dispose');
      return 'none';
    },
    leaseUnlock() {
      fake.calls.push('unlock');
      return { outcome: 'released' };
    },
    count: (name) => fake.calls.filter((called) => called === name).length,
  };
  return fake;
}

/** The lease handler over the host's lease owner with the stand-in module, and no PowerShell worker anywhere. */
function served(t) {
  const handlers = new Map();
  const closers = [];
  const fake = fakeModule();
  registerComputerLease(
    {
      handleRequest: (method, handler) => handlers.set(method, handler),
      onClose: (listener) => closers.push(listener),
    },
    nativeForegroundLease(() => fake)
  );
  t.after(() => closers.forEach((close) => close()));
  const ask = (params) =>
    handlers.get('host/computer/foregroundLease')(
      { instance: 'computer-1', action: 7, seq: 1, holdMs: 0, answerBy: 0, lease: 0, ...params },
      new AbortController().signal
    );
  return { ask, close: () => closers.forEach((close) => close()), fake };
}
test('an acquire is answered with the lease, and its release ends it and carries the action facts', async (t) => {
  const { ask, fake } = served(t);
  const granted = await ask({ op: 'acquire', holdMs: 200, answerBy: now() + 1_000 });
  assert.equal(granted.kind, 'ack');
  assert.equal(granted.answer, 'locked');
  assert.ok(granted.lease > 0 && granted.deadlineAt > 0);
  // A granted lease's facts wait for its release, which updates them.
  assert.equal(granted.facts, undefined);
  assert.equal(fake.count('request'), 1);
  const released = await ask({ op: 'release', lease: granted.lease });
  assert.equal(released.kind, 'released');
  assert.equal(released.lease, granted.lease);
  assert.equal(released.outcome, 'released');
  assert.equal(released.facts.answer, 'locked');
  assert.equal(typeof released.facts.host_pid, 'number');
  assert.equal(fake.count('end'), 1);
});

test('after the connection closes, a new ask is served by a new owner', async (t) => {
  const { ask, close } = served(t);
  const first = await ask({ op: 'acquire', holdMs: 200, answerBy: now() + 1_000 });
  assert.equal(first.answer, 'locked');
  close();
  const again = await ask({ op: 'acquire', action: 8, holdMs: 200, answerBy: now() + 1_000 });
  assert.equal(again.kind, 'ack');
  assert.equal(again.answer, 'locked');
});

test('a request with a malformed number is invalid params at once', async (t) => {
  const { ask } = served(t);
  await assert.rejects(ask({ op: 'acquire', seq: 1.5, holdMs: 200, answerBy: now() + 1_000 }), { code: -32602 });
  await assert.rejects(ask({ op: 'acquire', holdMs: 200, answerBy: Number.NaN }), { code: -32602 });
  await assert.rejects(ask({ op: 'release', lease: -1 }), { code: -32602 });
});

test('a release with nothing leased is answered none, and a gone is accepted', async (t) => {
  const { ask } = served(t);
  assert.equal((await ask({ op: 'release', lease: 0 })).outcome, 'none');
  assert.equal((await ask({ op: 'gone' })).kind, 'unavailable');
});

test('without a lock to lease the answer is unavailable', async () => {
  const handlers = new Map();
  registerComputerLease({ handleRequest: (m, h) => handlers.set(m, h), onClose() {} }, null);
  const answer = await handlers.get('host/computer/foregroundLease')({ op: 'acquire', instance: 'a', action: 1, seq: 1, holdMs: 200, answerBy: 1 });
  assert.equal(answer.kind, 'unavailable');
  assert.equal(answer.answer, 'unavailable');
});

test('a request without an op, instance or action is invalid params', async (t) => {
  const { ask } = served(t);
  await assert.rejects(ask({ op: 'steal' }), { code: -32602 });
  await assert.rejects(ask({ instance: 7 }), { code: -32602 });
});
