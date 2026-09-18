import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPresentationReads } from './presentation-reads.ts';

const frame = (frameId = 'frame-1') => ({
  frameId,
  documentId: 'p1:1',
  webContentsId: 1,
  width: 800,
  height: 600,
  viewportWidth: 800,
  viewportHeight: 600,
  url: 'https://example.test',
  title: 'Page',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  image: { mimeType: 'image/jpeg', data: 'pixels' },
});

test('concurrent display readers share a capture but retain their own image-delta baselines', async () => {
  const captures = [];
  const display = createBrowserPresentationReads({
    bounded: (work) => work,
    capture: (session) => new Promise((resolve) => captures.push({ session, resolve })),
  });
  const a = display.read('owner', 'frame-1');
  const b = display.read('owner');
  const other = display.read('other');
  assert.deepEqual(
    captures.map((value) => value.session),
    ['owner', 'other']
  );
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
    bounded: (work) => work,
    capture: (session, signal) => new Promise((resolve) => captures.push({ session, signal, resolve })),
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

test('a capture that loses its race asks for a resample instead of failing the display', async () => {
  let attempt = 0;
  const display = createBrowserPresentationReads({
    bounded: (work) => work,
    capture: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('Browser page changed during capture.');
      if (attempt === 2) return frame('live');
      throw new Error('Browser display frame timed out.');
    },
  });
  assert.deepEqual(await display.read('owner'), { resample: true });
  assert.equal((await display.read('owner')).image.data, 'pixels');
  // Only the race is ordinary; every other failure still reaches the caller.
  await assert.rejects(display.read('owner'), /timed out/);
  assert.equal(attempt, 3, 'a resample is reported, never captured again here');
});

test('release at the delivery boundary refuses a completed capture and leaves a reopened read independent', async () => {
  for (const mode of ['release', 'dispose']) {
    let display;
    let first = true;
    let count = 0;
    display = createBrowserPresentationReads({
      capture: async () => frame(`frame-${++count}`),
      bounded: async (work) => {
        const value = await work;
        if (first) {
          first = false;
          if (mode === 'release') display.release('owner');
          else display.dispose();
        }
        return value;
      },
    });
    await assert.rejects(display.read('owner'), /page changed during capture/);
    if (mode === 'release') assert.equal((await display.read('owner')).frameId, 'frame-2');
    else await assert.rejects(display.read('owner'), /closed/);
  }
});
