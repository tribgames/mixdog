// Records the Node golden for the Rust usage pricing: pricingCatalogRevisionSync and
// priceUsage over the fixtures in this directory (and the (provider, id) rows of golden.json).
// Run from the repository root, after record.mjs:
//   node native/core/crates/mixdog-ai/fixtures/catalog-lookup/record-pricing.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || process.cwd());
const read = (name) => readFileSync(join(here, name), 'utf-8');

const data = mkdtempSync(join(tmpdir(), 'pricing-golden-'));
process.env.MIXDOG_DATA_DIR = data;
mkdirSync(data, { recursive: true });
// Synthetic rows reach the columns the recorded catalogs lack (flex, media, tiers, off-peak).
const litellmDoc = { ...JSON.parse(read('litellm.json')), ...JSON.parse(read('pricing-extra-litellm.json')) };
writeFileSync(join(data, 'litellm-catalog.json'), `{"fetchedAt":1,"data":${JSON.stringify(litellmDoc)}}\n`);
writeFileSync(join(data, 'modelsdev-catalog.json'), `{"fetchedAt":1,"data":${read('modelsdev.json')}}\n`);
for (const [file, body] of Object.entries(JSON.parse(read('rosters.json')))) {
  writeFileSync(join(data, file), JSON.stringify(body));
}

const mod = (path) => import(pathToFileURL(join(root, path)).href);
const catalog = await mod('src/runtime/shared/llm/model-catalog.mjs');
const cost = await mod('src/runtime/shared/llm/cost.mjs');
await catalog.warmCatalogFromDisk();

const WEEKDAY_PEAK = Date.UTC(2026, 0, 7, 2, 0, 0); // Wednesday 02:00 UTC
const WEEKDAY_OFF = Date.UTC(2026, 0, 7, 12, 0, 0); // Wednesday 12:00 UTC
const WEEKEND = Date.UTC(2026, 0, 10, 3, 0, 0); // Saturday 03:00 UTC
const base = { outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100 };
const plain = { outputTokens: 500, inputTokens: 1000 };
const scenarios = [
  { name: 'plain', args: { ...plain, ts: WEEKDAY_OFF } },
  { name: 'plain-peak', args: { ...plain, ts: WEEKDAY_PEAK } },
  { name: 'plain-long', args: { outputTokens: 2000, uncachedInputTokens: 300000, ts: WEEKDAY_OFF } },
  { name: 'plain-cache-read', args: { ...plain, cacheReadTokens: 400, ts: WEEKEND } },
  { name: 'plain-priority', args: { ...plain, requestServiceTier: 'priority', kind: 'oauth' } },
  { name: 'plain-fast', args: { ...plain, requestServiceTier: 'fast', kind: 'oauth' } },
  { name: 'plain-ultrafast', args: { ...plain, requestServiceTier: 'ultrafast', kind: 'api' } },
  { name: 'plain-flex', args: { ...plain, serviceTier: 'flex' } },
  { name: 'plain-media', args: { ...plain, media: { images: 2, seconds: 5, resolution: '720P', outputImageTokens: 100 } } },
  { name: 'plain-aggregate', args: { outputTokens: 10, inputTokens: 250000, historicalAggregate: true } },
  { name: 'inclusive', args: { ...base, inputTokens: 1000, ts: WEEKDAY_OFF } },
  {
    name: 'uncached-1h',
    args: { ...base, uncachedInputTokens: 900, cacheReadTokens: 3000, cacheWriteTokens: 500, cacheWrite1hTokens: 200, ts: WEEKDAY_PEAK },
  },
  { name: 'long-prompt', args: { outputTokens: 2000, uncachedInputTokens: 300000, cacheReadTokens: 10000, ts: WEEKDAY_OFF } },
  { name: 'off-peak-weekend', args: { ...base, inputTokens: 5000, ts: WEEKEND } },
  { name: 'peak', args: { ...base, inputTokens: 5000, ts: WEEKDAY_PEAK } },
  { name: 'historical', args: { ...base, inputTokens: 5000, ts: WEEKDAY_OFF, historical: true } },
  { name: 'priority', args: { ...base, inputTokens: 1000, requestServiceTier: 'priority', kind: 'oauth' } },
  { name: 'priority-downgraded', args: { ...base, inputTokens: 1000, requestServiceTier: 'priority', kind: 'api', serviceTier: 'default' } },
  { name: 'fast', args: { ...base, inputTokens: 1000, requestServiceTier: 'fast', kind: 'oauth' } },
  { name: 'ultrafast', args: { ...base, inputTokens: 1000, requestServiceTier: 'ultrafast', kind: 'api' } },
  { name: 'flex', args: { ...base, inputTokens: 1000, serviceTier: 'flex' } },
  { name: 'unmeasured', args: { ...base, inputTokens: 1000, inputTokensKnown: false } },
  { name: 'aggregate', args: { ...base, inputTokens: 250000, historicalAggregate: true } },
  {
    name: 'media',
    args: { outputTokens: 500, uncachedInputTokens: 10, media: { images: 2, seconds: 5, resolution: '720P', outputImageTokens: 100, outputVideoTokens: 50 } },
  },
  { name: 'media-reported', args: { outputTokens: 5, uncachedInputTokens: 1, media: { reportedCostUsd: 0.123456789 } } },
  { name: 'media-empty', args: { media: { images: 0 } } },
  { name: 'requested-sku', args: { ...base, inputTokens: 1000, requestedModel: 'grok-4.7-requested', pricingModel: undefined } },
  { name: 'anthropic-style', args: { ...base, inputTokens: 1000, inputTokensInclusive: false } },
];

const golden = JSON.parse(read('golden.json'));
// Every row the catalog knows, a sample of those it does not, and the synthetic rows.
const rows = [
  ...golden.rows.filter((row, i) => row.known || i % 20 === 0).map((row) => [row.provider, row.id]),
  ...['synthetic-priced', 'synthetic-no-cache'].flatMap((id) => ['openai', 'deepseek'].map((provider) => [provider, id])),
];
// Compact: scenario arguments once, rate snapshots interned. A case is
// [scenario, provider, model, input, costUsd, rates index].
const table = [];
const interned = new Map();
const intern = (text) => {
  if (!interned.has(text)) {
    interned.set(text, table.length);
    table.push(text);
  }
  return interned.get(text);
};
const cases = [];
for (const scenario of scenarios) {
  for (const [provider, model] of rows) {
    const out = cost.priceUsage({ provider, model, ...scenario.args });
    cases.push([scenario.name, provider, model, out.input, out.costUsd, intern(JSON.stringify(out.rates))]);
  }
}
const args = Object.fromEntries(scenarios.map((s) => [s.name, JSON.parse(JSON.stringify(s.args))]));

writeFileSync(
  join(here, 'pricing-golden.json'),
  `${JSON.stringify({ revision: catalog.pricingCatalogRevisionSync(), args, rates: table, cases })}\n`
);
console.log(`recorded ${cases.length} priced cases, ${table.length} distinct rate snapshots`);
process.exit(0);
