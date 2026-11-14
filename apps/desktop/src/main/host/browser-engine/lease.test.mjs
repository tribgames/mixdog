import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLeases, LOCAL_INPUT_QUIET_MS } from './lease.ts';

/** A clock the test drives: timers fire when `advance` passes their time. */
function fakeClock() {
  let now = 1_000_000;
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++next;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const to = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = to;
    },
    pending: () => timers.size,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const clock = fakeClock();
  const notes = [];
  const notifications = new Map();
  const closers = [];
  const connection = {
    notify: (method, params) => notes.push({ method, params }),
    handleNotification: (method, handler) => notifications.set(method, handler),
    onClose: (listener) => closers.push(listener),
  };
  const ctx = { page: (pageId) => (pageId === 'p1' || pageId === 'p2' ? {} : undefined) };
  const leases = createLeases(connection, ctx, clock);
  return {
    clock,
    notes,
    leases,
    release: (params) => notifications.get('host/browser/lease/release')(params),
    close: () => closers.forEach((close) => close()),
  };
}

test('a person input aborts the agent call on that page with -32012 and says so', () => {
  const h = harness();
  const call = h.leases.beginCall('p1');
  const other = h.leases.beginCall('p2');
  h.leases.onUserInput('p1', 'key');
  assert.equal(call.signal.aborted, true);
  assert.equal(call.signal.reason.code, -32012);
  assert.equal(other.signal.aborted, false);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].method, 'host/browser/userInput');
  const params = h.notes[0].params;
  assert.deepEqual([params.pageId, params.held, params.reason, params.seq], ['p1', true, 'key', 1]);
  assert.equal(typeof params.until, 'number');
});

test('the page stays the person for the quiet window, then is let go', () => {
  const h = harness();
  h.leases.onUserInput('p1', 'pointer');
  assert.throws(() => h.leases.beginCall('p1'), { code: -32012 });
  assert.throws(() => h.leases.acquire('p1', 'c1', 5_000), { code: -32012 });
  h.clock.advance(LOCAL_INPUT_QUIET_MS - 1);
  assert.throws(() => h.leases.beginCall('p1'), { code: -32012 });
  // More input restarts the window.
  h.leases.onUserInput('p1', 'key');
  h.clock.advance(LOCAL_INPUT_QUIET_MS - 1);
  assert.equal(h.notes.at(-1).params.held, true);
  h.clock.advance(2);
  const last = h.notes.at(-1).params;
  assert.equal(last.held, false);
  assert.equal(last.until, undefined);
  assert.ok(last.seq > h.notes[0].params.seq);
  h.leases.beginCall('p1').end();
  assert.ok(h.leases.acquire('p1', 'c1', 5_000).startsWith('lease-p1-'));
});

test('a lease is dropped by the person, by its release, and by its ttl', () => {
  const h = harness();
  const id = h.leases.acquire('p1', 'c1', 5_000);
  assert.equal(h.leases.leaseOn('p1'), id);
  h.release({ pageId: 'p1', leaseId: 'other' });
  assert.equal(h.leases.leaseOn('p1'), id);
  h.release({ pageId: 'p1', leaseId: id });
  assert.equal(h.leases.leaseOn('p1'), undefined);
  h.leases.acquire('p1', 'c2', 100);
  h.clock.advance(101);
  assert.equal(h.leases.leaseOn('p1'), undefined);
  h.leases.acquire('p1', 'c3', 5_000);
  h.leases.onUserInput('p1', 'takeover');
  assert.equal(h.leases.leaseOn('p1'), undefined);
  assert.throws(() => h.release({ pageId: 'p1' }), { code: -32602 });
  assert.throws(() => h.leases.acquire('p9', 'c', 1), { code: -32011 });
});

test('person input runs one at a time in the order it came, and waits for the aborted agent call', async () => {
  const h = harness();
  const order = [];
  const call = h.leases.beginCall('p1');
  const gates = [];
  const op = (name) => () =>
    new Promise((resolve) => {
      order.push(`start ${name}`);
      gates.push(() => {
        order.push(`end ${name}`);
        resolve(name);
      });
    });
  const a = h.leases.executeLocal('p1', op('a'), { takeover: true, reason: 'key' });
  const b = h.leases.executeLocal('p1', op('b'), { takeover: true, reason: 'key' });
  await tick();
  assert.deepEqual(order, [], 'the aborted agent call has not ended yet');
  call.end();
  await tick();
  assert.deepEqual(order, ['start a']);
  gates[0]();
  await tick();
  gates[1]();
  assert.deepEqual([await a, await b], ['a', 'b']);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
});

test('hover is dropped while an agent call runs, and cancels nothing', async () => {
  const h = harness();
  const call = h.leases.beginCall('p1');
  let ran = false;
  const result = await h.leases.executeLocal('p1', async () => (ran = true), { takeover: false, dropIfBusy: true });
  assert.equal(result, undefined);
  assert.equal(ran, false);
  assert.equal(call.signal.aborted, false);
  assert.equal(h.notes.length, 0);
  call.end();
  assert.equal(await h.leases.executeLocal('p1', async () => 'moved', { takeover: false, dropIfBusy: true }), 'moved');
});

test('an input that waited longer than its bound expires unsent', async () => {
  const h = harness();
  const first = h.leases.executeLocal('p1', () => new Promise(() => {}), { takeover: true, reason: 'pointer' });
  first.catch(() => {});
  let ran = false;
  const late = h.leases.executeLocal('p1', async () => (ran = true), { takeover: true, maxWaitMs: 2_000, reason: 'key' });
  const failure = assert.rejects(late, /expired/);
  h.clock.advance(2_001);
  await failure;
  assert.equal(ran, false);
});

test('a pressed pointer holds the page until it is released, or its gesture expires', async () => {
  const h = harness();
  await h.leases.executeLocal('p1', async () => 1, { takeover: true, held: true, reason: 'pointer' });
  h.clock.advance(LOCAL_INPUT_QUIET_MS * 5);
  assert.equal(h.notes.at(-1).params.held, true, 'still pressed');
  assert.throws(() => h.leases.beginCall('p1'), { code: -32012 });
  await h.leases.executeLocal('p1', async () => 1, { takeover: true, held: false, reason: 'pointer' });
  h.clock.advance(LOCAL_INPUT_QUIET_MS + 1);
  assert.equal(h.notes.at(-1).params.held, false);

  await h.leases.executeLocal('p2', async () => 1, { takeover: true, held: true, reason: 'pointer' });
  h.clock.advance(60_000);
  assert.equal(h.notes.at(-1).params.pageId, 'p2');
  assert.equal(h.notes.at(-1).params.held, false, 'an unreleased press expires');
});

test('a held dialog or picker keeps the page until released', () => {
  const h = harness();
  const release = h.leases.hold('p1', 'filePicker');
  h.clock.advance(10_000);
  assert.throws(() => h.leases.beginCall('p1'), { code: -32012 });
  release();
  release();
  h.clock.advance(LOCAL_INPUT_QUIET_MS + 1);
  assert.equal(h.notes.at(-1).params.held, false);
  h.leases.beginCall('p1').end();
});

test('the connection closing drops every lease, stops the timers and ends the calls', () => {
  const h = harness();
  const call = h.leases.beginCall('p1');
  h.leases.acquire('p2', 'c', 60_000);
  h.leases.onUserInput('p1', 'key');
  h.close();
  assert.equal(call.signal.aborted, true);
  assert.equal(h.leases.leaseOn('p2'), undefined);
  assert.equal(h.clock.pending(), 0);
  const before = h.notes.length;
  h.leases.onUserInput('p1', 'key');
  assert.equal(h.notes.length, before);
});

test('person input still runs after the connection closed, unannounced', async () => {
  const h = harness();
  h.close();
  assert.equal(await h.leases.executeLocal('p1', async () => 'typed', { takeover: true, reason: 'key' }), 'typed');
  h.leases.hold('p1', 'dialog')();
  assert.equal(h.notes.length, 0);
  assert.equal(h.clock.pending(), 0);
});

test('an immediate input or a picker lets go of a pressed pointer, as the queue does', async () => {
  const h = harness();
  await h.leases.executeLocal('p1', async () => 1, { takeover: true, held: true, reason: 'pointer' });
  h.leases.onUserInput('p1', 'takeover');
  h.clock.advance(LOCAL_INPUT_QUIET_MS + 1);
  assert.equal(h.notes.at(-1).params.held, false);
  h.leases.beginCall('p1').end();
});

test('userInput seq keeps rising after an idle page state is dropped', () => {
  const h = harness();
  h.leases.onUserInput('p1', 'key');
  h.clock.advance(LOCAL_INPUT_QUIET_MS + 1);
  h.leases.onUserInput('p1', 'key');
  const seqs = h.notes.map((note) => note.params.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
});
