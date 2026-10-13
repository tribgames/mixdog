import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createProviderModels } from './provider-models.mjs';
import { createProviderReadiness } from './provider-readiness.mjs';

function deferred() {
  return Promise.withResolvers();
}

let nextRevision = 100;
function catalogFixture() {
  let revision = nextRevision;
  nextRevision += 100;
  let preparations = 0;
  const requests = [];
  const provider = {
    listModels() {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  };
  const registry = {
    providerCatalogRevision: () => revision,
    getAllProviders: () => new Map([['fixture', provider]]),
    getProvider: () => provider,
  };
  function consumer() {
    return createProviderModels({
      caches: {
        providerModelsLoadSeq: 0,
        providerModelsCache: { models: null, at: 0 },
        providerModelsPromise: null,
        webSearchProviderModelsCache: { models: null, at: 0 },
      },
      modelMetaByRoute: new Map(),
      getRoute: () => ({ provider: 'fixture' }),
      getConfig: () => ({ providers: { fixture: { enabled: true } } }),
      getReg: () => registry,
      webSearchCapableFor: () => false,
      sortProviderModelsRaw: (models) => models,
      providerModelCacheRowRaw: (name, model) => ({ ...model, provider: name }),
      ensureFullConfig: () => ({}),
      awaitKeychainPrewarm: async () => {},
      ensureProvidersReady: async () => {
        preparations += 1;
      },
      bootProfile() {},
      scheduleProviderModelWarmup() {},
      quickHelpers: {},
    });
  }
  return {
    consumer,
    requests,
    registry,
    advance: () => {
      revision += 1;
    },
    preparations: () => preparations,
  };
}

function model(label) {
  return [{ id: 'chat-model', display: label }];
}

for (const mode of ['foreground', 'forced', 'warmup']) {
  test(`a failed ${mode} catalog remains retryable in both shared and session caches`, async () => {
    const f = catalogFixture();
    const api = f.consumer();
    const first =
      mode === 'warmup'
        ? api.warmProviderModelCache({ loadSecrets: true })
        : api.collectProviderModels({ force: mode === 'forced' });
    await setImmediate();
    f.requests[0].reject(new Error('temporary catalog failure'));
    assert.deepEqual(await first, []);
    const next = api.collectProviderModels();
    await setImmediate();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve(model('recovered'));
    assert.equal((await next)[0].display, 'recovered');
    assert.equal((await f.consumer().collectProviderModels())[0].display, 'recovered');
    assert.equal((await api.collectProviderModels())[0].display, 'recovered');
    assert.equal(f.requests.length, 2);
  });
}

test('partial catalogs expose healthy providers without caching a failed provider as absent', async () => {
  const f = catalogFixture();
  const getProviders = f.registry.getAllProviders;
  f.registry.getAllProviders = () =>
    new Map([...getProviders(), ['healthy', { listModels: async () => [{ id: 'healthy-model' }] }]]);
  const api = f.consumer();
  const first = api.collectProviderModels();
  await setImmediate();
  f.requests[0].reject(new Error('temporary catalog failure'));
  assert.deepEqual(
    (await first).map((row) => row.id),
    ['healthy-model']
  );
  const next = api.collectProviderModels();
  await setImmediate();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(model('recovered'));
  assert.deepEqual((await next).map((row) => row.id).sort(), ['chat-model', 'healthy-model']);
});

test('a failed metadata lookup does not pin its fallback as authoritative', async () => {
  const f = catalogFixture();
  const api = f.consumer();
  const first = api.lookupModelMeta('fixture', 'chat-model', { allowFetch: true });
  f.requests[0].reject(new Error('temporary metadata failure'));
  assert.deepEqual(await first, { id: 'chat-model', provider: 'fixture' });
  const next = api.lookupModelMeta('fixture', 'chat-model', { allowFetch: true });
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(model('recovered'));
  assert.equal((await next).display, 'recovered');
});

for (const mode of ['catalog', 'metadata']) {
  test(`late ${mode} completion cannot overwrite newer shared rows or route metadata`, async () => {
    const f = catalogFixture();
    const api = f.consumer();
    const first =
      mode === 'catalog'
        ? api.collectProviderModels()
        : api.lookupModelMeta('fixture', 'chat-model', { allowFetch: true });
    await setImmediate();
    f.advance();
    const second = api.collectProviderModels();
    await setImmediate();
    f.requests[1].resolve(model('new'));
    await second;
    f.requests[0].resolve(model('old'));
    await first;
    assert.equal((await api.lookupModelMeta('fixture', 'chat-model')).display, 'new');
    assert.equal((await f.consumer().collectProviderModels())[0].display, 'new');
  });
}

for (const mode of ['foreground', 'warmup']) {
  test(`an old ${mode} completion cannot retire the newer in-flight catalog request`, async () => {
    const f = catalogFixture();
    const api = f.consumer();
    const start = () =>
      mode === 'warmup' ? api.warmProviderModelCache({ loadSecrets: true }) : api.collectProviderModels();
    const first = start();
    await setImmediate();
    f.advance();
    const second = start();
    await setImmediate();
    f.requests[0].resolve(model('old'));
    await first;
    const joined = api.collectProviderModels();
    await setImmediate();
    f.requests[1].resolve(model('new'));
    await second;
    const rows = await joined;
    assert.equal(rows[0].display, 'new');
    assert.equal(f.preparations(), 2);
  });
}

test('a catalog fetched across a revision change is not relabeled as current', async () => {
  const f = catalogFixture();
  const api = f.consumer();
  const first = api.collectProviderModels();
  await setImmediate();
  f.advance();
  f.requests[0].resolve(model('old'));
  await first;
  const next = api.collectProviderModels();
  await setImmediate();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(model('new'));
  assert.equal((await next)[0].display, 'new');
});

for (const mode of ['foreground', 'forced', 'warmup']) {
  test(`a ${mode} load retains fresh rows when its own preparation advances the catalog revision`, async () => {
    const f = catalogFixture();
    f.registry.refreshCatalogs = async () => {
      f.advance();
    };
    f.registry.refreshProviderCatalogsOnStartup = async () => {
      f.advance();
    };
    const api = f.consumer();
    const first =
      mode === 'warmup'
        ? api.warmProviderModelCache({ loadSecrets: true })
        : api.collectProviderModels({ force: mode === 'forced' });
    await setImmediate();
    f.requests[0].resolve(model('fresh'));
    await first;
    const next = api.collectProviderModels();
    await setImmediate();
    for (const request of f.requests) request.resolve(model('fresh'));
    assert.equal((await next)[0].display, 'fresh');
    assert.equal(f.preparations(), 1, 'the next read must use the freshly populated cache');
    assert.equal(f.requests.length, 1);
  });
}

test('provider readiness cannot initialize providers after its runtime closes during keychain readiness', async () => {
  const keychain = deferred();
  const rt = { config: { providers: {} }, closeRequested: false };
  let initialized = 0;
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets: () => keychain.promise },
    getReg: () => ({
      initProviders: async () => {
        initialized += 1;
      },
    }),
    getWarmProviderModelCache: () => () => {},
  });
  const started = readiness.ensureProvidersReady();
  rt.closeRequested = true;
  keychain.resolve();
  await assert.rejects(started, /runtime is closing/);
  assert.equal(initialized, 0);
});

test('startup catalog refresh cannot launch another warmup after runtime closure', async () => {
  const refresh = deferred();
  const rt = { config: { providers: {} }, closeRequested: false };
  let warmed = 0;
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets: async () => {} },
    getReg: () => ({
      initProviders: async () => {},
      refreshProviderCatalogsOnStartup: () => refresh.promise,
    }),
    getWarmProviderModelCache: () => () => {
      warmed += 1;
    },
  });
  await readiness.ensureProvidersReady();
  rt.closeRequested = true;
  refresh.resolve();
  await setImmediate();
  assert.equal(warmed, 0);
  assert.equal(rt.startupProviderCatalogRefreshPending, false);
});

test('provider set change re-runs the catalog refresh completion once per new promise', async () => {
  const a = deferred();
  const b = deferred();
  const rt = { config: { providers: {} }, closeRequested: false };
  let current = a.promise;
  let warmed = 0;
  const warmArgs = [];
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets: async () => {} },
    getReg: () => ({
      initProviders: async () => {},
      refreshProviderCatalogsOnStartup: () => current,
    }),
    getWarmProviderModelCache: () => (arg) => {
      warmed += 1;
      warmArgs.push(arg);
    },
  });
  await readiness.ensureProvidersReady({ x: { enabled: true } });
  assert.equal(rt.startupProviderCatalogRefreshPending, true);
  await readiness.ensureProvidersReady({ y: { enabled: true } });
  a.resolve();
  await setImmediate();
  assert.equal(warmed, 1, 'same memoized promise runs completion once');
  assert.equal(rt.startupProviderCatalogRefreshPending, false);

  current = b.promise;
  readiness.providerModelCaches.providerModelsCache.models = ['stale'];
  await readiness.ensureProvidersReady({ z: { enabled: true } });
  assert.equal(rt.startupProviderCatalogRefreshPending, true);
  b.resolve();
  await setImmediate();
  assert.equal(warmed, 2);
  assert.equal(readiness.providerModelCaches.providerModelsCache.models, null);
  assert.deepEqual(warmArgs, [{ loadSecrets: true }, { loadSecrets: true }]);
  assert.equal(rt.startupProviderCatalogRefreshPending, false);

  await readiness.ensureProvidersReady({ w: { enabled: true } });
  await setImmediate();
  assert.equal(warmed, 2);
});

test('an already initialized config still attaches to a refresh another runtime started', async () => {
  const a = deferred();
  const b = deferred();
  const rt = { config: { providers: {} }, closeRequested: false };
  let current = a.promise;
  let inits = 0;
  let warmed = 0;
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets: async () => {} },
    getReg: () => ({
      initProviders: async () => {
        inits += 1;
      },
      refreshProviderCatalogsOnStartup: () => current,
    }),
    getWarmProviderModelCache: () => () => {
      warmed += 1;
    },
  });
  const config = { x: { enabled: true } };
  await readiness.ensureProvidersReady(config);
  a.resolve();
  await setImmediate();
  assert.equal(warmed, 1);

  // The shared registry opened a new catalog epoch elsewhere; this runtime's
  // config is unchanged, so init is reused but the new refresh is observed.
  current = b.promise;
  await readiness.ensureProvidersReady(config);
  assert.equal(inits, 1, 'the cached init is reused');
  assert.equal(rt.startupProviderCatalogRefreshPending, true);
  b.resolve();
  await setImmediate();
  assert.equal(warmed, 2);
  assert.equal(rt.startupProviderCatalogRefreshPending, false);
});
