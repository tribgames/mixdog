import './usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { repairUsageLedger, usageLedgerIntegrity } from './usage-ledger-repair.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { importTraceRow } from './usage-ledger-import.mjs';
import { noteAbandonedUsage, noteRequestServiceTier } from './usage-context.mjs';
import { usageStatsSnapshot } from '../../../session-runtime/services/usage-stats-model.mjs';
import { resolveUsageStatsPeriod } from '../../../session-runtime/services/usage-stats-period.mjs';

test('selected identity survives concurrent nested transport traces and does not leak', async (t) => {
  const rows = [];
  const io = await import('../../agent/orchestrator/agent-trace-io.mjs');
  t.mock.module('../../agent/orchestrator/agent-trace-io.mjs', {
    namedExports: {
      ...io,
      appendAgentTrace: (row) => rows.push(row),
    },
  });
  const { traceAgentUsage } = await import('../../agent/orchestrator/agent-trace.mjs');
  await Promise.all(
    ['grok-oauth', 'xai'].map((provider) =>
      accountProviderSend(
        provider,
        {},
        async () => {
          await new Promise((resolve) => setTimeout(resolve, provider === 'xai' ? 1 : 5));
          traceAgentUsage({
            provider: 'xai',
            sessionId: 'transport-account',
            model: 'deployment',
            inputTokens: 10,
            outputTokens: 1,
            cachedTokens: 0,
          });
          return {};
        },
        'grok-4.20',
        { sessionId: `session-${provider}`, sourceType: 'lead' }
      )
    )
  );
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

test('each send records the tier its own final attempt sent, under concurrency and nesting', async () => {
  const usage = { inputTokens: 10, outputTokens: 1, cachedTokens: 0 };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (attempts) =>
    accountProviderSend(
      'openai-oauth',
      {},
      async () => {
        for (const [tier, ms] of attempts) {
          noteRequestServiceTier(tier);
          await sleep(ms);
        }
        return { usage: { ...usage } };
      },
      'gpt-5.5',
      { sessionId: 'tier-session' }
    );
  // Interleaved attempts: a fast-pool downgrade retry and a priority send.
  const [downgraded, priority, standard] = await Promise.all([
    send([
      ['fast', 5],
      ['', 1],
    ]),
    send([['priority', 3]]),
    send([['', 2]]),
  ]);
  assert.equal(downgraded.requestServiceTier, '');
  assert.equal(priority.requestServiceTier, 'priority');
  assert.equal(standard.requestServiceTier, '');
  // A fallback re-send runs its own accounting; the outer abandoned fast
  // attempt must not overwrite the tier the inner send actually used.
  const nested = await accountProviderSend(
    'anthropic-oauth',
    {},
    async () => {
      noteRequestServiceTier('fast');
      return accountProviderSend(
        'anthropic-oauth',
        {},
        async () => {
          noteRequestServiceTier('');
          return { usage: { ...usage } };
        },
        'claude-opus-5',
        {}
      );
    },
    'claude-opus-5-5',
    {}
  );
  assert.equal(nested.requestServiceTier, '');
});

test('re-sent, abandoned and failed attempts each reach the ledger exactly once', async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-usage-attempts-')), 'ledger.sqlite');
  const priorPath = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (priorPath === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = priorPath;
  });
  const model = 'claude-opus-4-8';
  const instance = { constructor: { inputExcludesCache: true } };
  const usage = (input) => ({
    inputTokens: input,
    outputTokens: 1,
    cachedTokens: 0,
    cacheWriteTokens: 1000,
    cacheWrite1hTokens: 1000,
  });
  const send = (sessionId, inner) => accountProviderSend('anthropic-oauth', instance, inner, model, { sessionId });
  // A fallback re-send returns its own result through the enclosing send.
  await send('audit-resend', () => send('audit-resend', async () => ({ model, usage: usage(10) })));
  // A retried stream attempt was billed before the retry replaced it.
  await send('audit-abandoned', async () => {
    noteAbandonedUsage(usage(20), model);
    noteAbandonedUsage({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }, model);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { model, usage: usage(30) };
  });
  // A cut-off stream surfaces its partial usage on the error through both sends.
  const cut = Object.assign(new Error('cut'), { partialUsage: usage(40), partialModel: model });
  await assert.rejects(
    send('audit-failed', () =>
      send('audit-failed', async () => {
        throw cut;
      })
    ),
    (error) => error === cut
  );
  const ledger = new UsageLedger(path);
  t.after(() => ledger.close());
  const inputs = (sessionId) =>
    ledger.db
      .prepare('SELECT input FROM events WHERE session_id=? ORDER BY input')
      .all(sessionId)
      .map((row) => row.input);
  assert.deepEqual(inputs('audit-resend'), [10]);
  assert.deepEqual(inputs('audit-abandoned'), [20, 30]);
  assert.deepEqual(inputs('audit-failed'), [40]);
  // Only the completed result owns the request's wall time.
  const timed = (sessionId) =>
    ledger.db
      .prepare('SELECT input,duration_ms FROM events WHERE session_id=? ORDER BY input')
      .all(sessionId)
      .map((row) => [row.input, row.duration_ms > 0]);
  assert.deepEqual(timed('audit-abandoned'), [
    [20, false],
    [30, true],
  ]);
  assert.deepEqual(timed('audit-failed'), [[40, false]]);
});

test('trace import prices the 1-hour cache-write share from the raw usage', () => {
  const imported = importTraceRow({
    kind: 'usage_raw',
    ts: Date.now(),
    model: 'claude-opus-4-8',
    input_tokens: 100,
    cache_write_tokens: 1000,
    output_tokens: 0,
    payload: {
      provider: 'anthropic-oauth',
      raw_usage: { cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } },
    },
  });
  assert.equal(imported.costUsd, 0.0105); // 100*5/M + 1000*(2*5)/M
});

test('Grok prices the requested SKU while retaining the actual response model; imports preserve it', () => {
  const args = {
    provider: 'grok-oauth',
    model: 'internal-deployment',
    pricingModel: 'grok-4.20',
    inputTokens: 2000,
    cacheReadTokens: 1000,
    outputTokens: 100,
  };
  const row = makeUsageRecord(args);
  assert.equal(row.model, 'internal-deployment');
  assert.equal(row.costUsd, 0.0017); // 1000*1.25/M + 1000*.2/M + 100*2.5/M
  assert.equal(row.rates.pricingModel, 'grok-4.20');
  assert.equal(row.costSource, 'subscription');
  assert.equal(makeUsageRecord({ ...args, pricingModel: undefined }).costUsd, null);
  assert.equal(
    makeUsageRecord({ ...args, provider: 'xai', pricingModel: undefined, requestedModel: 'grok-4.20' }).costUsd,
    null,
    'a requested API id is not evidence of the served SKU'
  );
  const imported = importTraceRow({
    kind: 'usage_raw',
    ts: Date.now(),
    model: 'internal-deployment',
    input_tokens: 2000,
    cached_tokens: 1000,
    output_tokens: 100,
    payload: { provider: 'grok-oauth', requested_model: 'grok-4.20' },
  });
  assert.equal(imported.costUsd, row.costUsd);
});

test('bounded repair preserves every request and token, known prices and future real API routes', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const ts = new Date(2026, 8, 14, 10).getTime();
  ledger.record([
    makeUsageRecord({
      id: 'legacy',
      ts,
      provider: 'xai',
      model: 'internal',
      inputTokens: 50,
      outputTokens: 5,
      origin: 'trace',
    }),
    makeUsageRecord({ id: 'unknown', ts, provider: 'custom-api', model: 'unknown', inputTokens: 20, outputTokens: 2 }),
    makeUsageRecord({
      id: 'known',
      ts,
      provider: 'openai',
      model: 'known',
      inputTokens: 30,
      outputTokens: 3,
      costUsd: 0,
    }),
    makeUsageRecord({
      id: 'future',
      ts: ts + 1000,
      provider: 'xai',
      model: 'internal',
      inputTokens: 40,
      outputTokens: 4,
      costUsd: 2,
    }),
  ]);
  const before = usageLedgerIntegrity(ledger.db);
  const options = {
    throughTs: ts,
    providerOverrides: { xai: 'grok-oauth' },
    price: ({ provider }) =>
      provider === 'grok-oauth' ? { costUsd: 0.5, rates: { inputCostPerM: 1 } } : { costUsd: null, rates: null },
  };
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
  assert.throws(
    () =>
      repairUsageLedger(ledger, {
        throughTs: Date.now(),
        providerOverrides: { xai: 'grok-oauth' },
        price: () => ({ costUsd: NaN }),
      }),
    /Invalid repair price/
  );
  assert.deepEqual(ledger.db.prepare('SELECT * FROM events').all(), rows);
  assert.equal(ledger.get('lastUsageRepair'), null);
  assert.equal(Object.values(ledger.rollup().days)[0].turns, 1);
});

test('all cost totals and price coverage come from included routes, not inconsistent historical day headers', () => {
  const route = {
    provider: 'openai',
    model: 'one',
    kind: 'api',
    turns: 2,
    input: 100,
    output: 20,
    costUsd: 3,
    costKnownTurns: 1,
    costBilled: 1,
    costEstimated: 2,
  };
  const stats = usageStatsSnapshot({
    source: 'all',
    now: new Date(2026, 8, 14, 12).getTime(),
    rollup: { days: { '2026-09-14': { costKnownTurns: 900, costEstimated: 900, models: { 'openai/one': route } } } },
  });
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
    makeUsageRecord({
      id: 'old',
      ts: new Date(2025, 11, 31, 12).getTime(),
      provider: 'custom-api',
      model: 'unknown',
      inputTokens: 10,
    }),
    makeUsageRecord({ id: 'new', ts: now, provider: 'custom-api', model: 'unknown', inputTokens: 20 }),
  ]);
  const yearly = resolveUsageStatsPeriod({ view: 'year', now });
  const stats = usageStatsSnapshot({ rollup: ledger.rollup(), period: yearly, now, source: 'all' });
  assert.equal(stats.totals.turns, 2);
  assert.equal(stats.totals.tokens, 30);
  assert.equal(yearly.fromMs, 0);
  const hourly = resolveUsageStatsPeriod({ view: 'hour', now });
  const hours = usageStatsSnapshot({
    rollup: ledger.rollup({
      hourlyDay: hourly.startDay,
      fromDay: hourly.startDay,
      toDay: hourly.endDay,
      fromMs: hourly.fromMs,
      toMs: hourly.toMs,
    }),
    period: hourly,
    now,
    source: 'all',
  }).hourly;
  assert.equal(
    hours.reduce((n, hour) => n + hour.turns, 0),
    1
  );
  assert.equal(
    hours.reduce((n, hour) => n + hour.costKnownTurns, 0),
    0
  );
});
