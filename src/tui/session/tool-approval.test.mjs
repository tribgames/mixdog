import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolApproval, resolveToolApprovalTimeoutMs } from './tool-approval.mjs';

// The observable contract of the approval FIFO: what lands in state.toolApproval,
// what each waiter resolves with, and which id settles which entry.
function harness({ timeoutMs = 60_000 } = {}) {
  let state = { toolApproval: null };
  let disposed = false;
  let seq = 0;
  const api = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `req-${++seq}`,
    getDisposed: () => disposed,
    timeoutMs,
  });
  return {
    api,
    current: () => state.toolApproval,
    dispose: () => {
      disposed = true;
    },
  };
}

test('a request is normalized, presented, and resolved by its own id', async () => {
  const h = harness();
  const answer = h.api.requestToolApproval({ tool_name: 'shell', tool_input: { cmd: 'ls' }, tool_use_id: 'call-1' });
  const presented = h.current();
  assert.equal(presented.id, 'req-1');
  assert.equal(presented.name, 'shell');
  assert.deepEqual(presented.args, { cmd: 'ls' });
  assert.equal(presented.toolCallId, 'call-1');
  assert.equal(presented.reason, 'approval requested by hook');
  assert.equal(presented.timeoutMs, 60_000);
  assert.equal(presented.expiresAt - presented.requestedAt, 60_000);

  assert.equal(h.api.finishToolApproval('req-9', true), false, 'an unknown id settles nothing');
  assert.equal(h.api.finishToolApproval('req-1', 'yes', 'ok'), true);
  assert.deepEqual(await answer, { approved: false, reason: 'ok' }, 'approved stays an === true comparison');
  assert.equal(h.current(), null);
});

test('the queued request takes the surface once the active one settles', async () => {
  const h = harness();
  const first = h.api.requestToolApproval({ name: 'a' });
  const second = h.api.requestToolApproval({ name: 'b' });
  assert.equal(h.current().id, 'req-1');

  assert.equal(h.api.finishToolApproval('req-1', true), true);
  assert.deepEqual(await first, { approved: true, reason: '' });
  assert.equal(h.current().id, 'req-2');

  assert.equal(h.api.finishToolApproval('req-2', false, 'nope'), true);
  assert.deepEqual(await second, { approved: false, reason: 'nope' });
  assert.equal(h.current(), null);
});

test('a still-queued request can be settled without ever being presented', async () => {
  const h = harness();
  const first = h.api.requestToolApproval({ name: 'a' });
  const second = h.api.requestToolApproval({ name: 'b' });

  assert.equal(h.api.finishToolApproval('req-2', true, 'early'), true);
  assert.deepEqual(await second, { approved: true, reason: 'early' });
  assert.equal(h.current().id, 'req-1', 'settling a queued entry does not re-present');

  h.api.finishToolApproval('req-1', true);
  await first;
  assert.equal(h.current(), null);
});

test('denying all settles the active request and everything still queued', async () => {
  const h = harness();
  const first = h.api.requestToolApproval({ name: 'a' });
  const second = h.api.requestToolApproval({ name: 'b' });

  h.api.denyAllToolApprovals('cancelled by user');
  assert.deepEqual(await first, { approved: false, reason: 'cancelled by user' });
  assert.deepEqual(await second, { approved: false, reason: 'cancelled by user' });
  assert.equal(h.current(), null);
});

test('a disposed runtime refuses new requests and presents nothing', async () => {
  const h = harness();
  h.dispose();
  assert.deepEqual(await h.api.requestToolApproval({ name: 'a' }), { approved: false, reason: 'runtime disposed' });
  assert.equal(h.current(), null);
});

test('an answer from a known device is recorded on the state; a timeout names nobody', async () => {
  let state = { toolApproval: null, toolApprovalResult: null };
  const api = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: (() => {
      let seq = 0;
      return () => `req-${++seq}`;
    })(),
    getDisposed: () => false,
    timeoutMs: 60_000,
  });
  const first = api.requestToolApproval({ name: 'shell' });
  assert.equal(api.finishToolApproval('req-1', true, 'approved by user', 'Pixel'), true);
  await first;
  assert.equal(state.toolApprovalResult.id, 'req-1');
  assert.equal(state.toolApprovalResult.approved, true);
  assert.equal(state.toolApprovalResult.device, 'Pixel');

  const second = api.requestToolApproval({ name: 'shell' });
  assert.equal(api.finishToolApproval('req-2', false, 'approval timed out'), true);
  await second;
  assert.equal(state.toolApprovalResult, null);
});

test('answers pass through to the waiter and kind/timeoutMs are honored per request', async () => {
  const h = harness();
  const answer = h.api.requestToolApproval({
    name: 'ask_user',
    kind: 'question',
    timeoutMs: 1234,
    args: { questions: [] },
  });
  const presented = h.current();
  assert.equal(presented.kind, 'question');
  assert.equal(presented.timeoutMs, 1234);
  assert.equal(presented.expiresAt - presented.requestedAt, 1234);
  const answers = [{ selected: ['A'] }, null];
  h.api.finishToolApproval(presented.id, true, 'ok', 'desktop', answers);
  assert.deepEqual(await answer, { approved: true, reason: 'ok', answers });
});

test('timeoutMs: null waits without a limit and stays pending until settled', async () => {
  const h = harness({ timeoutMs: 5 });
  let settled = false;
  const answer = h.api.requestToolApproval({ name: 'ask_user', kind: 'question', timeoutMs: null }).then((r) => {
    settled = true;
    return r;
  });
  const presented = h.current();
  assert.equal(presented.timeoutMs, null);
  assert.equal(presented.expiresAt, null);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false, 'the 5ms default never applies to an unlimited request');
  assert.equal(h.current().id, presented.id);
  h.api.finishToolApproval(presented.id, true, 'ok', 'desktop', [{ selected: ['A'] }], 'typed in chat');
  assert.deepEqual(await answer, {
    approved: true,
    reason: 'ok',
    answers: [{ selected: ['A'] }],
    reply: 'typed in chat',
  });
});

test('an unlimited request is settled by denyAll (turn stop)', async () => {
  const h = harness({ timeoutMs: 5 });
  const answer = h.api.requestToolApproval({ name: 'ask_user', kind: 'question', timeoutMs: null });
  h.api.denyAllToolApprovals('turn cancelled');
  assert.deepEqual(await answer, { approved: false, reason: 'turn cancelled' });
  assert.equal(h.current(), null);
});

/** A queue as the runtime builds it: the default limit comes from the environment. */
function runtimeQueue(env) {
  let state = { toolApproval: null };
  let seq = 0;
  const api = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `req-${++seq}`,
    getDisposed: () => false,
    timeoutMs: resolveToolApprovalTimeoutMs(env),
  });
  return { api, current: () => state.toolApproval };
}

for (const kind of ['', 'approval', 'outbound', 'permission']) {
  test(`a ${kind || 'tool'} approval has no default wait limit: pending past 120 s, answered whenever the user decides`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const queue = runtimeQueue({});
    let settled = null;
    const answer = queue.api
      .requestToolApproval({ name: 'mcp__gmail__send_email', kind, args: { to: 'boss@example.com' } })
      .then((result) => {
        settled = result;
        return result;
      });
    const presented = queue.current();
    assert.equal(presented.timeoutMs, null, 'no limit travels with the request');
    assert.equal(presented.expiresAt, null, 'no expiry for a card to count down to');

    t.mock.timers.tick(121_000);
    await Promise.resolve();
    assert.equal(settled, null, 'still waiting after the old 120 s limit');
    assert.equal(queue.current()?.id, presented.id, 'the card stays up');

    t.mock.timers.tick(3 * 60 * 60_000);
    await Promise.resolve();
    assert.equal(settled, null, 'still waiting hours later');

    assert.equal(queue.api.finishToolApproval(presented.id, true, 'approved by user', 'Pixel'), true);
    const result = await answer;
    assert.equal(result.approved, true);
    assert.equal(result.reason, 'approved by user');
    assert.equal(result.timedOut, undefined);
    assert.equal(queue.current(), null);
  });
}

test('a queued approval behind a pending one also waits without limit, and Stop still settles every waiter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const queue = runtimeQueue({});
  let settled = 0;
  const first = queue.api.requestToolApproval({ name: 'a' }).then((r) => {
    settled += 1;
    return r;
  });
  const second = queue.api.requestToolApproval({ name: 'b' }).then((r) => {
    settled += 1;
    return r;
  });
  t.mock.timers.tick(10 * 60_000);
  await Promise.resolve();
  assert.equal(settled, 0);
  assert.equal(queue.current().id, 'req-1');
  queue.api.denyAllToolApprovals('turn cancelled');
  assert.deepEqual(await first, { approved: false, reason: 'turn cancelled' });
  assert.deepEqual(await second, { approved: false, reason: 'turn cancelled' });
  assert.equal(queue.current(), null);
});

test('MIXDOG_TOOL_APPROVAL_TIMEOUT_MS stays an opt-in limit for tests and ops', async (t) => {
  assert.equal(resolveToolApprovalTimeoutMs({}), null);
  for (const value of ['', '0', '-5', 'soon']) {
    assert.equal(resolveToolApprovalTimeoutMs({ MIXDOG_TOOL_APPROVAL_TIMEOUT_MS: value }), null, value);
  }
  assert.equal(resolveToolApprovalTimeoutMs({ MIXDOG_TOOL_APPROVAL_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(resolveToolApprovalTimeoutMs({ MIXDOG_TOOL_APPROVAL_TIMEOUT_MS: '100' }), 1000, 'one second at least');

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const queue = runtimeQueue({ MIXDOG_TOOL_APPROVAL_TIMEOUT_MS: '5000' });
  const answer = queue.api.requestToolApproval({ name: 'shell' });
  assert.equal(queue.current().timeoutMs, 5000);
  t.mock.timers.tick(5001);
  assert.deepEqual(await answer, { approved: false, reason: 'approval timed out', timedOut: true });
});

test('a queue given no timeoutMs at all waits without limit (never an immediate NaN expiry)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let state = { toolApproval: null };
  const api = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => 'req-1',
    getDisposed: () => false,
  });
  let settled = false;
  const answer = api.requestToolApproval({ name: 'shell' }).then((r) => {
    settled = true;
    return r;
  });
  assert.equal(state.toolApproval.expiresAt, null);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(settled, false);
  api.finishToolApproval('req-1', true);
  assert.equal((await answer).approved, true);
});

test('a request timeout resolves with the approval-timed-out reason', async () => {
  const h = harness();
  const answer = h.api.requestToolApproval({ name: 'ask_user', kind: 'question', timeoutMs: 5 });
  const keepAlive = setTimeout(() => {}, 1000);
  const result = await answer;
  clearTimeout(keepAlive);
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'approval timed out');
});
