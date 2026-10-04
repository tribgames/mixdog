import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserGuestStateStore, browserDocumentId } from './guest-state.ts';
import { createBrowserRemoteControl } from './remote-control.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let index = 0; index < 8; index++) await flush();
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const state = new BrowserGuestStateStore();
  const changes = [];
  const frames = [];
  const calls = [];
  const dispatched = [];
  const ports = new Map();
  const makeGuest = (id, url) => {
    const guest = Object.assign(new EventEmitter(), {
      id,
      url,
      title: `Title ${id}`,
      isDestroyed: () => false,
      getURL: () => guest.url,
      getTitle: () => guest.title,
      isLoadingMainFrame: () => false,
      getZoomFactor: () => 1,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    });
    state.for(guest);
    ports.set(guest, new EventEmitter());
    return guest;
  };
  const a = makeGuest(1, 'https://a.test/');
  const b = makeGuest(2, 'https://b.test/');
  const current = { guest: a };
  const remote = createBrowserRemoteControl({
    state,
    cdp: {
      waitForInitialDocument: async () => {},
      guestDebugger: async (guest) => ports.get(guest),
      call: async (guest, method, params) => {
        calls.push([guest.id, method, params]);
        return {};
      },
    },
    ensureGuest: async () => current.guest,
    currentGuest: () => current.guest,
    viewerChanged: (sessionId, active) => changes.push([sessionId, active]),
    dispatchPageInput: async (guest, input) => dispatched.push([guest.id, input.type]),
    publishFrame: async (frame) => {
      frames.push(frame);
    },
    assertResolvedUrlAllowed: async () => {},
  });
  const screencastFrame = (guest, ackId = 1) =>
    ports.get(guest).emit('message', {}, 'Page.screencastFrame', {
      data: 'AAAA',
      sessionId: ackId,
      metadata: { deviceWidth: 400, deviceHeight: 300 },
    });
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { remote, state, changes, frames, calls, dispatched, a, b, current, screencastFrame, advance };
}

const SIZE = { maxWidth: 800, maxHeight: 600 };

test('streaming reports one viewer, and a subscription not renewed for 4s stops the screencast', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  await f.remote.remoteBrowserStream('s', SIZE);
  assert.deepEqual(f.changes, [['s', true]]);
  const start = f.calls.filter(([, method]) => method === 'Page.startScreencast');
  assert.equal(start.length, 1, 'a renewal does not restart the screencast');
  assert.equal(start[0][2].quality, 50);
  assert.equal(start[0][2].maxWidth, 800);
  await f.advance(3_000);
  await f.remote.remoteBrowserStream('s', SIZE);
  await f.advance(3_000);
  assert.deepEqual(f.changes, [['s', true]], 'renewal extends the lease');
  await f.advance(1_000);
  assert.deepEqual(f.changes, [
    ['s', true],
    ['s', false],
  ]);
  assert.ok(f.calls.some(([, method]) => method === 'Page.stopScreencast'));
});

test('stopping or releasing a session ends the stream and its viewer', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  await f.remote.remoteBrowserStream('s', null);
  await settle();
  assert.deepEqual(f.changes, [
    ['s', true],
    ['s', false],
  ]);
  await f.remote.remoteBrowserStream('s', SIZE);
  f.remote.releaseViewer('s');
  f.remote.releaseViewer('s');
  assert.deepEqual(f.changes.slice(2), [
    ['s', true],
    ['s', false],
  ]);
});

test('every screencast frame is acked and published with its document and viewport', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a, 41);
  await settle();
  assert.ok(f.calls.some(([id, method, params]) => id === 1 && method === 'Page.screencastFrameAck' && params.sessionId === 41));
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].documentId, browserDocumentId(f.state, f.a));
  assert.equal(f.frames[0].url, 'https://a.test/');
  assert.equal(f.frames[0].viewportWidth, 400);
  assert.equal(f.frames[0].image.mimeType, 'image/jpeg');
});

test('a tab switch and a navigation each push a frame with the new document and url', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a);
  await settle();
  const first = f.frames.at(-1);

  f.current.guest = f.b;
  await f.advance(150);
  await f.advance(100);
  assert.ok(f.calls.some(([id, method]) => id === 1 && method === 'Page.stopScreencast'));
  assert.ok(f.calls.some(([id, method]) => id === 2 && method === 'Page.startScreencast'), 'restarted on the new guest');
  const afterSwitch = f.frames.at(-1);
  assert.equal(afterSwitch.documentId, browserDocumentId(f.state, f.b));
  assert.notEqual(afterSwitch.documentId, first.documentId);
  assert.equal(afterSwitch.url, 'https://b.test/');
  assert.equal(afterSwitch.image, undefined, 'metadata-only until the new image arrives');
  f.screencastFrame(f.b);
  await advance100(f);
  assert.equal(f.frames.at(-1).documentId, afterSwitch.documentId);
  assert.ok(f.frames.at(-1).image);

  f.b.url = 'https://b.test/next';
  f.state.beginDocument(f.b);
  f.b.emit('did-navigate');
  await settle();
  await f.advance(100);
  const afterNavigation = f.frames.at(-1);
  assert.equal(afterNavigation.url, 'https://b.test/next');
  assert.notEqual(afterNavigation.documentId, afterSwitch.documentId);
  assert.equal(afterNavigation.documentId, browserDocumentId(f.state, f.b));
});

async function advance100(f) {
  await f.advance(100);
}

test('a title change alone pushes a metadata-only frame', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a);
  await settle();
  const count = f.frames.length;
  f.a.title = 'Renamed';
  f.a.emit('page-title-updated');
  await settle();
  await f.advance(100);
  assert.equal(f.frames.length, count + 1);
  assert.equal(f.frames.at(-1).title, 'Renamed');
  assert.equal(f.frames.at(-1).image, undefined, 'the unchanged image is not resent');
});

test('input for a superseded document is rejected, current input is dispatched', async (t) => {
  const f = fixture(t);
  const documentId = browserDocumentId(f.state, f.a);
  const wheel = { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 5 };
  await f.remote.remoteBrowserControl('s', { ...wheel, documentId });
  assert.deepEqual(f.dispatched, [[1, 'wheel']]);
  f.state.beginDocument(f.a);
  // Re-run assertCurrent through the real guard: the dispatcher stub is bypassed
  // by checking a stale id before dispatch.
  await assert.rejects(f.remote.remoteBrowserControl('s', { ...wheel, documentId }), /page changed/);
  assert.equal(f.dispatched.length, 1);
  f.current.guest = f.b;
  await assert.rejects(
    f.remote.remoteBrowserControl('s', { ...wheel, documentId: browserDocumentId(f.state, f.a) }),
    /page changed/
  );
});
