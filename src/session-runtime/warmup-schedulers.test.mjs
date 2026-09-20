import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createWarmupSchedulers } from './warmup-schedulers.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closed = false;
  let route = { provider: 'openai-oauth', model: 'first' };
  const calls = [];
  const timers = {};
  const schedulers = createWarmupSchedulers({
    timers,
    bootProfile() {},
    getRoute: () => route,
    getConfig: () => ({ providers: { [route.provider]: { enabled: true } } }),
    isCloseRequested: () => closed,
    getActiveTurnCount: () => 0,
    getSessionCreatePromise: () => null,
    getProviderModelsCache: () => ({}),
    getProviderModelsPromise: () => null,
    reloadFullConfig: () => {
      calls.push('reload');
    },
    ensureConfigForRouteProvider: () => {
      calls.push('config');
    },
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {
      calls.push('providers');
    },
    ensureProviderEnabled: (config) => config.providers,
    refreshStatuslineUsageSnapshot: (value) => {
      calls.push(['usage', value]);
    },
    warmProviderModelCache() {},
    cachedProviderSetup: async () => ({}),
    warmCatalogsInBackground: async () => {},
    isFirstTurnCompleted: () => true,
    envFlag: () => false,
    delays: {
      providerWarmupDelayMs: 0,
      providerSetupWarmupDelayMs: 0,
      providerModelWarmupDelayMs: 0,
      modelCatalogWarmupDelayMs: 0,
      statuslineUsageWarmupDelayMs: 0,
      statuslineUsageRefreshDelayMs: 1000,
      backgroundBusyRetryMs: 100,
    },
    flags: { providerWarmupEnabled: true, modelPrefetchEnabled: true, modelCatalogWarmupEnabled: true },
    ...overrides,
  });
  return {
    schedulers,
    calls,
    timers,
    close: () => {
      closed = true;
    },
    setRoute: (next) => {
      route = next;
    },
  };
}

for (const method of ['scheduleProviderWarmup', 'scheduleStatuslineUsageWarmup', 'scheduleStatuslineUsageRefresh']) {
  test(`${method} cannot start provider work after closing during keychain readiness`, async (t) => {
    const keychain = deferred();
    const f = fixture(t, { awaitKeychainPrewarm: () => keychain.promise });
    f.schedulers[method](0);
    t.mock.timers.tick(0);
    f.close();
    keychain.resolve();
    await setImmediate();
    assert.deepEqual(f.calls, []);
    assert.equal(f.timers.statuslineUsageRefreshTimer ?? null, null);
  });
}

test('provider warmup does not continue after a keychain failure during close', async (t) => {
  const keychain = deferred();
  const f = fixture(t, { awaitKeychainPrewarm: () => keychain.promise });
  f.schedulers.scheduleProviderWarmup(0);
  t.mock.timers.tick(0);
  f.close();
  keychain.reject(new Error('keychain unavailable'));
  await setImmediate();
  assert.deepEqual(f.calls, []);
});

for (const method of ['scheduleStatuslineUsageWarmup', 'scheduleStatuslineUsageRefresh']) {
  test(`${method} stops before usage refresh if provider readiness outlives the runtime`, async (t) => {
    const provider = deferred();
    const f = fixture(t, { ensureProvidersReady: () => provider.promise });
    f.schedulers[method](0);
    t.mock.timers.tick(0);
    await setImmediate();
    f.close();
    provider.resolve();
    await setImmediate();
    assert.deepEqual(f.calls, ['config']);
    assert.equal(f.timers.statuslineUsageRefreshTimer ?? null, null);
  });

  test(`${method} refreshes the prepared route if selection changes while waiting`, async (t) => {
    const provider = deferred();
    const f = fixture(t, { ensureProvidersReady: () => provider.promise });
    f.schedulers[method](0);
    t.mock.timers.tick(0);
    await setImmediate();
    f.setRoute({ provider: 'anthropic-oauth', model: 'replacement' });
    provider.resolve();
    await setImmediate();
    assert.deepEqual(f.calls, ['config', ['usage', { provider: 'openai-oauth', model: 'first' }]]);
    assert.ok(f.timers.statuslineUsageRefreshTimer);
  });
}

test('normal provider warmup still reloads configuration before provider initialization', async (t) => {
  const f = fixture(t);
  f.schedulers.scheduleProviderWarmup(0);
  t.mock.timers.tick(0);
  await setImmediate();
  assert.deepEqual(f.calls, ['reload', 'providers']);
});

function profiled(t, overrides = {}) {
  const events = [];
  const f = fixture(t, { bootProfile: (name, meta) => events.push(meta ? [name, meta] : name), ...overrides });
  return { ...f, events };
}

test('a busy runtime defers provider warmup and re-arms it on the busy retry delay', async (t) => {
  let active = 1;
  const f = profiled(t, { getActiveTurnCount: () => active });
  f.schedulers.scheduleProviderWarmup(0);
  t.mock.timers.tick(0);
  await setImmediate();
  assert.deepEqual(f.events, [['providers:warm-deferred', { reason: 'turn-active' }]]);
  assert.ok(f.timers.providerWarmupTimer);
  assert.deepEqual(f.calls, []);
  active = 0;
  t.mock.timers.tick(100);
  await setImmediate();
  assert.deepEqual(f.calls, ['reload', 'providers']);
});

test('provider model warmup waits for the catalog refresh and warms with secrets before the first turn', (t) => {
  let catalogPending = true;
  let firstTurn = false;
  const warms = [];
  const f = profiled(t, {
    isCatalogRefreshPending: () => catalogPending,
    isFirstTurnCompleted: () => firstTurn,
    warmProviderModelCache: (opts) => warms.push(opts),
  });
  f.schedulers.scheduleProviderModelWarmup(0);
  t.mock.timers.tick(0);
  assert.deepEqual(f.events, [['provider-models:warm-deferred', { reason: 'catalog-refresh-pending' }]]);
  assert.deepEqual(warms, []);
  catalogPending = false;
  t.mock.timers.tick(100);
  assert.deepEqual(f.events.at(-1), ['provider-models:warm-deferred', { reason: 'first-turn-pending' }]);
  assert.deepEqual(warms, [{ loadSecrets: true }]);
  assert.ok(f.timers.providerModelWarmupTimer);
  firstTurn = true;
  t.mock.timers.tick(100);
  assert.deepEqual(warms, [{ loadSecrets: true }, { loadSecrets: true }]);
  assert.equal(f.timers.providerModelWarmupTimer, null);
});

test('model catalog warmup re-arms on the returned retry delay and backs off a minute after a failure', async (t) => {
  let outcome = { retryAfterMs: 5000 };
  let runs = 0;
  const f = profiled(t, {
    warmCatalogsInBackground: async () => {
      runs += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  f.schedulers.scheduleModelCatalogWarmup(0);
  t.mock.timers.tick(0);
  await setImmediate();
  assert.equal(runs, 1);
  assert.deepEqual(f.events, ['model-catalog:warm-ready']);
  assert.ok(f.timers.modelCatalogWarmupTimer);
  outcome = new Error('offline');
  t.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(runs, 2);
  assert.deepEqual(f.events.at(-1), ['model-catalog:warm-failed', { error: 'offline' }]);
  t.mock.timers.tick(59_999);
  await setImmediate();
  assert.equal(runs, 2);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(runs, 3);
});

test('disabled or inapplicable warmups report the skip instead of arming a timer', (t) => {
  const f = profiled(t, {
    flags: { providerWarmupEnabled: false, modelPrefetchEnabled: false, modelCatalogWarmupEnabled: false },
  });
  f.setRoute({ provider: 'openai', model: 'm' });
  f.schedulers.scheduleProviderWarmup(0);
  f.schedulers.scheduleProviderModelWarmup(0);
  f.schedulers.scheduleModelCatalogWarmup(0);
  f.schedulers.scheduleStatuslineUsageWarmup(0);
  f.schedulers.scheduleStatuslineUsageRefresh(0);
  assert.deepEqual(f.events, [
    'providers:warm-skipped',
    ['model-catalog:warm-skipped', { reason: 'disabled' }],
    ['statusline-usage:warm-skipped', { provider: 'openai' }],
  ]);
  assert.deepEqual(Object.values(f.timers).filter(Boolean), []);
});

test('provider setup warmup reports readiness', async (t) => {
  const f = profiled(t);
  f.schedulers.scheduleProviderSetupWarmup(0);
  t.mock.timers.tick(0);
  await setImmediate();
  assert.deepEqual(f.events, ['provider-setup:warm-ready']);
});
