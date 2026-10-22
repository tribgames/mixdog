import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCatalogFailureItems,
  buildModelProviderItems,
  catalogProviderDisplayNames,
  loadProviderCatalogFailures,
  loadProviderDisplayNames,
  providerDisplayName,
  resolveProviderDisplayName,
  routeLabel,
} from './model-options.mjs';

const CUSTOM_ID = 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7';

const models = [
  { provider: 'openai', id: 'gpt-x', display: 'GPT X' },
  { provider: CUSTOM_ID, id: 'my-model', display: 'My Model' },
];

test('provider list falls back to the raw id without setup names', () => {
  const items = buildModelProviderItems(models, null);
  assert.equal(items.find((item) => item._provider === CUSTOM_ID).label, CUSTOM_ID);
});

test('provider list shows the setup-given name for custom providers', () => {
  const items = buildModelProviderItems(models, null, { [CUSTOM_ID]: '내 AI' });
  assert.equal(items.find((item) => item._provider === CUSTOM_ID).label, '내 AI');
  assert.equal(items.find((item) => item._provider === 'openai').label, providerDisplayName('openai'));
});

test('row providerName names a custom provider when setup is missing; setup still wins', async () => {
  const rows = [
    { provider: 'openai', id: 'gpt-x', providerName: 'Spoof' },
    { provider: CUSTOM_ID, id: 'my-model', providerName: 'Gateway' },
  ];
  const setupNames = await loadProviderDisplayNames({});
  const names = catalogProviderDisplayNames(rows, setupNames);
  const items = buildModelProviderItems(rows, null, names);
  assert.equal(items.find((item) => item._provider === CUSTOM_ID).label, 'Gateway');
  assert.equal(items.find((item) => item._provider === 'openai').label, providerDisplayName('openai'));
  assert.equal(catalogProviderDisplayNames(rows, { [CUSTOM_ID]: '내 AI' })[CUSTOM_ID], '내 AI');
  assert.equal(catalogProviderDisplayNames([{ provider: CUSTOM_ID, id: 'm' }])[CUSTOM_ID], undefined);
});

test('routeLabel names a custom provider by its setup name, built-ins by their label', () => {
  const names = { [CUSTOM_ID]: '내 AI' };
  assert.equal(routeLabel({ provider: CUSTOM_ID, model: 'my-model' }, names).split(' · ')[0], '내 AI');
  assert.equal(routeLabel({ provider: CUSTOM_ID, model: 'my-model' }).split(' · ')[0], CUSTOM_ID);
  assert.equal(
    routeLabel({ provider: 'openai', model: 'gpt-x' }, names).split(' · ')[0],
    providerDisplayName('openai')
  );
});

test('resolveProviderDisplayName prefers setup names', () => {
  assert.equal(resolveProviderDisplayName(CUSTOM_ID, { [CUSTOM_ID]: '내 AI' }), '내 AI');
  assert.equal(resolveProviderDisplayName(CUSTOM_ID, null), CUSTOM_ID);
  assert.equal(resolveProviderDisplayName('openai', {}), providerDisplayName('openai'));
  assert.equal(resolveProviderDisplayName('openai', { openai: 'Mine' }), providerDisplayName('openai'));
});

test('a provider whose model list failed gets a row that says why; one with models does not', async () => {
  const setup = {
    api: [
      {
        id: 'opencode-go',
        catalogError: {
          message: 'opencode-go models 401: This API key has expired.',
          errorKind: { kind: 'auth', code: 'api_key_expired', status: 401 },
        },
      },
      { id: 'openai', catalogError: { message: 'openai models 500', errorKind: { kind: 'transient', status: 500 } } },
      { id: 'xai' },
    ],
    oauth: [],
    local: [],
  };
  const failures = await loadProviderCatalogFailures({ getProviderSetup: async () => setup });
  assert.deepEqual(
    failures.map((failure) => failure.id),
    ['opencode-go', 'openai']
  );
  assert.equal(failures[0].text, 'Provider authentication failed Check your sign-in or API key, then try again.');
  const items = buildCatalogFailureItems(failures, models);
  assert.deepEqual(
    items.map((item) => [item.label, item._failure]),
    [[providerDisplayName('opencode-go'), failures[0].text]]
  );
  assert.deepEqual(await loadProviderCatalogFailures({}), []);
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
