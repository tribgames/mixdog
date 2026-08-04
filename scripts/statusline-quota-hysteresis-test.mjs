import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptQuotaSnapshot,
  fallbackStatusline,
  resolveContextUsedPct,
} from '../src/ui/statusline.mjs';

// Monotonic hysteresis for the 5H/7D usage segment: once a value has rendered,
// an OLDER shared-cache snapshot (written by another mixdog instance) must not
// displace it, but a NEWER one — or confirmed own-instance live data — must.
test('older shared-cache snapshot is rejected, newer is accepted', () => {
  const displayedOwnLive = { segments: ['5H 12%'], asOf: 2000, owned: true };

  // Another instance overwrites the shared cache with an OLDER snapshot →
  // metricsMatch flips false, source alternates to that unowned older snapshot.
  assert.equal(
    acceptQuotaSnapshot(displayedOwnLive, { asOf: 1000, owned: false }),
    false,
    'older unowned snapshot must not displace displayed own-live value',
  );

  // A strictly newer shared snapshot is allowed to advance the value.
  assert.equal(
    acceptQuotaSnapshot(displayedOwnLive, { asOf: 3000, owned: false }),
    true,
    'newer snapshot must replace the displayed value',
  );
});

test('own-instance live data always wins; empty timestamps preserve prior behavior', () => {
  const displayedShared = { segments: ['5H 12%'], asOf: 5000, owned: false };
  // Own-instance live data replaces even an apparently newer shared snapshot.
  assert.equal(acceptQuotaSnapshot(displayedShared, { asOf: 1, owned: true }), true);
  // Nothing displayed yet → accept.
  assert.equal(acceptQuotaSnapshot(undefined, { asOf: 1000, owned: false }), true);
  // No comparable timestamps → accept (byte-for-byte prior behavior).
  assert.equal(acceptQuotaSnapshot({ asOf: 0, owned: true }, { asOf: 0, owned: false }), true);
  // Shared→shared same asOf → accept (idempotent refresh).
  assert.equal(acceptQuotaSnapshot({ asOf: 2000, owned: false }, { asOf: 2000, owned: false }), true);
});

test('context percentage uses compaction pressure over trigger and ignores gateway boundary percent', () => {
  const args = {
    stats: {
      currentEstimatedContextTokens: 75_000,
      currentContextSource: 'estimated',
    },
    contextWindow: 100_000,
    compactBoundaryTokens: 100_000,
    autoCompactTokenLimit: 75_000,
  };
  assert.equal(resolveContextUsedPct({
    ...args,
    gatewayStatus: { contextUsedPct: 75 },
  }), 100);
  assert.match(
    fallbackStatusline({ provider: 'openai', model: 'test', ...args })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    /\b100%/,
  );
});
