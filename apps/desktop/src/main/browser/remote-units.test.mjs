import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserGuestStateStore, browserDocumentId } from './guest-state.ts';
import { buildFrame, frameSignature } from './remote-frame.ts';
import { schedulePublish } from './remote-frame-publish.ts';
import { isPageInputControl, pageInputGuard } from './remote-input.ts';
import { jpegSize } from './remote-jpeg-size.ts';
import { sizeKey, viewportKey } from './remote-stream.ts';

const guestOf = (extra = {}) => ({
  isDestroyed: () => false,
  getURL: () => '',
  getTitle: () => 'T',
  isLoadingMainFrame: () => false,
  getZoomFactor: () => 1,
  navigationHistory: { canGoBack: () => true, canGoForward: () => false },
  ...extra,
});
const view = { size: { width: 4, height: 3 }, viewport: { width: 2, height: 1 } };

test('jpegSize reads the start-of-frame marker and rejects non-JPEG data', () => {
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 20, 0, 30, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(jpegSize(sof.toString('base64')), { height: 20, width: 30 });
  assert.equal(jpegSize(Buffer.alloc(32).toString('base64')), null);
});

test('viewportKey and sizeKey name what restarts a screencast', () => {
  const viewport = { width: 10, height: 20, deviceScaleFactor: 2 };
  assert.equal(viewportKey(viewport), '10x20@2');
  const options = { maxWidth: 5, maxHeight: 6 };
  assert.equal(sizeKey({ options, viewport: null }), '5x6');
  assert.equal(sizeKey({ options, viewport }), '5x6:10x20@2');
});

test('buildFrame falls back to about:blank and includes only present facts', () => {
  const frame = buildFrame({}, 's', 35, guestOf(), 'doc', view, undefined);
  assert.equal(frame.frameId, 'rbf_z');
  assert.equal(frame.url, 'about:blank');
  assert.equal(frame.canGoBack, true);
  assert.deepEqual([frame.width, frame.height, frame.viewportWidth, frame.viewportHeight], [4, 3, 2, 1]);
  for (const key of ['tabs', 'dialog', 'image']) assert.equal(key in frame, false);
  const full = buildFrame(
    { tabs: { list: () => [{ id: 't' }] }, dialog: () => ({ id: 'd' }) },
    's',
    1,
    guestOf(),
    'doc',
    view,
    { mimeType: 'image/jpeg', data: 'x' }
  );
  assert.deepEqual([full.tabs, full.dialog, full.image.data], [[{ id: 't' }], { id: 'd' }, 'x']);
});

test('frameSignature changes with the picture and the page facts', () => {
  const guest = guestOf();
  const base = frameSignature({}, 's', guest, 'doc', view);
  assert.equal(frameSignature({}, 's', guest, 'doc', view), base);
  assert.notEqual(frameSignature({}, 's', guest, 'doc', { ...view, size: { width: 9, height: 3 } }), base);
  assert.notEqual(frameSignature({}, 's', guestOf({ getTitle: () => 'U' }), 'doc', view), base);
  assert.notEqual(frameSignature({ dialog: () => ({ id: 'd' }) }, 's', guest, 'doc', view), base);
});

test('schedulePublish sends the newest frame once and holds the next until the service is free', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  let release;
  const publish = (frame) => {
    sent.push(frame.seq);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const stream = {
    pending: { seq: 1 },
    publishing: false,
    publishTimer: null,
    lastPublishedAt: Number.NEGATIVE_INFINITY,
  };
  schedulePublish(stream, publish);
  assert.deepEqual(sent, [1]);
  stream.pending = { seq: 2 };
  stream.pending = { seq: 3 };
  schedulePublish(stream, publish);
  assert.deepEqual(sent, [1], 'busy service: nothing new goes out');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  assert.deepEqual(sent, [1, 3]);
});

test('a hand-off the service never answers reopens the gate after the relay ack window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const settles = [];
  // Every hand-off hangs, until the test settles it late.
  const publish = (frame) => {
    sent.push(frame.seq);
    return new Promise((resolve) => settles.push(resolve));
  };
  const stream = {
    pending: { seq: 1 },
    publishing: false,
    publishTimer: null,
    lastPublishedAt: Number.NEGATIVE_INFINITY,
  };
  schedulePublish(stream, publish);
  stream.pending = { seq: 2 };
  schedulePublish(stream, publish);
  t.mock.timers.tick(1_499);
  assert.deepEqual(sent, [1], 'still within the ack window');
  t.mock.timers.tick(1);
  assert.deepEqual(sent, [1, 2], 'the newest frame goes instead of waiting for ever');
  // The stale hand-off settling late must not reopen the gate for the newer one.
  stream.pending = { seq: 3 };
  settles[0]();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  assert.deepEqual(sent, [1, 2]);
  settles[1]();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  assert.deepEqual(sent, [1, 2, 3]);
});

test('isPageInputControl accepts only input controls', () => {
  for (const type of ['pointer', 'wheel', 'text', 'key', 'composition', 'composition-end']) {
    assert.equal(isPageInputControl({ type }), true);
  }
  for (const type of ['navigate', 'viewport', 'back']) assert.equal(isPageInputControl({ type }), false);
});

test('pageInputGuard throws once the page, document or crash state changed', () => {
  const state = new BrowserGuestStateStore();
  const guest = guestOf();
  state.for(guest);
  const documentId = browserDocumentId(state, guest);
  let current = guest;
  const host = { currentGuest: () => current };
  const assertCurrent = pageInputGuard(state, host, 's', guest, documentId);
  assert.doesNotThrow(assertCurrent);
  assert.throws(pageInputGuard(state, host, 's', guest, 'other'), /page changed/);
  current = guestOf();
  assert.throws(assertCurrent, /page changed/);
  current = guest;
  state.for(guest).crashed = true;
  assert.throws(assertCurrent, /page changed/);
});
