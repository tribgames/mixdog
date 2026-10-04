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
