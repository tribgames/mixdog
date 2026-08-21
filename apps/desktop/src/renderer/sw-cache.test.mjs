import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");

function loadWorker({ cache, fetchAsset = async () => {
  const response = new Response("asset");
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
} }) {
  const listeners = new Map();
  const context = {
    Headers,
    Promise,
    ReadableStream,
    Response,
    URL,
    caches: {
      keys: async () => [],
      open: async () => cache,
      delete: async () => true,
    },
    clearTimeout,
    fetch: fetchAsset,
    setTimeout,
    self: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      clients: { claim: async () => undefined },
      skipWaiting() {},
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${source}\n;globalThis.__swTest = { cacheFirst, scheduleAssetCacheTrim, storableCopy };`,
    context,
  );
  return { ...context.__swTest, listeners };
}

test("service-worker cache copies retain the body stream without encoded headers", async () => {
  let cloned = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed"));
      controller.close();
    },
  });
  const response = {
    headers: new Headers({
      "content-encoding": "br",
      "content-length": "8",
      "content-type": "text/plain",
    }),
    status: 200,
    statusText: "OK",
    clone() {
      cloned += 1;
      return { body };
    },
  };
  const { storableCopy } = loadWorker({ cache: {} });
  const copy = storableCopy(response);

  assert.equal(cloned, 1);
  assert.equal(copy.headers.has("content-encoding"), false);
  assert.equal(copy.headers.has("content-length"), false);
  assert.equal(await copy.text(), "streamed");
});

test("cache response is released before maintenance and burst trims coalesce", async () => {
  let releasePut;
  let keyScans = 0;
  const cache = {
    match: async () => null,
    put: async () => new Promise((resolve) => { releasePut = resolve; }),
    keys: async () => {
      keyScans += 1;
      return [];
    },
    delete: async () => true,
  };
  const { cacheFirst, scheduleAssetCacheTrim } = loadWorker({ cache });
  const result = await cacheFirst({ url: "https://relay/assets/bootstrap-hash.js" });

  assert.equal(result.response instanceof Response, true);
  assert.equal(typeof result.maintenance?.then, "function");
  let maintained = false;
  void result.maintenance.then(() => { maintained = true; });
  await Promise.resolve();
  assert.equal(maintained, false);

  releasePut();
  const firstTrim = scheduleAssetCacheTrim(cache);
  const secondTrim = scheduleAssetCacheTrim(cache);
  assert.equal(firstTrim, secondTrim);
  await Promise.all([result.maintenance, firstTrim]);
  assert.equal(keyScans, 1);
});
