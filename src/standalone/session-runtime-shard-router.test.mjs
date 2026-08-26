import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShardOwnership,
  hashRoutingKey,
  normalizeShardCount,
  mergeProviderCooldown,
  resolveShardCount,
  runtimeRoutingKey,
  selectShardIndex,
  shardIndexForKey,
  shardProbeOrder,
} from './session-runtime-shard-router.mjs';

test('production always uses one shared actor runtime process', () => {
  assert.equal(resolveShardCount({}, 1), 1);
  assert.equal(resolveShardCount({}, 2), 1);
  assert.equal(resolveShardCount({}, 128), 1);
  assert.equal(resolveShardCount({ MIXDOG_SESSION_RUNTIME_SHARDS: '6' }, 128), 1);
  // Explicit constructor counts remain a bounded recovery/routing test seam.
  assert.equal(normalizeShardCount(999), 16);
  assert.equal(normalizeShardCount(0), 1);
  assert.equal(normalizeShardCount(-3), 1);
  assert.equal(normalizeShardCount(Number.NaN), 1);
  assert.equal(normalizeShardCount(3), 3);
});

test('routing is deterministic, in range, and spreads keys across shards', () => {
  assert.equal(hashRoutingKey('sess-1'), hashRoutingKey('sess-1'));
  const used = new Set();
  for (let index = 0; index < 200; index += 1) {
    const key = `sess-${index}`;
    const shard = shardIndexForKey(key, 4);
    assert.equal(shard, shardIndexForKey(key, 4));
    assert.ok(shard >= 0 && shard < 4);
    used.add(shard);
  }
  // Fan-out is the point: a batch of independent sessions must not collapse
  // onto one event loop.
  assert.equal(used.size, 4);
});

test('probe order starts at the home shard and covers every shard once', () => {
  const order = shardProbeOrder('sess-probe', 4);
  assert.equal(order.length, 4);
  assert.equal(order[0], shardIndexForKey('sess-probe', 4));
  assert.equal(new Set(order).size, 4);
});

test('placement skips unplaceable shards but never drops the work', () => {
  const key = 'sess-degraded';
  const home = shardIndexForKey(key, 3);
  const next = shardProbeOrder(key, 3)[1];
  assert.equal(selectShardIndex(key, 3, () => true), home);
  assert.equal(selectShardIndex(key, 3, (index) => index !== home), next);
  // Every shard degraded: the home shard still owns it (queued, not lost).
  assert.equal(selectShardIndex(key, 3, () => false), home);
});

test('session identity owns the shard and ownership is sticky until released', () => {
  assert.equal(runtimeRoutingKey({ sessionId: 'sess-a' }, 'runtime-1'), 'sess-a');
  assert.equal(runtimeRoutingKey({}, 'runtime-1'), 'runtime-1');

  const ownership = createShardOwnership();
  const first = ownership.claim('sess-a', () => 1);
  // A second holder of the same session never re-resolves: same shard, even if
  // the placement policy would now choose differently.
  const second = ownership.claim('sess-a', () => 2);
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(ownership.size, 1);
  ownership.release('sess-a');
  assert.equal(ownership.peek('sess-a'), 1);
  ownership.release('sess-a');
  assert.equal(ownership.peek('sess-a'), null);
  assert.equal(ownership.size, 0);
  assert.equal(ownership.claim('sess-a', () => 2), 2);
});

test('provider cooldown merges monotonically across shards', () => {
  const start = { untilMs: 0, disabledReason: null, updatedAt: 0 };
  const first = mergeProviderCooldown(start, { untilMs: 10_000, observedAt: 5 });
  assert.equal(first.changed, true);
  assert.equal(first.cooldown.untilMs, 10_000);

  // A shorter/echoed cooldown must never shorten or re-broadcast.
  const echo = mergeProviderCooldown(first.cooldown, { untilMs: 9_500 });
  assert.equal(echo.changed, false);
  assert.equal(echo.cooldown.untilMs, 10_000);

  const longer = mergeProviderCooldown(first.cooldown, { untilMs: 30_000 });
  assert.equal(longer.changed, true);
  assert.equal(longer.cooldown.untilMs, 30_000);

  const disabled = mergeProviderCooldown(longer.cooldown, { untilMs: 0, disabledReason: 'overage off' });
  assert.equal(disabled.changed, true);
  assert.equal(disabled.cooldown.disabledReason, 'overage off');
  assert.equal(disabled.cooldown.untilMs, 30_000);
  assert.equal(mergeProviderCooldown(disabled.cooldown, { disabledReason: 'overage off' }).changed, false);
});
