import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { repairUsageLedger, usageLedgerIntegrity } from './usage-ledger-repair.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { importTraceRow } from './usage-ledger-import.mjs';
import { usageStatsSnapshot } from '../../../standalone/usage-stats-model.mjs';
import { resolveUsageStatsPeriod } from '../../../standalone/usage-stats-period.mjs';

test('selected identity survives concurrent nested transport traces and does not leak', async (t) => {
    const rows = [];
    const io = await import('../../agent/orchestrator/agent-trace-io.mjs');
    t.mock.module('../../agent/orchestrator/agent-trace-io.mjs', { namedExports: {
        ...io, appendAgentTrace: (row) => rows.push(row),
    } });
    const { traceAgentUsage } = await import('../../agent/orchestrator/agent-trace.mjs');
    await Promise.all(['grok-oauth', 'xai'].map((provider) =>
        accountProviderSend(provider, {}, async () => {
            await new Promise((resolve) => setTimeout(resolve, provider === 'xai' ? 1 : 5));
            traceAgentUsage({ provider: 'xai', sessionId: 'transport-account', model: 'deployment',
                inputTokens: 10, outputTokens: 1, cachedTokens: 0 });
            return {};
        }, 'grok-4.20', { sessionId: `session-${provider}`, sourceType: 'lead' })));
    for (const provider of ['grok-oauth', 'xai']) {
        const row = rows.find((row) => row.payload.provider === provider);
        assert.equal(row.sessionId, `session-${provider}`);
        assert.equal(row.payload.requested_model, 'grok-4.20');
        assert.equal(row.payload.source_type, 'lead');
    }
    traceAgentUsage({ provider: 'custom-api', model: 'other', inputTokens: 1, outputTokens: 1 });
    assert.equal(rows.at(-1).payload.provider, 'custom-api');
    assert.equal(rows.at(-1).payload.requested_model, null);
});

test('Grok prices the requested SKU while retaining the actual response model; imports preserve it', () => {
    const args = { provider: 'grok-oauth', model: 'internal-deployment', pricingModel: 'grok-4.20',
        inputTokens: 2000, cacheReadTokens: 1000, outputTokens: 100 };
    const row = makeUsageRecord(args);
    assert.equal(row.model, 'internal-deployment');
    assert.equal(row.costUsd, 0.0017); // 1000*1.25/M + 1000*.2/M + 100*2.5/M
    assert.equal(row.rates.pricingModel, 'grok-4.20');
    assert.equal(row.costSource, 'subscription');
    assert.equal(makeUsageRecord({ ...args, pricingModel: undefined }).costUsd, null);
    assert.equal(makeUsageRecord({ ...args, provider: 'xai', pricingModel: undefined,
        requestedModel: 'grok-4.20' }).costUsd, null, 'a requested API id is not evidence of the served SKU');
    const imported = importTraceRow({
        kind: 'usage_raw', ts: Date.now(), model: 'internal-deployment',
        input_tokens: 2000, cached_tokens: 1000, output_tokens: 100,
        payload: { provider: 'grok-oauth', requested_model: 'grok-4.20' },
    });
    assert.equal(imported.costUsd, row.costUsd);
});

test('bounded repair preserves every request and token, known prices and future real API routes', (t) => {
    const ledger = new UsageLedger(':memory:');
    t.after(() => ledger.close());
    const ts = new Date(2026, 8, 14, 10).getTime();
    ledger.record([
        makeUsageRecord({ id: 'legacy', ts, provider: 'xai', model: 'internal', inputTokens: 50,
            outputTokens: 5, origin: 'trace' }),
        makeUsageRecord({ id: 'unknown', ts, provider: 'custom-api', model: 'unknown',
            inputTokens: 20, outputTokens: 2 }),
        makeUsageRecord({ id: 'known', ts, provider: 'openai', model: 'known', inputTokens: 30,
            outputTokens: 3, costUsd: 0 }),
        makeUsageRecord({ id: 'future', ts: ts + 1000, provider: 'xai', model: 'internal',
            inputTokens: 40, outputTokens: 4, costUsd: 2 }),
    ]);
    const before = usageLedgerIntegrity(ledger.db);
    const options = { throughTs: ts, providerOverrides: { xai: 'grok-oauth' },
        price: ({ provider }) => provider === 'grok-oauth'
            ? { costUsd: 0.5, rates: { inputCostPerM: 1 } } : { costUsd: null, rates: null } };
    const result = repairUsageLedger(ledger, options);
    assert.equal(result.reattributed, 1);
    assert.equal(result.repriced, 1);
    assert.deepEqual(result.integrity, before);
    const rows = ledger.db.prepare('SELECT id,provider,kind,cost_source,cost_usd FROM events ORDER BY id').all();
    assert.equal(rows.find((r) => r.id === 'legacy').provider, 'grok-oauth');
    assert.equal(rows.find((r) => r.id === 'legacy').cost_source, 'subscription');
    assert.equal(rows.find((r) => r.id === 'future').provider, 'xai');
    assert.equal(rows.find((r) => r.id === 'future').cost_usd, 2);
    assert.equal(rows.find((r) => r.id === 'known').cost_usd, 0);
    const stats = usageStatsSnapshot({ rollup: ledger.rollup(), source: 'all', now: ts + 2000 });
    assert.equal(stats.totals.turns, 4);
    assert.equal(stats.totals.tokens, 154);
    assert.equal(stats.totals.costUsd, 2.5);
    assert.equal(stats.totals.costUnpricedTurns, 1);
    assert.equal(repairUsageLedger(ledger, options).reattributed, 0);
    assert.equal(repairUsageLedger(ledger, options).repriced, 0);
    assert.deepEqual(usageLedgerIntegrity(ledger.db), before);
});

test('invalid repair prices roll back attribution, indexes and receipt', (t) => {
    const ledger = new UsageLedger(':memory:');
    t.after(() => ledger.close());
    ledger.record([makeUsageRecord({ id: 'old', provider: 'xai', model: 'unknown', inputTokens: 100 })]);
    const rows = ledger.db.prepare('SELECT * FROM events').all();
    assert.throws(() => repairUsageLedger(ledger, { throughTs: Date.now(),
        providerOverrides: { xai: 'grok-oauth' }, price: () => ({ costUsd: NaN }) }), /Invalid repair price/);
    assert.deepEqual(ledger.db.prepare('SELECT * FROM events').all(), rows);
    assert.equal(ledger.get('lastUsageRepair'), null);
    assert.equal(Object.values(ledger.rollup().days)[0].turns, 1);
});

test('all cost totals and price coverage come from included routes, not inconsistent historical day headers', () => {
    const route = { provider: 'openai', model: 'one', kind: 'api', turns: 2, input: 100, output: 20,
        costUsd: 3, costKnownTurns: 1, costBilled: 1, costEstimated: 2 };
    const stats = usageStatsSnapshot({ source: 'all', now: new Date(2026, 8, 14, 12).getTime(),
        rollup: { days: { '2026-09-14': { costKnownTurns: 900, costEstimated: 900,
            models: { 'openai/one': route } } } } });
    assert.equal(stats.totals.costUsd, 3);
    assert.equal(stats.totals.costBilled, 1);
    assert.equal(stats.totals.costEstimated, 2);
    assert.equal(stats.totals.costKnownTurns, 1);
    assert.equal(stats.totals.costUnpricedTurns, 1);
    assert.equal(stats.daily[0].costKnownTurns, 1);
    assert.equal(stats.providers[0].models[0].costCoverage, 0.5);
});

test('yearly retains cross-year history and unknown prices remain unknown in hourly buckets', (t) => {
    const ledger = new UsageLedger(':memory:');
    t.after(() => ledger.close());
    const now = new Date(2026, 8, 14, 12).getTime();
    ledger.record([
        makeUsageRecord({ id: 'old', ts: new Date(2025, 11, 31, 12).getTime(),
            provider: 'custom-api', model: 'unknown', inputTokens: 10 }),
        makeUsageRecord({ id: 'new', ts: now, provider: 'custom-api', model: 'unknown', inputTokens: 20 }),
    ]);
    const yearly = resolveUsageStatsPeriod({ view: 'year', now });
    const stats = usageStatsSnapshot({ rollup: ledger.rollup(), period: yearly, now, source: 'all' });
    assert.equal(stats.totals.turns, 2);
    assert.equal(stats.totals.tokens, 30);
    assert.equal(yearly.fromMs, 0);
    const hourly = resolveUsageStatsPeriod({ view: 'hour', now });
    const hours = usageStatsSnapshot({ rollup: ledger.rollup({
        hourlyDay: hourly.startDay, fromDay: hourly.startDay, toDay: hourly.endDay,
        fromMs: hourly.fromMs, toMs: hourly.toMs,
    }),
        period: hourly, now, source: 'all' }).hourly;
    assert.equal(hours.reduce((n, hour) => n + hour.turns, 0), 1);
    assert.equal(hours.reduce((n, hour) => n + hour.costKnownTurns, 0), 0);
});
