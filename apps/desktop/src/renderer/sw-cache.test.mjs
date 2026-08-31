import assert from "node:assert/strict";
import test from "node:test";

import { loadWorker } from "./sw-test-harness.mjs";

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

test("a cached shell document answers without waiting for the network", async () => {
  let networkCalls = 0;
  let stored = null;
  const cache = {
    match: async () => new Response("cached shell"),
    put: async (_request, response) => { stored = response; },
    keys: async () => [],
    delete: async () => true,
  };
  const { shellFirst } = loadWorker({
    cache,
    fetchAsset: async () => {
      networkCalls += 1;
      const response = new Response("fresh shell");
      Object.defineProperty(response, "type", { value: "basic" });
      return response;
    },
  });
  const result = await shellFirst({ url: "https://relay/d/abc/", mode: "navigate" });

  // The paint gets the copy already on the device; the round trip runs behind it.
  assert.equal(await result.response.text(), "cached shell");
  assert.equal(typeof result.maintenance?.then, "function");
  await result.maintenance;
  assert.equal(networkCalls, 1);
  assert.equal(await stored.text(), "fresh shell");
});

test("a first launch with no cached shell still answers from the network", async () => {
  let stored = null;
  const cache = {
    match: async () => undefined,
    put: async (_request, response) => { stored = response; },
    keys: async () => [],
    delete: async () => true,
  };
  const { shellFirst } = loadWorker({ cache });
  const result = await shellFirst({ url: "https://relay/d/abc/", mode: "navigate" });

  assert.equal(await result.response.text(), "asset");
  assert.equal(result.maintenance, null);
  assert.equal(await stored.text(), "asset");
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

function shellCache(cached) {
  return {
    match: async () => new Response(cached),
    put: async () => undefined,
    keys: async () => [],
    delete: async () => true,
  };
}

function shellNetwork(body) {
  return async () => {
    const response = new Response(body);
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
}

test("a deploy found behind the paint is offered to the running app", async () => {
  const posted = [];
  const { shellFirst, SHELL_UPDATE_MESSAGE } = loadWorker({
    cache: shellCache("old shell"),
    windows: [{ postMessage: (message) => posted.push(message) }],
    fetchAsset: shellNetwork("new shell"),
  });
  const result = await shellFirst({ url: "https://relay/d/abc/", mode: "navigate" });

  // The paint is unchanged: the previous document still answers immediately.
  assert.equal(await result.response.text(), "old shell");
  await result.maintenance;
  // The worker builds its message inside its own realm, so compare values.
  assert.deepEqual(posted.map((message) => message.type), [SHELL_UPDATE_MESSAGE]);
});

test("an unchanged shell never disturbs the running app", async () => {
  const posted = [];
  const { shellFirst } = loadWorker({
    cache: shellCache("same shell"),
    windows: [{ postMessage: (message) => posted.push(message) }],
    fetchAsset: shellNetwork("same shell"),
  });
  const result = await shellFirst({ url: "https://relay/d/abc/", mode: "navigate" });
  await result.maintenance;

  assert.deepEqual(posted, []);
});

test("a first launch has no previous document to compare against", async () => {
  const posted = [];
  const { shellFirst } = loadWorker({
    cache: {
      match: async () => undefined,
      put: async () => undefined,
      keys: async () => [],
      delete: async () => true,
    },
    windows: [{ postMessage: (message) => posted.push(message) }],
    fetchAsset: shellNetwork("first shell"),
  });
  const result = await shellFirst({ url: "https://relay/d/abc/", mode: "navigate" });

  assert.equal(await result.response.text(), "first shell");
  assert.deepEqual(posted, []);
});
