import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createProviderReadiness } from './provider-readiness.mjs';
import { createProviderUsage, USAGE_REFRESH_REUSE_MS } from './provider-usage.mjs';

function deferred() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const readiness = createProviderReadiness({
    rt: { config: { providers: {} } },
    keychain: { prewarmSecrets: async () => {} },
    getReg: () => ({}),
    getWarmProviderModelCache: () => () => {},
  });
  const usage = createProviderUsage({
    caches: readiness.providerUsageCaches,
    getConfig: () => ({}),
    displayConfig: () => ({}),
    getReg: () => ({ getProvider: () => ({}) }),
    providerSetup: async () => ({}),
    createUsageDashboard: async () => ({}),
    consumeOpenAICodexResetCredit: async () => ({ outcome: 'reset' }),
    isCloseRequested: () => false,
    getProviderSetupWarmupTimer: () => null,
    scheduleProviderSetupWarmup() {},
    ...overrides,
  });
  return { usage, invalidate: readiness.invalidateProviderCaches };
}

test('an invalidated setup request cannot overwrite or retire its replacement', async () => {
  const requests = [];
  const f = fixture({
    providerSetup: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const first = f.usage.cachedProviderSetup();
  f.invalidate();
  const second = f.usage.cachedProviderSetup();
  requests[0].resolve({ generation: 'old' });
  await first;
  const joined = f.usage.cachedProviderSetup();
  requests[1].resolve({ generation: 'new' });
  await second;
  assert.deepEqual(await joined, { generation: 'new' });
  assert.equal(requests.length, 2);
});

test('quick setup retains the latest requested snapshot rather than the last completion', async () => {
  const requests = [];
  const f = fixture({
    providerSetup: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const first = f.usage.cachedProviderSetup({ quick: true });
  const second = f.usage.cachedProviderSetup({ quick: true, force: true });
  requests[1].resolve({ generation: 'new' });
  await second;
  requests[0].resolve({ generation: 'old' });
  await first;
  assert.deepEqual(await f.usage.cachedProviderSetup({ quick: true }), { generation: 'new' });
});

test('a quick setup invalidated in flight cannot repopulate its cache or schedule warmup', async () => {
  const request = deferred();
  let builds = 0;
  let warmups = 0;
  const f = fixture({
    providerSetup: async () => (++builds === 1 ? request.promise : { generation: 'new' }),
    scheduleProviderSetupWarmup: () => {
      warmups += 1;
    },
  });
  const first = f.usage.cachedProviderSetup({ quick: true });
  f.invalidate();
  request.resolve({ generation: 'old' });
  await first;
  assert.equal(warmups, 0);
  assert.deepEqual(await f.usage.cachedProviderSetup({ quick: true }), { generation: 'new' });
  assert.equal(builds, 2);
});

test('a late dashboard cannot replace a newer forced refresh', async () => {
  const requests = [];
  const f = fixture({
    createUsageDashboard: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const first = f.usage.getUsageDashboard({ quickSetup: false });
  await setImmediate();
  const fresh = f.usage.getUsageDashboard({ refresh: true, refreshSetup: false, quickSetup: false });
  await setImmediate();
  requests[1].resolve({ generation: 'new' });
  await fresh;
  requests[0].resolve({ generation: 'old' });
  await first;
  assert.equal((await f.usage.getUsageDashboard()).generation, 'new');
});

test('dashboard invalidation preserves the replacement in-flight request', async () => {
  const requests = [];
  const f = fixture({
    createUsageDashboard: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const first = f.usage.getUsageDashboard({ quickSetup: false });
  await setImmediate();
  f.invalidate();
  const second = f.usage.getUsageDashboard({ quickSetup: false });
  await setImmediate();
  requests[0].resolve({ generation: 'old' });
  await first;
  const joined = f.usage.getUsageDashboard({ quickSetup: false });
  requests[1].resolve({ generation: 'new' });
  await second;
  assert.equal((await joined).generation, 'new');
  assert.equal(requests.length, 2);
});

test('a dashboard preview is already part of the shared in-flight build', async () => {
  const quick = deferred();
  let builds = 0;
  let previews = 0;
  const f = fixture({
    providerSetup: async (_config, options) => (options.checkSecrets === false ? quick.promise : {}),
    createUsageDashboard: async (_config, options) => {
      if (options.preview) previews += 1;
      else builds += 1;
      return { generation: 'current' };
    },
  });
  const first = f.usage.getUsageDashboard({ onUpdate() {} });
  await setImmediate();
  const joined = f.usage.getUsageDashboard({ quickSetup: false });
  quick.resolve({});
  await Promise.all([first, joined]);
  assert.equal(previews, 1);
  assert.equal(builds, 1);
});

test('concurrent plain refreshes share one live sweep', async () => {
  const requests = [];
  const f = fixture({
    createUsageDashboard: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const rail = f.usage.getUsageDashboard({ refresh: true, refreshSetup: false });
  await setImmediate();
  const phone = f.usage.getUsageDashboard({ refresh: true, refreshSetup: false });
  await setImmediate();
  assert.equal(requests.length, 1);
  requests[0].resolve({ generation: 'live' });
  assert.equal((await rail).generation, 'live');
  assert.equal((await phone).generation, 'live');
});

test('a plain refresh right after a complete sweep reuses it; a later or scoped one sweeps again', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let builds = 0;
  const f = fixture({
    createUsageDashboard: async () => ({ generation: ++builds }),
  });
  assert.equal((await f.usage.getUsageDashboard({ refresh: true, refreshSetup: false })).generation, 1);
  now += USAGE_REFRESH_REUSE_MS - 1;
  const reused = await f.usage.getUsageDashboard({ refresh: true, refreshSetup: false });
  assert.equal(reused.generation, 1);
  assert.equal(reused.cached, true);
  // An account switch forces its provider live even inside the window.
  const scoped = await f.usage.getUsageDashboard({ refresh: true, refreshSetup: false, refreshProviders: ['x'] });
  assert.equal(scoped.generation, 2);
  // A scoped sweep served the other providers from cache: it is no stand-in.
  now += 1;
  assert.equal((await f.usage.getUsageDashboard({ refresh: true, refreshSetup: false })).generation, 3);
  now += USAGE_REFRESH_REUSE_MS;
  assert.equal((await f.usage.getUsageDashboard({ refresh: true, refreshSetup: false })).generation, 4);
  // A plain (unforced) build is not a live sweep either.
  f.invalidate();
  await f.usage.getUsageDashboard({ quickSetup: false });
  assert.equal((await f.usage.getUsageDashboard({ refresh: true, refreshSetup: false })).generation, 6);
});

test('a refresh after an invalidation never joins the sweep that predates it', async () => {
  const requests = [];
  const f = fixture({
    createUsageDashboard: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const before = f.usage.getUsageDashboard({ refresh: true, refreshSetup: false });
  await setImmediate();
  f.invalidate();
  const after = f.usage.getUsageDashboard({ refresh: true, refreshSetup: false });
  await setImmediate();
  assert.equal(requests.length, 2);
  requests[0].resolve({ generation: 'old' });
  requests[1].resolve({ generation: 'new' });
  assert.equal((await before).generation, 'old');
  assert.equal((await after).generation, 'new');
  assert.equal((await f.usage.getUsageDashboard()).generation, 'new');
});

test('a pre-redeem dashboard cannot restore spent reset credits in the cache', async () => {
  const requests = [];
  const f = fixture({
    createUsageDashboard: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const first = f.usage.getUsageDashboard({ quickSetup: false });
  await setImmediate();
  const redeemed = f.usage.consumeCodexRateLimitResetCredit({});
  await setImmediate();
  requests[1].resolve({ credits: 0 });
  await redeemed;
  requests[0].resolve({ credits: 1 });
  await first;
  assert.equal((await f.usage.getUsageDashboard()).credits, 0);
});
