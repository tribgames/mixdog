import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPresentationReads } from './presentation-reads.ts';

const frame = (frameId = 'frame-1') => ({
  frameId, documentId: 'p1:1', webContentsId: 1, width: 800, height: 600,
  viewportWidth: 800, viewportHeight: 600, url: 'https://example.test',
  title: 'Page', loading: false, canGoBack: false, canGoForward: false,
  image: { mimeType: 'image/jpeg', data: 'pixels' },
});

test('concurrent display readers share a capture but retain their own image-delta baselines', async () => {
  const captures = [];
  const display = createBrowserPresentationReads({
    bounded: work => work,
    capture: session => new Promise(resolve => captures.push({ session, resolve })),
  });
  const a = display.read('owner', 'frame-1');
  const b = display.read('owner');
  const other = display.read('other');
  assert.deepEqual(captures.map(value => value.session), ['owner', 'other']);
  captures[0].resolve(frame());
  captures[1].resolve(frame('other-frame'));
  const [unchanged, fresh, independent] = await Promise.all([a, b, other]);
  assert.equal(unchanged.image, undefined);
  assert.equal(fresh.image.data, 'pixels');
  assert.equal(independent.frameId, 'other-frame');
});

test('releasing or disposing a display rejects late pixels without cancelling a reopened session', async () => {
  const captures = [];
  const display = createBrowserPresentationReads({
    bounded: work => work,
    capture: (session, signal) => new Promise(resolve => captures.push({ session, signal, resolve })),
  });
  const old = display.read('owner');
  const cancelled = assert.rejects(old, /page changed during capture/);
  display.release('owner');
  assert.equal(captures[0].signal.aborted, true);
  const reopened = display.read('owner');
  captures[0].resolve(frame('old'));
  await cancelled;
  const joined = display.read('owner');
  assert.equal(captures.length, 2);
  captures[1].resolve(frame('new'));
  assert.equal((await reopened).frameId, 'new');
  assert.equal((await joined).frameId, 'new');
  const closing = display.read('other');
  const closed = assert.rejects(closing, /page changed during capture/);
  display.dispose();
  captures[2].resolve(frame());
  await closed;
  await assert.rejects(display.read('owner'), /closed/);
});
