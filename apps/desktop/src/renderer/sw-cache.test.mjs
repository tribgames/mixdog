import assert from "node:assert/strict";
import test from "node:test";

import { loadWorker, memoryCacheStorage, WORKER_ORIGIN } from "./sw-test-harness.mjs";

const shellMarkup = (label) => `${label}<meta name="mixdog-shell-version" content="${label}">`
  + '<meta name="mixdog-shell-assets" content="assets/bootstrap-12345678.js">';

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
    match: async () => new Response(shellMarkup("cached shell")),
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
  assert.equal(await result.response.text(), shellMarkup("cached shell"));
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
    match: async () => new Response(shellMarkup(cached)),
    put: async () => undefined,
    keys: async () => [],
    delete: async () => true,
  };
}

function shellNetwork(body) {
  return async () => {
    const response = new Response(shellMarkup(body));
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
  assert.equal(await result.response.text(), shellMarkup("old shell"));
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

  assert.equal(await result.response.text(), shellMarkup("first shell"));
  assert.deepEqual(posted, []);
});

test("an evicted bootstrap uses the fresh document instead of a broken cached release", async () => {
  const caches = memoryCacheStorage();
  const url = `${WORKER_ORIGIN}/d/device/`;
  await (await caches.open("mixdog-shell-v1")).put(url, new Response(shellMarkup("old")));
  const worker = loadWorker({ caches, fetchAsset: shellNetwork("new") });
  const result = await worker.shellFirst({ url, mode: "navigate" });
  assert.equal(await result.response.text(), shellMarkup("new"));
});

test("a late-starting page recovers a missed release notification by querying its version", async () => {
  const caches = memoryCacheStorage();
  const url = `${WORKER_ORIGIN}/d/device/`;
  await (await caches.open("mixdog-shell-v1")).put(url, new Response(shellMarkup("new")));
  const worker = loadWorker({ caches });
  const messages = [];
  let done;
  worker.listeners.get("message")({
    data: { type: "mixdog:shell-check", version: "old" },
    source: { url, postMessage: (message) => messages.push(message) },
    waitUntil: (promise) => { done = promise; },
  });
  await done;
  assert.equal(messages[0]?.type, worker.SHELL_UPDATE_MESSAGE);
  assert.equal(messages[0]?.version, "new");
  messages.length = 0;
  worker.listeners.get("message")({
    data: { type: "mixdog:shell-check", version: "new" },
    source: { url, postMessage: (message) => messages.push(message) },
    waitUntil: (promise) => { done = promise; },
  });
  await done;
  assert.equal(messages.length, 0);
});

test("shell cache quota failure still returns the first successful network response", async () => {
  let requests = 0;
  const worker = loadWorker({
    cache: {
      match: async () => undefined,
      put: async () => { throw new Error("QuotaExceededError"); },
    },
    fetchAsset: async () => {
      requests += 1;
      return shellNetwork("new")();
    },
  });
  const result = await worker.shellFirst({ url: `${WORKER_ORIGIN}/`, mode: "navigate" });
  assert.equal(await result.response.text(), shellMarkup("new"));
  assert.equal(requests, 1);
});

test("a missing lazy chunk refreshes only its owner's shell and reports a recoverable release", async () => {
  const caches = memoryCacheStorage();
  const url = `${WORKER_ORIGIN}/d/device/`;
  const messages = [];
  const worker = loadWorker({
    caches,
    windows: [{ id: "page", url, postMessage: (message) => messages.push(message) }],
    fetchAsset: async (request) => new URL(request.url).pathname.startsWith("/assets/")
      ? new Response("missing", { status: 404 })
      : shellNetwork("new")(),
  });
  let answer, done;
  worker.listeners.get("fetch")({
    clientId: "page",
    request: new Request(`${WORKER_ORIGIN}/assets/lazy-12345678.js`),
    respondWith: (promise) => { answer = promise; },
    waitUntil: (promise) => { done = promise; },
  });
  assert.equal((await answer).status, 404);
  await done;
  assert.equal(messages[0]?.version, "new");
  assert.equal(await (await (await caches.open("mixdog-shell-v1")).match(url)).text(), shellMarkup("new"));
});

test("share and notification query variants reuse one document per device", async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches, fetchAsset: shellNetwork("new") });
  for (let index = 0; index < 30; index += 1) {
    const result = await worker.shellFirst({
      url: `${WORKER_ORIGIN}/d/a/?shared=${index}&sessionId=${index}`,
    });
    await result.maintenance;
  }
  const other = await worker.shellFirst({ url: `${WORKER_ORIGIN}/d/b/?sessionId=1` });
  await other.maintenance;
  const documents = caches.peek("mixdog-shell-v1");
  assert.deepEqual((await documents.keys()).map(key => key.url).sort(), [
    `${WORKER_ORIGIN}/d/a/`, `${WORKER_ORIGIN}/d/b/`,
  ]);
});

test("document cache bounds both route count and retained bytes", async () => {
  for (const body of [shellMarkup("small"), shellMarkup("large") + "x".repeat(400_000)]) {
    const caches = memoryCacheStorage();
    const worker = loadWorker({
      caches,
      fetchAsset: async () => {
        const response = new Response(body);
        Object.defineProperty(response, "type", { value: "basic" });
        return response;
      },
    });
    for (let index = 0; index < 20; index += 1) {
      const result = await worker.shellFirst({ url: `${WORKER_ORIGIN}/d/${index}/` });
      await result.maintenance;
    }
    const documents = caches.peek("mixdog-shell-v1");
    const keys = await documents.keys();
    let bytes = 0;
    for (const key of keys) bytes += (await (await documents.match(key)).arrayBuffer()).byteLength;
    assert.ok(keys.length <= 16);
    assert.ok(bytes <= 4 * 1024 * 1024);
    assert.ok(await documents.match(`${WORKER_ORIGIN}/d/19/`));
  }
});

test("oversized and non-shell responses remain usable without entering document storage", async () => {
  const caches = memoryCacheStorage();
  const body = "x".repeat(600_000);
  const worker = loadWorker({
    caches,
    fetchAsset: async () => {
      const response = new Response(body);
      Object.defineProperty(response, "type", { value: "basic" });
      return response;
    },
  });
  for (const path of ["/d/a/", "/not-an-app-document"]) {
    const result = await worker.shellFirst({ url: `${WORKER_ORIGIN}${path}` });
    assert.equal(await result.response.text(), body);
    await result.maintenance;
  }
  assert.equal(caches.peek("mixdog-shell-v1").size, 0);
});

test("the next successful refresh retires legacy query copies without deleting another cache", async () => {
  const caches = memoryCacheStorage();
  const documents = await caches.open("mixdog-shell-v1");
  await documents.put(`${WORKER_ORIGIN}/d/a/?shared=legacy`, new Response(shellMarkup("old")));
  const unrelated = await caches.open("mixdog-share-v1");
  await unrelated.put(`${WORKER_ORIGIN}/shared-file`, new Response("user image"));
  const worker = loadWorker({ caches, fetchAsset: shellNetwork("new") });
  const result = await worker.shellFirst({ url: `${WORKER_ORIGIN}/d/a/` });
  await result.maintenance;
  assert.equal(documents.size, 1);
  assert.equal(await documents.match(`${WORKER_ORIGIN}/d/a/?shared=legacy`), undefined);
  assert.equal(unrelated.size, 1);
});
