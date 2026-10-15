import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createImagePreviewStore,
  deleteSessionImagePreviews,
  memoryPreviewBackend,
  previewKey,
} from './image-preview-store.ts';
import { rememberThumbnail, resetSavedThumbnails } from './persisted-thumbnail.ts';

const png = `data:image/png;base64,${'A'.repeat(40)}`;

test('a captured snapshot is kept and restored by a fresh store after a restart', async () => {
  resetSavedThumbnails();
  const backend = memoryPreviewBackend();
  const key = previewKey('sess', 'file|design/mockups/pricing.html');
  await rememberThumbnail(key, 'sess', png, { store: createImagePreviewStore(backend) });
  const restarted = createImagePreviewStore(backend);
  assert.equal(await restarted.get(key), png);
  assert.equal(await restarted.get(previewKey('sess', 'file|other.html')), undefined);
});

test('a non-data source is downscaled before it is kept; a failed capture keeps nothing', async () => {
  resetSavedThumbnails();
  const store = createImagePreviewStore(memoryPreviewBackend());
  await rememberThumbnail('k1', 's', 'blob:x', { store, make: async () => 'data:image/webp;base64,BBBB' });
  assert.equal(await store.get('k1'), 'data:image/webp;base64,BBBB');
  await rememberThumbnail('k2', 's', 'blob:y', {
    store,
    make: async () => {
      throw new Error('tainted');
    },
  });
  assert.equal(await store.get('k2'), undefined);
});

test('the saved set is bounded and a deleted session is forgotten', async () => {
  resetSavedThumbnails();
  const store = createImagePreviewStore(memoryPreviewBackend());
  const url = `data:image/png;base64,${'Q'.repeat(100)}`;
  await rememberThumbnail('k', 's', url, { store });
  await store.deleteSession('s');
  await rememberThumbnail('k', 's', url, { store });
  assert.equal(await store.get('k'), undefined, 'already marked saved this run');
  deleteSessionImagePreviews('s');
  await rememberThumbnail('k', 's', url, { store });
  assert.equal(await store.get('k'), url, 'forgotten with its session, saved again');
  for (let i = 0; i < 700; i += 1) await rememberThumbnail(`b${i}`, 'big', `data:image/png;base64,${i}`, { store });
  await store.deleteSession('big');
  await rememberThumbnail('b699', 'big', 'data:image/png;base64,699', { store });
  assert.equal(await store.get('b699'), undefined, 'recent markers are kept');
  await rememberThumbnail('b0', 'big', 'data:image/png;base64,0', { store });
  assert.equal(await store.get('b0'), 'data:image/png;base64,0', 'oldest markers were dropped past the cap');
});

test('a file snapshot is saved once per file version and reused; failures fall back quietly', async () => {
  const { fileSnapshot } = await import('./persisted-thumbnail.ts');
  resetSavedThumbnails();
  const store = createImagePreviewStore(memoryPreviewBackend());
  let captures = 0;
  let info = { mtimeMs: 1, size: 10 };
  const api = {
    statProjectFile: async () => info,
    captureFileSnapshot: async () => ({ dataUrl: `data:image/png;base64,S${++captures}`, ...info }),
  };
  const target = { project: '/p', path: 'design/index.html' };
  assert.equal(await fileSnapshot('s', target, api, store), 'data:image/png;base64,S1');
  assert.equal(await fileSnapshot('s', target, api, store), 'data:image/png;base64,S1');
  assert.equal(captures, 1, 'second read came from the store');
  info = { mtimeMs: 2, size: 12 };
  assert.equal(await fileSnapshot('s', target, api, store), 'data:image/png;base64,S2');
  // Unsupported host, wrong type, failing capture: nothing (the card keeps its monogram).
  assert.equal(await fileSnapshot('s', target, { statProjectFile: api.statProjectFile }, store), undefined);
  assert.equal(await fileSnapshot('s', { project: '/p', path: 'a.js' }, api, store), undefined);
  const failing = {
    ...api,
    captureFileSnapshot: async () => {
      throw new Error('timeout');
    },
  };
  info = { mtimeMs: 3, size: 1 };
  assert.equal(await fileSnapshot('s', target, failing, store), undefined);
  assert.equal(await fileSnapshot('s', target, api, store), undefined, 'a failed version is not retried');
});
