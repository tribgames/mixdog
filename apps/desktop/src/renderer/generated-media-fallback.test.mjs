// The RPC fallback of a generated-media card: a clip whose read finishes after
// the card has gone must not keep its object URL (the Blob) alive.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main id="root"></main></body></html>',
  jsdom: { url: 'https://relay.test/' },
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const created = [];
const revoked = [];
URL.createObjectURL = () => {
  const url = `blob:test/clip-${created.length}`;
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => revoked.push(url);

const { useGeneratedMediaFallback } = await import('./generated-media-fallback.ts');

async function mountFallback(api, wrap = (node) => node) {
  const result = {};
  const Probe = () => {
    result.current = useGeneratedMediaFallback(api, 'a1', 'video', true);
    return null;
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(wrap(React.createElement(Probe))));
  return { result, root };
}

const clipApi = (release) => ({
  invokeCapability: async () => {
    await release.promise;
    return { value: { base64: 'AAAA', mime: 'video/mp4' } };
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('a clip read that finishes after unmount revokes its object URL at once', async () => {
  created.length = 0;
  revoked.length = 0;
  const release = deferred();
  const { result, root } = await mountFallback(clipApi(release));
  const pending = result.current.loadClip();
  const outcome = pending.then(
    () => 'loaded',
    () => 'rejected'
  );
  await act(async () => root.unmount());
  release.resolve();
  assert.equal(await outcome, 'rejected');
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
});

test('a clip loaded while mounted is kept until unmount, also under StrictMode', async () => {
  created.length = 0;
  revoked.length = 0;
  const release = deferred();
  release.resolve();
  const { result, root } = await mountFallback(clipApi(release), (node) =>
    React.createElement(React.StrictMode, null, node)
  );
  const url = await result.current.loadClip();
  assert.equal(url, created[0]);
  assert.deepEqual(revoked, []);
  await act(async () => root.unmount());
  assert.deepEqual(revoked, [url]);
});
