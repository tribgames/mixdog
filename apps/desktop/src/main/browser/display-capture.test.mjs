import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { inflateSync } from 'node:zlib';
import { createBrowserDisplayCapture } from './display-capture.ts';

function image(text, width = 600, height = 400, scaleFactor = 1) {
  return {
    getSize: (scale = 1) => ({ width: width * scale, height: height * scale }),
    getScaleFactors: () => [1, scaleFactor],
    toBitmap: ({ scaleFactor: requested }) => {
      assert.equal(requested, scaleFactor);
      return Buffer.alloc(width * height * scaleFactor ** 2 * 4, Buffer.from([0, 0, text.charCodeAt(0), 255]));
    },
    crop: () => ({ toPNG: () => Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex') }),
  };
}

function firstRed(frame) {
  const bytes = Buffer.from(frame.data, 'base64');
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      return inflateSync(bytes.subarray(offset + 8, offset + 8 + length))[1];
    }
    offset += length + 12;
  }
  assert.fail('no PNG pixels');
}

test('display sampling keeps pages hidden and bounds pending native captures', async () => {
  let finish;
  let starts = 0;
  const guest = {
    capturePage(_rect, options) {
      assert.equal(options.stayHidden, true);
      starts += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const capture = createBrowserDisplayCapture();
  const first = capture(guest);
  const second = capture(guest);
  assert.equal(starts, 1);
  finish(image('pixels'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.data, b.data);
  const next = capture(guest);
  assert.equal(starts, 2);
  finish(image('', 0, 0));
  await assert.rejects(next, /not ready/);
});

test('navigation never reuses an outstanding native sample from the previous document', async () => {
  const pending = [];
  const guest = {
    capturePage() {
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const capture = createBrowserDisplayCapture();
  const old = capture(guest, '1');
  const next = capture(guest, '2');
  assert.equal(pending.length, 1, 'navigation must not start parallel native captures');
  pending[0](image('old'));
  await old;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1](image('new'));
  assert.equal(firstRed(await next), 'new'.charCodeAt(0));
});

test('resizing never relabels an old compositor image, even when its document is unchanged', async () => {
  const pending = [];
  const guest = { capturePage: () => new Promise((resolve) => pending.push(resolve)) };
  const capture = createBrowserDisplayCapture();
  const previous = capture(guest, 'same-document', { width: 600, height: 400 });
  const resized = capture(guest, 'same-document', { width: 390, height: 844 });
  pending[0](image('old'));
  await previous;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1](image('still-old'));
  await assert.rejects(resized, /Browser page changed during capture/);
  const fresh = capture(guest, 'same-document', { width: 390, height: 844 });
  pending[2](image('fresh', 390, 844, 3));
  const frame = await fresh;
  assert.equal(frame.mimeType, 'image/png');
  assert.deepEqual([frame.width, frame.height], [1170, 2532]);
  assert.equal(firstRed(frame), 'fresh'.charCodeAt(0));
});

test('offscreen presentation compresses losslessly without blocking input or starting another capture', async () => {
  const guest = new EventEmitter();
  guest.isOffscreen = () => true;
  let captures = 0;
  guest.invalidate = () => {
    captures++;
    guest.emit(
      'paint',
      {},
      {},
      {
        ...image('pixels'),
        toPNG: () => assert.fail('full display compression must not block the main thread'),
      }
    );
  };
  try {
    const capture = createBrowserDisplayCapture();
    const first = capture(guest, 'document', { width: 600, height: 400 });
    const second = capture(guest, 'document', { width: 600, height: 400 });
    assert.equal(captures, 1);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.deepEqual([a.width, a.height, a.mimeType], [600, 400, 'image/png']);
    assert.equal(firstRed(a), 'pixels'.charCodeAt(0));
    await capture(guest, 'document', { width: 600, height: 400 });
    assert.equal(captures, 1, 'unchanged paint reuses the encoded frame');
  } finally {
    guest.emit('destroyed');
  }
});
