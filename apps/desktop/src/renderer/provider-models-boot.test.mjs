import assert from 'node:assert/strict';
import test from 'node:test';

const storage = new Map();
globalThis.window ??= {};
window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const { fetchProviderModels, invalidateSharedModelCatalogRequest, PROVIDER_MODELS_FRESH_MS, requestModelCatalog } =
  await import('./model-catalog-cache.ts');
const { loadSidebarReferences, readSidebarReference, resetSidebarReferenceCache } = await import(
  './sidebar-reference-cache.ts'
);
const { preloadCapabilitySettings } = await import('./settings/capability-data.ts');

// Boot on a phone: the route picker (quick, then full), the sidebar panels
// and settings each want the catalog within a few seconds. The whole ~140 KB
// list must cross the relay once.

const FULL = Array.from({ length: 5 }, (_, index) => ({
  provider: 'openai',
  model: `gpt-boot-${index}`,
  display: `Boot ${index}`,
  effortOptions: [],
  fastCapable: false,
  fastPreferred: false,
}));
const QUICK_COLD = FULL.slice(0, 2);
const QUICK_WARM = FULL.map((row) => ({ ...row, catalogComplete: true }));

function bootApi({ warm }) {
  const calls = [];
  const gates = [];
  const api = {
    calls,
    release: () => {
      for (const open of gates.splice(0)) open();
    },
    listProviderModels(options) {
      calls.push(options.quick ? 'quick' : 'full');
      // Answers land only when the test releases them, so every boot caller
      // is issued while the first reads are still on the wire.
      return new Promise((resolve) => gates.push(resolve)).then(() =>
        options.quick ? (warm ? QUICK_WARM : QUICK_COLD) : FULL
      );
    },
    async invokeCapability() {
      return { value: null, snapshot: null };
    },
    async readCapabilities(requests) {
      return requests.map(() => ({ ok: true, value: null }));
    },
    async getSnapshot() {
      return null;
    },
  };
  return api;
}

async function settle(api) {
  for (let round = 0; round < 10; round += 1) {
    api.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test.beforeEach(() => {
  storage.clear();
  invalidateSharedModelCatalogRequest();
  resetSidebarReferenceCache();
});

for (const warm of [false, true]) {
  test(`a boot sequence of catalog readers issues one full read (daemon ${warm ? 'warm' : 'cold'})`, async () => {
    const api = bootApi({ warm });
    const picker = requestModelCatalog(api);
    const sidebar = loadSidebarReferences(api, ['quickProviderModels']);
    const settings = preloadCapabilitySettings(api);
    await settle(api);
    const [quick, full] = await Promise.all([picker.quick, picker.full, sidebar, settings]);
    const settingsData = (await settings).data;

    assert.deepEqual(api.calls.filter((call) => call === 'full').length, 1, `calls: ${api.calls.join(',')}`);
    assert.equal(api.calls.filter((call) => call === 'quick').length, 1);
    assert.equal(quick.length, warm ? FULL.length : QUICK_COLD.length);
    for (const models of [full, readSidebarReference('quickProviderModels'), settingsData.models]) {
      assert.deepEqual(
        models.map((row) => row.model),
        FULL.map((row) => row.model)
      );
    }
  });
}

test('a quick answer that is already the full catalog is never followed by a full read', async () => {
  const api = bootApi({ warm: true });
  const picker = requestModelCatalog(api);
  await settle(api);
  await picker.full;
  assert.deepEqual(api.calls, ['quick']);
  // Later readers inside the freshness window take the same answer.
  await loadSidebarReferences(api, ['quickProviderModels']);
  await preloadCapabilitySettings(api);
  assert.deepEqual(api.calls, ['quick']);
});

test('an unmarked quick answer (older daemon) still gets its full follow-up', async () => {
  const api = bootApi({ warm: false });
  const picker = requestModelCatalog(api);
  await settle(api);
  assert.equal((await picker.full).length, FULL.length);
  assert.deepEqual(api.calls, ['quick', 'full']);
});

test('an explicit refresh always reads the daemon and replaces the shared answer', async () => {
  const api = bootApi({ warm: false });
  const first = fetchProviderModels(api);
  await settle(api);
  await first;
  const sidebar = loadSidebarReferences(api, ['quickProviderModels'], { force: true });
  const settings = preloadCapabilitySettings(api, true);
  await settle(api);
  await Promise.all([sidebar, settings]);
  // Each explicit refresh asked the daemon itself.
  assert.deepEqual(api.calls, ['full', 'full', 'full']);
  // A plain reader afterwards shares the refreshed answer.
  const joined = fetchProviderModels(api);
  assert.deepEqual(api.calls.length, 3);
  assert.equal((await joined).length, FULL.length);
});

test('the shared answer expires and provider changes drop it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const api = bootApi({ warm: false });
  const first = fetchProviderModels(api);
  await settle(api);
  await first;
  await fetchProviderModels(api);
  assert.equal(api.calls.length, 1);
  t.mock.timers.tick(PROVIDER_MODELS_FRESH_MS);
  const expired = fetchProviderModels(api);
  await settle(api);
  await expired;
  assert.equal(api.calls.length, 2);
  invalidateSharedModelCatalogRequest();
  const changed = fetchProviderModels(api);
  await settle(api);
  await changed;
  assert.equal(api.calls.length, 3);
});
