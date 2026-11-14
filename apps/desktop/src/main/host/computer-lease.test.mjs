import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { leaseThreadStarter } from '../computer/backend/foreground-lock-host.ts';
import { registerComputerLease } from './computer-lease.ts';

const FAKE_NATIVE = fileURLToPath(new URL('../computer/backend/fixtures/fake-lease-native.cjs', import.meta.url));
const now = () => Number(process.hrtime.bigint()) / 1e6;

/** The lease handler over a real lease thread with a stand-in user32, and no PowerShell worker anywhere. */
function served(t) {
  const handlers = new Map();
  const closers = [];
  const shared = new SharedArrayBuffer(48);
  const unlocks = [];
  registerComputerLease(
    {
      handleRequest: (method, handler) => handlers.set(method, handler),
      onClose: (listener) => closers.push(listener),
    },
    {
      startThread: leaseThreadStarter({ nativeModule: FAKE_NATIVE, shared }),
      fallbackUnlock: () => (unlocks.push(true), { outcome: 'released' }),
    }
  );
  t.after(() => closers.forEach((close) => close()));
  const ask = (params) =>
    handlers.get('host/computer/foregroundLease')(
      { instance: 'computer-1', action: 7, seq: 1, holdMs: 0, answerBy: 0, lease: 0, ...params },
      new AbortController().signal
    );
  return { ask, close: () => closers.forEach((close) => close()), counts: new Int32Array(shared, 0, 8) };
}

test('an acquire is answered with the lease, and its release ends it and carries the action facts', async (t) => {
  const { ask, counts } = served(t);
  const granted = await ask({ op: 'acquire', holdMs: 200, answerBy: now() + 1_000 });
  assert.equal(granted.kind, 'ack');
  assert.equal(granted.answer, 'locked');
  assert.ok(granted.lease > 0 && granted.deadlineAt > 0);
  // A granted lease's facts wait for its release, which updates them.
  assert.equal(granted.facts, undefined);
  assert.equal(Atomics.load(counts, 0), 1);
  const released = await ask({ op: 'release', lease: granted.lease });
  assert.equal(released.kind, 'released');
  assert.equal(released.lease, granted.lease);
  assert.equal(released.outcome, 'released');
  assert.equal(released.facts.answer, 'locked');
  assert.equal(typeof released.facts.host_pid, 'number');
  assert.equal(Atomics.load(counts, 1), 1);
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
