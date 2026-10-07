import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { accountScopedSessionId } from '../provider-accounts.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

const ts = Date.now();
const route = { provider: 'anthropic', model: 'claude-opus-4-8' };
const usage = (responseId, { offset = 0, ...extra } = {}) =>
  makeUsageRecord({
    ...route,
    ts: ts + offset,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 4000,
    cacheWriteTokens: 500,
    sessionId: 'session-a',
    sourceType: 'lead',
    responseId,
    ...extra,
  });

// The session's own turn, a compaction recorded under it, a turn without a
// price, and an older subscription turn recorded under the account's provider
// session; a gateway summary of the same route that must not double them; and
// another session, through the same account too, that must stay out.
const turn = usage('turn');
const compaction = usage('compaction', { offset: 1, sourceType: 'compact' });
const unpriced = { ...usage('unpriced', { offset: 2 }), costUsd: null, costSource: 'unpriced' };
const viaAccount = usage('via-account', {
  offset: 3,
  sessionId: accountScopedSessionId('anthropic-oauth', 'account-1', 'session-a'),
});
const gateway = usage('gateway', { offset: 4, origin: 'gateway' });
const elsewhere = usage('elsewhere', { offset: 5, sessionId: 'session-b' });
const elsewhereViaAccount = usage('elsewhere-via-account', {
  offset: 6,
  sessionId: accountScopedSessionId('anthropic-oauth', 'account-1', 'session-b'),
});
const rows = [turn, compaction, unpriced, viaAccount, gateway, elsewhere, elsewhereViaAccount];
const included = [turn, compaction, unpriced, viaAccount];

function expected(included) {
  const sum = (field) => included.reduce((total, row) => total + row[field], 0);
  const known = included.filter((row) => row.costSource !== 'unpriced');
  const prompt = sum('input') + sum('cacheRead') + sum('cacheWrite');
  return {
    sessionId: 'session-a',
    // None of these rows carries a request duration, so no speed is known.
    outputTokensPerSecond: null,
    turns: included.length,
    input: sum('input'),
    output: sum('output'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
    tokens: prompt + sum('output'),
    unmeasuredTurns: 0,
    costUsd: Math.round(known.reduce((total, row) => total + row.costUsd, 0) * 1e6) / 1e6,
    costKnownTurns: known.length,
    costUnpricedTurns: included.length - known.length,
    cacheHitRate: Math.round((sum('cacheRead') / prompt) * 1e4) / 1e4,
  };
}

const api = (ledger, sessionId) =>
  createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    accountPool: (provider) => ({ accounts: provider === 'anthropic-oauth' ? [{ id: 'account-1' }] : [] }),
    getSessionId: () => sessionId,
  });

test('session usage sums every request of the session, compactions included, without gateway doubles', async (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  ledger.record(rows);
  assert.deepEqual(await api(ledger, 'session-a').getSessionUsage(), expected(included));
  assert.equal(await api(ledger, null).getSessionUsage(), null);
});

test('session usage reads through the ledger worker with the same answer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-usage-'));
  const ledger = new UsageLedger(join(dir, 'ledger.sqlite'));
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  ledger.record(rows);
  assert.deepEqual(await api(ledger, 'session-a').getSessionUsage(), expected(included));
});
