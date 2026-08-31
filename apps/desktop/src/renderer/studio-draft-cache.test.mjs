import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;

const {
  readStudioAssetReferences,
  readStudioDraftMetadata,
  readStudioDraftReferences,
  removeStudioAssetReferences,
  writeStudioAssetReferences,
  writeStudioDraftMetadata,
  writeStudioDraftReferences,
} = await import('./studio-draft-cache.ts');

function memoryReferenceStore() {
  const values = new Map();
  return {
    values,
    async read(key) { return values.get(key); },
    async write(key, value) { values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
  };
}

test('the last Studio route, options, and prompt survive a metadata reload', () => {
  window.localStorage.clear();
  writeStudioDraftMetadata({
    kind: 'video',
    laneId: 'gemini',
    model: 'veo:3/preview',
    options: {
      aspectRatio: '16:9',
      resolution: '1080p',
      size: '2K',
      quality: 'high',
      duration: 8,
    },
    prompt: 'A cave entrance glowing at dusk',
  });

  assert.deepEqual(readStudioDraftMetadata(), {
    kind: 'video',
    laneId: 'gemini',
    model: 'veo:3/preview',
    options: {
      aspectRatio: '16:9',
      resolution: '1080p',
      size: '2K',
      quality: 'high',
      duration: 8,
    },
    prompt: 'A cave entrance glowing at dusk',
  });
});

test('draft and per-asset reference images survive cache round trips independently', async () => {
  const store = memoryReferenceStore();
  const draft = [{ base64: 'ZHJhZnQ=', mime: 'image/png' }];
  const asset = [{ base64: 'YXNzZXQ=', mime: 'image/jpeg' }];

  await writeStudioDraftReferences(draft, store);
  await writeStudioAssetReferences('asset-1', asset, store);

  assert.deepEqual(await readStudioDraftReferences(store), draft);
  assert.deepEqual(await readStudioAssetReferences('asset-1', store), asset);

  await removeStudioAssetReferences('asset-1', store);
  assert.deepEqual(await readStudioAssetReferences('asset-1', store), []);
  assert.deepEqual(await readStudioDraftReferences(store), draft);
});

test('invalid cached image payloads are ignored instead of breaking Studio', async () => {
  const store = memoryReferenceStore();
  store.values.set('draft:latest', {
    references: [
      { base64: 'valid', mime: 'image/webp' },
      { base64: '', mime: 'image/png' },
      { base64: 'not-an-image', mime: 'text/plain' },
    ],
  });

  assert.deepEqual(await readStudioDraftReferences(store), [
    { base64: 'valid', mime: 'image/webp' },
  ]);
});
