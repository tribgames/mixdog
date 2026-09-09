import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserDisplayCapture } from './display-capture.ts';

function image(text, width = 600, height = 400, scaleFactor = 1) {
  return {
    getSize: () => ({ width, height }),
    getScaleFactors: () => [1, scaleFactor],
    toPNG: ({ scaleFactor: requested }) => {
      assert.equal(requested, scaleFactor);
      const bytes = Buffer.alloc(24 + Buffer.byteLength(text));
      bytes.writeUInt32BE(width * scaleFactor, 16);
      bytes.writeUInt32BE(height * scaleFactor, 20);
      bytes.write(text, 24);
      return bytes;
    },
  };
}

test('display sampling keeps pages hidden and bounds pending native captures', async () => {
  let finish;
  let starts = 0;
  const guest = {
    capturePage(_rect, options) {
      assert.equal(options.stayHidden, true);
      starts += 1;
      return new Promise(resolve => { finish = resolve; });
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
  finish({ getSize: () => ({ width: 0, height: 0 }) });
  await assert.rejects(next, /not ready/);
});

test('navigation never reuses an outstanding native sample from the previous document', async () => {
  const pending = [];
  const guest = {
    capturePage() { return new Promise(resolve => pending.push(resolve)); },
  };
  const capture = createBrowserDisplayCapture();
  const old = capture(guest, '1');
  const next = capture(guest, '2');
  assert.equal(pending.length, 1, 'navigation must not start parallel native captures');
  pending[0](image('old'));
  await old;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1](image('new'));
  assert.equal(Buffer.from((await next).data, 'base64').subarray(24).toString(), 'new');
});

test('resizing never relabels an old compositor image, even when its document is unchanged', async () => {
  const pending = [];
  const guest = { capturePage: () => new Promise(resolve => pending.push(resolve)) };
  const capture = createBrowserDisplayCapture();
  const previous = capture(guest, 'same-document', { width: 600, height: 400 });
  const resized = capture(guest, 'same-document', { width: 390, height: 844 });
  pending[0](image('old'));
  await previous;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1](image('still-old'));
  await assert.rejects(resized, /Browser page changed during capture/);
  const fresh = capture(guest, 'same-document', { width: 390, height: 844 });
  pending[2](image('fresh', 390, 844, 3));
  const frame = await fresh;
  assert.equal(frame.mimeType, 'image/png');
  assert.deepEqual([frame.width, frame.height], [1170, 2532]);
  assert.equal(Buffer.from(frame.data, 'base64').subarray(24).toString(), 'fresh');
});
