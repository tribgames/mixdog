import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { importTraceRow, repriceRestoredDays } from './usage-ledger-import.mjs';
import { usageStatsSnapshot } from '../../../standalone/usage-stats-model.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

const now = new Date(2026, 8, 12, 12).getTime();
function store(t) {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  return ledger;
}
function row(id, extra = {}) {
  return makeUsageRecord({
    id,
    ts: now,
    provider: 'openai',
    model: 'one',
    sessionId: 'session-a',
    sourceType: 'lead',
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 1,
    ...extra,
  });
}
const snapshot = (ledger, days = null) => usageStatsSnapshot({ rollup: ledger.rollup(), now, source: 'all', days });

test('source precedence preserves independent provider/model routes and disjoint legacy history', (t) => {
  const ledger = store(t);
  ledger.record([
    row('raw', { origin: 'trace' }),
    row('overlap', { origin: 'gateway', inputTokens: 9999, costUsd: 99 }),
    row('other-model', { origin: 'gateway', model: 'two', inputTokens: 200, outputTokens: 20, costUsd: 2 }),
    row('other-provider', {
      origin: 'gateway',
      provider: 'custom-api',
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 3,
    }),
  ]);
  const legacyRoute = { turns: 1, input: 400, output: 40, cacheRead: 0, cacheWrite: 0, costUsd: 4 };
  ledger.preserveLegacyDays({
    '2026-09-12': {
      restored: true,
      models: {
        'openai/one': { ...legacyRoute, provider: 'openai', model: 'one', input: 99999 },
        'cursor-oauth/legacy': { ...legacyRoute, provider: 'cursor-oauth', model: 'legacy', kind: 'oauth' },
      },
    },
  });
  const stats = snapshot(ledger);
  assert.equal(stats.totals.turns, 4);
  assert.equal(stats.totals.tokens, 700);
  assert.equal(stats.totals.costUsd, 6);
  assert.equal(stats.providers.length, 3);
  assert.equal(stats.providers.find((p) => p.provider === 'openai').models.length, 2);
  // A legacy route cannot be tied to session ids: its count is a floor of zero.
  const legacy = stats.providers.find((p) => p.provider === 'cursor-oauth');
  assert.equal(legacy.sessions, 0);
  assert.equal(legacy.sessionsComplete, false);
  assert.equal(stats.totals.sessions, 1);
  assert.equal(stats.totals.sessionsComplete, false);
  assert.equal(stats.daily[0].tokens, 700);
  assert.equal(stats.daily[0].costUsd, 6);
  assert.equal(legacy.input, null, 'context-derived historical Cursor input is not metered input');
  assert.equal(legacy.costCoverage, 0);
  assert.equal(stats.totals.unmeasuredTurns, 1);
  assert.equal(snapshot(ledger).totals.tokens, 700, 'reading again never accumulates fallback routes');
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM events').get().n, 4);
});

test('session counts deduplicate across requests, models, providers and calendar days, excluding background cycles', (t) => {
  const ledger = store(t);
  const yesterday = new Date(2026, 8, 11, 12).getTime();
  ledger.record([
    row('yesterday', { ts: yesterday }),
    row('repeat'),
    row('other-model', { model: 'two' }),
    row('other-session', { sessionId: 'session-b' }),
    row('other-provider', { provider: 'custom-api' }),
    row('background', { sessionId: 'cycle', sourceType: 'memory-cycle' }),
  ]);
  const stats = snapshot(ledger);
  assert.equal(stats.totals.turns, 6);
  assert.equal(stats.totals.sessions, 2);
  const openai = stats.providers.find((p) => p.provider === 'openai');
  assert.equal(openai.sessions, 2);
  assert.equal(openai.models.find((m) => m.model === 'one').sessions, 2);
  assert.equal(openai.models.find((m) => m.model === 'two').sessions, 1);
  assert.equal(stats.providers.find((p) => p.provider === 'custom-api').sessions, 1);
  assert.equal(snapshot(ledger, 0).totals.turns, 5);
  assert.equal(snapshot(ledger, 0).totals.sessions, 2);
});

test('unclassified raw trace scopes and missing session ids leave a lower bound, not a conversation count', (t) => {
  const ledger = store(t);
  ledger.record([
    row('known'),
    row('account-scope', { origin: 'trace', sourceType: '', sessionId: 'account-scope' }),
    row('missing', { provider: 'custom-api', sessionId: '' }),
  ]);
  const stats = snapshot(ledger);
  assert.equal(stats.totals.turns, 3);
  assert.equal(stats.totals.tokens, 330);
  // Only the classified id is counted; the account scope never becomes a session.
  assert.equal(stats.totals.sessions, 1);
  assert.equal(stats.totals.sessionsComplete, false);
  assert.equal(stats.providers.find((p) => p.provider === 'openai').sessions, 1);
  assert.equal(stats.providers.find((p) => p.provider === 'custom-api').sessions, 0);
  assert.equal(
    stats.providers.every((p) => p.sessionsComplete === false),
    true
  );
});

test('raw import preserves explicit background attribution and duration from surviving originals', (t) => {
  const ledger = store(t);
  ledger.record([
    importTraceRow({
      kind: 'usage_raw',
      ts: now,
      model: 'one',
      session_id: 'cycle',
      input_tokens: 100,
      output_tokens: 10,
      durationMs: 1234,
      payload: { provider: 'openai', sourceType: 'memory-cycle' },
    }),
  ]);
  const stats = snapshot(ledger);
  assert.equal(stats.totals.sessions, 0);
  assert.equal(stats.providers[0].sessions, 0);
  assert.equal(stats.totals.avgDurationMs, 1234);
});

test('restored route price coverage distinguishes known free local use from an unpriced API', () => {
  const original = {
    '2026-09-12': {
      restored: true,
      models: {
        local: { provider: 'mixdog-local', model: 'uncatalogued', turns: 2, input: 100, output: 10 },
        unknown: { provider: 'custom-api', model: 'uncatalogued', turns: 3, input: 200, output: 20 },
      },
    },
  };
  const result = repriceRestoredDays(original)['2026-09-12'];
  assert.equal(result.models.local.costKnownTurns, 2);
  assert.equal(result.models.local.costUsd, 0);
  assert.equal(result.models.unknown.costKnownTurns, 0);
  assert.equal(result.costKnownTurns, 2);
  assert.equal(original['2026-09-12'].models.local.costKnownTurns, undefined);
});

test('statistics refresh historical imports until live capture establishes a stable cutover', async (t) => {
  const ledger = store(t);
  let imports = 0;
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {
      imports++;
      ledger.record([row(`import-${imports}`, { origin: 'gateway', ts: Date.now() - 1000 })]);
      ledger.set('importedThrough', ledger.get('liveSince') || Date.now());
    },
  });
  assert.equal((await api.getUsageStats({ days: 0 })).totals.turns, 1);
  assert.equal((await api.getUsageStats({ days: 0 })).totals.turns, 2);
  ledger.beginCapture(Date.now() + 1);
  assert.equal((await api.getUsageStats({ days: 0 })).totals.turns, 3);
  await api.getUsageStats({ days: 0 });
  assert.equal(imports, 3);
});
