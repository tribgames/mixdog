import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolApproval } from './tool-approval.mjs';

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
  const answer = h.api.requestToolApproval({ name: 'ask_user', kind: 'question', timeoutMs: 1234, args: { questions: [] } });
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
  assert.deepEqual(await answer, { approved: true, reason: 'ok', answers: [{ selected: ['A'] }], reply: 'typed in chat' });
});

test('an unlimited request is settled by denyAll (turn stop)', async () => {
  const h = harness({ timeoutMs: 5 });
  const answer = h.api.requestToolApproval({ name: 'ask_user', kind: 'question', timeoutMs: null });
  h.api.denyAllToolApprovals('turn cancelled');
  assert.deepEqual(await answer, { approved: false, reason: 'turn cancelled' });
  assert.equal(h.current(), null);
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
