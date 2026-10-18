import assert from 'node:assert/strict';
import test from 'node:test';

const { autoHiddenModelKeys, customModelHiddenFlags, listedModels, modelPreferenceChanges, orderModelsByRecency } =
  await import('./model-visibility.ts');

const option = (provider, model, extra = {}) => ({
  provider,
  model,
  display: model,
  effortOptions: [],
  fastCapable: false,
  fastPreferred: false,
  ...extra,
});
const keys = (models) => models.map((entry) => `${entry.provider}:${entry.model}`);

// Anthropic keeps one Sonnet: the older one is left out of /model by default.
const catalog = orderModelsByRecency([
  option('anthropic', 'claude-sonnet-4-5'),
  option('anthropic', 'claude-sonnet-5'),
  option('openai', 'gpt-5.4'),
]);

test('the family limit auto-hides older models; every other model is listed by default', () => {
  assert.deepEqual([...autoHiddenModelKeys(catalog)], ['anthropic:claude-sonnet-4-5']);
  assert.deepEqual(keys(listedModels(catalog, catalog, null)), ['anthropic:claude-sonnet-5', 'openai:gpt-5.4']);
});

test('a model the server newly reports is listed unless the user unchecked it', () => {
  const grown = orderModelsByRecency([...catalog, option('openai', 'gpt-5.5')]);
  assert.ok(keys(listedModels(grown, grown, null)).includes('openai:gpt-5.5'));
  const unchecked = grown.map((entry) => (entry.model === 'gpt-5.5' ? { ...entry, savedHidden: true } : entry));
  assert.ok(!keys(listedModels(unchecked, unchecked, null)).includes('openai:gpt-5.5'));
});

test('an explicit choice wins over the family limit both ways', () => {
  const chosen = catalog.map((entry) => {
    if (entry.model === 'claude-sonnet-4-5') return { ...entry, savedHidden: false };
    if (entry.model === 'claude-sonnet-5') return { ...entry, savedHidden: true };
    return entry;
  });
  assert.deepEqual(keys(listedModels(chosen, chosen, null)), ['anthropic:claude-sonnet-4-5', 'openai:gpt-5.4']);
});

test("a custom provider's own hidden overrides decide its visibility", () => {
  const setup = {
    api: [
      {
        id: 'custom-1',
        custom: true,
        modelOverrides: { kept: { hidden: false }, gone: { hidden: true }, named: { name: 'x' } },
      },
      { id: 'openai', modelOverrides: { 'gpt-5.4': { hidden: true } } },
    ],
  };
  const flags = customModelHiddenFlags(setup);
  assert.deepEqual(Object.fromEntries(flags), { 'custom-1:kept': false, 'custom-1:gone': true });
  const rows = [option('custom-1', 'kept'), option('custom-1', 'gone'), option('openai', 'gpt-5.4')];
  assert.deepEqual(keys(listedModels(rows, rows, setup)), ['custom-1:kept', 'openai:gpt-5.4']);
});

test('pending card edits report only changed fields, one entry per model', () => {
  const saved = new Map([
    ['a', { shown: true, favorite: false }],
    ['b', { shown: false, favorite: true }],
    ['c', { shown: true, favorite: false }],
  ]);
  const draft = new Map([
    ['a', { shown: false, favorite: true }],
    ['b', { shown: false, favorite: true }],
    ['c', { shown: true, favorite: true }],
  ]);
  assert.deepEqual(modelPreferenceChanges(saved, draft), [
    { model: 'a', hidden: true, favorite: true },
    { model: 'c', favorite: true },
  ]);
  assert.deepEqual(modelPreferenceChanges(saved, saved), []);
});
