#!/usr/bin/env node
// Records Node's relay pricing for the k1 UNTESTED model-catalog-relay-pricing.test.mjs (gaps-rest.md section 3,
// mixdog-ai `catalog`). The test's LiteLLM table is written as the data dir's `litellm-catalog.json` and warmed from disk
// as the test does; each call of the test then goes through Node's real `getModelMetadataSync` (the whole metadata),
// `computeCostUsd` with `priceUsage` (the whole priced usage), the models.dev lookups and `enrichModels`.
//
//   node benchmarks/rust-core/recorders/record-relay-pricing-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/relay-pricing-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-relay-pricing-cases.mjs';
const TEST = 'src/runtime/agent/orchestrator/providers/model-catalog-relay-pricing.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);

const litellm = {
  'claude-relay-test-1': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    max_input_tokens: 200000,
    mode: 'chat',
  },
  'gemini/gemini-relay-test-1': {
    litellm_provider: 'gemini',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 4e-6,
    max_input_tokens: 1000000,
    max_output_tokens: 65536,
    mode: 'chat',
  },
};
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-pricing-'));
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: litellm }));
process.env.MIXDOG_DATA_DIR = dataDir;

const catalogMod = await importFrom(tree, 'src/runtime/shared/llm/model-catalog.mjs');
await (await importFrom(tree, 'src/runtime/shared/llm/catalog-warm.fixture.mjs')).warmCatalogForTest(catalogMod);
const { enrichModels, getModelMetadataSync } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-catalog.mjs');
const { computeCostUsd, priceUsage } = await importFrom(tree, 'src/runtime/shared/llm/cost.mjs');

const meta = (pairs) => pairs.map(([model, provider]) => ({ model, provider, meta: getModelMetadataSync(model, provider) }));
const cost = (list) => list.map((usage) => ({ usage, costUsd: computeCostUsd(usage), priced: priceUsage(usage) }));
const turn = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 };

const cases = [
  { case: 'a relayed model is priced at the rate of the vendor that served it', recorded: { meta: meta([['claude-relay-test-1', 'anthropic-oauth'], ['claude-relay-test-1', 'cursor-oauth']]) } },
  { case: 'repricing reaches the prefixed catalog keys too', recorded: { meta: meta([['gemini-relay-test-1', 'cursor-oauth']]) } },
  {
    case: 'relay pricing does not inherit vendor context or output limits',
    recorded: { meta: meta([['gemini-relay-test-1', 'google'], ...['cursor-oauth', 'cursor-api', 'antigravity-oauth'].map((p) => ['gemini-relay-test-1', p])]) },
  },
  {
    case: 'a relayed turn costs what the same turn costs on the vendor directly',
    recorded: {
      cost: cost([
        { ...turn, provider: 'anthropic-oauth', model: 'claude-relay-test-1' },
        { ...turn, inputTokens: 1_500_000, provider: 'cursor-oauth', model: 'claude-relay-test-1' },
      ]),
    },
  },
  {
    case: 'a model no vendor claims is left unpriced rather than guessed at',
    recorded: { meta: meta([['kimi-relay-test-1', 'cursor-oauth']]), cost: cost([{ provider: 'cursor-oauth', model: 'kimi-relay-test-1', inputTokens: 1_000_000 }]) },
  },
  {
    case: 'a local model stays free: nothing is relayed and nothing is priced',
    recorded: { meta: meta([['claude-relay-test-1', 'mixdog-local']]), cost: cost([{ provider: 'mixdog-local', model: 'claude-relay-test-1', inputTokens: 1_000_000 }]) },
  },
  { case: 'an ordinary provider is never repriced by a name that merely resembles one', recorded: { meta: meta([['claude-relay-test-1', 'openai-oauth']]) } },
];
{
  const rows = [{ id: 'unknown-fixture', provider: 'fixture', display: 'Native label' }, { provider: 'fixture' }];
  const enriched = await enrichModels(rows, { fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  cases.push({ case: 'enrichment preserves unknown and id-less rows by reference and in order', recorded: { rows, enriched, same: enriched.map((row, i) => row === rows[i]) } });
}

const excluded = {
  'injected models.dev lookups stay separate from the disk catalog':
    "GONE: `getModelsDevRowSync`/`getModelsDevProviderModelsSync` with an injected table are Node's test seam; the core's lookups read the service's own layers and take no injected table",
};

const finalDir = join(FIXTURES_ROOT, 'relay-pricing-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's relay pricing at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, litellm, cases });
writeSetManifest(stage, {
  set: 'relay-pricing-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "meta: each whole metadata (CatalogService::sync_meta); cost: computeCostUsd and the whole priced usage (price_usage: input, costUsd, the rates object); enrichment: each whole row (enrich_model) and that each is the row given",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`relay-pricing-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
