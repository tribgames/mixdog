// "Save bytes on this device" and the paired-device behaviours built on it:
// the sink choice (phone app native save vs browser), the attachment bridge
// that used to open a blob tab, and generated media without a media lane.
import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';

import { NATIVE_FILE_SAVE_MAX_CHUNK_BYTES } from '../shared/native-file-save.ts';
import { blobFromUrl, FileSaveError, saveBlobWithSink } from './file-download-transfer.ts';
import { readMediaClip, readMediaStill } from './generated-media-fallback.ts';
import { installTestDom } from './test-support/test-dom.mjs';

function nativeSink(overrides = {}) {
  const calls = [];
  const call = async (method, args) => {
    calls.push([method, args]);
    if (overrides[method]) return overrides[method](args);
    switch (method) {
      case 'fileSaveBegin':
        return { ok: true, handle: 'h1' };
      case 'fileSaveWrite':
        return { ok: true, handle: 'h1', written: args.offset + Buffer.from(args.data, 'base64').length };
      case 'fileSaveFinish':
        return { ok: true, handle: 'h1', displayName: 'x', size: args.size, persisted: true };
      case 'fileSaveShare':
        return { ok: true, shared: true };
      default:
        return { ok: true, handle: 'h1' };
    }
  };
  return { sink: { kind: 'native', call }, calls };
}

test('a browser sink hands the blob to the browser delivery under the given name', async () => {
  const delivered = [];
  const blob = new Blob(['abc'], { type: 'text/plain' });
  const result = await saveBlobWithSink({ kind: 'browser' }, blob, 'a.txt', async (target, transfer) => {
    delivered.push([target.blob === blob, transfer]);
    return 'shared';
  });
  assert.equal(result, 'shared');
  assert.deepEqual(delivered, [[true, { name: 'a.txt', mime: 'text/plain' }]]);
});

test('the phone app saves natively: begin, acked chunks, finish, then its share sheet', async () => {
  const { sink, calls } = nativeSink();
  const size = NATIVE_FILE_SAVE_MAX_CHUNK_BYTES * 2 + 5;
  const result = await saveBlobWithSink(sink, new Blob([new Uint8Array(size)], { type: 'image/png' }), 'p.png', () => {
    throw new Error('the browser path must not run');
  });
  assert.equal(result, 'shared');
  assert.deepEqual(
    calls.map(([method]) => method),
    ['fileSaveBegin', 'fileSaveWrite', 'fileSaveWrite', 'fileSaveWrite', 'fileSaveFinish', 'fileSaveShare']
  );
  assert.deepEqual(calls[0][1], { name: 'p.png', mime: 'image/png', size, purpose: 'share' });
  assert.deepEqual(
    calls.filter(([method]) => method === 'fileSaveWrite').map(([, args]) => args.offset),
    [0, NATIVE_FILE_SAVE_MAX_CHUNK_BYTES, NATIVE_FILE_SAVE_MAX_CHUNK_BYTES * 2]
  );
});

test('a dismissed native share sheet is saved when the file persisted, dismissed when it did not', async () => {
  const dismissed = { fileSaveShare: () => ({ ok: true, shared: false }) };
  const kept = nativeSink(dismissed);
  assert.equal(await saveBlobWithSink(kept.sink, new Blob(['x']), 'a.txt'), 'saved');
  const staged = nativeSink({
    ...dismissed,
    fileSaveFinish: (args) => ({ ok: true, handle: 'h1', displayName: 'a', size: args.size, persisted: false }),
  });
  assert.equal(await saveBlobWithSink(staged.sink, new Blob(['x']), 'a.txt'), 'dismissed');
  const cancelled = nativeSink({ fileSaveBegin: () => ({ ok: false, error: 'cancelled' }) });
  assert.equal(await saveBlobWithSink(cancelled.sink, new Blob(['x']), 'a.txt'), 'dismissed');
});

test('a failed native write aborts the partial file and rejects; no sink rejects as no-sink', async () => {
  const failing = nativeSink({ fileSaveWrite: () => ({ ok: false, error: 'storage' }) });
  await assert.rejects(saveBlobWithSink(failing.sink, new Blob(['x']), 'a.txt'), FileSaveError);
  assert.ok(failing.calls.some(([method]) => method === 'fileSaveAbort'));
  await assert.rejects(saveBlobWithSink({ kind: 'none' }, new Blob(['x']), 'a.txt'), { reason: 'no-sink' });
});

test('a data URL is decoded without fetch', async () => {
  const blob = await blobFromUrl('data:text/plain;base64,aGk=');
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blob.text(), 'hi');
});

test('attachment "Save as" on a paired browser fetches the bytes and reports the real outcome', async (t) => {
  const { window } = installTestDom(t, { globals: { navigator: { userAgent: 'MixdogApp/1.0 Android' } } });
  const { sink, calls } = nativeSink({ fileSaveShare: () => ({ ok: true, shared: false }) });
  window.mixdogNative = {
    platform: 'android',
    version: '1',
    call: async (method, args) => {
      if (method === 'getNativeCapabilities') return { fileSave: 1 };
      return sink.call(method, args);
    },
  };
  const { REMOTE_BROWSER_FALLBACKS } = await import('./remote-browser-fallbacks.ts');
  assert.equal(await REMOTE_BROWSER_FALLBACKS.saveFileAs('data:text/plain;base64,aGk=', 'n.txt'), true);
  assert.deepEqual(calls[0], ['fileSaveBegin', { name: 'n.txt', mime: 'text/plain', size: 2, purpose: 'share' }]);
  await assert.rejects(REMOTE_BROWSER_FALLBACKS.saveFileAs('file:///etc/passwd', 'x'), TypeError);
});

test('"Open image" on a paired browser opens the in-app lightbox, not a blob tab', async (t) => {
  const { window, document } = installTestDom(t);
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  const opened = [];
  window.open = (...args) => opened.push(args);
  // The app registers the viewer when it loads it.
  await import('./image-lightbox.tsx');
  const { REMOTE_BROWSER_FALLBACKS } = await import('./remote-browser-fallbacks.ts');
  await act(async () => {
    await REMOTE_BROWSER_FALLBACKS.openAttachmentImage('data:image/png;base64,AA==', 'shot.png');
  });
  const image = document.querySelector('dialog.image-lightbox img');
  assert.equal(image?.getAttribute('src'), 'data:image/png;base64,AA==');
  assert.deepEqual(opened, []);
});

test('generated media without a media lane reads a still (and a clip) over RPC', async () => {
  const reads = [];
  const read = async (id, options) => {
    reads.push([id, options]);
    return { base64: 'AA==', mime: options.variant === 'original' ? 'video/mp4' : 'image/webp' };
  };
  assert.equal(await readMediaStill(read, 'a1', 'image'), 'data:image/webp;base64,AA==');
  assert.equal(await readMediaStill(read, 'v1', 'video'), 'data:image/webp;base64,AA==');
  assert.deepEqual(reads, [
    ['a1', { variant: 'display', allowOriginal: true }],
    ['v1', { variant: 'thumb' }],
  ]);
  // A host that could only return the clip gives no still to draw.
  assert.equal(await readMediaStill(async () => ({ base64: 'AA==', mime: 'video/mp4' }), 'v1', 'video'), '');
  assert.equal(await readMediaStill(async () => null, 'a1', 'image'), '');
  const url = await readMediaClip(read, 'v1');
  assert.match(url, /^blob:/);
  URL.revokeObjectURL(url);
  await assert.rejects(readMediaClip(async () => null, 'v1'));
});
