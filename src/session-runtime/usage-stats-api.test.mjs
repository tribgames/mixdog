import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageStatsApi } from './usage-stats-api.mjs';
import { UsageLedger, makeUsageRecord } from '../runtime/shared/llm/usage-ledger.mjs';

test('local quota history retains labels, selected account, time-range and page query shapes', async (t) => {
  const previous = process.env.MIXDOG_MODEL_PROXY;
  delete process.env.MIXDOG_MODEL_PROXY;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = previous;
  });
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const now = Date.UTC(2026, 0, 1, 12);
  t.mock.method(Date, 'now', () => now);
  const provider = 'anthropic-oauth';
  for (const account of ['default', 'work']) {
    ledger.recordQuota([{ provider, account, label: '5H', ts: now - 60_000, usedPct: 10, resetAt: now + 3_600_000 }]);
  }
  const api = createUsageStatsApi({
    ledger: () => ledger,
    accountPool: () => ({ selectedId: 'work', accounts: [{ id: 'work', label: 'Work account' }] }),
    accountEmails: () => ({ work: 'work@example.com' }),
  });
  const history = await api.getQuotaHistory();
  assert.equal(history.selection.account, 'work');
  assert.equal(history.desktopUsageStatus, undefined);
  assert.equal(history.subscriptions.find((row) => row.account === 'work').accountLabel, 'Work account');
  assert.equal(history.subscriptions.find((row) => row.account === 'work').accountEmail, 'work@example.com');
  const page = await api.getQuotaHistory({ provider, account: 'default', window: '5H', page: 0 });
  assert.equal(page.selection.account, 'default');
  assert.equal(page.total, 1);
  assert.equal((await api.getQuotaHistory({ view: '7d' })).period.days, 7);
});

test('local session usage keeps historical account-scoped ids beside the visible session', async (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const api = createUsageStatsApi({
    ledger: () => ledger,
    accountPool: () => ({ accounts: [] }),
    getSessionId: () => 'visible-session',
  });
  ledger.record([makeUsageRecord({
    provider: 'openai-oauth', model: 'fixture-model', sessionId: 'visible-session', inputTokens: 10,
  })]);
  const result = await api.getSessionUsage({ sessionIds: ['agent-session'] });
  assert.equal(result.sessionId, 'visible-session');
  assert.ok(result.sessions['agent-session']);
});
