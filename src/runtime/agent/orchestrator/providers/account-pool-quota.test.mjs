import assert from 'node:assert/strict';
import { test, after, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every account-store write on Windows spawns icacls/PowerShell to lock the
// file to its owner (~0.2-0.5 s each, hundreds of writes here). The roster
// logic under test does not depend on file ACLs, which have their own suite
// (shared/file-permissions.test.mjs, atomic-file.test.mjs).
mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const dir = mkdtempSync(join(tmpdir(), 'mixdog-account-pool-quota-'));
process.env.MIXDOG_DATA_DIR = dir;
const {
  registerProviderAccount,
  changeProviderAccounts,
  readProviderAccountPool,
  newProviderAccountId,
  recordProviderAccountUsage,
  blockProviderAccount,
  removeProviderAccount,
} = await import('../../../shared/provider-accounts.mjs');
const { createAccountPoolProvider, resetAccountProbePacing } = await import('./account-pool.mjs');
const { fetchOAuthUsageSnapshot } = await import('./oauth-usage.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

const provider = 'cursor-oauth';

function setup(options = {}) {
  for (const row of readProviderAccountPool(provider).accounts) removeProviderAccount(provider, row.id);
  resetAccountProbePacing();
  const ids = [newProviderAccountId(), newProviderAccountId(), newProviderAccountId()];
  for (const [i, id] of ids.entries()) registerProviderAccount(provider, id, { label: `Account ${i + 1}` });
  changeProviderAccounts(provider, { selectedId: ids[0], auto: true, useCredits: false, ...options });
  return ids;
}
function quotaError(retryAfterMs) {
  return Object.assign(new Error('Quota exhausted'), {
    code: 'usage_limit_reached',
    status: 429,
    ...(retryAfterMs ? { headers: { 'retry-after-ms': String(retryAfterMs) } } : {}),
  });
}
const failing = (makeError, onSend) =>
  createAccountPoolProvider(provider, () => ({
    async send(_m, _model, _t, opts) {
      onSend?.(opts);
      throw makeError();
    },
  }));

test('every account refused with retry-after marks the error with the earliest reset', async () => {
  setup();
  const delays = [3_600_000, 7_200_000, 1_800_000];
  let i = 0;
  const gateway = failing(() => quotaError(delays[i++]));
  const before = Date.now();
  await assert.rejects(gateway.send([], 'model-x', [], {}), (error) => {
    assert.equal(error.quotaExhausted.provider, provider);
    assert.equal(error.quotaExhausted.model, 'model-x');
    assert.ok(error.quotaExhausted.resetAt >= before + 1_800_000);
    assert.ok(error.quotaExhausted.resetAt <= Date.now() + 1_800_000);
    return true;
  });
});

test('inferred blocks leave the reset unknown but still mark exhaustion', async () => {
  setup();
  const gateway = failing(() => quotaError());
  await assert.rejects(gateway.send([], 'model-x', [], {}), (error) => {
    assert.deepEqual(error.quotaExhausted, { provider, model: 'model-x', resetAt: null });
    return true;
  });
});

test('a pre-exhausted roster throws the structured error: 5H cleared, 7D Opus full', async () => {
  const ids = setup();
  const resetAt = Date.now() + 5_000_000;
  for (const id of ids) {
    recordProviderAccountUsage(provider, id, {
      quotaWindows: [
        { label: '5H', usedPct: 10, resetAt: Date.now() + 60_000 },
        { label: '7D Opus', usedPct: 100, resetAt },
      ],
    });
  }
  const gateway = createAccountPoolProvider(provider, () => ({
    async send() {
      return { content: 'ok' };
    },
  }));
  await assert.rejects(gateway.send([], 'claude-opus-4-1', [], {}), (error) => {
    assert.equal(error.code, 'provider_accounts_exhausted');
    assert.deepEqual(error.quotaExhausted, { provider, model: 'claude-opus-4-1', resetAt });
    return true;
  });
  assert.equal((await gateway.send([], 'claude-sonnet-4', [], {})).content, 'ok');
});

test('a retry-after block marks exhaustion with its time', async () => {
  const ids = setup();
  const until = Date.now() + 900_000;
  for (const id of ids) {
    blockProviderAccount(provider, id, until, 'm', 'retry-after');
    recordProviderAccountUsage(provider, id, { quotaWindows: [{ label: '5H', usedPct: 100, resetAt: until }] });
  }
  const gateway = failing(() => new Error('unreachable'));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.ok(Math.abs(error.quotaExhausted.resetAt - until) < 5);
    return true;
  });
});

test('auto switching off: the selected account refusing with quota is the whole eligible set', async () => {
  setup({ auto: false });
  const gateway = failing(() => quotaError(600_000));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted.provider, provider);
    assert.ok(error.quotaExhausted.resetAt > Date.now());
    return true;
  });
});

test('auto switching off: a non-quota failure is not marked', async () => {
  setup({ auto: false });
  const gateway = failing(() => Object.assign(new Error('boom'), { status: 500 }));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('a generic 429 with a long Retry-After rotates accounts but carries no marker', async () => {
  setup();
  let calls = 0;
  const gateway = failing(() => {
    calls += 1;
    return Object.assign(new Error('Too many requests'), { status: 429, headers: { 'retry-after': '120' } });
  });
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
  assert.equal(calls, 3, 'rotation across the roster is unchanged');
});

test('the 20-attempt cap with every account exhausted still carries the marker', async () => {
  for (const row of readProviderAccountPool(provider).accounts) removeProviderAccount(provider, row.id);
  resetAccountProbePacing();
  const ids = Array.from({ length: 20 }, () => newProviderAccountId());
  for (const [i, id] of ids.entries()) registerProviderAccount(provider, id, { label: `A${i}` });
  changeProviderAccounts(provider, { selectedId: ids[0], auto: true, useCredits: false });
  let calls = 0;
  const gateway = failing(() => {
    calls += 1;
    return quotaError(600_000);
  });
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted.provider, provider);
    return true;
  });
  assert.equal(calls, 20);
});

test('no marker when output was already emitted', async () => {
  setup();
  const gateway = failing(
    () => quotaError(600_000),
    (opts) => opts.onTextDelta('partial')
  );
  await assert.rejects(gateway.send([], 'm', [], { onTextDelta() {} }), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('no marker for a generic 429 without a quota signal', async () => {
  setup();
  const gateway = failing(() => Object.assign(new Error('Too many requests'), { status: 429 }));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('no roster: an exhausted cached snapshot marks the error with its reset', async () => {
  for (const row of readProviderAccountPool(provider).accounts) removeProviderAccount(provider, row.id);
  const resetAt = Date.now() + 4_000_000;
  await fetchOAuthUsageSnapshot(
    { provider },
    {
      async getUsageSnapshot() {
        return {
          quotaWindows: [
            { label: '5H', usedPct: 100, resetAt: Date.now() + 1_000_000 },
            { label: '7D', usedPct: 100, resetAt },
          ],
        };
      },
    },
    () => {},
    { force: true }
  );
  const gateway = createAccountPoolProvider(provider, () => ({
    async send() {
      return { content: 'ok' };
    },
  }));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.deepEqual(error.quotaExhausted, { provider, model: 'm', resetAt });
    return true;
  });
});

test('a retry before the block expires still carries the marker', async () => {
  setup();
  const gateway = failing(() => quotaError(600_000));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => error.quotaExhausted?.provider === provider);
  const fresh = createAccountPoolProvider(provider, () => ({
    async send() {
      throw new Error('unreachable');
    },
  }));
  await assert.rejects(fresh.send([], 'm', [], {}), (error) => {
    assert.equal(error.code, 'provider_accounts_exhausted');
    assert.equal(error.quotaExhausted.provider, provider);
    assert.ok(error.quotaExhausted.resetAt > Date.now());
    return true;
  });
});

test('blocks without quota evidence stay unmarked on later sends', async () => {
  const ids = setup();
  for (const id of ids) blockProviderAccount(provider, id, Date.now() + 600_000, 'm', 'retry-after');
  const gateway = failing(() => new Error('unreachable'));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('auto switching off: a full window on the selected account marks even with another account free', async () => {
  const ids = setup({ auto: false });
  const resetAt = Date.now() + 2_000_000;
  recordProviderAccountUsage(provider, ids[0], { quotaWindows: [{ label: '5H', usedPct: 100, resetAt }] });
  const gateway = failing(() => new Error('unreachable'));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.deepEqual(error.quotaExhausted, { provider, model: 'm', resetAt });
    return true;
  });
});
