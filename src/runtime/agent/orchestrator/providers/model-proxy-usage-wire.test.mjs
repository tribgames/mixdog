import assert from 'node:assert/strict';
import test from 'node:test';
import { isModelProxyUsageAccount, sanitizeModelProxyUsageReply } from './model-proxy-usage-wire.mjs';

const provider = 'openai-oauth';
const account = `proxy-${'a'.repeat(64)}`;
const other = `proxy-${'b'.repeat(64)}`;
const cachedAt = Date.UTC(2026, 0, 1);
const ready = () => ({
  status: 'ready',
  accounts: [account, other],
  account,
  snapshot: {
    provider,
    accountId: account,
    source: 'desktop-oauth',
    cachedAt,
    quotaWindows: [{ label: '5H', usedPct: 42, resetAt: cachedAt + 3_600_000 }],
  },
});

test('usage replies are reconstructed with only bounded public quota fields', () => {
  const input = ready();
  input.email = 'private@example.com';
  input.snapshot.raw = { access_token: 'SECRET' };
  input.snapshot.resetCredits = { availableCredits: ['private-offer'] };
  input.snapshot.quotaWindows[0].headers = { Authorization: 'SECRET' };
  input.snapshot.quotaWindows[0].usedUsd = 0;
  input.snapshot.quotaWindows[0].limitCredits = 10;
  const expected = ready();
  expected.snapshot.quotaWindows[0].usedUsd = 0;
  expected.snapshot.quotaWindows[0].limitCredits = 10;
  const output = sanitizeModelProxyUsageReply(provider, input);
  assert.deepEqual(output, expected);
  input.accounts.length = 0;
  input.snapshot.quotaWindows[0].usedPct = 99;
  assert.equal(output.accounts.length, 2);
  assert.equal(output.snapshot.quotaWindows[0].usedPct, 42);
  assert.equal(JSON.stringify(output).includes('SECRET'), false);
  assert.equal(JSON.stringify(output).includes('@'), false);
  const many = ready();
  many.snapshot.quotaWindows = Array.from({ length: 30 }, () => ({ label: '7D Opus', usedPct: 101 }));
  assert.equal(sanitizeModelProxyUsageReply(provider, many).snapshot.quotaWindows.length, 12);
});

test('account ownership survives failed or unsupported measurements without leaking unknown keys', () => {
  for (const status of ['unavailable', 'unsupported', 'invented']) {
    assert.deepEqual(
      sanitizeModelProxyUsageReply(provider, { ...ready(), status, secret: 'SECRET' }),
      { status: status === 'unsupported' ? status : 'unavailable', accounts: [account, other], account }
    );
  }
  assert.deepEqual(sanitizeModelProxyUsageReply(provider, { status: 'unsupported', accounts: [] }), {
    status: 'unsupported',
    accounts: [],
  });
});

test('invalid identities, timestamps and quota fields fail closed', () => {
  for (const value of [null, {}, { status: 'ready' }, { accounts: ['default'] }, { accounts: Array(2) }, { accounts: Array(21).fill(account) }])
    assert.deepEqual(sanitizeModelProxyUsageReply(provider, value), { status: 'unavailable', accounts: [] });
  for (const bad of ['default', 'proxy-unattributed', `proxy-${'A'.repeat(64)}`, `proxy-${'a'.repeat(63)}`, '@']) {
    assert.equal(isModelProxyUsageAccount(bad), false);
    const input = ready();
    input.account = bad;
    assert.deepEqual(sanitizeModelProxyUsageReply(provider, input), {
      status: 'unavailable',
      accounts: [account, other],
    });
  }
  const mutations = [
    (row) => { row.accounts = [other]; },
    (row) => { row.snapshot.provider = 'anthropic-oauth'; },
    (row) => { row.snapshot.accountId = other; },
    (row) => { row.snapshot.source = 'local'; },
    (row) => { row.snapshot.cachedAt = '2026-01-01'; },
    (row) => { row.snapshot.cachedAt = Infinity; },
    (row) => { row.snapshot.cachedAt = -1; },
    (row) => { row.snapshot.cachedAt = 8_640_000_000_000_001; },
    (row) => { row.snapshot.quotaWindows = []; },
    (row) => { row.snapshot.quotaWindows[0].label = 'private@example.com'; },
    (row) => { row.snapshot.quotaWindows[0].label = 'x'.repeat(41); },
    (row) => { row.snapshot.quotaWindows[0].usedPct = -1; },
    (row) => { row.snapshot.quotaWindows[0].usedPct = '42'; },
    (row) => { row.snapshot.quotaWindows[0].remainingUsd = NaN; },
    (row) => { row.snapshot.quotaWindows[0].resetAt = -1; },
  ];
  for (const mutate of mutations) {
    const input = ready();
    mutate(input);
    const output = sanitizeModelProxyUsageReply(provider, input);
    assert.equal(output.status, 'unavailable');
    assert.equal(output.snapshot, undefined);
    assert.ok(output.accounts.every(isModelProxyUsageAccount));
  }
});
