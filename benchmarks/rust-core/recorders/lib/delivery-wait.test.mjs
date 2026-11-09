// The wait for Node's review deliveries, against Node's real `turn-boundary-signal.mjs`:
//   MIXDOG_BENCH_TREE=<tree of b6f10295a> node --test benchmarks/rust-core/recorders/lib/delivery-wait.test.mjs
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { drainDeliveries } from './delivery-wait.mjs';

const boundary = await import(pathToFileURL(join(process.env.MIXDOG_BENCH_TREE, 'src/runtime/shared/turn-boundary-signal.mjs')).href);
const registry = () => globalThis[Symbol.for('mixdog.turnBoundarySignal.v1')];

test('a drain returns once every delivery it followed has reached the listeners, ones raised by listeners included', async () => {
  const calls = [];
  let left = 3;
  const off = boundary.onTurnReviewChanged(() => {
    calls.push('listener');
    if ((left -= 1) > 0) boundary.noteTurnReviewChanged();
  });
  boundary.noteTurnReviewChanged();
  await drainDeliveries(boundary, 'chain');
  off();
  assert.deepEqual(calls, ['listener', 'listener', 'listener']);
  assert.equal(registry().reviewQueued, false);
});

test('a drain with nothing queued returns without a delivery', async () => {
  await drainDeliveries(boundary, 'idle');
});

test('a listener that signals again after every delivery fails the drain by name instead of hanging', async () => {
  const off = boundary.onTurnReviewChanged(() => boundary.noteTurnReviewChanged());
  boundary.noteTurnReviewChanged();
  await assert.rejects(drainDeliveries(boundary, 'perpetual', { maxDeliveries: 25 }), /perpetual: a review delivery is still queued after following 25 of them/);
  off();
  await drainDeliveries(boundary, 'cleanup');
});

test('a queued delivery that never reaches its listeners fails the drain by name at its deadline', async () => {
  // A registry whose queue never empties and whose listeners never run: the delivery the drain waits for does not come.
  const stuck = { onTurnReviewChanged: () => () => {} };
  registry().reviewQueued = true;
  try {
    await assert.rejects(drainDeliveries(stuck, 'stuck', { deadlineMs: 50 }), /stuck: the queued review delivery did not reach its listeners within 50 ms/);
  } finally {
    registry().reviewQueued = false;
  }
});
