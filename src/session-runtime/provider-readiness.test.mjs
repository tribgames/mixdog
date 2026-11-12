import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createProviderReadiness } from './provider-readiness.mjs';

function harness({ prewarm = Promise.resolve(), prewarmSecrets = () => prewarm, stored = {} } = {}) {
  const inits = [];
  const registryWrites = [];
  const syncs = [];
  const rt = {
    config: { providers: { demo: { enabled: true, apiKey: 'old-key' } } },
    closeRequested: false,
    wakeDeferredWarmups() {},
  };
  const catalogRefresh = Promise.resolve();
  const reg = {
    initProviders: async (providers) => {
      inits.push(providers.demo.apiKey);
      registryWrites.push(providers);
    },
    syncProviders: async (record, options) => {
      syncs.push({ key: record.demo?.apiKey, decisions: options.decisions });
    },
    refreshProviderCatalogsOnStartup: () => catalogRefresh,
  };
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets, onKeychainRecovered: () => {} },
    getReg: () => reg,
    getWarmProviderModelCache: () => () => {},
    // The record: this runtime's config once loaded with secrets.
    getEnsureFullConfig: () => () => rt.config,
    getStoredProviders: () => stored,
  });
  return { rt, reg, inits, registryWrites, syncs, readiness };
}

test('a request waiting on the keychain registers the record read after the wait, never the old key', async () => {
  let releasePrewarm;
  const prewarm = new Promise((resolve) => {
    releasePrewarm = resolve;
  });
  const { rt, inits, registryWrites, readiness } = harness({ prewarm });
  // One plain request and one that turns a route's provider on, both made
  // with the old key while the keychain is still being read.
  const plain = readiness.ensureProvidersReady();
  const routed = readiness.ensureProvidersReady({ ...rt.config.providers, extra: { enabled: true } });
  // Another process saved a new key; the change step reloads.
  rt.config = { providers: { demo: { enabled: true, apiKey: 'new-key' }, extra: { enabled: false } } };
  releasePrewarm();
  await Promise.all([plain, routed]);
  assert.deepEqual(inits, ['new-key', 'new-key']);
  // The routed request still turns its provider on, over the new record.
  assert.ok(registryWrites.some((providers) => providers.demo.apiKey === 'new-key' && providers.extra.enabled));
});

test('a request registers what the record enables, not the view the caller held', async () => {
  const { rt, registryWrites, readiness } = harness();
  // The runtime's secrets-less boot view: the key provider reads as off.
  const view = { demo: { enabled: false }, route: { enabled: true } };
  rt.config = { providers: { demo: { enabled: true, apiKey: 'k' }, route: { enabled: false } } };
  await readiness.ensureProvidersReady(view);
  assert.deepEqual(registryWrites.at(-1), { demo: { enabled: true, apiKey: 'k' }, route: { enabled: true } });
});

test('every request asks the registry again: no earlier answer stands in for a provider since removed', async () => {
  const { inits, readiness } = harness();
  await readiness.ensureProvidersReady({ demo: { enabled: true } });
  await readiness.ensureProvidersReady({ demo: { enabled: true } });
  assert.equal(inits.length, 2);
});

test('provider initialization warms the keys of the configured custom providers that hold one', async () => {
  const warmed = [];
  const { readiness } = harness({ prewarmSecrets: (accounts) => (warmed.push(accounts), Promise.resolve()) });
  await readiness.ensureProvidersReady({
    demo: { enabled: true, apiKey: 'k' },
    'custom-keyed': { type: 'custom', enabled: true },
    'custom-env': { type: 'custom', enabled: true, apiKeyEnv: 'SOME_KEY_VAR' },
    'custom-open': { type: 'custom', enabled: true, auth: 'none' },
  });
  assert.ok(warmed.some((accounts) => accounts.includes('agent.openai.apiKey')), 'the built-in keys are warmed');
  assert.deepEqual(warmed.at(-1), ['agent.custom-keyed.apiKey']);
});

test('initialization waits at most one 5 s deadline for the built-in and custom key warms together', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = new Promise(() => {});
  const { readiness, inits } = harness({ prewarmSecrets: () => never });
  const ready = readiness.ensureProvidersReady({
    demo: { enabled: true, apiKey: 'k' },
    'custom-keyed': { type: 'custom', enabled: true },
  });
  await flush();
  t.mock.timers.tick(5000);
  await ready;
  assert.deepEqual(inits, ['old-key'], 'initialized after the single deadline');
});

test('a provider change syncs the shared registry to the reloaded record and its stored decisions', async () => {
  const stored = { demo: { enabled: false } };
  const { rt, inits, syncs, readiness } = harness({ stored });
  rt.config = { providers: { demo: { enabled: false } } };
  await readiness.reinitProviders();
  assert.deepEqual(syncs, [{ key: undefined, decisions: stored }]);
  // A change registers nothing on its own: requests do that on demand.
  assert.deepEqual(inits, []);
});

test('a sync that failed rejects, and the retried change step syncs again', async () => {
  const { reg, syncs, readiness } = harness();
  const realSync = reg.syncProviders;
  reg.syncProviders = async () => {
    throw new Error('registry refused');
  };
  await assert.rejects(readiness.reinitProviders(), /registry refused/);
  reg.syncProviders = realSync;
  await readiness.reinitProviders();
  assert.equal(syncs.length, 1);
});

// Mirrors lib/keychain-cjs.cjs: a process-wide listener Set, subscribe returns the unsubscribe.
function fakeKeychain() {
  const listeners = new Set();
  return {
    listeners,
    prewarmSecrets: () => Promise.resolve(),
    onKeychainRecovered(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover: () => [...listeners].forEach((listener) => listener()),
  };
}

function readinessOn(keychain) {
  const rt = { config: { providers: {} }, closeRequested: false, wakeDeferredWarmups() {} };
  return createProviderReadiness({
    rt,
    keychain,
    getReg: () => ({}),
    getWarmProviderModelCache: () => () => {},
  });
}

test('disposing a runtime releases its keychain recovery listener', () => {
  const keychain = fakeKeychain();
  const before = keychain.listeners.size;
  const readiness = readinessOn(keychain);
  assert.equal(keychain.listeners.size, before + 1);
  readiness.dispose();
  assert.equal(keychain.listeners.size, before);
  // Teardown may run more than once.
  readiness.dispose();
  assert.equal(keychain.listeners.size, before);
});

test('creating and disposing many runtimes leaves no listeners behind, and a live one still invalidates on recovery', () => {
  const keychain = fakeKeychain();
  for (let i = 0; i < 25; i += 1) readinessOn(keychain).dispose();
  assert.equal(keychain.listeners.size, 0);

  const live = readinessOn(keychain);
  const gone = readinessOn(keychain);
  live.modelMetaByRoute.set('route', { stale: true });
  gone.modelMetaByRoute.set('route', { stale: true });
  gone.dispose();
  keychain.recover();
  assert.equal(live.modelMetaByRoute.size, 0, 'the live runtime dropped its stale caches');
  assert.equal(gone.modelMetaByRoute.size, 1, 'a disposed runtime is no longer notified');
  live.dispose();
  assert.equal(keychain.listeners.size, 0);
});
