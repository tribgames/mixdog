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

const { ClipLoadCancelled, useGeneratedMediaFallback } =await import('./generated-media-fallback.ts');

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
  await assert.rejects(pending, ClipLoadCancelled);
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

test('a reloaded clip revokes the one it replaces, and an asset change revokes the last', async () => {
  created.length = 0;
  revoked.length = 0;
  const release = deferred();
  release.resolve();
  const result = {};
  const Probe = ({ id }) => {
    result.current = useGeneratedMediaFallback(clipApi(release), id, 'video', true);
    return null;
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe, { id: 'a1' })));
  const first = await result.current.loadClip();
  const second = await result.current.loadClip();
  assert.deepEqual(revoked, [first]);
  await act(async () => root.render(React.createElement(Probe, { id: 'a2' })));
  assert.deepEqual(revoked, [first, second]);
  assert.equal(result.current.clip, '', 'a revoked clip is never handed out');
  await act(async () => root.unmount());
  assert.deepEqual(revoked, [first, second]);
});

test('the clip the hook shows is cleared with its revoke and loads again on the next click', async () => {
  created.length = 0;
  revoked.length = 0;
  const release = deferred();
  release.resolve();
  const result = {};
  const Probe = ({ enabled }) => {
    result.current = useGeneratedMediaFallback(clipApi(release), 'a1', 'video', enabled);
    return null;
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe, { enabled: true })));
  await act(async () => {
    await result.current.loadClip();
  });
  assert.equal(result.current.clip, created[0]);
  await act(async () => root.render(React.createElement(Probe, { enabled: false })));
  assert.equal(result.current.clip, '');
  await act(async () => root.render(React.createElement(Probe, { enabled: true })));
  assert.equal(result.current.clip, '');
  await act(async () => {
    await result.current.loadClip();
  });
  assert.equal(result.current.clip, created[1]);
  assert.deepEqual(revoked, [created[0]]);
  await act(async () => root.unmount());
});

async function mountStill(api, assetId = 'a1') {
  const result = {};
  const Probe = ({ id }) => {
    result.current = useGeneratedMediaFallback(api, id, 'image', true);
    return null;
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe, { id: assetId })));
  return { result, root, rerender: (id) => act(async () => root.render(React.createElement(Probe, { id }))) };
}

const stillApi = {
  invokeCapability: async () => ({ value: { base64: 'AAAA', mime: 'image/webp' } }),
};

test('the still is an object URL over its bytes, revoked on replace and on unmount', async () => {
  created.length = 0;
  revoked.length = 0;
  const { result, root, rerender } = await mountStill(stillApi);
  await act(async () => {});
  assert.equal(result.current.still, created[0]);
  assert.match(result.current.still, /^blob:/);
  await rerender('a2');
  await act(async () => {});
  assert.deepEqual(revoked, [created[0]]);
  assert.equal(result.current.still, created[1]);
  await act(async () => root.unmount());
  assert.deepEqual(revoked, [created[0], created[1]]);
});

test('a still read that lands after unmount is revoked at once', async () => {
  created.length = 0;
  revoked.length = 0;
  const release = deferred();
  const api = {
    invokeCapability: async () => {
      await release.promise;
      return { value: { base64: 'AAAA', mime: 'image/png' } };
    },
  };
  const { root } = await mountStill(api);
  await act(async () => root.unmount());
  release.resolve();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
});
