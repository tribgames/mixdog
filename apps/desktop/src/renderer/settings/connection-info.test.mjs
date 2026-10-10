import assert from 'node:assert/strict';
import test from 'node:test';

import { getCachedConnectionInfo, preloadConnectionInfo, setCachedConnectionInfo } from './connection-info.ts';

const readyInfo = (url) => ({
  relayBrowserUrl: url,
  relayBrowserQrSvg: `<svg data-url="${url}"/>`,
  clients: [],
});

test('a timed-out connection read releases the cache for a successful retry', async () => {
  let calls = 0;
  const expected = readyInfo('https://relay.example/device');
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

test('a late successful read survives retries that also exceed the deadline', async () => {
  let resolveFirst;
  let calls = 0;
  const expected = readyInfo('https://relay.example/late');
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

test('a late timed-out response cannot replace a newer connection result', async () => {
  let resolveFirst;
  let calls = 0;
  const stale = readyInfo('https://relay.example/stale');
  const current = readyInfo('https://relay.example/current');
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

test('disconnect invalidation prevents a late ready response from restoring the old QR', async () => {
  const oldReply = Promise.withResolvers();
  const fresh = readyInfo('https://relay.example/reconnected');
  let calls = 0;
  const api = {
    getRemoteAccessInfo() {
      calls += 1;
      return calls === 1 ? oldReply.promise : Promise.resolve(fresh);
    },
  };

  assert.equal(await preloadConnectionInfo(api, 10), null);
  setCachedConnectionInfo(api, readyInfo('https://relay.example/old'));
  setCachedConnectionInfo(api, null);
  oldReply.resolve(readyInfo('https://relay.example/old'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getCachedConnectionInfo(api), null);
  assert.deepEqual(await preloadConnectionInfo(api), fresh);
});

// Mirrors the host contract: activate:false reads only, default activates.
function fakeHost({ activated }) {
  const state = { activated, seen: [] };
  const info = readyInfo('https://relay.example/warm');
  state.api = {
    getRemoteAccessInfo(options) {
      state.seen.push(options);
      if (options?.activate !== false) state.activated = true;
      return Promise.resolve(state.activated ? info : null);
    },
  };
  return state;
}

test('warm-up preload does not activate a fresh install', async () => {
  const host = fakeHost({ activated: false });
  assert.equal(await preloadConnectionInfo(host.api, 10, { activate: false }), null);
  assert.equal(host.activated, false);
  assert.deepEqual(host.seen, [{ activate: false }]);
});

test('opening the Connection page activates and gets the card', async () => {
  const host = fakeHost({ activated: false });
  await preloadConnectionInfo(host.api, 10, { activate: false });
  const info = await preloadConnectionInfo(host.api, 10);
  assert.equal(host.activated, true);
  assert.ok(info?.relayBrowserQrSvg);
});

test('an in-flight read-only preload does not satisfy an activating request', async () => {
  let resolveFirst;
  const seen = [];
  const api = {
    getRemoteAccessInfo(options) {
      seen.push(options);
      return seen.length === 1
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(readyInfo('https://relay.example/act'));
    },
  };
  const warm = preloadConnectionInfo(api, 50, { activate: false });
  const page = await preloadConnectionInfo(api, 50);
  assert.deepEqual(seen, [{ activate: false }, undefined]);
  assert.ok(page?.relayBrowserQrSvg);
  resolveFirst(null);
  await warm;
});

test('an activated install still gets warmed info without activating', async () => {
  const host = fakeHost({ activated: true });
  const info = await preloadConnectionInfo(host.api, 10, { activate: false });
  assert.ok(info?.relayBrowserQrSvg);
  assert.deepEqual(host.seen, [{ activate: false }]);
});
