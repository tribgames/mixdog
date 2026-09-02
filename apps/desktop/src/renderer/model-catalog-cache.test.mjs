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
  const calls = { models: 0, modelOptions: [], setup: 0 };
  return {
    calls,
    async listProviderModels(options) {
      calls.models += 1;
      calls.modelOptions.push(options);
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
  assert.deepEqual((await first.quick).map((entry) => entry.model), [CATALOG[0].model]);
  assert.deepEqual((await first.full).map((entry) => entry.model), [CATALOG[0].model]);
  await first.setup;

  const second = requestModelCatalog(api);
  assert.deepEqual(await second.quick, await first.quick);
  assert.deepEqual(await second.full, await first.full);
  assert.deepEqual(api.calls.modelOptions, [{ quick: true }, { quick: false }]);
  assert.equal(api.calls.setup, 1);
});

test("a failed catalog request is retried by the next caller", async () => {
  let fullAttempts = 0;
  const api = {
    async listProviderModels({ quick }) {
      if (quick) return CATALOG;
      fullAttempts += 1;
      if (fullAttempts === 1) throw new Error("catalog boom");
      return CATALOG;
    },
    async invokeCapability() {
      return { value: null, snapshot: null };
    },
  };
  const failed = requestModelCatalog(api);
  assert.deepEqual((await failed.quick).map((entry) => entry.model), [CATALOG[0].model]);
  await assert.rejects(failed.full, /catalog boom/);
  await failed.setup;

  const retried = requestModelCatalog(api);
  assert.notEqual(retried, failed);
  assert.deepEqual((await retried.quick).map((entry) => entry.model), [CATALOG[0].model]);
  assert.deepEqual((await retried.full).map((entry) => entry.model), [CATALOG[0].model]);
  await retried.setup;
  assert.equal(fullAttempts, 2);
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
  await first.quick;
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

test("the quick catalog resolves before the full catalog starts and never replaces complete storage", async () => {
  let releaseQuick;
  let releaseFull;
  const quickGate = new Promise((resolve) => { releaseQuick = resolve; });
  const fullGate = new Promise((resolve) => { releaseFull = resolve; });
  const calls = [];
  const api = {
    async listProviderModels({ quick }) {
      calls.push(quick ? "quick" : "full");
      await (quick ? quickGate : fullGate);
      return CATALOG;
    },
  };

  const request = requestModelCatalog(api);
  await Promise.resolve();
  assert.deepEqual(calls, ["quick"]);
  releaseQuick();
  await request.quick;
  await Promise.resolve();
  assert.deepEqual(calls, ["quick", "full"]);
  assert.deepEqual(readCachedModelCatalog().models, []);
  releaseFull();
  await request.full;
  assert.deepEqual(
    readCachedModelCatalog().models.map((entry) => entry.model),
    [CATALOG[0].model],
  );
});
