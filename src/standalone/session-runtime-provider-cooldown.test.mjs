import assert from 'node:assert/strict';
import test from 'node:test';

import * as fastMode from '../runtime/agent/orchestrator/providers/anthropic-fast-mode.mjs';
import {
  applyProviderCooldown,
  mergeKnownProviderCooldown,
  providerCooldownAdvanced,
  readProviderCooldown,
} from './session-runtime-provider-cooldown.mjs';

test('a sibling shard cooldown is replayed into this process without hammering the pool', () => {
  fastMode.clearFastModeCooldown();
  try {
    const now = Date.now();
    assert.equal(fastMode.fastModeAvailable(now), true);

    const applied = applyProviderCooldown(fastMode, { untilMs: now + 120_000 }, now);
    assert.equal(applied, true);
    assert.equal(fastMode.fastModeAvailable(now), false);
    // The policy owns the floor: a replay is never SHORTER than observed.
    assert.ok(fastMode.fastModeCooldownRemainingMs(now) >= 120_000);

    // Reading it back reproduces the cooldown for the next shard in line.
    const observed = readProviderCooldown(fastMode, now);
    assert.ok(observed.untilMs >= now + 120_000);
    assert.equal(observed.disabledReason, null);
  } finally {
    fastMode.clearFastModeCooldown();
  }
});

test('an expired or short replay never clears a live cooldown', () => {
  fastMode.clearFastModeCooldown();
  try {
    const now = Date.now();
    applyProviderCooldown(fastMode, { untilMs: now + 300_000 }, now);
    const remaining = fastMode.fastModeCooldownRemainingMs(now);
    // Stale/short frames are ignored; the live cooldown survives.
    assert.equal(applyProviderCooldown(fastMode, { untilMs: now - 5_000 }, now), false);
    assert.equal(applyProviderCooldown(fastMode, { untilMs: now + 500 }, now), false);
    assert.equal(fastMode.fastModeCooldownRemainingMs(now), remaining);
    assert.equal(fastMode.fastModeAvailable(now), false);
  } finally {
    fastMode.clearFastModeCooldown();
  }
});

test('a disabled fast pool replays as a terminal disable', () => {
  fastMode.clearFastModeCooldown();
  try {
    const now = Date.now();
    assert.equal(
      applyProviderCooldown(fastMode, { untilMs: 0, disabledReason: 'overage unavailable' }, now),
      true,
    );
    assert.equal(fastMode.fastModeDisabledReason(), 'overage unavailable');
    assert.equal(fastMode.fastModeAvailable(now), false);
    const observed = readProviderCooldown(fastMode, now);
    assert.equal(observed.disabledReason, 'overage unavailable');
  } finally {
    fastMode.clearFastModeCooldown();
  }
});

test('replayed state is not echoed back as a new local discovery', () => {
  const known = mergeKnownProviderCooldown(
    { untilMs: 0, disabledReason: null },
    { untilMs: 10_000, disabledReason: null },
  );
  assert.equal(known.untilMs, 10_000);
  assert.equal(providerCooldownAdvanced(known, { untilMs: 10_000 }), false);
  assert.equal(providerCooldownAdvanced(known, { untilMs: 10_500 }), false);
  assert.equal(providerCooldownAdvanced(known, { untilMs: 30_000 }), true);
  assert.equal(providerCooldownAdvanced(known, { untilMs: 0, disabledReason: 'off' }), true);
  assert.equal(
    providerCooldownAdvanced({ ...known, disabledReason: 'off' }, { untilMs: 0, disabledReason: 'off' }),
    false,
  );
});
