// Run with --experimental-test-module-mocks.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

test('a quota resume asks the pool over fresh forced readings of every account', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-reading-'));
  const overrides = { MIXDOG_DATA_DIR: dir, MIXDOG_CONFIG_DIR: dir, MIXDOG_SKIP_USER_DATA_BACKUP: '1' };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const accounts = await import('../../../shared/provider-accounts.mjs');
  const fetches = [];
  // usedPct per account the provider's usage endpoint reports right now.
  const meter = new Map();
  // Accounts whose usage endpoint fails right now, and how: a throw or no snapshot.
  const failing = new Map();
  // Whole snapshots an endpoint answers with, for readings that carry no meter.
  const snapshots = new Map();
  t.mock.module('./oauth-usage.mjs', {
    namedExports: {
      fetchOAuthUsageSnapshot: async (routeInfo, providerObj, _log, options) => {
        fetches.push({ accountId: routeInfo.accountId, bound: providerObj?.accountId, force: options?.force });
        const key = routeInfo.accountId || routeInfo.provider;
        if (failing.get(key) === 'throw') throw new Error('usage endpoint down');
        if (failing.get(key) === 'empty') return null;
        if (snapshots.has(key)) return snapshots.get(key);
        if (!routeInfo.accountId) return { quotaWindows: [{ label: '5H', usedPct: meter.get(key), resetAt: 0 }] };
        const snapshot = {
          quotaWindows: [{ label: '5H', usedPct: meter.get(routeInfo.accountId), resetAt: Date.now() + 3_600_000 }],
        };
        accounts.recordProviderAccountUsage(routeInfo.provider, routeInfo.accountId, snapshot);
        return snapshot;
      },
      readCachedOAuthUsageSnapshot: () => null,
    },
  });
  const provider = { forAccount: (accountId) => ({ accountId }) };
  t.mock.module('./registry.mjs', { namedExports: { getProvider: () => provider } });
  const { providerQuotaUsable } = await import('./quota-reading.mjs');

  accounts.registerProviderAccount('openai-oauth', ACCOUNT_A);
  accounts.registerProviderAccount('openai-oauth', ACCOUNT_B);
  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    accounts.blockProviderAccount('openai-oauth', id, Date.now() + 3_600_000, 'gpt-x', 'retry-after', { quota: true });
  }

  meter.set(ACCOUNT_A, 100).set(ACCOUNT_B, 100);
  assert.equal(await providerQuotaUsable('openai-oauth', 'gpt-x'), false);
  assert.deepEqual(fetches.map((call) => [call.accountId, call.bound, call.force]).sort(), [
    [ACCOUNT_A, ACCOUNT_A, true],
    [ACCOUNT_B, ACCOUNT_B, true],
  ]);

  // The reset came: a fresh reading below 100% releases that account.
  meter.set(ACCOUNT_B, 12);
  assert.equal(await providerQuotaUsable('openai-oauth', 'gpt-x'), true);
  assert.equal(fetches.length, 4);

  // A failed reading is no evidence: B's earlier usable record does not count
  // while its endpoint throws or returns nothing, and A reads exhausted.
  for (const mode of ['throw', 'empty']) {
    failing.set(ACCOUNT_B, mode);
    assert.equal(await providerQuotaUsable('openai-oauth', 'gpt-x'), false, mode);
  }
  failing.set(ACCOUNT_A, 'throw');
  assert.equal(await providerQuotaUsable('openai-oauth', 'gpt-x'), false, 'every reading failed');
  failing.clear();
  assert.equal(await providerQuotaUsable('openai-oauth', 'gpt-x'), true);

  // No roster: the single credential needs a successful fresh reading too.
  meter.set('anthropic-oauth', 20);
  assert.equal(await providerQuotaUsable('anthropic-oauth', 'claude-x'), true);
  failing.set('anthropic-oauth', 'throw');
  assert.equal(await providerQuotaUsable('anthropic-oauth', 'claude-x'), false);
  failing.set('anthropic-oauth', 'empty');
  assert.equal(await providerQuotaUsable('anthropic-oauth', 'claude-x'), false);
  failing.clear();
  meter.set('anthropic-oauth', 100);
  assert.equal(await providerQuotaUsable('anthropic-oauth', 'claude-x'), false);

  // A truthy reading is not evidence by itself. On a roster with no active
  // block, an all-unknown meter and a balance-only snapshot both stay unusable.
  const ACCOUNT_C = '33333333-3333-4333-8333-333333333333';
  const ACCOUNT_D = '44444444-4444-4444-8444-444444444444';
  accounts.registerProviderAccount('grok-oauth', ACCOUNT_C);
  accounts.registerProviderAccount('grok-oauth', ACCOUNT_D);
  const unknownMeter = { quotaWindows: [{ label: '5H', usedPct: null, resetAt: 0 }] };
  const balanceOnly = { quotaWindows: [], balance: { unit: 'credits', remainingCredits: 25 } };
  snapshots.set(ACCOUNT_C, unknownMeter).set(ACCOUNT_D, unknownMeter);
  assert.equal(await providerQuotaUsable('grok-oauth', 'grok-x'), false, 'all-unknown meter');
  snapshots.set(ACCOUNT_C, balanceOnly).set(ACCOUNT_D, balanceOnly);
  assert.equal(await providerQuotaUsable('grok-oauth', 'grok-x'), false, 'balance-only without credits');
  // Paying with credits, a positive measured balance is the evidence; a spent one is not.
  accounts.changeProviderAccounts('grok-oauth', { useCredits: true });
  assert.equal(await providerQuotaUsable('grok-oauth', 'grok-x'), true, 'positive credit balance');
  const spent = { quotaWindows: [], balance: { unit: 'credits', remainingCredits: 0 } };
  snapshots.set(ACCOUNT_C, spent).set(ACCOUNT_D, spent);
  assert.equal(await providerQuotaUsable('grok-oauth', 'grok-x'), false, 'spent credit balance');

  // No roster: an unknown meter, a balance-only reading, or a window scoped to
  // another model family is no evidence for this model.
  for (const [label, snapshot] of [
    ['unknown meter', unknownMeter],
    ['balance only', balanceOnly],
    ['other family', { quotaWindows: [{ label: '7D Opus', usedPct: 10, resetAt: 0 }] }],
  ]) {
    snapshots.set('cursor-oauth', snapshot);
    assert.equal(await providerQuotaUsable('cursor-oauth', 'claude-sonnet'), false, label);
  }
  snapshots.set('cursor-oauth', { quotaWindows: [{ label: '7D Sonnet', usedPct: 10, resetAt: 0 }] });
  assert.equal(await providerQuotaUsable('cursor-oauth', 'claude-sonnet'), true, 'measured for this model');
});
