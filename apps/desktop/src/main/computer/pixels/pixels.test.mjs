import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { registerComputerPixels } from '../../host/computer-pixels.ts';
import { HostRpcError } from '../../host/connection.ts';
import { acquirePixels } from './acquire.ts';
import { blobChunkBytes, uploadBlob } from './blob-upload.ts';
import { encodeImage, fitSize } from './encode.ts';

/** An image that records what is done to it. */
function image(width, height, { empty = false, bytes = Buffer.from('pixels') } = {}) {
  const self = {
    ops: [],
    getSize: () => ({ width, height }),
    isEmpty: () => empty,
    resize(options) {
      const next = image(options.width, options.height, { bytes });
      next.ops = [...self.ops, ['resize', options.width, options.height]];
      return next;
    },
    crop(rect) {
      const next = image(rect.width, rect.height, { bytes });
      next.ops = [...self.ops, ['crop', rect.x, rect.y, rect.width, rect.height]];
      return next;
    },
    toJPEG: (quality) => Buffer.concat([Buffer.from(`jpeg${quality}:`), bytes]),
    toPNG: () => Buffer.concat([Buffer.from('png:'), bytes]),
  };
  return self;
}

const display = (id, index, x, primary = false) => ({
  id,
  index,
  primary,
  geometry: { x, y: 0, width: 2000, height: 1000 },
  scaleFactor: 1,
  pixelSize: { width: 2000, height: 1000 },
});

const ownedWindow = (capturePage) => ({
  geometry: { x: 10, y: 20, width: 800, height: 600 },
  scaleFactor: 1.5,
  pixelSize: { width: 800, height: 600 },
  capturePage,
});

function fakeSources(overrides = {}) {
  const calls = [];
  return {
    calls,
    displays: () => [display('11', 0, 0, true), display('12', 1, 2000)],
    ownedWindow: (id) => (id === 'hwnd:0x1' ? ownedWindow(async () => image(800, 600)) : null),
    displayPixels: async (d, size) => (calls.push(['display', d.id, size.width, size.height]), image(size.width, size.height)),
    windowPixels: async (id, size) => (calls.push(['window', id, size.width, size.height]), image(size.width, size.height)),
    screenAccess: () => undefined,
    ...overrides,
  };
}

const request = (extra = {}) => ({ target: { kind: 'display' }, backend: 'screen', maxWidth: 1000, ...extra });
const windowRequest = (id, backend = 'app_owned') => request({ target: { kind: 'window', windowId: id }, backend });

test('a display is picked by id, by index or as the primary one, and fitted to maxWidth and maxHeight', async () => {
  const sources = fakeSources();
  const byId = await acquirePixels(sources, request({ target: { kind: 'display', displayId: '12' } }));
  assert.equal(byId.source.displayId, '12');
  assert.equal(byId.source.x, 2000);
  assert.ok(byId.image.getSize().width <= 1000);
  const byIndex = await acquirePixels(sources, request({ target: { kind: 'display', index: 1 } }));
  assert.equal(byIndex.source.displayId, '12');
  const primary = await acquirePixels(sources, request());
  assert.equal(primary.source.displayId, '11');
  const short = await acquirePixels(sources, request({ maxHeight: 200 }));
  const { width, height } = short.image.getSize();
  assert.ok(height <= 200);
  assert.ok(Math.abs(width / height - 2) < 0.05);
  assert.deepEqual(fitSize({ width: 800, height: 600 }, 1280), { width: 800, height: 600 });
});

test('a region is cut from the full-resolution capture and answered as the source', async () => {
  const sources = fakeSources();
  const region = { x: 2100, y: 100, width: 400, height: 300 };
  const got = await acquirePixels(
    sources,
    request({ target: { kind: 'display', displayId: '12' }, region, maxWidth: 3840 })
  );
  assert.deepEqual(sources.calls[0], ['display', '12', 2000, 1000]);
  assert.deepEqual(got.image.ops, [['crop', 100, 100, 400, 300]]);
  assert.deepEqual([got.source.x, got.source.y, got.source.width, got.source.height], [2100, 100, 400, 300]);
  await assert.rejects(
    acquirePixels(sources, request({ target: { kind: 'display', displayId: '12' }, region: { x: 0, y: 0, width: 10, height: 10 } })),
    (error) => error.code === 'invalid_params'
  );
});

test('an app-owned window tries its page, then the compositor, and records both attempts', async () => {
  const failing = fakeSources({
    ownedWindow: (id) =>
      id === 'hwnd:0x1'
        ? ownedWindow(async () => {
            throw new Error('capture_timeout: app-owned capture');
          })
        : null,
  });
  const got = await acquirePixels(failing, windowRequest('hwnd:0x1'));
  assert.equal(got.backend, 'composited');
  assert.deepEqual(got.attempts, [
    { backend: 'app_owned', ok: false, reason: 'capture_timeout: app-owned capture' },
    { backend: 'composited', ok: true },
  ]);
  assert.equal(got.source.windowId, 'hwnd:0x1');
  assert.equal(got.source.scaleFactor, 1.5);
  const owned = await acquirePixels(fakeSources(), windowRequest('hwnd:0x1'));
  assert.deepEqual(owned.attempts, [{ backend: 'app_owned', ok: true }]);
  const compositor = await acquirePixels(fakeSources(), windowRequest('hwnd:0x1', 'composited'));
  assert.deepEqual(compositor.attempts, [{ backend: 'composited', ok: true }]);
});

test('failures map to the codes the core reads', async () => {
  await assert.rejects(
    acquirePixels(fakeSources(), windowRequest('hwnd:0x9')),
    (error) => error.code === 'computer_window_gone' && error.attempts.length === 2
  );
  const empty = fakeSources({ displayPixels: async () => image(10, 10, { empty: true }) });
  await assert.rejects(
    acquirePixels(empty, request()),
    (error) => error.code === 'computer_capture_unavailable' && /empty_frame/.test(error.message)
  );
  const denied = fakeSources({ displayPixels: async () => image(10, 10, { empty: true }), screenAccess: () => 'denied' });
  await assert.rejects(acquirePixels(denied, request()), (error) => error.code === 'computer_capture_permission');
  const refused = fakeSources({
    displayPixels: async () => {
      throw new Error('Permission denied by the portal');
    },
  });
  await assert.rejects(acquirePixels(refused, request()), (error) => error.code === 'computer_capture_permission');
  await assert.rejects(
    acquirePixels(fakeSources(), request({ target: { kind: 'display', displayId: '99' } })),
    (error) => error.code === 'computer_capture_unavailable'
  );
  await assert.rejects(acquirePixels(fakeSources(), request({ backend: 'app_owned' })), (error) => error.code === 'invalid_params');
  await assert.rejects(acquirePixels(fakeSources(), windowRequest('hwnd:0x1', 'screen')), (error) => error.code === 'invalid_params');
});

test('encoding: jpeg takes the quality, png does not, empty bytes are refused', () => {
  assert.ok(encodeImage(image(4, 4), 'jpeg', 70).bytes.toString().startsWith('jpeg70:'));
  assert.equal(encodeImage(image(4, 4), 'png', 70).mimeType, 'image/png');
  const none = image(4, 4);
  none.toPNG = () => Buffer.alloc(0);
  assert.throws(() => encodeImage(none, 'png', 1), /empty_frame/);
});

test('an upload goes in chunks under the limit, each carrying the digest of the whole', async () => {
  const bytes = Buffer.alloc(250_000, 7);
  const puts = [];
  const result = await uploadBlob(async (method, params) => (puts.push({ method, ...params }), {}), bytes);
  assert.equal(result.byteLength, 250_000);
  assert.equal(result.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.ok(puts.length >= 3 && puts.every((put) => put.method === 'blob/put' && put.digest === result.digest));
  let offset = 0;
  for (const put of puts) {
    assert.equal(put.offset, offset);
    const raw = Buffer.from(put.bytesB64, 'base64');
    assert.ok(raw.length <= blobChunkBytes());
    offset += raw.length;
  }
  assert.equal(offset, 250_000);
  const offsets = [];
  await uploadBlob(async (_method, params) => offsets.push(params.offset), Buffer.alloc(10), 4);
  assert.deepEqual(offsets, [0, 3, 6, 9]);
  assert.equal(blobChunkBytes(10), 9);
  assert.equal(blobChunkBytes(1_000_000_000), blobChunkBytes());
});

function host(sources, callCore) {
  const handlers = new Map();
  registerComputerPixels({ handleRequest: (method, run) => handlers.set(method, run) }, { callCore, sources });
  return (params) => handlers.get('host/computer/pixels')(params, new AbortController().signal);
}

test('the host method uploads before it answers the blob reference', async () => {
  const puts = [];
  const ask = host(fakeSources(), async (_method, params) => (puts.push(params), {}));
  const answer = await ask({ target: { kind: 'display' }, backend: 'screen', maxWidth: 1000, format: 'jpeg', quality: 60 });
  assert.equal(answer.blob.mimeType, 'image/jpeg');
  assert.equal(answer.blob.digest, puts[0].digest);
  assert.equal(answer.blob.byteLength, Buffer.from(puts[0].bytesB64, 'base64').length);
  assert.ok(answer.captureWidth <= 1000);
  assert.deepEqual(answer.source, { x: 0, y: 0, width: 2000, height: 1000, scaleFactor: 1, displayId: '11', windowId: null });
  assert.deepEqual(answer.attempts, [{ backend: 'screen', ok: true }]);
  assert.equal(answer.backend, 'screen');
});

test('the host method answers -32602 for bad params and -32000 with the code for a failed capture', async () => {
  const ask = host(
    fakeSources({ displayPixels: async () => image(10, 10, { empty: true }), screenAccess: () => 'denied' }),
    async () => ({})
  );
  await assert.rejects(
    ask({ target: { kind: 'display' }, backend: 'screen', maxWidth: 0, format: 'jpeg', quality: 60 }),
    (error) => error instanceof HostRpcError && error.code === -32602
  );
  await assert.rejects(
    ask({ target: { kind: 'display' }, backend: 'screen', maxWidth: 100, format: 'jpeg', quality: 0 }),
    (error) => error.code === -32602
  );
  await assert.rejects(
    ask({ target: { kind: 'display' }, backend: 'screen', maxWidth: 100, format: 'jpeg', quality: 50 }),
    (error) => error.code === -32000 && error.data.code === 'computer_capture_permission' && error.data.attempts.length === 1
  );
});
