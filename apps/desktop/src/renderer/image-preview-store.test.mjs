import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  claimSentImage,
  createImagePreviewStore,
  discardSentImages,
  memoryPreviewBackend,
  persistentImagePreviews,
  previewKey,
  purgeEmptySessionPreviews,
  sentImageIdentity,
  stageSentImages,
} from './image-preview-store.ts';
import { purgeRemovedSessionPreviews } from './session-catalog-cache.ts';
import { MarkdownSessionContext } from './MarkdownLink.tsx';
import { TranscriptRow } from './transcript-row.tsx';
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

test('a restored message shows its stored thumbnail on marker chips', async () => {
  const line = '[Image: visualize pin 1 · input, 177x21]';
  await persistentImagePreviews.put(
    previewKey('sess-1', sentImageIdentity('m-1', 0, line)),
    'sess-1',
    'data:image/webp;base64,AAAA'
  );
  // Legacy shapes never show: another message id, and the empty-session copy.
  await persistentImagePreviews.put(previewKey('sess-1', line), 'sess-1', 'data:image/webp;base64,LEGACY');
  await persistentImagePreviews.put(
    previewKey('', sentImageIdentity('m-1', 0, line)),
    '',
    'data:image/webp;base64,EMPTY'
  );
  const markup = (session, id, messageId) =>
    renderToStaticMarkup(
      React.createElement(
        MarkdownSessionContext.Provider,
        { value: session },
        React.createElement(TranscriptRow, {
          item: { kind: 'user', id, ...(messageId ? { messageId } : {}), text: `look\n${line}` },
        })
      )
    );
  globalThis.window ??= {};
  assert.match(markup('sess-1', 'u1', 'm-1'), /<img[^>]+src="data:image\/webp;base64,AAAA"/);
  // The restored row of the same message has another id but the same messageId.
  assert.match(markup('sess-1', 'hist_sess-1_4_0', 'm-1'), /<img[^>]+src="data:image\/webp;base64,AAAA"/);
  assert.doesNotMatch(markup('other', 'u1', 'm-1'), /<img/);
  assert.doesNotMatch(markup('sess-1', 'u1', 'm-2'), /<img/, 'a different message is a different picture');
  assert.doesNotMatch(markup('sess-1', 'u1'), /<img/, 'old history without a messageId keeps the icon card');
});

test('same-named pictures of different messages or positions keep their own thumbnails', async () => {
  const store = createImagePreviewStore(memoryPreviewBackend());
  const line = '[Image: source: shot.png, 100x100]';
  await store.put(previewKey('s', sentImageIdentity('m1', 0, line)), 's', url('1'));
  await store.put(previewKey('s', sentImageIdentity('m1', 1, line)), 's', url('2'));
  await store.put(previewKey('s', sentImageIdentity('m2', 0, line)), 's', url('3'));
  assert.equal(await store.get(previewKey('s', sentImageIdentity('m1', 0, line))), url('1'));
  assert.equal(await store.get(previewKey('s', sentImageIdentity('m1', 1, line))), url('2'));
  assert.equal(await store.get(previewKey('s', sentImageIdentity('m2', 0, line))), url('3'));
});

test('a new chat first send is saved under the session its row renders in, once', async () => {
  const line = '[Image: source: first.png, 10x10]';
  stageSentImages('sub-1', [{ line, dataUrl: 'data:image/png;base64,Z' }], async () => url('T'));
  assert.equal(await claimSentImage('', 'sub-1', 'msg-1', 0, line), undefined, 'no session yet: nothing is saved');
  assert.equal(await claimSentImage('chat-a', 'sub-1', '', 0, line), undefined, 'no messageId yet');
  assert.equal(await claimSentImage('chat-a', 'sub-9', 'msg-1', 0, line), undefined, 'another submission');
  assert.equal(await claimSentImage('chat-a', 'sub-1', 'msg-1', 0, line), url('T'));
  assert.equal(await persistentImagePreviews.get(previewKey('chat-a', sentImageIdentity('msg-1', 0, line))), url('T'));
  assert.equal(await persistentImagePreviews.get(previewKey('', sentImageIdentity('msg-1', 0, line))), undefined);
  assert.equal(await claimSentImage('chat-b', 'sub-1', 'msg-1', 0, line), undefined, 'another chat cannot take it');
});

test('a preview saved by a live row is found by the restored row of the same message only', async () => {
  const line = '[Image: source: live.png, 20x20]';
  stageSentImages('sub-live', [{ line, dataUrl: 'x' }], async () => 'data:image/webp;base64,LIVE');
  await claimSentImage('chat-l', 'sub-live', 'msg-live', 0, line);
  const markup = (id, messageId) =>
    renderToStaticMarkup(
      React.createElement(
        MarkdownSessionContext.Provider,
        { value: 'chat-l' },
        React.createElement(TranscriptRow, { item: { kind: 'user', id, messageId, text: `hi\n${line}` } })
      )
    );
  globalThis.window ??= {};
  assert.match(markup('hist_chat-l_2_0', 'msg-live'), /<img[^>]+src="data:image\/webp;base64,LIVE"/);
  assert.doesNotMatch(markup('hist_chat-l_2_0', 'msg-other'), /<img/);
});

test('a refused send keeps no staged thumbnail', async () => {
  const line = '[Image: source: r.png, 10x10]';
  stageSentImages('sub-r', [{ line, dataUrl: 'x' }], async () => url('R'));
  discardSentImages('sub-r');
  assert.equal(await claimSentImage('chat-r', 'sub-r', 'msg-r', 0, line), undefined);
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
