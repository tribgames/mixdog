import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { MAX_INLINE_SCREENSHOT_BYTES, registerScreenshot } from './screenshot.ts';

function jpegOf(bytes) {
  const body = Buffer.alloc(bytes, 7);
  body[0] = 255;
  body[1] = 216;
  body[bytes - 2] = 255;
  body[bytes - 1] = 217;
  return body.toString('base64');
}

function harness({ size = 1000, withheld = false, snapshotId = 'p1-s2' } = {}) {
  const handlers = new Map();
  const puts = [];
  const connection = {
    request: async (method, params) => {
      assert.equal(method, 'blob/put');
      puts.push(params);
      return {};
    },
    handleRequest: (method, handler) => handlers.set(method, handler),
  };
  const guest = { getURL: () => 'https://a.example/', isDestroyed: () => false };
  const state = {
    pageId: 'p1',
    documentGeneration: 1,
    cdpSessions: new Map(),
    accessibilityRefs: { snapshotId, refs: new Map() },
  };
  const calls = [];
  const shot = (extra) => ({ data: jpegOf(size), width: 800, height: 600, mimeType: 'image/jpeg', fullPage: false, ...extra });
  const host = {
    screenshots: {
      capture: async (_guest, background, options) => {
        calls.push(['capture', background, options]);
        if (withheld) throw new Error('Visual output withheld to protect a registered credential.');
        return shot({ fullPage: options.fullPage });
      },
      captureElement: async (_guest, background, options, rect, geometry) => {
        calls.push(['captureElement', background, options, rect, geometry]);
        return { ...shot(), partial: false };
      },
    },
    resolveRefRect: async (_guest, ref) => {
      calls.push(['resolveRefRect', ref]);
      return { x: 10, y: 20, width: 30, height: 40 };
    },
    evaluate: async () => ({ viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } }),
  };
  const ctx = {
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp: {},
    events: { flush: () => {}, facts: (pageId) => ({ pageId, seq: 1 }) },
    redactKnown: (_pageId, text) => text,
    isEngineMode: () => true,
  };
  registerScreenshot(connection, ctx, host);
  const call = (params) => handlers.get('host/browser/screenshot')({ pageId: 'p1', ...params }, new AbortController().signal);
  return { call, calls, puts };
}

test('a picture of 128 KiB or less travels inline, one byte more goes to the blob store', async () => {
  const inline = harness({ size: MAX_INLINE_SCREENSHOT_BYTES });
  const small = await inline.call({ format: 'jpeg' });
  assert.equal(small.data, jpegOf(MAX_INLINE_SCREENSHOT_BYTES));
  assert.equal(small.blob, undefined);
  assert.deepEqual([small.mimeType, small.width, small.height], ['image/jpeg', 800, 600]);
  assert.deepEqual(small.facts, { pageId: 'p1', seq: 1 });
  assert.deepEqual(inline.puts, []);

  const large = harness({ size: MAX_INLINE_SCREENSHOT_BYTES + 1 });
  const big = await large.call({ format: 'jpeg' });
  const bytes = Buffer.from(jpegOf(MAX_INLINE_SCREENSHOT_BYTES + 1), 'base64');
  assert.equal(big.data, undefined);
  assert.deepEqual(big.blob, { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length });
  assert.equal(large.puts.length, 2);
  assert.equal(Buffer.concat(large.puts.map((put) => Buffer.from(put.bytesB64, 'base64'))).equals(bytes), true);
});

test('a full page and the background flag reach the capture', async () => {
  const h = harness();
  const result = await h.call({ format: 'png', fullPage: true, background: true });
  assert.equal(result.width, 800);
  assert.deepEqual(h.calls, [['capture', true, { format: 'png', fullPage: true }]]);
  const foreground = harness();
  await foreground.call({ format: 'jpeg', quality: 60 });
  assert.deepEqual(foreground.calls, [['capture', false, { format: 'jpeg', quality: 60, fullPage: false }]]);
});

test('a rectangle clip is cropped from the viewport capture with the page geometry', async () => {
  const h = harness();
  await h.call({ format: 'jpeg', clip: { x: 1, y: 2, width: 3, height: 4 } });
  assert.deepEqual(h.calls, [
    [
      'captureElement',
      false,
      { format: 'jpeg' },
      { x: 1, y: 2, width: 3, height: 4 },
      { viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } },
    ],
  ]);
});

test('a ref clip resolves the ref of the current snapshot; a stale snapshot is -32013 and nothing is captured', async () => {
  const h = harness();
  await h.call({ format: 'jpeg', clip: { snapshotId: 'p1-s2', ref: 'p1-s2-e3' } });
  assert.deepEqual(
    h.calls.map((call) => call[0]),
    ['resolveRefRect', 'captureElement']
  );
  assert.deepEqual(h.calls[1][3], { x: 10, y: 20, width: 30, height: 40 });
  const stale = harness();
  await assert.rejects(
    stale.call({ format: 'jpeg', clip: { snapshotId: 'p1-s1', ref: 'p1-s1-e3' } }),
    (error) => error.code === -32013
  );
  assert.deepEqual(stale.calls, []);
});

test('bad params are -32602: format, quality with png, a clip with fullPage, a clip of neither shape', async () => {
  const h = harness();
  const bad = (params, text) =>
    assert.rejects(h.call(params), (error) => error.code === -32602 && error.message.includes(text));
  await bad({ format: 'webp' }, 'jpeg or png');
  await bad({ format: 'png', quality: 80 }, 'only with format=jpeg');
  await bad({ format: 'jpeg', quality: 101 }, 'between 0 and 100');
  await bad({ format: 'jpeg', fullPage: true, clip: { x: 0, y: 0, width: 1, height: 1 } }, 'drop fullPage');
  await bad({ format: 'jpeg', clip: { x: 1 } }, 'clip must be');
  assert.deepEqual(h.calls, []);
});

test('a capture the privacy check withholds is refused with its message and nothing is sent', async () => {
  const h = harness({ withheld: true });
  await assert.rejects(h.call({ format: 'jpeg' }), (error) => error.code === -32000 && /withheld/.test(error.message));
  assert.deepEqual(h.puts, []);
});
