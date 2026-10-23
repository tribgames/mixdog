import assert from 'node:assert/strict';
import test from 'node:test';

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
    removeItem: (key) => {
      storage.delete(key);
    },
  },
};

const {
  fetchProviderModels,
  invalidateSharedModelCatalogRequest,
  readCachedModelCatalog,
  requestModelCatalog,
  subscribeModelCatalogInvalidation,
  writeCachedModelCatalog,
} = await import('./model-catalog-cache.ts');

const CATALOG = [
  {
    provider: 'openai',
    model: 'gpt-catalog-share-test',
    display: 'Catalog share test',
    effortOptions: [{ value: 'high', label: 'High' }],
  },
];

/** Desktop API stub whose two catalog reads fail for the first `failures`
 *  attempts and succeed afterwards. */
function stubApi({ failures = 0 } = {}) {
  const calls = { models: 0, modelOptions: [], setup: 0 };
  return {
    calls,
    async listProviderModels(options) {
      calls.models += 1;
      calls.modelOptions.push(options);
      if (calls.models <= failures) throw new Error('catalog boom');
      return CATALOG;
    },
    async invokeCapability() {
      calls.setup += 1;
      if (calls.setup <= failures) throw new Error('setup boom');
      return { value: { api: [{ id: 'openai', authenticated: true }] }, snapshot: null };
    },
  };
}

test.beforeEach(() => {
  storage.clear();
  invalidateSharedModelCatalogRequest();
});

test('a successful catalog request is shared instead of refetched', async () => {
  const api = stubApi();
  const first = requestModelCatalog(api);
  assert.deepEqual(
    (await first.quick).map((entry) => entry.model),
    [CATALOG[0].model]
  );
  assert.deepEqual(
    (await first.full).map((entry) => entry.model),
    [CATALOG[0].model]
  );
  await first.setup;

  const second = requestModelCatalog(api);
  assert.deepEqual(await second.quick, await first.quick);
  assert.deepEqual(await second.full, await first.full);
  assert.deepEqual(api.calls.modelOptions, [{ quick: true }, { quick: false }]);
  assert.equal(api.calls.setup, 1);
});

/** Runs the rest of a test as a server (ssh) window, whose provider setup is
 *  proxied from the desktop. */
function asServerWindow(t) {
  window.mixdogDesktop = { connection: { kind: 'ssh' } };
  t.after(() => {
    delete window.mixdogDesktop;
  });
}

test('a local window invalidation re-reads without forcing the daemon caches', async () => {
  const api = stubApi();
  const requests = [];
  api.invokeCapability = async (request) => {
    requests.push(request);
    return { value: { api: [{ id: 'openai', authenticated: true }] } };
  };
  await requestModelCatalog(api).setup;
  invalidateSharedModelCatalogRequest();
  const next = requestModelCatalog(api);
  await Promise.all([next.full, next.setup]);
  assert.deepEqual(
    requests.map((request) => request.args),
    [[], []]
  );
  assert.equal(
    api.calls.modelOptions.some((options) => options.force),
    false
  );
});

test('provider invalidation wakes mounted catalog consumers and refetches', async () => {
  const api = stubApi();
  const first = requestModelCatalog(api);
  await Promise.all([first.quick, first.full, first.setup]);
  let invalidations = 0;
  const unsubscribe = subscribeModelCatalogInvalidation(() => {
    invalidations += 1;
  });
  try {
    invalidateSharedModelCatalogRequest();
    await Promise.resolve();
    assert.equal(invalidations, 1);
    const refreshed = requestModelCatalog(api);
    assert.notEqual(refreshed, first);
    await Promise.all([refreshed.quick, refreshed.full, refreshed.setup]);
    assert.equal(api.calls.models, 4);
    assert.equal(api.calls.setup, 2);
  } finally {
    unsubscribe();
  }
});

test('a failed catalog request is retried by the next caller', async () => {
  let fullAttempts = 0;
  const api = {
    async listProviderModels({ quick }) {
      if (quick) return CATALOG;
      fullAttempts += 1;
      if (fullAttempts === 1) throw new Error('catalog boom');
      return CATALOG;
    },
    async invokeCapability() {
      return { value: null, snapshot: null };
    },
  };
  const failed = requestModelCatalog(api);
  assert.deepEqual(
    (await failed.quick).map((entry) => entry.model),
    [CATALOG[0].model]
  );
  await assert.rejects(failed.full, /catalog boom/);
  await failed.setup;

  const retried = requestModelCatalog(api);
  assert.notEqual(retried, failed);
  assert.deepEqual(
    (await retried.quick).map((entry) => entry.model),
    [CATALOG[0].model]
  );
  assert.deepEqual(
    (await retried.full).map((entry) => entry.model),
    [CATALOG[0].model]
  );
  await retried.setup;
  assert.equal(fullAttempts, 2);
});

test('a failing provider setup does not pin a healthy catalog', async () => {
  const api = {
    calls: 0,
    async listProviderModels() {
      return CATALOG;
    },
    async invokeCapability() {
      api.calls += 1;
      if (api.calls === 1) throw new Error('setup boom');
      return { value: null, snapshot: null };
    },
  };
  const first = requestModelCatalog(api);
  await first.quick;
  await first.full;
  await assert.rejects(first.setup, /setup boom/);

  const second = requestModelCatalog(api);
  assert.notEqual(second, first);
  assert.equal(await second.setup, null);
});

test('a partial full catalog expires at its retry time, wakes consumers, and refetches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000_000 });
  let partial = true;
  const api = stubApi();
  api.listProviderModels = async (options) => {
    api.calls.models += 1;
    api.calls.modelOptions.push(options);
    if (!partial) return CATALOG;
    return CATALOG.map((row) => ({
      ...row,
      catalogPartial: true,
      catalogMissing: ['offline-provider'],
      catalogRetryAt: Date.now() + 30_000,
    }));
  };
  let woken = 0;
  const unsubscribe = subscribeModelCatalogInvalidation(() => {
    woken += 1;
  });
  t.after(unsubscribe);
  const first = requestModelCatalog(api);
  await Promise.all([first.full, first.setup]);
  assert.equal(requestModelCatalog(api), first, 'shared until the retry time');
  t.mock.timers.tick(29_999);
  assert.equal(requestModelCatalog(api), first);
  partial = false;
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(woken, 1, 'mounted pickers are woken to read again');
  const next = requestModelCatalog(api);
  assert.notEqual(next, first);
  assert.deepEqual(
    (await next.full).map((entry) => entry.model),
    [CATALOG[0].model]
  );
  assert.equal(api.calls.models, 4, 'the refetch goes to the daemon instead of the 30s answer cache');
  assert.equal(requestModelCatalog(api), next, 'a complete answer is shared again');
});

test('a completed catalog fetch survives in browser storage', async () => {
  const api = stubApi();
  await requestModelCatalog(api).full;
  assert.deepEqual(
    readCachedModelCatalog().models.map((entry) => entry.model),
    [CATALOG[0].model]
  );
});

test('the quick catalog resolves before the full catalog starts and never replaces complete storage', async () => {
  let releaseQuick;
  let releaseFull;
  const quickGate = new Promise((resolve) => {
    releaseQuick = resolve;
  });
  const fullGate = new Promise((resolve) => {
    releaseFull = resolve;
  });
  const calls = [];
  const api = {
    async listProviderModels({ quick }) {
      calls.push(quick ? 'quick' : 'full');
      await (quick ? quickGate : fullGate);
      return CATALOG;
    },
  };

  const request = requestModelCatalog(api);
  await Promise.resolve();
  assert.deepEqual(calls, ['quick']);
  releaseQuick();
  await request.quick;
  await Promise.resolve();
  assert.deepEqual(calls, ['quick', 'full']);
  assert.deepEqual(readCachedModelCatalog().models, []);
  releaseFull();
  await request.full;
  assert.deepEqual(
    readCachedModelCatalog().models.map((entry) => entry.model),
    [CATALOG[0].model]
  );
});

test('late success from an invalidated request cannot overwrite the current catalog', async () => {
  let releaseOld, signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const oldFull = new Promise((resolve) => {
    releaseOld = resolve;
  });
  let attempts = 0;
  const api = {
    listProviderModels({ quick }) {
      if (quick) return Promise.resolve([]);
      if (++attempts === 1) {
        signalStarted();
        return oldFull;
      }
      return Promise.resolve([{ provider: 'test', model: 'new' }]);
    },
  };
  const old = requestModelCatalog(api);
  await started;
  invalidateSharedModelCatalogRequest();
  const current = requestModelCatalog(api);
  await current.full;
  releaseOld([{ provider: 'test', model: 'old' }]);
  await old.full;
  assert.equal(old.isCurrent(), false);
  assert.equal(current.isCurrent(), true);
  assert.equal(readCachedModelCatalog().models[0].model, 'new');
});

test('one API object cannot share a catalog across device routes', async () => {
  const api = stubApi();
  window.location = { pathname: '/d/a/', protocol: 'https:', origin: 'https://relay.test' };
  try {
    const first = requestModelCatalog(api);
    await first.full;
    window.location.pathname = '/d/b/';
    assert.deepEqual(readCachedModelCatalog().models, []);
    const second = requestModelCatalog(api);
    assert.notEqual(first, second);
    assert.equal(first.isCurrent(), false);
    await second.full;
  } finally {
    delete window.location;
  }
});

test('an empty boot catalog is asked again soon and never replaces the stored catalog (#205)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  writeCachedModelCatalog(CATALOG);
  const api = stubApi();
  let answers = 0;
  api.listProviderModels = async () => (answers++ < 2 ? [] : CATALOG); // quick + full of the first request
  let woken = 0;
  const unsubscribe = subscribeModelCatalogInvalidation(() => {
    woken += 1;
  });
  t.after(unsubscribe);

  const first = requestModelCatalog(api);
  assert.deepEqual(await first.full, []);
  assert.deepEqual(
    readCachedModelCatalog().models.map((entry) => entry.model),
    [CATALOG[0].model],
    'the empty answer did not overwrite the stored catalog'
  );
  assert.equal(requestModelCatalog(api), first, 'shared until its retry time');

  t.mock.timers.tick(31_000);
  await Promise.resolve();
  assert.equal(woken, 1, 'mounted pickers are woken at the retry time');
  const retry = requestModelCatalog(api);
  assert.notEqual(retry, first, 'an empty answer is not held for a day');
  assert.equal((await retry.full)[0].model, CATALOG[0].model);
});

test('fetchProviderModels does not memoize an empty answer', async () => {
  let answers = 0;
  const api = { listProviderModels: async () => (answers++ === 0 ? [] : CATALOG) };
  assert.deepEqual(await fetchProviderModels(api, { quick: false }), []);
  assert.equal((await fetchProviderModels(api, { quick: false }))[0].model, CATALOG[0].model);
  assert.equal(answers, 2);
  assert.equal((await fetchProviderModels(api, { quick: false }))[0].model, CATALOG[0].model, 'a real answer is memoized');
  assert.equal(answers, 2);
});

test('an unavailable desktop snapshot is retryable even with a warm model catalog', async () => {
  const api = stubApi();
  let offline = true;
  api.invokeCapability = async () => ({
    value: offline
      ? { managedByClient: true, unavailable: true, api: [], oauth: [], local: [] }
      : { managedByClient: true, api: [{ id: 'openai', authenticated: true }] },
  });
  const first = requestModelCatalog(api);
  await assert.rejects(first.setup, /Desktop model providers are unavailable/);
  await first.full;
  offline = false;
  const next = requestModelCatalog(api);
  assert.notEqual(next, first);
  assert.equal((await next.setup).api[0].authenticated, true);
  await next.full;
});

test('provider invalidation bypasses the server setup TTL before sharing the refreshed catalog', async (t) => {
  asServerWindow(t);
  const api = stubApi();
  let authenticated = false;
  let serverCached = false;
  const requests = [];
  api.listProviderModels = async (options) => {
    if (options.force) return authenticated ? CATALOG : [];
    return []; // daemon's stale model catalog before the provider was connected
  };
  api.invokeCapability = async (request) => {
    requests.push(request);
    if (request.args[0]?.force) serverCached = authenticated;
    return { value: { managedByClient: true, api: [{ id: 'openai', usable: serverCached }] } };
  };
  const first = requestModelCatalog(api);
  await Promise.all([first.full, first.setup]);
  authenticated = true;
  invalidateSharedModelCatalogRequest();
  const next = requestModelCatalog(api);
  assert.equal((await next.setup).api[0].usable, true);
  assert.equal((await next.full)[0].model, CATALOG[0].model);
  assert.deepEqual(requests.at(-1).args, [{ force: true }]);
});

test('an invalidation before the first API read forces both model and setup snapshots', async (t) => {
  asServerWindow(t);
  invalidateSharedModelCatalogRequest();
  const requests = [];
  const api = stubApi();
  api.listProviderModels = async (options) => (options.force ? CATALOG : []);
  api.invokeCapability = async (request) => {
    requests.push(request);
    return { value: { managedByClient: true, api: [{ id: 'openai', usable: request.args[0]?.force === true }] } };
  };
  const current = requestModelCatalog(api);
  assert.equal((await current.full)[0]?.model, CATALOG[0].model);
  assert.equal((await current.setup).api[0].usable, true);
  assert.deepEqual(requests[0].args, [{ force: true }]);
  assert.equal(requestModelCatalog(api), current, 'a consumed invalidation does not defeat sharing');
});
