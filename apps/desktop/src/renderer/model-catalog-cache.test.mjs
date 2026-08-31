import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  },
};

const {
  invalidateSharedModelCatalogRequest,
  readCachedModelCatalog,
  requestModelCatalog,
} = await import("./model-catalog-cache.ts");

const CATALOG = [{
  provider: "openai",
  model: "gpt-catalog-share-test",
  display: "Catalog share test",
  effortOptions: [{ value: "high", label: "High" }],
}];

/** Desktop API stub whose two catalog reads fail for the first `failures`
 *  attempts and succeed afterwards. */
function stubApi({ failures = 0 } = {}) {
  const calls = { models: 0, setup: 0 };
  return {
    calls,
    async listProviderModels() {
      calls.models += 1;
      if (calls.models <= failures) throw new Error("catalog boom");
      return CATALOG;
    },
    async invokeCapability() {
      calls.setup += 1;
      if (calls.setup <= failures) throw new Error("setup boom");
      return { value: { api: [{ id: "openai", authenticated: true }] }, snapshot: null };
    },
  };
}

test.beforeEach(() => {
  storage.clear();
  invalidateSharedModelCatalogRequest();
});

test("a successful catalog request is shared instead of refetched", async () => {
  const api = stubApi();
  const first = requestModelCatalog(api);
  assert.deepEqual((await first.full).map((entry) => entry.model), [CATALOG[0].model]);
  await first.setup;

  const second = requestModelCatalog(api);
  assert.deepEqual(await second.full, await first.full);
  assert.equal(api.calls.models, 1);
  assert.equal(api.calls.setup, 1);
});

test("a failed catalog request is retried by the next caller", async () => {
  const api = stubApi({ failures: 1 });
  const failed = requestModelCatalog(api);
  await assert.rejects(failed.full, /catalog boom/);
  await assert.rejects(failed.setup, /setup boom/);

  const retried = requestModelCatalog(api);
  assert.notEqual(retried, failed);
  assert.deepEqual((await retried.full).map((entry) => entry.model), [CATALOG[0].model]);
  await retried.setup;
  assert.equal(api.calls.models, 2);
  assert.equal(api.calls.setup, 2);
});

test("a failing provider setup does not pin a healthy catalog", async () => {
  const api = {
    calls: 0,
    async listProviderModels() { return CATALOG; },
    async invokeCapability() {
      api.calls += 1;
      if (api.calls === 1) throw new Error("setup boom");
      return { value: null, snapshot: null };
    },
  };
  const first = requestModelCatalog(api);
  await first.full;
  await assert.rejects(first.setup, /setup boom/);

  const second = requestModelCatalog(api);
  assert.notEqual(second, first);
  assert.equal(await second.setup, null);
});

test("a completed catalog fetch survives in browser storage", async () => {
  const api = stubApi();
  await requestModelCatalog(api).full;
  assert.deepEqual(
    readCachedModelCatalog().models.map((entry) => entry.model),
    [CATALOG[0].model],
  );
});
