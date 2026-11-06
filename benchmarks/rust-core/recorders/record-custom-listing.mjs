#!/usr/bin/env node
// Custom-provider model listings (WP-AI-COMPAT): Node's REAL `listModels` of
// `createCustomProvider` over a scripted `/models` behind a stubbed fetch, with
// per-model overrides, hidden-by-default discovery, manual rows and a failed
// discovery. The metadata catalogs stay empty (every catalog fetch is a 404).
//
//   node benchmarks/rust-core/recorders/record-custom-listing.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/oracles/custom-listing.json
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const BASE = 'https://gateway.example/v1';

const ROSTER = [
  { id: 'plain' },
  { id: 'limits', context_window: 128000, max_output_tokens: 4096 },
  { id: 'ladder', reasoning_efforts: ['low', 'high'] },
  { id: 'ladder-none', reasoning_efforts: ['none'] },
  { id: 'overridden' },
  { id: 'hidden-one' },
  { id: 'embed', type: 'embedding' },
  { id: 'plain' },
];
const MODELS_DEV = {
  'deepseek-reasoner-fixture': {
    id: 'deepseek-reasoner-fixture',
    name: 'DeepSeek Reasoner Fixture',
    reasoning: true,
    interleaved: { field: 'reasoning_content' },
    limit: { context: 64000, output: 8000 },
  },
};
const CATALOG_ROSTER = [{ id: 'deepseek-reasoner-fixture' }, { id: 'vendor/deepseek-reasoner-fixture' }, { id: 'plain' }];
const ANTHROPIC_ROSTER = [
  { id: 'claude-x', display_name: 'Claude X', max_input_tokens: 200000, max_tokens: 64000 },
  { id: 'claude-y' },
  { id: 'claude-z', max_input_tokens: 0, max_tokens: '8000' },
];

const OVERRIDES = {
  overridden: {
    name: 'Renamed',
    contextWindow: 64000,
    maxOutputTokens: 2000,
    supportsVision: true,
    reasoning: { levels: ['low', 'high', 'max'], wireFormat: 'together', wireValues: { low: 'L', max: 'M' }, replay: true },
  },
  'hidden-one': { hidden: true },
  ladder: { reasoning: { wireValues: { high: 'H', medium: 'dropped' } } },
  'manual-only': { manual: true, name: 'Manual', contextWindow: 32000, hidden: false },
  limits: { hidden: false, supportsVision: false },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function recordCustomListing(tree, outFile) {
  const dataDir = mkdtempSync(join(tmpdir(), 'custom-listing-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  const realFetch = globalThis.fetch;
  let script = () => new Response('not found', { status: 404 });
  let sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/\/(v1\/)?models$/.test(url) || !url.startsWith('https://gateway.example')) return new Response('not found', { status: 404 });
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    sent.push({ url, headers: Object.fromEntries(Object.entries(headers).filter(([k]) => ['authorization', 'x-api-key', 'anthropic-version', 'x-extra'].includes(k))) });
    return script();
  };
  // models.dev warmed from a disk copy: a vendor row whose interleaved field the catalog
  // lends a custom model of the same bare id as its default replay.
  writeFileSync(
    join(dataDir, 'modelsdev-catalog.json'),
    `{"fetchedAt":${Date.now()},"data":${JSON.stringify({ deepseek: { models: MODELS_DEV } })}}\n`
  );
  const custom = await importFrom(tree, `${P}/custom-provider.mjs`);
  const catalog = await importFrom(tree, 'src/runtime/shared/llm/model-catalog.mjs');
  await catalog.warmCatalogFromDisk();

  const cases = [];
  const run = async (scenario, config, answer) => {
    script = answer;
    sent = [];
    let out;
    try {
      const provider = await custom.createCustomProvider('custom-fixture', { apiKey: 'fixture-custom-key', ...config });
      out = { rows: await provider.listModels() };
    } catch (error) {
      out = { error: String(error?.message ?? error), status: error?.status ?? null };
    }
    cases.push({ scenario, config, requests: sent, ...out });
  };
  const v2 = (extra) => ({ schemaVersion: 2, name: 'Fixture', protocol: 'openai-chat', baseURL: BASE, headers: { 'X-Extra': 'e' }, ...extra });

  await run('plain-discovery', v2({}), () => json({ data: ROSTER }));
  await run('overrides', v2({ modelOverrides: OVERRIDES }), () => json({ data: ROSTER }));
  await run('new-models-hidden', v2({ discovery: { newModelsHidden: true }, modelOverrides: OVERRIDES }), () => json({ data: ROSTER }));
  await run('catalog-replay', v2({}), () => json({ data: CATALOG_ROSTER }));
  await run(
    'catalog-replay-overridden',
    v2({ modelOverrides: { 'deepseek-reasoner-fixture': { reasoning: { replay: false } }, 'vendor/deepseek-reasoner-fixture': { reasoning: { levels: ['low'] } } } }),
    () => json({ data: CATALOG_ROSTER })
  );
  await run('keyless', v2({ auth: 'none' }), () => json({ data: ROSTER.slice(0, 3) }));
  await run('failed-with-manual', v2({ modelOverrides: OVERRIDES }), () => json({ error: { message: 'bad key fixture-custom-key' } }, 403));
  await run('failed-with-nothing', v2({}), () => json({ error: 'boom' }, 500));
  await run('anthropic', { schemaVersion: 2, name: 'Fixture', protocol: 'anthropic', baseURL: 'https://gateway.example/v1', headers: { 'X-Extra': 'e' }, modelOverrides: { 'claude-y': { name: 'Why', hidden: true } } }, () => json({ data: ANTHROPIC_ROSTER }));

  globalThis.fetch = realFetch;
  rmSync(dataDir, { recursive: true, force: true });
  writeJson(outFile, {
    _doc: 'Recorded from the REAL listModels of a Node custom provider (createCustomProvider) over a scripted /models behind a stubbed fetch; metadata catalogs empty. `rows` are the Node rows verbatim.',
    recorder: 'benchmarks/rust-core/recorders/record-custom-listing.mjs',
    roster: ROSTER,
    anthropicRoster: ANTHROPIC_ROSTER,
    catalogRoster: CATALOG_ROSTER,
    modelsDev: MODELS_DEV,
    cases,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tree = resolveTree(parseArgs());
  await recordCustomListing(tree, join(FIXTURES_ROOT, 'providers', 'oracles', 'custom-listing.json'));
  console.log('recorded custom-listing; providers/MANIFEST.json is regenerated by record-providers.mjs');
}
