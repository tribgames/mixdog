import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const here = (path) => new URL(path, import.meta.url).href;
const saved = [];
let generate = async () => ({ bytes: Buffer.from('png'), mime: 'image/png' });
let adapterCalls = [];

mock.module(here('./lanes.mjs'), {
  namedExports: {
    mediaError: (message, code, status) => Object.assign(new Error(message), { code, status }),
    resolveMediaRequest: async ({ model }) => ({
      kind: 'image',
      lane: { id: 'gemini' },
      model,
      spec: { models: [{ id: model, controls: { maxReferences: 1 } }] },
    }),
  },
});
mock.module(here('./store.mjs'), {
  namedExports: {
    saveMediaAsset: (asset) => {
      saved.push(asset);
      return { id: `asset-${saved.length}` };
    },
  },
});
mock.module(here('./defaults.mjs'), { namedExports: { setMediaDefault: () => {} } });
mock.module(here('./adapters/gemini-image.mjs'), {
  namedExports: {
    generateImage: (request) => {
      adapterCalls.push(request);
      return generate(request);
    },
  },
});
const { getMediaJob, startMediaJob } = await import('./jobs.mjs');

const settled = async (id) => {
  for (let i = 0; i < 200 && getMediaJob(id).status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  return getMediaJob(id);
};

test('a started job reports running, then stores the generated asset with the trimmed prompt', async () => {
  adapterCalls = [];
  const options = { aspectRatio: '1:1' };
  const references = [{ base64: 'AAA', mime: 'image/jpeg' }, { base64: 'BBB' }];
  const started = await startMediaJob({
    lane: 'gemini',
    kind: 'image',
    model: 'm1',
    prompt: '  a cat  ',
    options,
    references,
  });
  assert.equal(started.status, 'running');
  assert.equal(started.prompt, 'a cat');
  const done = await settled(started.id);
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 100);
  assert.equal(done.assetId, `asset-${saved.length}`);
  assert.equal(adapterCalls.length, 1);
  assert.equal(adapterCalls[0].prompt, 'a cat');
  assert.equal(adapterCalls[0].options, options);
  assert.deepEqual(adapterCalls[0].references, [{ base64: 'AAA', mime: 'image/jpeg' }]);
  const asset = saved.at(-1);
  assert.equal(asset.prompt, 'a cat');
  assert.deepEqual(asset.options, options);
  assert.notEqual(asset.options, options);
});

test('an adapter failure ends the job as failed with its message and code', async (t) => {
  t.mock.method(console, 'error', () => {});
  generate = async () => {
    throw Object.assign(new Error('upstream refused'), { code: 'MEDIA_UPSTREAM' });
  };
  const started = await startMediaJob({ lane: 'gemini', kind: 'image', model: 'm1', prompt: 'a dog' });
  const failed = await settled(started.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'upstream refused');
  assert.equal(failed.errorCode, 'MEDIA_UPSTREAM');
  assert.equal(typeof failed.endedAt, 'number');
});
