import assert from "node:assert/strict";
import test from "node:test";

import {
  getCachedConnectionInfo,
  preloadConnectionInfo,
} from "./connection-info.ts";

const readyInfo = (url) => ({
  relayBrowserUrl: url,
  relayBrowserQrSvg: `<svg data-url="${url}"/>`,
  clients: [],
});

test("a timed-out connection read releases the cache for a successful retry", async () => {
  let calls = 0;
  const expected = readyInfo("https://relay.example/device");
  const api = {
    getRemoteAccessInfo() {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return Promise.resolve(expected);
    },
  };

  assert.equal(await preloadConnectionInfo(api, 10), null);
  assert.deepEqual(await preloadConnectionInfo(api, 10), expected);
  assert.equal(calls, 2);
});

test("a late successful read survives retries that also exceed the deadline", async () => {
  let resolveFirst;
  let calls = 0;
  const expected = readyInfo("https://relay.example/late");
  const api = {
    getRemoteAccessInfo() {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise(() => {});
    },
  };

  assert.equal(await preloadConnectionInfo(api, 10), null);
  const retry = preloadConnectionInfo(api, 20);
  resolveFirst(expected);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(getCachedConnectionInfo(api), expected);
  assert.deepEqual(await preloadConnectionInfo(api, 10), expected);
  assert.deepEqual(await retry, expected);
  assert.equal(calls, 2);
});

test("a late timed-out response cannot replace a newer connection result", async () => {
  let resolveFirst;
  let calls = 0;
  const stale = readyInfo("https://relay.example/stale");
  const current = readyInfo("https://relay.example/current");
  const api = {
    getRemoteAccessInfo() {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(current);
    },
  };

  assert.equal(await preloadConnectionInfo(api, 10), null);
  assert.deepEqual(await preloadConnectionInfo(api, 10), current);
  resolveFirst(stale);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(getCachedConnectionInfo(api), current);
});
