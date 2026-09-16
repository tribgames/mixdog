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
