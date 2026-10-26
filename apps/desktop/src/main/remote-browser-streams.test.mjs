import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_BROWSER_FRAME_EVENT, REMOTE_BROWSER_OPEN_EVENT, BROWSER_OPEN_REQUESTED_DESKTOP_EVENT } from '../shared/remote-browser.ts';
import { createBrowserRemoteStreams } from './remote-browser-streams.ts';
import { createRelayPushLanes } from './remote-relay-push-lanes.ts';

const SIZE = { maxWidth: 800, maxHeight: 600 };
const frame = (seq, extra = {}) => ({
  sessionId: 's',
  seq,
  frameId: `rbf_${seq}`,
  documentId: 'p1:1',
  url: 'https://a.test/',
  title: 't',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  width: 10,
  height: 10,
  viewportWidth: 10,
  viewportHeight: 10,
  image: { mimeType: 'image/jpeg', data: `img${seq}` },
  ...extra,
});

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const requests = [];
  const live = new Set(['c1', 'c2']);
  const streams = createBrowserRemoteStreams({
    isLive: (id) => live.has(id),
    send: async (id, message) => {
      sent.push([id, message]);
    },
    request: async (sessionId, options) => {
      requests.push([sessionId, options]);
    },
  });
  return { streams, sent, requests, live };
}

test('a client gets one frame in flight; the newest replaces superseded ones after its ack', (t) => {
  const f = fixture(t);
  f.streams.subscribe('c1', 's', SIZE);
  f.streams.publish(frame(1));
  f.streams.publish(frame(2));
  f.streams.publish(frame(3));
  assert.deepEqual(f.sent.map(([id, m]) => [id, m.event, m.payload.seq]), [['c1', REMOTE_BROWSER_FRAME_EVENT, 1]]);
  f.streams.acknowledge('c1', 's', 99);
  assert.equal(f.sent.length, 1, 'an unrelated ack releases nothing');
  f.streams.acknowledge('c1', 's', 1);
  assert.deepEqual(f.sent.map(([, m]) => m.payload.seq), [1, 3], 'frame 2 was dropped');
  f.streams.acknowledge('c1', 's', 3);
  assert.equal(f.sent.length, 2, 'nothing newer to send');
});

test('a take-over joining an unfitted stream is shown no picture until the fitted layout’s first one', (t) => {
  const f = fixture(t);
  const FIT = { width: 411, height: 782, deviceScaleFactor: 2.625 };
  // A watcher streams the agent's page as it is.
  f.streams.subscribe('c1', 's', SIZE);
  f.streams.publish(frame(1));
  f.streams.acknowledge('c1', 's', 1);

  // The take-over joins: the cached unfitted frame goes out as facts only.
  f.streams.subscribe('c2', 's', { ...SIZE, fit: FIT });
  assert.deepEqual(f.requests.at(-1), ['s', { ...SIZE, fit: FIT }], 'the desktop is asked to fit');
  const first = f.sent.filter(([id]) => id === 'c2').at(-1)[1].payload;
  assert.equal(first.image, undefined);
  assert.deepEqual([first.width, first.height, first.viewportWidth, first.viewportHeight], [0, 0, 0, 0]);
  assert.equal(first.documentId, 'p1:1', 'the page facts still arrive');
  f.streams.acknowledge('c2', 's', 1);

  // A late unfitted picture, and a facts frame inheriting it: still no picture.
  f.streams.publish(frame(2));
  f.streams.acknowledge('c2', 's', 2);
  f.streams.publish(frame(3, { image: undefined, title: 'x', fitSettled: true }));
  f.streams.acknowledge('c2', 's', 3);
  for (const [, message] of f.sent.filter(([id]) => id === 'c2')) {
    assert.equal(message.payload.image, undefined, `frame ${message.payload.seq} shows no unfitted picture`);
  }

  // The fitted layout's first picture is the first one it sees, and pictures flow from then on.
  f.streams.publish(frame(4, { viewportWidth: 411, viewportHeight: 782, fitSettled: true }));
  assert.equal(f.sent.at(-1)[0], 'c2');
  assert.equal(f.sent.at(-1)[1].payload.image.data, 'img4');
  f.streams.acknowledge('c2', 's', 4);
  f.streams.publish(frame(5, { fitSettled: true }));
  assert.equal(f.sent.filter(([id]) => id === 'c2').at(-1)[1].payload.image.data, 'img5');
  // The watcher is never held back.
  assert.ok(f.sent.filter(([id]) => id === 'c1').every(([, message]) => message.payload.image));
});

test('take-over intent lasts for the subscription: a renewal omitting fit keeps it; fit: null or the end releases it', (t) => {
  const f = fixture(t);
  const FIT = { width: 411, height: 782, deviceScaleFactor: 2.625 };
  f.streams.subscribe('c1', 's', SIZE);
  // fit → omitted → fit: every request to the desktop keeps the same fit.
  f.streams.subscribe('c2', 's', { ...SIZE, fit: FIT });
  f.streams.subscribe('c2', 's', SIZE);
  f.streams.subscribe('c2', 's', { ...SIZE, fit: FIT });
  f.streams.subscribe('c1', 's', SIZE);
  assert.deepEqual(
    f.requests.slice(1).map(([, options]) => options.fit),
    [FIT, FIT, FIT, FIT],
    'no request without the fit: no restore, no re-fit'
  );
  assert.equal(f.streams.awaitingFit('c2', 's'), true, 'the wait is not reset either');

  // An explicit release ends it while the subscription stays.
  f.streams.subscribe('c2', 's', { ...SIZE, fit: null });
  assert.deepEqual(f.requests.at(-1), ['s', SIZE]);
  assert.equal(f.streams.awaitingFit('c2', 's'), false);
  f.streams.subscribe('c2', 's', SIZE);
  assert.deepEqual(f.requests.at(-1), ['s', SIZE], 'a released take-over stays released');

  // So does the subscription's end.
  f.streams.subscribe('c2', 's', { ...SIZE, fit: FIT });
  assert.deepEqual(f.requests.at(-1), ['s', { ...SIZE, fit: FIT }]);
  f.streams.unsubscribe('c2', 's');
  assert.deepEqual(f.requests.at(-1), ['s', SIZE]);
});

test('a fit that failed ends a take-over’s wait: it is shown the page as when watching', (t) => {
  const f = fixture(t);
  f.streams.subscribe('c2', 's', { ...SIZE, fit: { width: 411, height: 782, deviceScaleFactor: 2.625 } });
  f.streams.publish(frame(1));
  assert.equal(f.sent.at(-1)[1].payload.image, undefined);
  assert.equal(f.streams.awaitingFit('c2', 's'), true);
  f.streams.acknowledge('c2', 's', 1);
  f.streams.publish(frame(2, { fitFailed: true }));
  assert.equal(f.sent.at(-1)[1].payload.image.data, 'img2');
  assert.equal(f.sent.at(-1)[1].payload.fitFailed, true);
  assert.equal(f.streams.awaitingFit('c2', 's'), false, 'its WebRTC view may be promoted as a watcher’s');
});

test('while WebRTC owns a client view its frames carry facts only; resuming resends the newest picture', (t) => {
  const f = fixture(t);
  f.streams.subscribe('c1', 's', SIZE);
  f.streams.subscribe('c2', 's', SIZE);
  assert.equal(f.streams.subscribed('c1', 's'), true);
  assert.equal(f.streams.subscribed('c3', 's'), false);
  f.streams.setImages('c1', 's', false);
  f.streams.publish(frame(1));
  const toC1 = f.sent.filter(([id]) => id === 'c1').map(([, m]) => m.payload);
  const toC2 = f.sent.filter(([id]) => id === 'c2').map(([, m]) => m.payload);
  assert.deepEqual([toC1[0].seq, toC1[0].image, toC1[0].documentId], [1, undefined, 'p1:1']);
  assert.equal(toC2[0].image.data, 'img1', 'another viewer keeps its JPEG view');
  f.streams.acknowledge('c1', 's', 1);
  f.streams.setImages('c1', 's', true);
  const resumed = f.sent.filter(([id]) => id === 'c1').at(-1)[1].payload;
  assert.equal(resumed.image.data, 'img1', 'the JPEG view returns without waiting for a repaint');
});

test('a dropped subscription is reported, per client and session', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dropped = [];
  const streams = createBrowserRemoteStreams({
    isLive: () => true,
    send: async () => {},
    request: async () => {},
    onDrop: (clientId, sessionId) => dropped.push([clientId, sessionId]),
  });
  streams.subscribe('c1', 's', SIZE);
  streams.unsubscribe('c1', 's');
  streams.subscribe('c2', 's', SIZE);
  t.mock.timers.tick(4_000);
  assert.deepEqual(dropped, [
    ['c1', 's'],
    ['c2', 's'],
  ]);
});

test('an unacknowledged frame is superseded after 1.5s', (t) => {
  const f = fixture(t);
  f.streams.subscribe('c1', 's', SIZE);
  f.streams.publish(frame(1));
  f.streams.publish(frame(2));
  t.mock.timers.tick(1_499);
  assert.equal(f.sent.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(f.sent.map(([, m]) => m.payload.seq), [1, 2]);
});

test('clients are paced independently and a metadata-only frame keeps the waiting image', (t) => {
  const f = fixture(t);
  f.streams.subscribe('c1', 's', SIZE);
  f.streams.subscribe('c2', 's', { maxWidth: 1200, maxHeight: 400 });
  assert.deepEqual(f.requests.at(-1), ['s', { maxWidth: 1200, maxHeight: 600 }], 'largest request wins');
  // A take-over's fit reaches the desktop with the request: the earliest one.
  const fit = { width: 411, height: 782, deviceScaleFactor: 2.625 };
  f.streams.subscribe('c3', 's', { ...SIZE, fit });
  f.streams.subscribe('c4', 's', { ...SIZE, fit: { ...fit, width: 360 } });
  assert.deepEqual(f.requests.at(-1), ['s', { maxWidth: 1200, maxHeight: 600, fit }]);
  f.streams.unsubscribe('c3', 's');
  f.streams.unsubscribe('c4', 's');
  assert.deepEqual(f.requests.at(-1), ['s', { maxWidth: 1200, maxHeight: 600 }], 'watchers carry no fit');
  f.streams.publish(frame(1));
  f.streams.acknowledge('c2', 's', 1);
  f.streams.publish(frame(2));
  f.streams.acknowledge('c2', 's', 2);
  f.streams.publish(frame(3, { image: undefined, title: 'renamed' }));
  const byClient = (id) => f.sent.filter(([to]) => to === id).map(([, m]) => m.payload);
  assert.deepEqual(byClient('c2').map((p) => p.seq), [1, 2, 3]);
  assert.deepEqual(byClient('c1').map((p) => p.seq), [1]);
  f.streams.acknowledge('c1', 's', 1);
  const last = byClient('c1').at(-1);
  assert.equal(last.seq, 3);
  assert.equal(last.title, 'renamed');
  assert.equal(last.image.data, 'img2', 'the dropped image still reaches the slow client');
});

test('a late subscriber receives the latest frame immediately, a stop reaches the desktop when none remain', (t) => {
  const f = fixture(t);
  f.streams.subscribe('c1', 's', SIZE);
  f.streams.publish(frame(1));
  f.streams.subscribe('c2', 's', SIZE);
  assert.deepEqual(f.sent.at(-1).slice(0, 1), ['c2']);
  f.streams.unsubscribe('c1', 's');
  assert.equal(f.requests.at(-1)[1] !== null, true, 'another client still streams');
  f.streams.unsubscribe('c2', 's');
  assert.deepEqual(f.requests.at(-1), ['s', null]);
  f.streams.publish(frame(2));
  assert.equal(f.sent.length, 2, 'frames with no subscriber are dropped');
});

test('a subscription not renewed for 4s lapses, and a disconnected client is dropped', (t) => {
  const f = fixture(t);
  f.streams.subscribe('c1', 's', SIZE);
  t.mock.timers.tick(3_000);
  f.streams.subscribe('c1', 's', SIZE);
  t.mock.timers.tick(3_000);
  assert.notEqual(f.requests.at(-1)[1], null);
  t.mock.timers.tick(1_000);
  assert.deepEqual(f.requests.at(-1), ['s', null]);
  f.streams.subscribe('c2', 's', SIZE);
  f.live.delete('c2');
  f.streams.publish(frame(1));
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.requests.at(-1), ['s', null]);
});

test('an explicit reveal or hide request is forwarded to every client as a non-droppable open event', (t) => {
  const broadcasts = [];
  let listener;
  const push = createRelayPushLanes({
    clients: new Map([['web', { lanes: new Set() }]]),
    subscribeDesktopEvents: (next) => {
      listener = next;
      return () => {};
    },
    broadcastEncrypted: (...args) => broadcasts.push(args),
  });
  t.after(() => push.dispose());
  const request = { sessionId: 's', reveal: true };
  listener({ name: BROWSER_OPEN_REQUESTED_DESKTOP_EVENT, value: request });
  listener({ name: BROWSER_OPEN_REQUESTED_DESKTOP_EVENT, value: { sessionId: 's', hide: true } });
  assert.deepEqual(broadcasts, [
    [{ event: REMOTE_BROWSER_OPEN_EVENT, payload: request }, false],
    [{ event: REMOTE_BROWSER_OPEN_EVENT, payload: { sessionId: 's', hide: true } }, false],
  ]);
});
