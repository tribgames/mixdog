import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const here = (path) => new URL(path, import.meta.url).href;
const saved = [];
let generate = async () => ({ bytes: Buffer.from('png'), mime: 'image/png' });
let adapterCalls = [];

mock.module(here('./lanes.mjs'), {
  namedExports: {
    mediaError: (message, code, status) => Object.assign(new Error(message), { code, status }),
    // The fake gemini lane stands in for an account-backed lane.
    mediaLaneAccountProvider: (lane) => (lane === 'gemini' ? 'openai-oauth' : ''),
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
const { currentProviderAccountId } = await import('../shared/provider-auth-binding.mjs');

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

test('a job started with an account runs the adapter as that account, whatever the caller is using', async () => {
  const account = '0b1c2d3e-0000-4000-8000-000000000001';
  const seen = [];
  generate = async () => {
    seen.push(currentProviderAccountId('openai-oauth'));
    return { bytes: Buffer.from('png'), mime: 'image/png' };
  };
  const pinned = await startMediaJob({ lane: 'gemini', kind: 'image', model: 'm1', prompt: 'a', account });
  assert.equal((await settled(pinned.id)).status, 'done');
  const plain = await startMediaJob({ lane: 'gemini', kind: 'image', model: 'm1', prompt: 'b' });
  assert.equal((await settled(plain.id)).status, 'done');
  assert.equal(seen[0], account);
  assert.notEqual(seen[1], account, 'without a pinned account the job follows the current one');
});
