import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnerFairGate } from '../src/runtime/shared/owner-fair-gate.mjs';

test('owner-fair gate bounds queue wait and reports overload telemetry', async () => {
  const gate = createOwnerFairGate({
    name: 'test gate',
    activeMax: 1,
    queueMax: 8,
    minOwnerQueue: 1,
    waitTimeoutMs: 20,
  });
  const held = Promise.withResolvers();
  const running = gate.run('session-a', () => held.promise);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    gate.run('session-b', () => 'late'),
    (error) => error?.code === 'EADMISSIONWAITTIMEOUT',
  );
  const snapshot = gate.snapshot();
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.queued, 0);
  assert.equal(snapshot.timedOut, 1);
  assert.equal(snapshot.rejected, 1);
  held.resolve();
  await running;
});

test('owner-fair gate keeps a thousand-call burst bounded', async () => {
  const gate = createOwnerFairGate({
    name: 'burst gate',
    activeMax: 4,
    queueMax: 1024,
    minOwnerQueue: 8,
    waitTimeoutMs: 5_000,
  });
  let active = 0;
  let peak = 0;
  const calls = Array.from({ length: 1000 }, (_, index) =>
    gate.run(`session-${index % 32}`, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    }));
  await Promise.all(calls);
  assert.equal(peak, 4);
  assert.equal(gate.snapshot().queued, 0);
  assert.equal(gate.snapshot().admitted, 1000);
});
