import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'mixdog-model-pricing-'));
process.env.MIXDOG_DATA_DIR = directory;
const litellm = {
  'gemini/gemini-3.8-flash': {
    litellm_provider: 'gemini',
    input_cost_per_token: 0.75e-6,
    output_cost_per_token: 3.75e-6,
    cache_read_input_token_cost: 0.075e-6,
    supports_prompt_caching: true,
    max_input_tokens: 1048576,
  },
  'gemini/gemini-3.5-flash': {
    litellm_provider: 'gemini',
    input_cost_per_token: 1.5e-6,
    output_cost_per_token: 9e-6,
    cache_read_input_token_cost: 0.15e-6,
  },
  // Published Gemini 2.5 Pro text rates: >200k is not a uniform multiplier.
  'gemini/gemini-2.5-pro': {
    litellm_provider: 'gemini',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.125e-6,
    input_cost_per_token_above_200k_tokens: 2.5e-6,
    output_cost_per_token_above_200k_tokens: 15e-6,
    cache_read_input_token_cost_above_200k_tokens: 0.25e-6,
  },
  'anthropic/claude-price-test': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 0.3e-6,
    max_input_tokens: 200000,
  },
};
const modelsdev = {
  'opencode-go': {
    models: {
      'minimax-m3': {
        cost: {
          input: 0.3,
          output: 1.2,
          cache_read: 0.06,
          tiers: [{ input: 0.6, output: 2.4, cache_read: 0.12, tier: { type: 'context', size: 512000 } }],
          context_over_200k: { input: 0.6, output: 2.4, cache_read: 0.12 },
        },
      },
    },
  },
  'cursor-api': {
    models: {
      'claude-price-test': { cost: { input: 4, output: 20, cache_read: 0.4 } },
    },
  },
};
const antigravity = [
  {
    id: 'gemini-3.8-flash',
    provider: 'antigravity-oauth',
    contextWindow: 1048576,
    wire: { high: 'gemini-3.8-flash-high', medium: 'gemini-3.8-flash-medium', low: 'gemini-3.8-flash-low' },
  },
  {
    id: 'gemini-3.5-flash',
    provider: 'antigravity-oauth',
    wire: { high: 'gemini-3-flash-agent', medium: 'gemini-3.5-flash-low', low: 'gemini-3.5-flash-extra-low' },
  },
];
const writeCatalog = (file, data) =>
  writeFileSync(join(directory, file), JSON.stringify({ fetchedAt: Date.now(), data }));
const writeModels = (models) =>
  writeFileSync(
    join(directory, 'antigravity-oauth-models.json'),
    JSON.stringify({ version: 1, fetchedAt: Date.now(), models })
  );
writeCatalog('litellm-catalog.json', litellm);
writeCatalog('modelsdev-catalog.json', modelsdev);
writeModels(antigravity);

const catalog = await import('../../agent/orchestrator/providers/model-catalog.mjs');
const { priceUsage } = await import('./cost.mjs');
const { UsageLedger, makeUsageRecord } = await import('./usage-ledger.mjs');
const { refreshUnpricedUsage } = await import('./usage-pricing-refresh.mjs');
const { usageLedgerIntegrity } = await import('./usage-ledger-repair.mjs');
const { createUsageStatsApi } = await import('../../../session-runtime/usage-stats-api.mjs');
const injectedFetch = async (url) => ({
  ok: true,
  json: async () => structuredClone(String(url).includes('models.dev') ? modelsdev : litellm),
});

test('wire ids use the gateway mapping, including aliases that cannot be suffix-stripped', () => {
  for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']) {
    const priced = priceUsage({
      provider: 'antigravity-oauth',
      model,
      requestedModel: 'gemini-3.8-flash',
      inputTokens: 1000000,
      outputTokens: 100000,
      cacheReadTokens: 500000,
    });
    assert.equal(priced.costUsd, 0.7875);
    assert.equal(priced.rates.pricingModel, 'gemini-3.8-flash');
    assert.equal(priced.rates.requestedModel, 'gemini-3.8-flash');
    assert.equal(priced.rates.pricingProvider, 'google');
    assert.equal(priced.rates.pricingSource, 'litellm');
  }
  assert.equal(catalog.getModelMetadataSync('gemini-3-flash-agent', 'antigravity-oauth').inputCostPerM, 1.5);
  assert.equal(catalog.getModelMetadataSync('gemini-3.8-flash-ultra', 'antigravity-oauth'), null);
  assert.equal(catalog.getModelMetadataSync('gemini-3.8-flash-high', 'gemini'), null, 'aliases are route-scoped');
  assert.equal(
    catalog.resolveModelPricingIdentity('gemini-3.1-pro-high', 'antigravity-oauth').pricingModel,
    'gemini-3.1-pro',
    'the shared offline transport mapping also works before discovery'
  );
  assert.equal(
    priceUsage({ provider: 'grok-oauth', model: 'grok-code-fast-1', inputTokens: 1000000, outputTokens: 100000 })
      .costUsd,
    1.2
  );
});

test('list enrichment and accounting agree, and a relay-specific price beats its vendor fallback', async () => {
  const models = [
    { id: 'gemini-3.8-flash-high', provider: 'antigravity-oauth' },
    { id: 'claude-price-test', provider: 'cursor-oauth' },
    { id: 'claude-price-test', provider: 'cursor-api' },
    { id: 'claude-price-test', provider: 'anthropic' },
  ];
  const enriched = await catalog.enrichModels(models, { fetchFn: injectedFetch });
  for (const row of enriched) {
    const sync = catalog.getModelMetadataSync(row.id, row.provider);
    for (const key of ['inputCostPerM', 'outputCostPerM', 'cacheReadCostPerM', 'pricingModel', 'pricingProvider']) {
      assert.equal(row[key], sync[key], `${row.provider}/${row.id}: ${key}`);
    }
  }
  assert.equal(enriched[2].inputCostPerM, 4);
  assert.equal(enriched[2].pricingProvider, 'cursor-api');
  assert.equal(enriched[1].contextWindow, null, 'vendor limits must not leak into a relay');
});

test('the full prompt selects separate input, output and cache rates at the published boundary', () => {
  const args = { provider: 'gemini', model: 'gemini-2.5-pro', outputTokens: 1000 };
  assert.equal(priceUsage({ ...args, inputTokens: 200000 }).costUsd, 0.26);
  assert.equal(priceUsage({ ...args, inputTokens: 300000 }).costUsd, 0.765);
  const cached = priceUsage({ ...args, inputTokens: 300000, cacheReadTokens: 299000 });
  assert.equal(cached.input, 1000);
  assert.equal(cached.costUsd, 0.09225);
  assert.equal(cached.rates.cacheReadCostPerM, 0.25);
  const aggregate = priceUsage({ ...args, inputTokens: 300000, historicalAggregate: true });
  assert.equal(aggregate.costUsd, null);
  assert.equal(aggregate.rates.unpricedReason, 'request-boundaries-unavailable');
});

test('structured context tiers take precedence over a legacy compatibility field', () => {
  const args = { provider: 'opencode-go', model: 'minimax-m3', outputTokens: 1000 };
  assert.equal(priceUsage({ ...args, inputTokens: 300000 }).costUsd, 0.0912);
  assert.equal(priceUsage({ ...args, inputTokens: 512000 }).costUsd, 0.1548);
  assert.equal(priceUsage({ ...args, inputTokens: 600000 }).costUsd, 0.3624);
  const missing = priceUsage({ ...args, inputTokens: 2000, cacheWriteTokens: 100 });
  assert.equal(missing.costUsd, null);
  assert.equal(missing.rates.unpricedReason, 'missing-rate');
  assert.deepEqual(missing.rates.missingRates, ['cacheWriteCostPerM']);
});

test('Anthropic 1-hour cache writes bill at 2x base input, the rest at the 5-minute rate', () => {
  // Opus 5.5 list rates: input $4, 5m write $5, 1h write $8 per MTok.
  const args = { provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 1000, cacheWriteTokens: 1_000_000 };
  assert.equal(priceUsage(args).costUsd, 5.004);
  const split = priceUsage({ ...args, cacheWrite1hTokens: 400_000 });
  assert.equal(split.costUsd, 6.204);
  assert.ok(Math.abs(split.rates.cacheWrite1hCostPerM - 8) < 1e-9);
  assert.equal(split.rates.cacheWrite1hTokens, 400_000);
  // Fast mode multiplies every slot, including the 1h write rate.
  assert.equal(priceUsage({ ...args, cacheWrite1hTokens: 400_000, fast: true }).costUsd, 12.408);
  assert.equal(makeUsageRecord({ ...args, cacheWrite1hTokens: 400_000, ts: Date.now() }).costUsd, 6.204);
});

test('GPT-6 Sol and Luna price on both OpenAI routes, doubling input above 272K', () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  for (const provider of ['openai', 'openai-oauth']) {
    near(priceUsage({ provider, model: 'gpt-6-sol', inputTokens: 100_000, outputTokens: 10_000 }).costUsd, 0.3);
    near(priceUsage({ provider, model: 'gpt-6-sol', inputTokens: 300_000, outputTokens: 10_000 }).costUsd, 1.35);
    near(priceUsage({ provider, model: 'gpt-6-luna', inputTokens: 100_000, outputTokens: 10_000 }).costUsd, 0.015);
  }
  const sol = catalog.getModelMetadataSync('gpt-6-sol', 'openai-oauth');
  assert.equal(sol.supportsWebSearch, true);
  assert.equal(sol.supportsVision, true);
  // Public API limits come from the override; OAuth never inherits them.
  assert.equal(catalog.getModelMetadataSync('gpt-6-sol', 'openai').contextWindow, 1050000);
  assert.equal(catalog.getModelMetadataSync('gpt-6-luna', 'openai').outputTokens, 128000);
  assert.equal(sol.contextWindow, null);
});

test('unknown prices retain both request and pricing identity instead of losing them', () => {
  const row = makeUsageRecord({
    provider: 'grok-oauth',
    model: 'internal-deployment',
    requestedModel: 'grok-not-yet-priced',
    inputTokens: 100,
    outputTokens: 10,
  });
  assert.equal(row.model, 'internal-deployment');
  assert.equal(row.costUsd, null);
  assert.equal(row.rates.requestedModel, 'grok-not-yet-priced');
  assert.equal(row.rates.pricingModel, 'grok-not-yet-priced');
  assert.equal(row.rates.unpricedReason, 'model-not-found');
  assert.equal(
    makeUsageRecord({
      provider: 'openai',
      model: 'unidentified-deployment',
      requestedModel: 'gemini-3.8-flash',
      inputTokens: 100,
    }).costUsd,
    null
  );
});

test('automatic coverage checks include every execution id and required cache rates', () => {
  const rows = catalog.auditModelPricing(
    [...antigravity, { id: 'gemini-unidentified', wire: { high: 'gemini-unidentified-high' } }],
    'antigravity-oauth'
  );
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((r) => !r.priced).length, 2);
  assert.equal(rows.find((r) => r.model === 'gemini-3-flash-agent').pricingModel, 'gemini-3.5-flash');
});

test('dashboard recovery backs up originals, preserves known costs/tokens, and revisits new explicit aliases', async (t) => {
  const path = join(directory, 'recovery.sqlite');
  const ledger = new UsageLedger(path);
  t.after(() => ledger.close());
  const ts = Date.now() - 1000;
  const old = makeUsageRecord({
    id: 'old',
    ts,
    provider: 'antigravity-oauth',
    model: 'gemini-3.8-flash-high',
    inputTokens: 1000,
    outputTokens: 100,
  });
  ledger.record([
    { ...old, costUsd: null, costSource: 'unpriced', rates: null },
    { ...old, id: 'known', costUsd: 7, costSource: 'subscription' },
    makeUsageRecord({
      id: 'future-alias',
      ts,
      provider: 'antigravity-oauth',
      model: 'gateway-new-wire',
      inputTokens: 1000,
      outputTokens: 100,
    }),
    makeUsageRecord({
      id: 'unmeasured',
      ts,
      provider: 'cursor-api',
      model: 'claude-price-test',
      inputTokensKnown: false,
      outputTokens: 100,
    }),
  ]);
  const before = usageLedgerIntegrity(ledger.db);
  const originals = ledger.db.prepare('SELECT * FROM events ORDER BY id').all();
  ledger.beginCapture(ts);
  ledger.set('importedThrough', ts);
  const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
  const stats = await api.getUsageStats({ days: null });
  assert.equal(stats.totals.costUsd, 7.001125);
  const receipt = JSON.parse(ledger.get('lastUsageRepair'));
  assert.equal(receipt.repriced, 1);
  assert.ok(receipt.backupPath);
  const backup = new DatabaseSync(receipt.backupPath, { readOnly: true });
  try {
    assert.deepEqual(backup.prepare('SELECT * FROM events ORDER BY id').all(), originals);
  } finally {
    backup.close();
  }
  assert.deepEqual(usageLedgerIntegrity(ledger.db), before);
  assert.equal(refreshUnpricedUsage(ledger).skipped, true);
  // One model record owns all of its explicit wire aliases.
  writeModels([{ ...antigravity[0], wire: { ...antigravity[0].wire, new: 'gateway-new-wire' } }, antigravity[1]]);
  const recovered = refreshUnpricedUsage(ledger);
  assert.equal(recovered.repriced, 1);
  assert.equal(ledger.db.prepare("SELECT cost_usd FROM events WHERE id='known'").get().cost_usd, 7);
  assert.equal(ledger.db.prepare("SELECT cost_usd FROM events WHERE id='unmeasured'").get().cost_usd, null);
  assert.deepEqual(usageLedgerIntegrity(ledger.db), before);
  writeModels(antigravity);
});

test('Antigravity missing prices recover at the direct API rates without double-counting cache', async (t) => {
  const ledger = new UsageLedger(join(directory, 'antigravity-partial.sqlite'));
  t.after(() => ledger.close());
  const ts = Date.now() - 1000;
  const usage = { ts, model: 'gemini-3.8-flash', inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 500000 };
  const apiPrice = priceUsage({ ...usage, provider: 'gemini' });
  assert.equal(apiPrice.costUsd, 0.7875);
  const known = makeUsageRecord({
    ...usage,
    id: 'ag-known',
    provider: 'antigravity-oauth',
    model: 'gemini-3.8-flash-high',
  });
  assert.equal(known.costUsd, apiPrice.costUsd);
  const missing = { ...known, id: 'ag-missing', costUsd: null, costSource: 'unpriced', rates: null };
  ledger.record([known, missing]);
  const before = usageLedgerIntegrity(ledger.db);
  const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
  const stats = await api.getUsageStats({ days: null });
  assert.equal(stats.totals.costUsd, 1.575);
  assert.equal(stats.totals.costCoverage, 1);
  assert.equal(ledger.db.prepare("SELECT cost_usd FROM events WHERE id='ag-missing'").get().cost_usd, apiPrice.costUsd);
  assert.deepEqual(usageLedgerIntegrity(ledger.db), before);
  // A still-running older writer can append another price-less request after
  // the dashboard's first recovery; it must not stay behind a cached check.
  ledger.record([{ ...missing, id: 'ag-later' }]);
  const refreshed = await api.getUsageStats({ days: null });
  assert.equal(refreshed.totals.costUsd, 2.3625);
  assert.equal(refreshed.totals.costCoverage, 1);
  assert.equal(refreshUnpricedUsage(ledger).skipped, true);
});

test('expired catalogs refresh, failures retain disk prices, and retry waits for its cooldown', async (t) => {
  let clock = Date.now();
  let calls = 0;
  let failing = false;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    if (failing) throw new Error('fixture network unavailable');
    return injectedFetch(url);
  });
  await catalog.refreshCatalog();
  assert.equal(calls, 2);
  await catalog.warmCatalogsInBackground();
  assert.equal(calls, 2);
  clock += catalog.PRICING_CATALOG_REFRESH_MS + 1;
  await catalog.warmCatalogsInBackground();
  assert.equal(calls, 4);
  clock += catalog.PRICING_CATALOG_REFRESH_MS + 1;
  failing = true;
  const failed = await catalog.warmCatalogsInBackground();
  assert.equal(calls, 6);
  assert.equal(failed.retryAfterMs, 60000);
  assert.equal(
    priceUsage({ provider: 'gemini', model: 'gemini-2.5-pro', inputTokens: 300000, outputTokens: 1000 }).costUsd,
    0.765
  );
  await catalog.warmCatalogsInBackground();
  assert.equal(calls, 6);
  failing = false;
  clock += 60001;
  await catalog.warmCatalogsInBackground();
  assert.equal(calls, 8);
});
