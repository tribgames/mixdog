// One registry and one precedence order for model metadata: the sync lookup
// and list enrichment must agree, and capability data may only come from the
// endpoint that actually serves the request.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-catalog-registry-'));
process.env.MIXDOG_DATA_DIR = dir;
test.after(() => rmSync(dir, { recursive: true, force: true }));

const FIVE = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const SIX = [...FIVE, 'max'];
const effort = (values) => [{ type: 'effort', values }];
const spark = (name, cost, values, output = 65536) => ({
  name,
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 1048576, output },
  cost,
  reasoning_options: effort(values),
});
const modelsdev = {
  meta: {
    models: {
      // Fixture limits/prices differ from the Muse seeds, so a seed leaking
      // over fetched data is visible.
      'muse-spark-1.3': spark('Muse Spark 1.3', { input: 1.5, output: 5, cache_read: 0.2 }, SIX),
      // models.dev `meta` omits max for the contributor tier.
      'muse-spark-1.3-contributor': spark('Muse Spark 1.3 Contributor', { input: 0.2, output: 0.4 }, FIVE),
      // Declares text-only, no reasoning, no tool calls; publishes no output limit.
      'muse-spark-1.1': {
        name: 'Muse Spark 1.1',
        reasoning: false,
        tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 400000 },
        cost: { input: 1, output: 2 },
      },
    },
  },
  'opencode-go': {
    models: {
      'muse-spark-1.3-contributor': {
        name: 'Muse Spark 1.3 Contributor',
        reasoning: true,
        limit: { context: 262144, output: 32768 },
        cost: { input: 0.3, output: 0.9 },
        reasoning_options: effort(FIVE),
      },
    },
  },
  anthropic: {
    models: {
      'claude-registry-1': {
        name: 'Claude Registry 1',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'] },
        limit: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15, cache_read: 0.3 },
        reasoning_options: effort(['low', 'high', 'max']),
      },
      'claude-registry-2-5': {
        name: 'Claude Registry 2.5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'] },
        limit: { context: 1000000, output: 128000 },
        cost: { input: 5, output: 25 },
        reasoning_options: effort(['low', 'medium', 'high', 'xhigh', 'max']),
      },
    },
  },
  xai: {
    models: {
      'grok-registry-build': {
        name: 'Grok Registry Build',
        reasoning: true,
        tool_call: true,
        limit: { context: 256000, output: 32000 },
        cost: { input: 0.2, output: 1.5 },
        reasoning_options: effort(['low', 'medium', 'high']),
      },
    },
  },
  xiaomi: {
    models: {
      'mimo-registry-pro': {
        name: 'MiMo Registry Pro',
        reasoning: true,
        tool_call: true,
        limit: { context: 1000000, output: 128000 },
        cost: { input: 1, output: 3 },
      },
    },
  },
  moonshotai: {
    models: {
      'kimi-registry-code': {
        name: 'Kimi Registry Code',
        reasoning: true,
        tool_call: true,
        limit: { context: 262144, output: 65536 },
        cost: { input: 0.6, output: 2.5 },
        reasoning_options: effort(['low', 'high']),
      },
    },
  },
  alibaba: {
    models: {
      'qwen9.9-registry': {
        name: 'Qwen Registry',
        reasoning: true,
        tool_call: true,
        cost: { input: 0.4, output: 1.2 },
        reasoning_options: effort(['low', 'medium', 'high']),
      },
    },
  },
};
modelsdev['opencode-go'].models = {
  ...modelsdev['opencode-go'].models,
  // Own rows that declare reasoning but no effort ladder.
  'kimi-registry-code': { name: 'Kimi Registry Code', reasoning: true, cost: { input: 0.5, output: 2 } },
  'qwen9.9-registry': {
    name: 'Qwen Registry',
    reasoning: true,
    limit: { context: 131072, output: 16384 },
    reasoning_options: [{ type: 'toggle' }],
  },
  'longcat-registry-2': { name: 'LongCat Registry', reasoning: true, tool_call: true },
  // Own explicit falses beat the vendor's guess.
  'kimi-registry-lite': {
    name: 'Kimi Registry Lite',
    reasoning: false,
    tool_call: false,
    modalities: { input: ['text'] },
    cost: { input: 0.1, output: 0.3 },
  },
};
modelsdev.moonshotai.models['kimi-registry-lite'] = {
  name: 'Kimi Registry Lite',
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image'] },
  reasoning_options: effort(['low', 'high']),
};
modelsdev.google = {
  models: {
    'gemini-registry-pro': {
      name: 'Gemini Registry Pro',
      reasoning: true,
      tool_call: true,
      modalities: { input: ['text', 'image'] },
      limit: { context: 1048576, output: 65536 },
      cost: { input: 2, output: 12 },
      reasoning_options: effort(['low', 'medium', 'high']),
    },
  },
};
// LiteLLM is the only source of web-search support here.
const litellm = {
  'claude-registry-1': { litellm_provider: 'anthropic', mode: 'chat', supports_web_search: true },
  'xai/grok-registry-build': { litellm_provider: 'xai', mode: 'chat', supports_web_search: true },
  'gemini/gemini-registry-pro': { litellm_provider: 'gemini', mode: 'chat', supports_web_search: true },
};
writeFileSync(join(dir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: litellm }));
writeFileSync(join(dir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: modelsdev }));

const catalog = await import('./model-catalog.mjs');
const registry = await import('./provider-catalog-registry.mjs');
const injectedFetch = async (url) => ({
  ok: true,
  json: async () => structuredClone(String(url).includes('models.dev') ? modelsdev : litellm),
});
const effortValues = (meta) => meta?.reasoningOptions?.find((o) => o.type === 'effort')?.values || [];

test('a providerless listed row enriches from the catalog without a registry entry', async () => {
  const [listed] = await catalog.enrichModels([{ id: 'claude-registry-1' }], { fetchFn: injectedFetch });
  assert.equal(listed.id, 'claude-registry-1');
});

// Both lookup paths for one provider/model.
async function bothPaths(provider, id) {
  const [listed] = await catalog.enrichModels([{ id, provider }], { fetchFn: injectedFetch });
  return { sync: catalog.getModelMetadataSync(id, provider), listed };
}

test('the registry maps providers, endpoints and relays from one table', () => {
  const muse = registry.providerCatalogEntry('muse-code-oauth');
  assert.equal(muse.modelsDev, 'meta');
  assert.equal(muse.sameEndpoint, true);
  assert.equal(muse.relay, false);
  assert.deepEqual(muse.rosterFiles, ['muse-code-oauth-models.json']);
  for (const [provider, vendor] of [
    ['openai-oauth', 'openai'],
    ['anthropic-oauth', 'anthropic'],
    ['grok-oauth', 'xai'],
    ['mimo-oauth', 'xiaomi'],
  ]) {
    const entry = registry.providerCatalogEntry(provider);
    assert.equal(entry.modelsDev, vendor, provider);
    assert.equal(entry.sameEndpoint, false, provider);
  }
  assert.equal(registry.providerCatalogEntry('gemini').modelsDev, 'google');
  for (const relay of ['cursor-oauth', 'cursor-api', 'antigravity-oauth', 'opencode-go-oauth']) {
    assert.equal(registry.providerCatalogEntry(relay).relay, true, relay);
  }
  assert.deepEqual(registry.providerRosterFiles('mimo-oauth'), ['mimo-oauth-models.json']);
  assert.equal(registry.rosterProviders().includes('anthropic'), false, 'a shared roster file is listed once');
});

test('Muse OAuth exposes max and the 1M window from models.dev meta on both paths', async () => {
  for (const id of ['muse-spark-1.3', 'muse-spark-1.3-contributor']) {
    for (const [path, meta] of Object.entries(await bothPaths('muse-code-oauth', id))) {
      assert.deepEqual(effortValues(meta), SIX, `${path} ${id}`);
      assert.equal(meta.contextWindow, 1048576, `${path} ${id}`);
      assert.equal(meta.outputTokens, 65536, `${path} ${id}: fetched limits beat the seed`);
    }
  }
  const { sync, listed } = await bothPaths('muse-code-oauth', 'muse-spark-1.3');
  assert.equal(sync.inputCostPerM, 1.5, 'fetched pricing beats the seed');
  assert.equal(listed.inputCostPerM, 1.5);
  assert.equal(sync.pricingProvider, 'meta');
  assert.equal(sync.supportsVision, true);
});

test('opencode-go serves its own ladder and never borrows meta’s max', async () => {
  for (const [path, meta] of Object.entries(await bothPaths('opencode-go-oauth', 'muse-spark-1.3-contributor'))) {
    assert.deepEqual(effortValues(meta), FIVE, path);
    assert.equal(meta.contextWindow, 262144, path);
    assert.equal(meta.inputCostPerM, 0.3, path);
  }
});

test('a relay model without its own row guesses vendor capabilities and ladder, never limits', async () => {
  for (const [provider, id, price, ladder] of [
    ['opencode-go-oauth', 'muse-spark-1.3', 1.5, SIX],
    ['cursor-oauth', 'claude-registry-1', 3, ['low', 'high', 'max']],
    // Relays may spell Anthropic versions with dots.
    ['cursor-oauth', 'claude-registry-2.5', 5, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['cursor-api', 'claude-registry-1', 3, ['low', 'high', 'max']],
    ['antigravity-oauth', 'claude-registry-1', 3, ['low', 'high', 'max']],
  ]) {
    for (const [path, meta] of Object.entries(await bothPaths(provider, id))) {
      const label = `${path} ${provider}/${id}`;
      assert.equal(meta.inputCostPerM, price, label);
      assert.deepEqual(effortValues(meta), ladder, label);
      assert.equal(meta.contextWindow, null, label);
      assert.equal(meta.outputTokens, null, label);
      assert.equal(meta.supportsReasoning, true, label);
      assert.equal(meta.supportsVision, true, label);
      assert.equal(meta.supportsFunctionCalling, true, label);
    }
  }
  for (const [path, meta] of Object.entries(await bothPaths('cursor-oauth', 'claude-registry-1'))) {
    assert.equal(meta.supportsWebSearch ?? null, null, `${path}: web search is the relay endpoint's own`);
  }
});

test('a same-vendor provider on another endpoint guesses capabilities and ladder from the vendor row', async () => {
  for (const [path, meta] of Object.entries(await bothPaths('anthropic-oauth', 'claude-registry-1'))) {
    assert.equal(meta.inputCostPerM, 3, path);
    assert.equal(meta.cacheReadCostPerM, 0.3, path);
    assert.deepEqual(effortValues(meta), ['low', 'high', 'max'], path);
    assert.equal(meta.contextWindow, null, path);
    assert.equal(meta.outputTokens, null, path);
    assert.equal(meta.supportsVision, true, path);
    assert.equal(meta.supportsWebSearch, true, path);
  }
  // Grok's roster has no ladder: the xai row supplies it, never its limits.
  for (const [path, meta] of Object.entries(await bothPaths('grok-oauth', 'grok-registry-build'))) {
    assert.deepEqual(effortValues(meta), ['low', 'medium', 'high'], path);
    assert.equal(meta.supportsWebSearch, true, path);
    assert.equal(meta.contextWindow, null, path);
  }
  const direct = catalog.getModelMetadataSync('claude-registry-1', 'anthropic');
  assert.deepEqual(effortValues(direct), ['low', 'high', 'max'], 'the vendor’s own endpoint keeps it all');
  assert.equal(direct.contextWindow, 200000);
});

test('seeds apply only to what fetched data left empty', async () => {
  // muse-spark-1.2 has no models.dev row: the offline seed supplies everything.
  for (const [path, meta] of Object.entries(await bothPaths('muse-code-oauth', 'muse-spark-1.2'))) {
    assert.deepEqual(effortValues(meta), FIVE, path);
    assert.equal(meta.contextWindow, 1048576, path);
    assert.equal(meta.outputTokens, 131072, path);
    assert.equal(meta.inputCostPerM, 1.25, path);
  }
  // A live roster row wins over both the seed and models.dev.
  writeFileSync(
    join(dir, 'muse-code-oauth-models.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      models: [
        { id: 'muse-spark-1.2', provider: 'muse-code-oauth', contextWindow: 524288 },
        { id: 'muse-spark-1.3', provider: 'muse-code-oauth', outputTokens: 32000 },
      ],
    })
  );
  try {
    assert.equal(catalog.getModelMetadataSync('muse-spark-1.2', 'muse-code-oauth').contextWindow, 524288);
    assert.equal(catalog.getModelMetadataSync('muse-spark-1.3', 'muse-code-oauth').outputTokens, 32000);
    assert.equal(catalog.getModelMetadataSync('muse-spark-1.2', 'muse-code-oauth').outputTokens, 131072);
  } finally {
    rmSync(join(dir, 'muse-code-oauth-models.json'), { force: true });
  }
  assert.equal(catalog.getModelMetadataSync('muse-unknown', 'muse-code-oauth'), null);
});

test('an empty or coerced-false roster ladder keeps the lookup ladder on both paths', async () => {
  const roster = [
    { id: 'muse-spark-1.3', supportsReasoning: true, reasoningOptions: [] },
    { id: 'muse-spark-1.3-contributor', supportsReasoning: false, reasoningOptions: [] },
  ];
  writeFileSync(
    join(dir, 'muse-code-oauth-models.json'),
    JSON.stringify({ version: 1, fetchedAt: Date.now(), models: roster })
  );
  try {
    const listed = await catalog.enrichModels(
      roster.map((row) => ({ ...row, provider: 'muse-code-oauth' })),
      { fetchFn: injectedFetch }
    );
    for (const row of listed) {
      const sync = catalog.getModelMetadataSync(row.id, 'muse-code-oauth');
      assert.deepEqual(effortValues(sync), SIX, `${row.id}: sync`);
      assert.deepEqual(effortValues(row), effortValues(sync), `${row.id}: enrichment agrees with sync`);
      assert.equal(row.supportsReasoning, sync.supportsReasoning, row.id);
    }
  } finally {
    rmSync(join(dir, 'muse-code-oauth-models.json'), { force: true });
  }
});

test('a roster storing flat reasoningLevels exposes its ladder on both paths', async () => {
  const row = { id: 'gemini-registry-flash', reasoningLevels: ['low', 'medium', 'high'] };
  writeFileSync(join(dir, 'antigravity-oauth-models.json'), JSON.stringify({ fetchedAt: Date.now(), models: [row] }));
  try {
    const sync = catalog.getModelMetadataSync(row.id, 'antigravity-oauth');
    assert.deepEqual(effortValues(sync), ['low', 'medium', 'high']);
    const [listed] = await catalog.enrichModels([{ ...row, provider: 'antigravity-oauth' }], {
      fetchFn: injectedFetch,
    });
    assert.deepEqual(effortValues(listed), ['low', 'medium', 'high']);
  } finally {
    rmSync(join(dir, 'antigravity-oauth-models.json'), { force: true });
  }
});

test('explicit-false capabilities from a same-endpoint catalog row survive the seed', async () => {
  for (const [path, meta] of Object.entries(await bothPaths('muse-code-oauth', 'muse-spark-1.1'))) {
    assert.equal(meta.supportsVision, false, path);
    assert.equal(meta.supportsReasoning, false, path);
    assert.equal(meta.supportsFunctionCalling, false, path);
    assert.deepEqual(effortValues(meta), [], `${path}: no seeded ladder for a non-reasoning model`);
    assert.equal(meta.contextWindow, 400000, path);
    // Absent fields are still seed-filled.
    assert.equal(meta.outputTokens, 131072, path);
  }
});

test('a live roster false is a coerced unknown: catalogs and seeds still decide it', () => {
  writeFileSync(
    join(dir, 'muse-code-oauth-models.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      models: [
        { id: 'muse-spark-1.2', supportsVision: false, supportsReasoning: false },
        { id: 'muse-spark-1.3', supportsVision: false, supportsReasoning: false },
      ],
    })
  );
  try {
    const seeded = catalog.getModelMetadataSync('muse-spark-1.2', 'muse-code-oauth');
    assert.equal(seeded.supportsVision, true);
    assert.equal(seeded.supportsReasoning, true);
    assert.equal(seeded.supportsFunctionCalling, true);
    assert.equal(seeded.contextWindow, 1048576);

    // models.dev `meta` declares vision and a six-level ladder for 1.3.
    const fetched = catalog.getModelMetadataSync('muse-spark-1.3', 'muse-code-oauth');
    assert.equal(fetched.supportsVision, true);
    assert.equal(fetched.supportsReasoning, true);
    assert.ok(effortValues(fetched).includes('max'));
  } finally {
    rmSync(join(dir, 'muse-code-oauth-models.json'), { force: true });
  }
});

test('a relay’s own row wins; the serving vendor fills only its undeclared ladder and capabilities', async () => {
  // Own row declares reasoning but no ladder: the vendor ladder fills it,
  // own pricing stays and no vendor limit is borrowed.
  for (const [path, meta] of Object.entries(await bothPaths('opencode-go-oauth', 'kimi-registry-code'))) {
    assert.deepEqual(effortValues(meta), ['low', 'high'], path);
    assert.equal(meta.supportsFunctionCalling, true, path);
    assert.equal(meta.inputCostPerM, 0.5, path);
    assert.equal(meta.contextWindow, null, path);
  }
  // Own non-effort options stay; the vendor's effort entry joins them.
  for (const [path, meta] of Object.entries(await bothPaths('opencode-go-oauth', 'qwen9.9-registry'))) {
    assert.deepEqual(effortValues(meta), ['low', 'medium', 'high'], path);
    assert.ok(
      meta.reasoningOptions.some((o) => o.type === 'toggle'),
      path
    );
    assert.equal(meta.contextWindow, 131072, path);
  }
  // No vendor ladder identifiable: none, and no blanket fallback.
  for (const [path, meta] of Object.entries(await bothPaths('opencode-go-oauth', 'longcat-registry-2'))) {
    assert.deepEqual(effortValues(meta), [], path);
  }
  // Own explicit falses beat the vendor's trues.
  for (const [path, meta] of Object.entries(await bothPaths('opencode-go-oauth', 'kimi-registry-lite'))) {
    assert.equal(meta.supportsReasoning, false, path);
    assert.equal(meta.supportsVision, false, path);
    assert.equal(meta.supportsFunctionCalling, false, path);
    assert.deepEqual(effortValues(meta), [], path);
  }
});

test('MiMo OAuth: a coerced roster false is filled from the xiaomi row; roster limits stay', async () => {
  writeFileSync(
    join(dir, 'mimo-oauth-models.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      models: [{ id: 'mimo-registry-pro', contextWindow: 262144, supportsFunctionCalling: false }],
    })
  );
  try {
    for (const [path, meta] of Object.entries(await bothPaths('mimo-oauth', 'mimo-registry-pro'))) {
      assert.equal(meta.supportsFunctionCalling, true, path);
      assert.equal(meta.supportsReasoning, true, path);
      assert.equal(meta.contextWindow, 262144, path);
      assert.equal(meta.outputTokens, null, path);
      assert.equal(meta.inputCostPerM, 1, path);
    }
  } finally {
    rmSync(join(dir, 'mimo-oauth-models.json'), { force: true });
  }
});

test('Antigravity keeps its roster ladder (empty included) and never borrows vendor web search', async () => {
  writeFileSync(
    join(dir, 'antigravity-oauth-models.json'),
    JSON.stringify({
      fetchedAt: Date.now(),
      models: [
        { id: 'claude-registry-1', supportsReasoning: true, supportsVision: false, reasoningLevels: [] },
        { id: 'gemini-registry-pro', supportsReasoning: true, reasoningLevels: ['low', 'high'] },
      ],
    })
  );
  try {
    for (const [path, meta] of Object.entries(await bothPaths('antigravity-oauth', 'claude-registry-1'))) {
      assert.deepEqual(effortValues(meta), [], `${path}: no effort surface on this route`);
      assert.equal(meta.supportsWebSearch ?? null, null, path);
      assert.equal(meta.supportsVision, true, path);
      assert.equal(meta.inputCostPerM, 3, path);
    }
    for (const [path, meta] of Object.entries(await bothPaths('antigravity-oauth', 'gemini-registry-pro'))) {
      assert.deepEqual(effortValues(meta), ['low', 'high'], `${path}: the roster’s own ladder`);
      assert.equal(meta.supportsWebSearch ?? null, null, path);
      assert.equal(meta.supportsFunctionCalling, true, path);
      assert.equal(meta.contextWindow, null, path);
    }
  } finally {
    rmSync(join(dir, 'antigravity-oauth-models.json'), { force: true });
  }
});

test('a custom provider guesses capabilities and ladder from the vendor, never limits or prices', async () => {
  const sync = catalog.getModelMetadataSync('claude-registry-1', 'custom-registry');
  const [listed] = await catalog.enrichModels(
    [{ id: 'anthropic/claude-registry-1', provider: 'custom-registry', contextWindow: 32000 }],
    { fetchFn: injectedFetch }
  );
  for (const [path, meta] of Object.entries({ sync, listed })) {
    assert.deepEqual(effortValues(meta), ['low', 'high', 'max'], path);
    assert.equal(meta.supportsVision, true, path);
    assert.equal(meta.supportsWebSearch, true, path);
    assert.equal(meta.inputCostPerM == null, true, path);
  }
  assert.equal(sync.contextWindow, undefined);
  assert.equal(listed.contextWindow, 32000);
});
