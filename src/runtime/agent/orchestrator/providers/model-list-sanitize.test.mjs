import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeModelList } from './model-list-sanitize.mjs';

// Dates derive from now so the 9-month absolute cut cannot age fixtures.
const monthsAgo = (n) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
};

const catalog = (provider, models) => ({
  [provider]: {
    models: Object.fromEntries(
      Object.entries(models).map(([id, [family, months, extra = {}]]) => [
        id,
        { family, release_date: monthsAgo(months), tool_call: true, name: id, ...extra },
      ])
    ),
  },
});

const rows = (provider, ids) => ids.map((id) => ({ id, provider, mode: 'chat' }));
const keptIds = (provider, ids, models) =>
  sanitizeModelList(rows(provider, ids), { provider, _testCatalog: catalog(provider, models) }).map((r) => r.id);

test('rolling aliases survive newer concrete versions and the age cut; stable supersession still applies', () => {
  const models = {
    '~google/gemini-flash-latest': ['gemini-flash', 4],
    '~anthropic/claude-opus-latest': ['claude-opus', 30],
    'google/gemini-3.5-flash': ['gemini-flash', 3],
    'google/gemini-3.7-flash': ['gemini-flash', 2],
    'google/gemini-3.8-flash': ['gemini-flash', 1],
    'anthropic/claude-opus-5': ['claude-opus', 1],
  };
  assert.deepEqual(keptIds('openrouter', Object.keys(models), models), [
    '~google/gemini-flash-latest',
    '~anthropic/claude-opus-latest',
    'google/gemini-3.8-flash',
    'anthropic/claude-opus-5',
  ]);
});

test('provider-native old -latest aliases are not aged out or superseded', () => {
  const models = {
    'mistral-large-latest': ['mistral-large', 24],
    'codestral-latest': ['codestral', 24],
    'mistral-large-4': ['mistral-large', 1],
    'codestral-2508': ['codestral', 2],
    'mistral-small-2603': ['mistral-small', 2],
  };
  assert.deepEqual(keptIds('mistral', Object.keys(models), models), [
    'mistral-large-latest',
    'codestral-latest',
    'mistral-large-4',
    'codestral-2508',
    'mistral-small-2603',
  ]);
});

test('a newer alias date never supersedes an older concrete version', () => {
  const models = {
    'vendor/x-1': ['x', 5],
    '~vendor/x-latest': ['x', 1],
    'vendor/y-1': ['y', 5],
    'vendor/y-2': ['y', 3],
  };
  assert.deepEqual(keptIds('openrouter', Object.keys(models), models), [
    'vendor/x-1',
    '~vendor/x-latest',
    'vendor/y-2',
  ]);
});

test('stable models survive newer preview/experimental variants of the same family', () => {
  const models = {
    hy3: ['Hy', 3, { name: 'Hy3' }],
    'hy4-preview': ['Hy', 1, { name: 'Hy4 preview' }],
    'longcat-2.0': ['longcat', 3, { name: 'LongCat-2.0' }],
    'longcat-2.5-preview-free': ['longcat', 1, { name: 'LongCat 2.5 Preview Free' }],
    'vision-1': ['vision', 3],
    'vision-2-exp': ['vision', 1],
    'deepseek-v4-flash': ['deepseek-flash', 4],
    'deepseek-v4-flash-vision-exp': ['deepseek-flash', 2],
    'deepseek-v4.1-flash': ['deepseek-flash', 1],
    'glm-5.2': ['glm', 3],
    'glm-5.3': ['glm', 1],
  };
  assert.deepEqual(keptIds('opencode-go', Object.keys(models), models), [
    'hy3',
    'hy4-preview',
    'longcat-2.0',
    'longcat-2.5-preview-free',
    'vision-1',
    'vision-2-exp',
    'deepseek-v4.1-flash',
    'glm-5.3',
  ]);
});

test('preview rows are still superseded by newer previews and stable models', () => {
  const models = {
    'q-1-preview': ['q', 4],
    'q-2-preview': ['q', 2],
    'r-1-preview': ['r', 3],
    'r-2': ['r', 1],
  };
  assert.deepEqual(keptIds('opencode-go', Object.keys(models), models), ['q-2-preview', 'r-2']);
});

test('display labels do not turn stable model IDs into preview variants', () => {
  const models = {
    'model-1': ['model', 3],
    'model-2': ['model', 1, { name: 'Model 2 with image preview support' }],
  };
  assert.deepEqual(keptIds('opencode-go', Object.keys(models), models), ['model-2']);
});

test('batch, non-chat, non-tool, legacy and dated duplicates are still excluded on hosted providers', () => {
  const models = {
    'gpt-5.5': ['gpt', 1],
    'gpt-5.5:batch': ['gpt', 1],
    'sonar-lite': ['sonar', 1, { tool_call: false }],
    'gpt-4o': ['gpt-4', 1],
    'text-embedding-3-large': ['embed', 1],
  };
  // The search-preview SKU and the dated snapshot have no catalog row, so the
  // id-level fallback and the canonical dedupe are what exclude them.
  const ids = [...Object.keys(models), 'gpt-search-preview', 'gpt-5.5-2026-01-01'];
  assert.deepEqual(keptIds('openai', ids, models), ['gpt-5.5']);
});

test('unknown providers only drop non-chat modes', () => {
  const list = [
    { id: 'foo-latest', mode: 'chat' },
    { id: 'foo:batch' },
    { id: 'gpt-4o' },
    { id: 'embedder', mode: 'embedding' },
  ];
  assert.deepEqual(
    sanitizeModelList(list, { provider: 'my-local' }).map((r) => r.id),
    ['foo-latest', 'foo:batch', 'gpt-4o']
  );
});
