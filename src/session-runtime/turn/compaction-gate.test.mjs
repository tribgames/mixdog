import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompactionGate } from './compaction-gate.mjs';

test('the next command waits for the chained compaction instead of racing it', async () => {
  const order = [];
  let release;
  const gate = createCompactionGate({
    getSessionId: () => 'A',
    compact: () =>
      new Promise((resolve) => {
        order.push('compact:start');
        release = () => {
          order.push('compact:end');
          resolve();
        };
      }),
  });
  gate.run('A');
  const next = gate.after(async () => order.push('turn'))();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['compact:start']);
  release();
  await next;
  assert.deepEqual(order, ['compact:start', 'compact:end', 'turn']);
});

test('a compaction for a session that is no longer current is skipped, and failures do not block', async () => {
  let current = 'A';
  let calls = 0;
  const gate = createCompactionGate({
    getSessionId: () => current,
    compact: async () => {
      calls++;
      throw new Error('boom');
    },
  });
  current = 'B';
  await gate.run('A');
  assert.equal(calls, 0);
  current = 'A';
  await gate.run('A');
  assert.equal(calls, 1);
  assert.equal(await gate.after(async () => 'ok')(), 'ok');
});
