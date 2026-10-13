import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createImagePreviewStore,
  memoryPreviewBackend,
  persistentImagePreviews,
  previewKey,
  purgeEmptySessionPreviews,
} from './image-preview-store.ts';
import { purgeRemovedSessionPreviews } from './session-catalog-cache.ts';
import { MarkdownSessionContext } from './MarkdownLink.tsx';
import { TranscriptRow, loadAttachmentThumbnail } from './transcript-row.tsx';
import { registerImagePreview } from './transcript-metrics.ts';

const url = (n, size = 10) => `data:image/webp;base64,${String(n).repeat(size)}`;

test('put/get round-trips through a fresh store on the same backend', async () => {
  const backend = memoryPreviewBackend();
  const first = createImagePreviewStore(backend);
  await first.put('s|a', 's', url('a'));
  const restarted = createImagePreviewStore(backend);
  assert.equal(restarted.peek('s|a'), undefined);
  assert.equal(await restarted.get('s|a'), url('a'));
  assert.equal(restarted.peek('s|a'), url('a'));
  assert.equal(await restarted.get('s|missing'), undefined);
});

test('the least recently used entries are evicted past the byte cap', async () => {
  const entry = url('x').length;
  const store = createImagePreviewStore(memoryPreviewBackend(), entry * 2 + 1);
  await store.put('k1', 's', url('1'));
  await store.put('k2', 's', url('2'));
  await store.get('k1');
  await store.put('k3', 's', url('3'));
  assert.equal(await store.get('k2'), undefined, 'k2 was the oldest');
  assert.equal(await store.get('k1'), url('1'));
  assert.equal(await store.get('k3'), url('3'));
});

test('deleting a session removes only its entries', async () => {
  const backend = memoryPreviewBackend();
  const store = createImagePreviewStore(backend);
  await store.put('a|1', 'a', url('1'));
  await store.put('b|1', 'b', url('2'));
  await store.deleteSession('a');
  const restarted = createImagePreviewStore(backend);
  assert.equal(await restarted.get('a|1'), undefined);
  assert.equal(await restarted.get('b|1'), url('2'));
});

const renderRow = (session, item) =>
  renderToStaticMarkup(
    React.createElement(
      MarkdownSessionContext.Provider,
      { value: session },
      React.createElement(TranscriptRow, { item })
    )
  );

function stubHost(impl) {
  globalThis.window ??= {};
  const calls = [];
  globalThis.window.mixdogDesktop = {
    readAttachmentThumbnail: (ref) => {
      calls.push(ref);
      return impl(ref);
    },
  };
  return calls;
}

const asIs = async (dataUrl) => dataUrl;

test('a row with an attachmentRef and no live preview fetches the thumbnail and caches it', async () => {
  const calls = stubHost(async () => url('F'));
  const item = {
    kind: 'user',
    id: 'u-f',
    text: 'hi',
    images: [{ id: 1, bytes: 4, name: 'f.png', attachmentRef: 'ref-f' }],
  };
  assert.doesNotMatch(renderRow('chat-f', item), /<img/);
  assert.equal(await loadAttachmentThumbnail('chat-f', 'ref-f', asIs), url('F'));
  assert.deepEqual(calls, ['ref-f']);
  assert.equal(persistentImagePreviews.peek(previewKey('chat-f', 'attachment:ref-f')), url('F'));
  assert.match(renderRow('chat-f', item), new RegExp(`<img[^>]+src="${url('F')}"`));
});

test('the host picture is fitted to thumbnail size before it is cached', async () => {
  stubHost(async () => url('BIG'));
  assert.equal(await loadAttachmentThumbnail('chat-z', 'ref-z', async () => url('SMALL')), url('SMALL'));
  assert.equal(persistentImagePreviews.peek(previewKey('chat-z', 'attachment:ref-z')), url('SMALL'));
});

test('a restored row finds each chip’s original by the line that draws it', async () => {
  await persistentImagePreviews.put(previewKey('chat-m', 'attachment:ref-b'), 'chat-m', url('B'));
  await persistentImagePreviews.put(previewKey('chat-m', 'attachment:ref-c'), 'chat-m', url('C'));
  const omitted = '[Image omitted from stored history: too large]';
  const text = `look\n${omitted}\n[Image: source: b.png, 20x20]\n[Image: image/png]\n[Image: image/png]`;
  const imageRefs = [
    { line: '[Image: source: b.png, 20x20]', ref: 'ref-b' },
    { line: '[Image: image/png]', ref: 'ref-none' },
    { line: '[Image: image/png]', ref: 'ref-c' },
  ];
  const markup = renderRow('chat-m', { kind: 'user', id: 'h1', text, imageRefs });
  // The omitted chip takes no picture; b.png gets B; the bare lines get theirs in order.
  const sources = [...markup.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sources, [url('B'), url('C')]);
  assert.ok(markup.indexOf(url('B')) > markup.indexOf('Image'));
});

test('an image without a stored original keeps an empty slot before one that has it', async () => {
  await persistentImagePreviews.put(previewKey('chat-s', 'attachment:ref-2'), 'chat-s', url('TWO'));
  const text = 'look\n[Image: image/png]\n[Image: image/png]';
  const imageRefs = [{ line: '[Image: image/png]' }, { line: '[Image: image/png]', ref: 'ref-2' }];
  const markup = renderRow('chat-s', { kind: 'user', id: 's1', text, imageRefs });
  const sources = [...markup.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  // The first chip claims the empty slot, so the picture belongs to the second card.
  assert.deepEqual(sources, [url('TWO')]);
});

test('a store hit makes no host call', async () => {
  const calls = stubHost(async () => url('H'));
  await persistentImagePreviews.put(previewKey('chat-h', 'attachment:ref-h'), 'chat-h', url('S'));
  assert.equal(await loadAttachmentThumbnail('chat-h', 'ref-h', asIs), url('S'));
  assert.deepEqual(calls, []);
});

test('two rows with the same ref make one host call; a missing picture is not asked again', async () => {
  let release;
  const calls = stubHost(() => new Promise((resolve) => (release = resolve)));
  const a = loadAttachmentThumbnail('chat-s', 'ref-s', asIs);
  const b = loadAttachmentThumbnail('chat-s', 'ref-s', asIs);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release(url('D'));
  assert.deepEqual(await Promise.all([a, b]), [url('D'), url('D')]);
  assert.deepEqual(calls, ['ref-s']);
  const failing = stubHost(async () => null);
  assert.equal(await loadAttachmentThumbnail('chat-x', 'ref-x', asIs), undefined);
  assert.equal(await loadAttachmentThumbnail('chat-x', 'ref-x', asIs), undefined);
  assert.deepEqual(failing, ['ref-x']);
});

test('a failed host call is retried once the host answers again', async () => {
  let down = true;
  const calls = stubHost(async () => {
    if (down) throw new Error('host unreachable');
    return url('R');
  });
  assert.equal(await loadAttachmentThumbnail('chat-r', 'ref-r', asIs), undefined);
  down = false;
  assert.equal(await loadAttachmentThumbnail('chat-r', 'ref-r', asIs), url('R'));
  assert.deepEqual(calls, ['ref-r', 'ref-r']);
});

test('the empty-session entries are purged once', async () => {
  const store = createImagePreviewStore(memoryPreviewBackend());
  const flags = new Map();
  const storage = { getItem: (k) => flags.get(k) ?? null, setItem: (k, v) => flags.set(k, v) };
  await store.put('|legacy', '', url('1'));
  await store.put('s|keep', 's', url('2'));
  await purgeEmptySessionPreviews(store, storage);
  assert.equal(await store.get('|legacy'), undefined);
  assert.equal(await store.get('s|keep'), url('2'));
  await store.put('|again', '', url('3'));
  await purgeEmptySessionPreviews(store, storage);
  assert.equal(await store.get('|again'), url('3'), 'already purged: not run again');
});

test('eviction and session deletion see what other windows wrote', async () => {
  const entry = url('x').length;
  const backend = memoryPreviewBackend();
  const a = createImagePreviewStore(backend, entry * 2 + 1);
  const b = createImagePreviewStore(backend, entry * 2 + 1);
  await a.put('a1', 'sa', url('1'));
  await b.put('b1', 'sb', url('2'));
  await a.put('a2', 'sa', url('3'));
  const fresh = createImagePreviewStore(backend);
  assert.equal(await fresh.get('a1'), undefined, 'the shared cap evicted the oldest across windows');
  assert.equal(await fresh.get('b1'), url('2'));
  await a.deleteSession('sb');
  assert.equal(
    await createImagePreviewStore(backend).get('b1'),
    undefined,
    'a session delete reaches entries another window wrote'
  );
});

test('two chats whose first attachments share id 1 and size each show their own picture', () => {
  registerImagePreview('sub-a', 1, 4, 'data:image/png;base64,AAAA');
  registerImagePreview('sub-b', 1, 4, 'data:image/png;base64,BBBB');
  const markup = (session, id) =>
    renderToStaticMarkup(
      React.createElement(
        MarkdownSessionContext.Provider,
        { value: session },
        React.createElement(TranscriptRow, {
          item: { kind: 'user', id, text: 'hi', images: [{ id: 1, bytes: 4, name: 'p.png' }] },
        })
      )
    );
  globalThis.window ??= {};
  assert.match(markup('chat-a', 'sub-a'), /src="data:image\/png;base64,AAAA"/);
  assert.match(markup('chat-b', 'pending:sub-b'), /src="data:image\/png;base64,BBBB"/);
  assert.doesNotMatch(markup('chat-c', 'sub-c'), /<img/, 'an unrelated message resolves nothing');
});

test('deleting a session clears this window even when another window already deleted the records', async () => {
  const backend = memoryPreviewBackend();
  const a = createImagePreviewStore(backend);
  const b = createImagePreviewStore(backend);
  await a.put('s|1', 's', url('1'));
  await b.deleteSession('s');
  assert.equal(a.peek('s|1'), url('1'));
  await a.deleteSession('s');
  assert.equal(a.peek('s|1'), undefined);
  assert.equal(await a.get('s|1'), undefined);
});

test('a removed session in the catalog deletes its previews, a listed or kept one does not', async () => {
  await persistentImagePreviews.put('gone|1', 'gone', url('1'));
  await persistentImagePreviews.put('stay|1', 'stay', url('2'));
  await persistentImagePreviews.put('new|1', 'new', url('3'));
  const row = (id) => ({ id });
  purgeRemovedSessionPreviews([row('gone'), row('stay'), row('new')], [row('stay')], new Set(['new']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await persistentImagePreviews.get('gone|1'), undefined);
  assert.equal(await persistentImagePreviews.get('stay|1'), url('2'));
  assert.equal(await persistentImagePreviews.get('new|1'), url('3'));
});
