import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useStudioMediaJobs } from './studio-media-state.ts';

test('Studio polls every job in bounded batches at the existing cadence and surfaces failures', async (context) => {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://mixdog.test/' });
  const originals = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let poll;
  let delay;
  let cleared = 0;
  const interval = {};
  context.mock.method(globalThis, 'setInterval', (callback, ms) => {
    poll = callback;
    delay = ms;
    return interval;
  });
  context.mock.method(globalThis, 'clearInterval', (handle) => {
    assert.equal(handle, interval);
    cleared += 1;
  });
  const jobs = Array.from({ length: 35 }, (_, index) => ({
    id: `job-${index}`, status: 'running', kind: 'image', lane: 'lane', model: 'model',
    progress: 0, assetId: null, error: null,
  }));
  const batches = [];
  let progress = 1;
  let failed = false;
  const api = {
    async readCapabilities(requests) {
      batches.push(requests);
      return requests.map(({ args }) => failed
        ? { ok: false, error: 'job status unavailable' }
        : { ok: true, value: { ...jobs.find((job) => job.id === args[0]), progress } });
    },
    invokeCapability() { assert.fail('Job polling must use the value-only transport.'); },
  };
  const errors = [];
  const setError = (error) => errors.push(error);
  const refreshAssetKind = async () => { assert.fail('Running jobs have no completed asset.'); };
  const assets = [];
  let current;
  function Harness() {
    current = useStudioMediaJobs({ active: true, api, assets, refreshAssetKind, setError });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    assert.equal(cleared, 1);
    context.mock.restoreAll();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => current.setJobs(jobs));
  assert.equal(delay, 1_500);
  assert.deepEqual(batches.map((batch) => batch.length), [32, 3]);
  assert.deepEqual(batches.flat().map(({ args }) => args[0]), jobs.map(({ id }) => id));
  assert.deepEqual(current.jobs.map(({ progress }) => progress), jobs.map(() => 1));
  progress = 2;
  await act(async () => poll());
  assert.deepEqual(batches.map((batch) => batch.length), [32, 3, 32, 3]);
  assert.deepEqual(current.jobs.map(({ progress }) => progress), jobs.map(() => 2));
  failed = true;
  await act(async () => poll());
  assert.deepEqual(errors, ['job status unavailable']);
  assert.deepEqual(current.jobs.map(({ progress }) => progress), jobs.map(() => 2));
});
