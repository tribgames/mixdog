import assert from 'node:assert/strict';
import test from 'node:test';
import { drainDeferral, idleGcEligible } from './daemon-drain-policy.mjs';

test('idle GC is eligible with background-only work and memory agents in flight', () => {
  const work = { activeCalls: 0, queuedCalls: 0, busySessions: 2, busyMemoryAgents: 1, turnBusySessions: 0 };
  assert.equal(idleGcEligible(work), true);
  assert.equal(drainDeferral(work), 'busy'); // shutdown semantics unchanged
});

test('idle GC is blocked by a running turn or an active/queued call', () => {
  assert.equal(idleGcEligible({ turnBusySessions: 1 }), false);
  assert.equal(idleGcEligible({ activeCalls: 1 }), false);
  assert.equal(idleGcEligible({ queuedCalls: 1 }), false);
});
