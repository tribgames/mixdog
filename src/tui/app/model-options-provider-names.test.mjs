import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelProviderItems,
  loadProviderDisplayNames,
  providerDisplayName,
  resolveProviderDisplayName,
} from './model-options.mjs';

const CUSTOM_ID = 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7';

const models = [
  { provider: 'openai', id: 'gpt-x', display: 'GPT X' },
  { provider: CUSTOM_ID, id: 'my-model', display: 'My Model' },
];

test('provider list falls back to the raw id without setup names', () => {
  const items = buildModelProviderItems(models, null);
  assert.equal(
    items.find((item) => item._provider === CUSTOM_ID).label,
    CUSTOM_ID
  );
});

test('provider list shows the setup-given name for custom providers', () => {
  const items = buildModelProviderItems(models, null, { [CUSTOM_ID]: '내 AI' });
  assert.equal(items.find((item) => item._provider === CUSTOM_ID).label, '내 AI');
  assert.equal(items.find((item) => item._provider === 'openai').label, providerDisplayName('openai'));
});

test('resolveProviderDisplayName prefers setup names', () => {
  assert.equal(resolveProviderDisplayName(CUSTOM_ID, { [CUSTOM_ID]: '내 AI' }), '내 AI');
  assert.equal(resolveProviderDisplayName(CUSTOM_ID, null), CUSTOM_ID);
  assert.equal(resolveProviderDisplayName('openai', {}), providerDisplayName('openai'));
});

test('loadProviderDisplayNames reads setup rows best-effort', async () => {
  const store = {
    getProviderSetup: async () => ({
      api: [{ id: CUSTOM_ID, name: '내 AI' }],
      oauth: [],
      local: [],
    }),
  };
  assert.deepEqual(await loadProviderDisplayNames(store), { [CUSTOM_ID]: '내 AI' });
  assert.deepEqual(await loadProviderDisplayNames({}), {});
  assert.deepEqual(await loadProviderDisplayNames(null), {});
  assert.deepEqual(
    await loadProviderDisplayNames({
      getProviderSetup: async () => {
        throw new Error('down');
      },
    }),
    {}
  );
});
