import assert from "node:assert/strict";
import test from "node:test";
import { readCachedProjectCatalog, writeCachedProjectCatalog } from "./project-catalog-cache.ts";
import {
  readCachedSessionCatalog, writeCachedSessionCatalog,
  scheduleCachedSessionCatalogWrite, flushCachedSessionCatalogWrite,
} from "./session-catalog-cache.ts";
import { readCachedModelCatalog, writeCachedModelCatalog } from "./model-catalog-cache.ts";
import { catalogStorageScope } from "./catalog-storage-scope.ts";

const originalWindow = globalThis.window;
const storage = new Map();
function route(pathname, protocol = "https:") {
  globalThis.window = {
    location: { pathname, protocol, origin: "https://relay.test" },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    setTimeout,
    clearTimeout,
  };
}
test.beforeEach(() => { storage.clear(); route("/d/device-a/"); });
test.afterEach(() => {
  flushCachedSessionCatalogWrite();
  globalThis.window = originalWindow;
});

const catalogs = [
  { name: "projects", write: () => writeCachedProjectCatalog([{ path: "C:/private", name: "A" }]),
    read: () => readCachedProjectCatalog() },
  { name: "sessions", write: () => writeCachedSessionCatalog([{ id: "session_a", title: "Private A", preview: "Private A" }]),
    read: () => readCachedSessionCatalog() },
  { name: "models", write: () => writeCachedModelCatalog([{ provider: "private", model: "A" }]),
    read: () => readCachedModelCatalog().models },
];

for (const catalog of catalogs) {
  test(`${catalog.name} stay isolated across device and server identities`, () => {
    catalog.write();
    const expected = catalog.read();
    assert.equal(expected.length, 1);
    route("/d/device-b/");
    assert.deepEqual(catalog.read(), []);
    route("/d/device-a/");
    storage.set("mixdog.remote-server", "https://other-relay.test");
    assert.deepEqual(catalog.read(), []);
    storage.delete("mixdog.remote-server");
    assert.deepEqual(catalog.read(), expected);
  });

  test(`${catalog.name} never adopt unscoped legacy data into a remote device`, () => {
    route("/", "file:");
    catalog.write();
    const expected = catalog.read();
    route("/d/device-a/");
    assert.deepEqual(catalog.read(), []);
    route("/", "file:");
    assert.deepEqual(catalog.read(), expected);
  });
}

test('delayed session persistence retains the scope that scheduled it', () => {
  scheduleCachedSessionCatalogWrite([{ id: "session_a", title: "A" }]);
  route("/d/device-b/");
  flushCachedSessionCatalogWrite();
  assert.deepEqual(readCachedSessionCatalog(), []);
  route("/d/device-a/");
  assert.equal(readCachedSessionCatalog()[0].title, "A");
});

test('bare remote routes use the remembered device, never the desktop namespace', () => {
  route("/");
  const unpaired = catalogStorageScope();
  assert.notEqual(unpaired, "desktop");
  storage.set("mixdog.remote-device", "device-a");
  const remembered = catalogStorageScope();
  route("/d/device-a/");
  assert.equal(catalogStorageScope(), remembered);
  assert.notEqual(remembered, unpaired);
});
