import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createProviderReadiness } from './provider-readiness.mjs';

function harness({ prewarm = Promise.resolve() } = {}) {
  const inits = [];
  const registryWrites = [];
  const rt = { config: { providers: { demo: { enabled: true, apiKey: 'old-key' } } }, closeRequested: false };
  const catalogRefresh = Promise.resolve();
  const reg = {
    initProviders: async (providers) => {
      inits.push(providers.demo.apiKey);
      registryWrites.push(providers);
    },
    refreshProviderCatalogsOnStartup: () => catalogRefresh,
  };
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets: () => prewarm, onKeychainRecovered: () => {} },
    getReg: () => reg,
    getWarmProviderModelCache: () => () => {},
  });
  return { rt, inits, registryWrites, readiness };
}

test('an initialization waiting on the keychain when the provider config changes never installs the old key', async () => {
  let releasePrewarm;
  const prewarm = new Promise((resolve) => {
    releasePrewarm = resolve;
  });
  const { rt, inits, registryWrites, readiness } = harness({ prewarm });
  // One plain request and one that turns a route's provider on, both captured
  // with the old key while the keychain is still being read.
  const plain = readiness.ensureProvidersReady();
  const routed = readiness.ensureProvidersReady({ ...rt.config.providers, extra: { enabled: true } });
  // Another process saved a new key; the change step reloads and re-inits.
  rt.config = { providers: { demo: { enabled: true, apiKey: 'new-key' }, extra: { enabled: false } } };
  readiness.reinitProviders();
  releasePrewarm();
  await Promise.all([plain, routed]);
  assert.equal(inits.includes('old-key'), false, `registry writes: ${JSON.stringify(inits)}`);
  assert.equal(inits.at(-1), 'new-key');
  // The routed request was replayed on the new config, its provider still on.
  assert.ok(registryWrites.some((providers) => providers.demo.apiKey === 'new-key' && providers.extra.enabled));
});

test('a provider change re-initializes the shared registry from the reloaded config of a runtime that used it', async () => {
  const { rt, inits, readiness } = harness();
  await readiness.ensureProvidersReady();
  assert.deepEqual(inits, ['old-key']);
  // The config reloaded with the key another process saved.
  rt.config = { providers: { demo: { enabled: true, apiKey: 'new-key' } } };
  readiness.reinitProviders();
  await flush();
  await flush();
  assert.deepEqual(inits, ['old-key', 'new-key']);
});

test('a rebuild that failed is retried as a rebuild and reports its real outcome', async () => {
  const { rt, inits, readiness } = harness();
  await readiness.ensureProvidersReady();
  const reg = { fail: true };
  const realInit = inits.push.bind(inits);
  inits.push = (key) => {
    if (reg.fail) throw new Error('registry refused');
    return realInit(key);
  };
  rt.config = { providers: { demo: { enabled: true, apiKey: 'new-key' } } };
  await assert.rejects(readiness.reinitProviders(), /registry refused/);
  // The retry of the change step rebuilds; it is no "never initialized" no-op.
  await assert.rejects(readiness.reinitProviders(), /registry refused/);
  reg.fail = false;
  await readiness.reinitProviders();
  assert.deepEqual([...inits], ['old-key', 'new-key']);
});

test('a runtime that never initialized providers does not start them on a provider change', async () => {
  const { inits, readiness } = harness();
  readiness.reinitProviders();
  await flush();
  assert.deepEqual(inits, []);
});
