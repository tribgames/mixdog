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
