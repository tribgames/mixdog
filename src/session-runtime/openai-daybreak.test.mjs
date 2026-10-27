import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// One catalog for the whole file: the provider's in-memory mirror is read once.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-daybreak-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const [
  { _normalizeCodexModel },
  { makeModelCache },
  { OpenAIOAuthProvider, buildRequestBody },
  { hydrateProviderModelRow },
  { providerModelCacheRow },
  daybreak,
  { routeModelLabel, agentModelProfile },
  store,
] = await Promise.all([
  import('../runtime/agent/orchestrator/providers/openai-codex-model.mjs'),
  import('../runtime/agent/orchestrator/providers/model-cache.mjs'),
  import('../runtime/agent/orchestrator/providers/openai-oauth.mjs'),
  import('./provider-models/row-hydration.mjs'),
  import('./model-recency.mjs'),
  import('../runtime/shared/llm/openai-daybreak.mjs'),
  import('../tui/app/model-options.mjs'),
  import('../runtime/agent/orchestrator/providers/openai-oauth-catalog-store.mjs'),
]);

// Shaped like the live /models answer: `available_access_programs.cyber`
// carries the capability, `visibility` and `upgrade` the lifecycle.
const blue = { available_access_programs: { cyber: ['standard', 'daybreak_blue'] } };
const standardOnly = { available_access_programs: { cyber: ['standard'] } };
const catalog = [
  { slug: 'gpt-6.1-sol', priority: 1, visibility: 'list', ...standardOnly },
  { slug: 'gpt-6-astra', priority: 2, visibility: 'list', ...standardOnly },
  { slug: 'gpt-6-sol', priority: 3, visibility: 'list', ...blue },
  { slug: 'gpt-6-luna', priority: 4, visibility: 'list', ...blue },
  { slug: 'gpt-5.6-sol', priority: 5, visibility: 'list', ...blue },
  { slug: 'gpt-5.6-terra', priority: 8, visibility: 'list', ...blue },
  { slug: 'gpt-5.6-luna', priority: 9, visibility: 'list', ...blue },
  // A standalone program variant, still listed by the server.
  {
    slug: 'gpt-daybreak-blue-latest',
    priority: 11,
    visibility: 'list',
    model_specialty: 'cyber',
    available_access_programs: { cyber: ['daybreak_blue'] },
  },
  {
    slug: 'gpt-5.5',
    priority: 13,
    visibility: 'hide',
    ...blue,
    upgrade: { model: 'gpt-6.1-sol', retirement_at: '2026-10-14T19:00:00Z' },
  },
  // No access-program data at all: only the static fallback can answer.
  { slug: 'gpt-6-luna-nodata', priority: 20 },
];
makeModelCache({ fileName: 'openai-oauth-models.json', version: 7, ttlMs: 60_000 }).save(
  catalog.map(_normalizeCodexModel)
);

const SUPPORTED = ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const UNSUPPORTED = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna-nodata', 'unknown-model'];
const messages = [{ role: 'user', content: 'Daybreak wire check' }];
const on = { modelParameters: { daybreak: 'on' } };

test('the Responses request carries the Blue access program only when on and supported', () => {
  for (const model of SUPPORTED) {
    const body = buildRequestBody(messages, model, [], on);
    assert.deepEqual(body.access_programs, { cyber: 'daybreak_blue' }, model);
    // The selection rides after the text controls, never ahead of routing fields.
    const keys = Object.keys(body);
    assert.ok(keys.indexOf('access_programs') > keys.indexOf('text'), model);
    assert.equal(Object.hasOwn(buildRequestBody(messages, model, [], {}), 'access_programs'), false, model);
    assert.equal(
      Object.hasOwn(buildRequestBody(messages, model, [], { modelParameters: { daybreak: 'off' } }), 'access_programs'),
      false,
      model
    );
  }
  for (const model of UNSUPPORTED) {
    assert.equal(Object.hasOwn(buildRequestBody(messages, model, [], on), 'access_programs'), false, model);
  }
  // The public API route never forwards it.
  const direct = buildRequestBody(messages, 'gpt-6-sol', [], { ...on, promptCacheProvider: 'openai' });
  assert.equal(Object.hasOwn(direct, 'access_programs'), false);
});

test('the picker hides the retired Blue model and offers the toggle only on Blue models', async () => {
  const provider = Object.create(OpenAIOAuthProvider.prototype);
  provider.ensureAuth = async () => {
    throw new Error('offline');
  };
  const previousQuiet = process.stderr.write;
  process.stderr.write = () => true;
  let listed;
  try {
    listed = await provider.listModels();
  } finally {
    process.stderr.write = previousQuiet;
  }
  const rows = listed.map((model) =>
    hydrateProviderModelRow(
      {},
      providerModelCacheRow('openai-oauth', model, () => false)
    )
  );
  // Metadata keeps resolving for saved routes; the pickers drop hidden rows.
  const hidden = rows.filter((row) => row.hidden === true).map((row) => row.id);
  assert.deepEqual(hidden.sort(), ['gpt-5.5', 'gpt-daybreak-blue-latest']);
  const offersBlue = (id) =>
    (rows.find((row) => row.id === id).modelParameterOptions || []).some((option) => option.id === 'daybreak');
  for (const id of SUPPORTED) assert.equal(offersBlue(id), true, id);
  for (const id of UNSUPPORTED.filter((id) => id !== 'unknown-model')) assert.equal(offersBlue(id), false, id);
  const option = rows.find((row) => row.id === 'gpt-6-sol').modelParameterOptions.find((o) => o.id === 'daybreak');
  assert.deepEqual(
    option.options.map((entry) => entry.value),
    ['off', 'on']
  );
});

test('catalog successors: program variants move to the first Blue model, retired models to their upgrade', () => {
  const models = catalog.map(_normalizeCodexModel);
  assert.deepEqual(store.codexModelSuccessor(models, 'gpt-daybreak-blue-latest'), {
    model: 'gpt-6-sol',
    modelParameters: { daybreak: 'on' },
  });
  const beforeRetirement = Date.parse('2026-10-14T18:59:59Z');
  const afterRetirement = Date.parse('2026-10-14T19:00:00Z');
  assert.equal(store.codexModelSuccessor(models, 'gpt-5.5', beforeRetirement), null);
  assert.deepEqual(store.codexModelSuccessor(models, 'gpt-5.5', afterRetirement), { model: 'gpt-6.1-sol' });
  for (const id of ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna-nodata', 'unknown-model']) {
    assert.equal(store.codexModelSuccessor(models, id, afterRetirement), null, id);
  }
  // Without catalog data nothing is superseded.
  assert.equal(store.codexModelSuccessor(null, 'gpt-daybreak-blue-latest'), null);

  const migrated = store.migrateCodexRoute(
    { provider: 'openai-oauth', model: 'gpt-daybreak-blue-latest', effort: 'xhigh', modelParameters: {} },
    models
  );
  assert.deepEqual(migrated, {
    provider: 'openai-oauth',
    model: 'gpt-6-sol',
    effort: 'xhigh',
    modelParameters: { daybreak: 'on' },
  });
  const foreign = { provider: 'openrouter', model: 'gpt-daybreak-blue-latest' };
  assert.equal(store.migrateCodexRoute(foreign, models), foreign);

  // Schedule / webhook model refs follow the same rule.
  assert.equal(
    store.migrateCodexModelRef('openai-oauth/gpt-daybreak-blue-latest@xhigh+fast', models),
    'openai-oauth/gpt-6-sol@xhigh+fast?daybreak=on'
  );
  for (const ref of ['openai-oauth/gpt-6-luna@high', 'nightly-preset', 'openrouter/gpt-daybreak-blue-latest']) {
    assert.equal(store.migrateCodexModelRef(ref, models), ref);
  }
});

test('capability: only the catalog list decides; no id is special', () => {
  assert.equal(daybreak.daybreakBlueSupported({ id: 'gpt-6-sol', accessPrograms: ['standard'] }), false);
  assert.equal(daybreak.daybreakBlueSupported({ id: 'gpt-6-sol', accessPrograms: [] }), false);
  assert.equal(daybreak.daybreakBlueSupported({ id: 'future', accessPrograms: ['daybreak_blue'] }), true);
  assert.equal(daybreak.daybreakBlueSupported({ id: 'gpt-5.6-sol' }), false);
  assert.equal(
    daybreak.daybreakBlueSupported({ id: 'gpt-9-future', accessPrograms: ['standard', 'daybreak_blue'] }),
    true
  );
  assert.equal(daybreak.daybreakBlueSupported('gpt-6-astra'), false);
});

test('TUI route labels show Blue next to the model', () => {
  const route = {
    provider: 'openai-oauth',
    model: 'gpt-6-sol',
    modelDisplay: 'GPT-6 Sol',
    effort: 'xhigh',
    modelParameters: { daybreak: 'on' },
  };
  // The model's own display name (whatever its casing rule), then Blue, then effort.
  assert.match(routeModelLabel(route), /^GPT-6.Sol Blue · XHigh$/);
  assert.match(agentModelProfile({ ...route, modelParameters: { daybreak: 'off' } }), /^GPT-6.Sol · XHigh$/);
});
