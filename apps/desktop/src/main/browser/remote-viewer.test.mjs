import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserGuestStateStore, browserDocumentId } from './guest-state.ts';
import { createBrowserRemoteControl } from './remote-control.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let index = 0; index < 8; index++) await flush();
}

function fixture(t, { tabs, dialog, leave } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const state = new BrowserGuestStateStore();
  const changes = [];
  const frames = [];
  const calls = [];
  const dispatched = [];
  const ports = new Map();
  /** The viewport each page is rendered at, and an optional hold on restores. */
  const viewports = new Map();
  const gates = { restore: undefined, debugger: undefined };
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
    tabs,
    dialog,
    leave,
    state,
    cdp: {
      waitForInitialDocument: async () => {},
      guestDebugger: async (guest) => {
        await gates.debugger;
        return ports.get(guest);
      },
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
    drive: {
      apply: async (sessionId, guest, viewport) => {
        calls.push([guest.id, 'drive.apply', { sessionId, ...viewport }]);
        viewports.set(guest.id, 'phone');
      },
      restore: async (guest) => {
        calls.push([guest.id, 'drive.restore']);
        await gates.restore;
        viewports.set(guest.id, 'pane');
      },
    },
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
  return {
    remote,
    state,
    changes,
    frames,
    calls,
    dispatched,
    viewports,
    gates,
    a,
    b,
    current,
    screencastFrame,
    advance,
  };
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

test('tab controls go to the session tab strip and frames carry that strip', async (t) => {
  const log = [];
  const strip = [{ id: 'p1', title: 'A', url: 'https://a.test/', active: true, loading: false, kind: 'page' }];
  const f = fixture(t, {
    tabs: {
      list: () => strip,
      create: (sessionId) => log.push(['create', sessionId]),
      select: (sessionId, tabId) => log.push(['select', sessionId, tabId]),
      close: (sessionId, tabId) => log.push(['close', sessionId, tabId]),
    },
  });
  await f.remote.remoteBrowserControl('s', { type: 'new-tab' });
  await f.remote.remoteBrowserControl('s', { type: 'select-tab', tabId: 'p2' });
  await f.remote.remoteBrowserControl('s', { type: 'close-tab', tabId: 'p2' });
  assert.deepEqual(log, [
    ['create', 's'],
    ['select', 's', 'p2'],
    ['close', 's', 'p2'],
  ]);
  assert.deepEqual(f.dispatched, [], 'tab chrome never reaches page input');

  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a, 1);
  await settle();
  assert.deepEqual(f.frames.at(-1).tabs, strip);
  const count = f.frames.length;
  strip.push({ id: 'p2', title: 'B', url: 'about:blank', active: false, loading: false, kind: 'page' });
  await f.advance(200);
  assert.ok(f.frames.length > count, 'a tab change pushes a metadata frame');
  assert.equal(f.frames.at(-1).tabs.length, 2);
});

test('close-tab replies with the tabs left after the window actually closed', async (t) => {
  let strip = [
    { id: 'p1', title: 'A', url: 'https://a.test/', active: true, loading: false, kind: 'page' },
    { id: 'p2', title: 'B', url: 'https://b.test/', active: false, loading: false, kind: 'page' },
  ];
  const f = fixture(t, {
    tabs: {
      list: () => strip,
      create: () => {},
      select: () => {},
      // The window closes a moment later, and the PC added p3 meanwhile.
      close: (_sessionId, tabId) =>
        setTimeout(() => {
          strip = strip
            .filter((tab) => tab.id !== tabId)
            .concat({ id: 'p3', title: 'C', url: 'about:blank', active: false, loading: false, kind: 'page' });
        }, 100),
    },
  });
  const reply = f.remote.remoteBrowserControl('s', { type: 'close-tab', tabId: 'p1' });
  await f.advance(100);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 2 });
});

test('a vetoed close-tab still counts the tab that stayed', async (t) => {
  const strip = [
    { id: 'p1', title: 'A', url: 'https://a.test/', active: true, loading: false, kind: 'page' },
    { id: 'p2', title: 'B', url: 'https://b.test/', active: false, loading: false, kind: 'page' },
  ];
  const f = fixture(t, { tabs: { list: () => strip, create() {}, select() {}, close() {} } });
  const pending = f.remote.remoteBrowserControl('s', { type: 'close-tab', tabId: 'p2' });
  await f.advance(2_000);
  assert.deepEqual(await pending, { remainingTabs: 2 });
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
  // The page's facts go out at once, describing no picture until one arrives.
  assert.equal(f.frames.length, 1);
  assert.deepEqual([f.frames[0].image, f.frames[0].width, f.frames[0].viewportWidth], [undefined, 0, 0]);
  f.screencastFrame(f.a, 41);
  await f.advance(100);
  assert.ok(
    f.calls.some(([id, method, params]) => id === 1 && method === 'Page.screencastFrameAck' && params.sessionId === 41)
  );
  assert.equal(f.frames.length, 2);
  assert.equal(f.frames[1].documentId, browserDocumentId(f.state, f.a));
  assert.equal(f.frames[1].url, 'https://a.test/');
  assert.equal(f.frames[1].viewportWidth, 400);
  assert.equal(f.frames[1].image.mimeType, 'image/jpeg');
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
  assert.ok(
    f.calls.some(([id, method]) => id === 2 && method === 'Page.startScreencast'),
    'restarted on the new guest'
  );
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

test('after a navigation no frame describes the old document’s picture before the new screencast sends one', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a);
  await f.advance(100);
  assert.deepEqual([f.frames.at(-1).width, f.frames.at(-1).viewportWidth], [400, 400], 'the image is described');

  const count = f.frames.length;
  f.a.url = 'https://a.test/next';
  f.state.beginDocument(f.a);
  f.a.emit('did-navigate');
  // The new document's screencast starts but sends no pixels; facts keep coming.
  await f.advance(1_000);
  f.a.title = 'Next';
  f.a.emit('page-title-updated');
  await f.advance(1_000);
  assert.ok(
    f.calls.filter(([id, method]) => id === 1 && method === 'Page.startScreencast').length >= 2,
    'a new screencast runs for the new document'
  );
  const facts = f.frames.slice(count);
  assert.ok(facts.length > 0);
  assert.equal(facts.at(-1).title, 'Next');
  for (const frame of facts) {
    assert.equal(frame.documentId, browserDocumentId(f.state, f.a));
    assert.deepEqual(
      [frame.image, frame.width, frame.height, frame.viewportWidth, frame.viewportHeight],
      [undefined, 0, 0, 0, 0],
      'the old document’s picture is never described for the new one'
    );
  }

  // Its own image is.
  f.screencastFrame(f.a);
  await f.advance(100);
  assert.deepEqual([f.frames.at(-1).width, f.frames.at(-1).viewportWidth], [400, 400]);
  assert.ok(f.frames.at(-1).image);
});

const PHONE = { type: 'viewport', width: 390, height: 780, deviceScaleFactor: 3 };
const methods = (f, guestId) =>
  f.calls
    .filter(([id, method]) => id === guestId && !['Page.screencastFrameAck', 'Page.getLayoutMetrics'].includes(method))
    .map(([, method]) => method);

test('a phone viewport drives the streamed page before a fresh screencast, once per page and document', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a);
  await settle();
  f.calls.length = 0;
  await f.remote.remoteBrowserControl('s', PHONE);
  assert.deepEqual(methods(f, 1), ['Page.stopScreencast', 'drive.apply', 'Page.startScreencast']);
  assert.deepEqual(f.calls.find(([, method]) => method === 'drive.apply')[2], {
    sessionId: 's',
    width: 390,
    height: 780,
    deviceScaleFactor: 3,
  });

  // The old size's view is gone: page facts go out describing no picture
  // until the new size's image arrives.
  const count = f.frames.length;
  f.a.title = 'Renamed';
  f.a.emit('page-title-updated');
  await f.advance(200);
  const facts = f.frames.slice(count);
  assert.equal(facts.at(-1)?.title, 'Renamed');
  for (const frame of facts) {
    assert.deepEqual(
      [frame.image, frame.width, frame.height, frame.viewportWidth, frame.viewportHeight],
      [undefined, 0, 0, 0, 0],
      'no frame describes the new size with the old image'
    );
  }
  f.screencastFrame(f.a);
  await f.advance(100);
  assert.ok(f.frames.at(-1).image);
  assert.equal(f.frames.at(-1).viewportWidth, 400);

  // The same viewport again (each renewal resends it) changes nothing.
  f.calls.length = 0;
  await f.remote.remoteBrowserControl('s', PHONE);
  await f.advance(200);
  assert.deepEqual(methods(f, 1), []);

  // A new document does not keep the emulation: it is applied again.
  f.state.beginDocument(f.a);
  f.a.emit('did-navigate');
  await f.advance(200);
  assert.deepEqual(methods(f, 1), ['Page.stopScreencast', 'drive.apply', 'Page.startScreencast']);

  // Another page of the session takes the drive; the previous one is restored.
  f.calls.length = 0;
  f.current.guest = f.b;
  await f.advance(200);
  assert.deepEqual(methods(f, 2), ['drive.apply', 'Page.startScreencast']);
  assert.ok(methods(f, 1).includes('drive.restore'));

  // An explicit stop hands the page back to its pane.
  f.calls.length = 0;
  await f.remote.remoteBrowserStream('s', null);
  await settle();
  assert.deepEqual(methods(f, 2), ['Page.stopScreencast', 'drive.restore']);
});

test('a lapsed lease restores the driven page; a viewport without a stream is dropped', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserControl('s', PHONE);
  assert.deepEqual(methods(f, 1), [], 'no stream, no drive');

  await f.remote.remoteBrowserStream('s', SIZE);
  await f.remote.remoteBrowserControl('s', PHONE);
  assert.ok(methods(f, 1).includes('drive.apply'));
  f.calls.length = 0;
  await f.advance(4_000);
  assert.deepEqual(f.changes.at(-1), ['s', false]);
  assert.deepEqual(methods(f, 1), ['Page.stopScreencast', 'drive.restore']);

  // A renewed stream is not driven until the client sends its viewport again.
  f.calls.length = 0;
  await f.remote.remoteBrowserStream('s', SIZE);
  assert.deepEqual(methods(f, 1), ['Page.startScreencast']);
  await f.remote.remoteBrowserControl('s', PHONE);
  assert.ok(methods(f, 1).includes('drive.apply'));
});

test('a stream restarted while the previous one still restores the pane ends at the phone viewport', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  await f.remote.remoteBrowserControl('s', PHONE);
  assert.equal(f.viewports.get(1), 'phone');

  // The old stream's restore is still in flight when the phone streams again.
  let release;
  f.gates.restore = new Promise((resolve) => (release = resolve));
  await f.remote.remoteBrowserStream('s', null);
  const restarted = f.remote.remoteBrowserStream('s', SIZE);
  const driven = f.remote.remoteBrowserControl('s', PHONE);
  await settle();
  release();
  await Promise.all([restarted, driven]);
  await settle();
  assert.equal(f.viewports.get(1), 'phone', 'the stale restore did not undo the new stream');

  // Unchanged renewals keep it.
  await f.remote.remoteBrowserStream('s', SIZE);
  await f.remote.remoteBrowserControl('s', PHONE);
  await f.advance(200);
  assert.equal(f.viewports.get(1), 'phone');
});

async function advance100(f) {
  await f.advance(100);
}

test('a title change alone pushes a metadata-only frame', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a);
  await f.advance(100);
  const count = f.frames.length;
  f.a.title = 'Renamed';
  f.a.emit('page-title-updated');
  await settle();
  await f.advance(100);
  assert.equal(f.frames.length, count + 1);
  assert.equal(f.frames.at(-1).title, 'Renamed');
  assert.equal(f.frames.at(-1).image, undefined, 'the unchanged image is not resent');
});

test('frames carry the dialog the pane offers, and a new or answered dialog pushes a frame', async (t) => {
  const shown = { dialog: undefined };
  const f = fixture(t, { dialog: (guest) => (guest.id === 1 ? shown.dialog : undefined) });
  await f.remote.remoteBrowserStream('s', SIZE);
  f.screencastFrame(f.a);
  await f.advance(100);
  assert.equal(f.frames.at(-1).dialog, undefined);

  const count = f.frames.length;
  shown.dialog = { id: 'leave_1', type: 'beforeunload', message: '' };
  await f.advance(200);
  assert.equal(f.frames.length, count + 1, 'the dialog reaches the client without a repaint');
  assert.deepEqual(f.frames.at(-1).dialog, shown.dialog);
  assert.equal(f.frames.at(-1).image, undefined);

  shown.dialog = undefined;
  await f.advance(200);
  assert.equal(f.frames.length, count + 2);
  assert.equal(f.frames.at(-1).dialog, undefined, 'an answered dialog leaves the client too');
});

test('a fresh stream carries a pending dialog before any pixels, so the client can answer what blocks them', async (t) => {
  const shown = { dialog: { id: 'leave_1', type: 'beforeunload', message: '' } };
  // The dialog holds back painting: no screencast frame, and no layout
  // metrics for a first-frame capture (the fixture answers {}).
  const f = fixture(t, { dialog: () => shown.dialog });
  await f.remote.remoteBrowserStream('s', SIZE);
  await f.advance(1_000);
  assert.ok(f.frames.length > 0, 'a frame goes out without pixels');
  const card = f.frames.at(-1);
  assert.deepEqual(card.dialog, shown.dialog);
  assert.equal(card.image, undefined);
  assert.equal(card.documentId, browserDocumentId(f.state, f.a), 'answerable for the page’s document');

  // Answered, the page paints again and its first image arrives with its size.
  shown.dialog = undefined;
  f.screencastFrame(f.a);
  await f.advance(200);
  const painted = f.frames.at(-1);
  assert.equal(painted.dialog, undefined);
  assert.ok(painted.image);
  assert.deepEqual([painted.viewportWidth, painted.viewportHeight], [400, 300]);
});

test('a dialog holding back debugger initialization still reaches the client, and a new one is pushed meanwhile', async (t) => {
  const shown = { dialog: { id: 'd_1', type: 'alert', message: 'Hello' } };
  const f = fixture(t, { dialog: () => shown.dialog });
  let release;
  f.gates.debugger = new Promise((resolve) => {
    release = resolve;
  });
  // The stream start itself waits on the debugger; its facts do not.
  void f.remote.remoteBrowserStream('s', SIZE);
  await f.advance(100);
  assert.equal(f.frames.length, 1, 'the card goes out before the debugger is ready');
  assert.deepEqual(f.frames[0].dialog, shown.dialog);
  assert.deepEqual(
    [f.frames[0].image, f.frames[0].width, f.frames[0].height, f.frames[0].viewportWidth, f.frames[0].viewportHeight],
    [undefined, 0, 0, 0, 0],
    'no picture is described'
  );
  assert.equal(f.frames[0].documentId, browserDocumentId(f.state, f.a));
  assert.equal(f.calls.some(([, method]) => method === 'Page.startScreencast'), false);

  // The watch keeps reporting while the start is still stuck.
  shown.dialog = { id: 'd_2', type: 'confirm', message: 'Sure?' };
  await f.advance(1_000);
  assert.deepEqual(f.frames.at(-1).dialog, shown.dialog);

  shown.dialog = undefined;
  release();
  await f.advance(1_000);
  assert.ok(f.calls.some(([, method]) => method === 'Page.startScreencast'), 'the screencast starts once it can');
  f.screencastFrame(f.a);
  await f.advance(200);
  assert.ok(f.frames.at(-1).image);
  assert.equal(f.frames.at(-1).dialog, undefined);
});

test('remote toolbar navigation is a leave request like the pane\'s', async (t) => {
  const requests = [];
  const f = fixture(t, { leave: { request: (guest, run) => requests.push([guest.id, run]) } });
  await f.remote.remoteBrowserControl('s', { type: 'navigate', url: 'https://b.test/' });
  await f.remote.remoteBrowserControl('s', { type: 'back' });
  await f.remote.remoteBrowserControl('s', { type: 'reload' });
  assert.deepEqual(
    requests.map(([id]) => id),
    [1, 1, 1]
  );
  assert.deepEqual(f.dispatched, [], 'navigation never reaches page input');
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
