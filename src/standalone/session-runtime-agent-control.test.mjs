import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentControlRouter } from './session-runtime-agent-control.mjs';

// Minimal stand-ins for the shard pool: only what the router touches.
function fakePool() {
  const requests = [];
  const shards = [0, 1].map((index) => ({
    index,
    child: { killed: false },
    request(type, payload, timeoutMs) {
      requests.push({ shard: index, type, payload, timeoutMs });
      return Promise.resolve({ ok: true });
    },
  }));
  return {
    requests,
    shards,
    shardAt: (index) => shards[((Math.floor(Number(index) || 0) % shards.length) + shards.length) % shards.length],
    liveShards: () => shards,
    isPlaceable: () => true,
    ownership: { peek: () => null },
  };
}

test('a control cancel aborts the canonical run, which cancels the shard that owns the work', async () => {
  const pool = fakePool();
  // The canonical controller dispatches its work to shard 1 and forwards its
  // own abort there — exactly what host.agentDispatch does with the signal.
  let dispatched = null;
  const router = new AgentControlRouter(pool, async (_args, context) => {
    dispatched = new Promise((resolve) => {
      context.signal.addEventListener(
        'abort',
        () => {
          void pool.shardAt(1).request('agent-dispatch-cancel', { dispatchId: 'dispatch-owned-by-1' }, 10_000);
          resolve('canceled');
        },
        { once: true }
      );
    });
    return dispatched;
  });

  // The control is requested by a session on shard 0.
  router.handleAgentControl(pool.shardAt(0), pool.shardAt(0).child, {
    controlId: 'control-1',
    args: { type: 'spawn', tag: 'worker1' },
    context: { callerSessionId: 'sess_owner' },
  });

  assert.equal(router.cancelAgentControl({ controlId: 'control-1', reason: 'user canceled' }), true);
  await dispatched;
  const cancels = pool.requests.filter((row) => row.type === 'agent-dispatch-cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].shard, 1);
  assert.equal(cancels[0].payload.dispatchId, 'dispatch-owned-by-1');
});

test('a cancel for an unknown control answers false without broadcasting to any shard', () => {
  const pool = fakePool();
  const router = new AgentControlRouter(pool, async () => 'never runs');
  assert.equal(router.cancelAgentControl({ controlId: 'not-a-control' }), false);
  assert.equal(router.cancelAgentControl({}), false);
  assert.deepEqual(pool.requests, []);
});
