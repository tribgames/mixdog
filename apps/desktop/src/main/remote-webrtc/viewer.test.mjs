import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_WEBRTC_VERSION } from '../../shared/remote-webrtc.ts';
import {
  REMOTE_WEBRTC_DEMOTE_ACK_TIMEOUT_MS,
  REMOTE_WEBRTC_NEGOTIATION_TIMEOUT_MS,
  createRemoteWebrtcViewer,
} from './viewer.ts';

const HEX_A = Array.from({ length: 32 }, () => 'AB').join(':');
const HEX_B = Array.from({ length: 32 }, () => 'CD').join(':');
const SDP = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${HEX_A}\r\n`;
const TURN = [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }];
const source = { kind: 'browser', sessionId: 's1' };
const geometry = { generation: 1, cssWidth: 400, cssHeight: 300, deviceScaleFactor: 1, pixelWidth: 400, pixelHeight: 300 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** `dispatch`: an extra step every dispatch awaits (to hold one in flight). */
function harness({ dispatch } = {}) {
  const signals = [];
  const sender = [];
  const dispatched = [];
  const acks = [];
  const released = [];
  const timers = new Map();
  let timerId = 0;
  let connectionSerial = 0;
  const page = { documentId: 'p1:1', geometry, framesSinceCurrent: 1 };
  const promotions = { count: 0 };
  const viewer = createRemoteWebrtcViewer(source, {
    signal: (signal) => signals.push(signal),
    open: (connection) => sender.push(['open', connection.connectionId]),
    answer: (id, sdp) => sender.push(['answer', id, sdp]),
    candidate: (id, candidate) => sender.push(['candidate', id, candidate]),
    channelSend: (_id, text) => acks.push(JSON.parse(text)),
    close: (id) => sender.push(['close', id]),
    dispatch: async (control) => {
      dispatched.push(control.type === 'text' ? control.text : control.type);
      await dispatch?.(control);
    },
    release: async (controls) => {
      released.push(controls.map((control) => `${control.phase}:${control.button}`));
    },
    page: () => page,
    newConnectionId: () => `connection_${String(++connectionSerial).padStart(12, '0')}`,
    now: () => 0,
    setTimer: (run, ms) => {
      timerId += 1;
      timers.set(timerId, { run, ms });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
    report: () => {},
    promoted: () => {
      promotions.count += 1;
    },
  });
  const last = (type) => signals.filter((signal) => signal.type === type).at(-1);
  const ref = () => {
    const offer = last('offer');
    return { v: REMOTE_WEBRTC_VERSION, source, connectionId: offer.connectionId, generation: offer.generation };
  };
  const fire = (ms) => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms === ms) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  const input = (epoch, seq, control, geometryGeneration = 1) =>
    JSON.stringify({ v: REMOTE_WEBRTC_VERSION, kind: 'input', epoch, seq, geometryGeneration, sentAt: seq, control });
  /** ready → offer → answer → connected (matching certificate). */
  const connect = () => {
    viewer.ready(['video/VP8'], TURN);
    viewer.senderOffer(sender.filter(([kind]) => kind === 'open').at(-1)[1], SDP);
    viewer.signal({ ...ref(), type: 'answer', sdp: SDP, fingerprints: [{ algorithm: 'sha-256', value: HEX_A }] });
    viewer.senderConnected(ref().connectionId, { fingerprintAlgorithm: 'sha-256', fingerprint: HEX_A });
  };
  /** …then media-ready → promote → promote-ack. */
  const promote = () => {
    connect();
    viewer.geometryAck(1);
    viewer.signal({ ...ref(), type: 'media-ready', documentId: 'p1:1', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 });
    const epoch = last('promote').inputEpoch;
    viewer.signal({ ...ref(), type: 'promote-ack', inputEpoch: epoch });
    return epoch;
  };
  return { viewer, signals, sender, dispatched, acks, released, timers, page, last, ref, fire, input, connect, promote, promotions };
}

test('desktop pushes reach the channel only while it is up; promotion announces it once', () => {
  const h = harness();
  const push = { v: REMOTE_WEBRTC_VERSION, kind: 'screen-cursor', x: 1, y: 2, generation: 1 };
  h.viewer.push(JSON.stringify(push));
  h.connect();
  h.viewer.push(JSON.stringify(push));
  assert.deepEqual(h.acks, [], 'nothing before promotion: the phone’s channel may not be open');
  h.viewer.geometryAck(1);
  h.viewer.signal({ ...h.ref(), type: 'media-ready', documentId: 'p1:1', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 });
  assert.equal(h.promotions.count, 1);
  h.viewer.push(JSON.stringify(push));
  assert.deepEqual(h.acks, [push], 'sent while promoting');
  h.viewer.signal({ ...h.ref(), type: 'promote-ack', inputEpoch: h.last('promote').inputEpoch });
  h.viewer.push(JSON.stringify({ ...push, x: 3 }));
  assert.equal(h.acks.length, 2);
  assert.equal(h.promotions.count, 1);
});

const KEY = { type: 'key', key: 'Enter', documentId: 'p1:1' };
const TEXT = (text) => ({ type: 'text', text, documentId: 'p1:1' });
const POINTER = {
  type: 'pointer',
  phase: 'mousePressed',
  x: 10,
  y: 10,
  button: 'left',
  buttons: 1,
  modifiers: 0,
  clickCount: 1,
  documentId: 'p1:1',
};

test('the offer carries the SDP fingerprints, TURN-only policy, locked geometry and the relay epoch', () => {
  const h = harness();
  h.viewer.ready(['video/VP8'], TURN);
  assert.equal(h.viewer.state, 'negotiating');
  h.viewer.senderOffer(h.sender[0][1], SDP);
  const offer = h.last('offer');
  assert.deepEqual(offer.fingerprints, [{ algorithm: 'sha-256', value: HEX_A }]);
  assert.equal(offer.iceTransportPolicy, 'relay');
  assert.deepEqual(offer.iceServers, TURN);
  assert.deepEqual(offer.geometry, geometry);
  assert.equal(offer.inputEpoch, 1);
});

test('without a TURN server the phone is told at once and the JPEG view stays', () => {
  const h = harness();
  h.viewer.ready(['video/VP8'], [{ urls: ['stun:turn.example:3478'] }]);
  assert.equal(h.viewer.state, 'relay');
  assert.deepEqual(h.sender, [], 'no peer connection is opened');
  assert.equal(h.last('close').reason, 'turn-unavailable');
});

test('stale generations and foreign connections are discarded', () => {
  const h = harness();
  h.connect();
  const ref = h.ref();
  h.viewer.signal({ ...ref, generation: ref.generation + 1, type: 'close', reason: 'ice-failed' });
  h.viewer.signal({ ...ref, connectionId: 'connection_999999999999', type: 'close', reason: 'ice-failed' });
  h.viewer.senderFailed('connection_999999999999', 'ice-failed');
  assert.equal(h.viewer.state, 'connected');
});

test('a connected certificate other than the E2EE-signaled one is rejected', () => {
  const h = harness();
  h.viewer.ready(['video/VP8'], TURN);
  h.viewer.senderOffer(h.sender[0][1], SDP);
  h.viewer.signal({ ...h.ref(), type: 'answer', sdp: SDP, fingerprints: [{ algorithm: 'sha-256', value: HEX_A }] });
  h.viewer.senderConnected(h.ref().connectionId, { fingerprintAlgorithm: 'sha-256', fingerprint: HEX_B });
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.last('close').reason, 'fingerprint-mismatch');
  assert.equal(h.last('close').retryAfterMs, undefined, 'no new attempt is welcome');
  // The path never worked: no automatic retry.
  h.viewer.ready(['video/VP8'], TURN);
  assert.equal(h.viewer.state, 'cooldown');
});

test('negotiation is bounded; a failure before promotion goes straight back without demotion', () => {
  const h = harness();
  h.viewer.ready(['video/VP8'], TURN);
  h.fire(REMOTE_WEBRTC_NEGOTIATION_TIMEOUT_MS);
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.last('close').reason, 'negotiation-timeout');
  assert.equal(h.last('demote'), undefined);
  assert.ok(h.sender.some(([kind]) => kind === 'close'));
});

test('promotion needs a frame of the current document and the acknowledged geometry', () => {
  const h = harness();
  h.connect();
  const media = { ...h.ref(), type: 'media-ready', documentId: 'p1:1', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 };
  h.viewer.signal(media);
  assert.equal(h.viewer.state, 'connected', 'geometry not acknowledged yet');
  h.viewer.geometryAck(1);
  h.viewer.signal({ ...media, documentId: 'p1:0' });
  h.viewer.signal({ ...media, pixelWidth: 200 });
  h.page.framesSinceCurrent = 0;
  h.viewer.signal(media);
  assert.equal(h.viewer.state, 'connected');
  h.page.framesSinceCurrent = 1;
  h.viewer.signal(media);
  assert.equal(h.viewer.state, 'promoting');
  assert.equal(h.last('promote').inputEpoch, 2);
});

test('channel input waits behind the promote-ack barrier, then runs once and in order', async () => {
  const h = harness();
  h.connect();
  h.viewer.geometryAck(1);
  h.viewer.signal({ ...h.ref(), type: 'media-ready', documentId: 'p1:1', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 });
  const id = h.ref().connectionId;
  h.viewer.channel(id, h.input(2, 1, TEXT('a')), 0);
  h.viewer.channel(id, h.input(2, 2, TEXT('b')), 0);
  h.viewer.channel(id, h.input(2, 2, TEXT('b')), 0);
  await flush();
  assert.deepEqual(h.dispatched, [], 'held until the relay ack proves earlier relay input settled');
  h.viewer.signal({ ...h.ref(), type: 'promote-ack', inputEpoch: 2 });
  assert.equal(h.viewer.state, 'webrtc');
  await h.viewer.settled();
  assert.deepEqual(h.dispatched, ['a', 'b'], 'a repeated seq is never applied twice');
  assert.deepEqual(
    h.acks.map((ack) => [ack.seq, ack.outcome]),
    [
      [1, 'applied'],
      [2, 'applied'],
    ]
  );
});

test('demotion opens a new epoch: queued and late channel input is never applied or replayed', async () => {
  const h = harness();
  const epoch = h.promote();
  const id = h.ref().connectionId;
  h.viewer.channel(id, h.input(epoch, 1, KEY), 0);
  // The channel fails while that input is still queued.
  h.viewer.senderFailed(id, 'ice-failed');
  assert.equal(h.viewer.state, 'demoting');
  assert.equal(h.last('demote').inputEpoch, epoch + 1);
  h.viewer.channel(id, h.input(epoch, 2, TEXT('late')), 0);
  await h.viewer.settled();
  assert.deepEqual(h.dispatched, [], 'queued and late input of the old epoch is never applied');
  assert.deepEqual(
    h.acks.map((ack) => [ack.seq, ack.outcome]),
    [[1, 'rejected']],
    'the phone learns it was not applied (and must not replay it)'
  );
  // No answer within the relay ack window: the connection closes, input is relay's.
  h.fire(REMOTE_WEBRTC_DEMOTE_ACK_TIMEOUT_MS);
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.last('close').reason, 'ice-failed');
});

test('a demoted viewer that had worked may retry; demote-ack completes the hand-back', () => {
  const h = harness();
  const epoch = h.promote();
  h.viewer.signal({ ...h.ref(), type: 'close', reason: 'channel-failed' });
  assert.equal(h.viewer.state, 'demoting');
  h.viewer.signal({ ...h.ref(), type: 'demote-ack', inputEpoch: epoch });
  assert.equal(h.viewer.state, 'demoting', 'an ack of the old epoch does not count');
  const ref = h.ref();
  h.viewer.signal({ ...ref, type: 'demote-ack', inputEpoch: epoch + 1 });
  assert.equal(h.viewer.state, 'cooldown');
  const close = h.last('close');
  assert.deepEqual(
    [close.connectionId, close.reason, close.retryAfterMs],
    [ref.connectionId, 'channel-failed', 0],
    'the hand-back ends with close, welcoming another attempt now'
  );
  h.viewer.ready(['video/VP8'], TURN);
  assert.equal(h.viewer.state, 'negotiating');
});

test('mouse buttons the channel pressed are released at hand-back and when the viewer leaves', async () => {
  const h = harness();
  const epoch = h.promote();
  const id = h.ref().connectionId;
  h.viewer.channel(id, h.input(epoch, 1, POINTER), 0);
  h.viewer.channel(id, h.input(epoch, 2, { ...POINTER, button: 'right', buttons: 2 }), 0);
  h.viewer.channel(id, h.input(epoch, 3, { ...POINTER, button: 'right', buttons: 0, phase: 'mouseReleased' }), 0);
  await h.viewer.settled();
  h.viewer.senderFailed(id, 'ice-failed');
  await h.viewer.settled();
  assert.deepEqual(h.released, [['mouseReleased:left']], 'only the still-pressed button');

  const left = harness();
  const leftEpoch = left.promote();
  left.viewer.channel(left.ref().connectionId, left.input(leftEpoch, 1, POINTER), 0);
  await left.viewer.settled();
  left.viewer.stop();
  await left.viewer.settled();
  assert.deepEqual(left.released, [['mouseReleased:left']]);
  assert.equal(left.last('demote'), undefined, 'leaving is a close, not a demotion');
});

test('a press still being dispatched at hand-back is released once it lands', async () => {
  const handBacks = {
    demotion: (h, id) => h.viewer.senderFailed(id, 'ice-failed'),
    departure: (h) => h.viewer.stop(),
  };
  for (const [name, handBack] of Object.entries(handBacks)) {
    let land;
    const h = harness({ dispatch: () => new Promise((resolve) => (land = resolve)) });
    const epoch = h.promote();
    const id = h.ref().connectionId;
    h.viewer.channel(id, h.input(epoch, 1, POINTER), 0);
    await flush();
    assert.deepEqual(h.dispatched, ['pointer'], `${name}: the press is in flight`);
    handBack(h, id);
    land();
    await h.viewer.settled();
    assert.deepEqual(h.released, [['mouseReleased:left']], `${name}: the late press is released`);
  }
});

test('coordinate input needs the current, acknowledged geometry; keys do not', async () => {
  const h = harness();
  const epoch = h.promote();
  const id = h.ref().connectionId;
  // An explicit resize locked generation 2; the phone has not acked it yet.
  h.page.geometry = { ...geometry, generation: 2, cssWidth: 390 };
  h.viewer.geometryChanged();
  assert.equal(h.last('geometry').geometry.generation, 2);
  h.viewer.channel(id, h.input(epoch, 1, POINTER, 1), 0);
  h.viewer.channel(id, h.input(epoch, 2, POINTER, 2), 0);
  h.viewer.channel(id, h.input(epoch, 3, KEY, 1), 0);
  await h.viewer.settled();
  assert.deepEqual(h.dispatched, ['key']);
  h.viewer.geometryAck(2);
  h.viewer.channel(id, h.input(epoch, 4, POINTER, 2), 0);
  await h.viewer.settled();
  assert.deepEqual(h.dispatched, ['key', 'pointer']);
});

test('a phone that starts over supersedes the connection after a demotion, then renegotiates', () => {
  const h = harness();
  const epoch = h.promote();
  const first = h.ref().connectionId;
  h.viewer.ready(['video/VP8'], TURN);
  assert.equal(h.viewer.state, 'demoting');
  assert.equal(h.last('demote').reason, 'superseded');
  h.viewer.signal({ ...h.ref(), type: 'demote-ack', inputEpoch: epoch + 1 });
  assert.equal(h.viewer.state, 'negotiating');
  assert.notEqual(h.sender.filter(([kind]) => kind === 'open').at(-1)[1], first);
});

test('screen input on a browser source is a contract violation', () => {
  const h = harness();
  const epoch = h.promote();
  const text = JSON.stringify({
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-input',
    epoch,
    seq: 1,
    geometryGeneration: 1,
    sentAt: 0,
    control: { type: 'screen-release' },
  });
  h.viewer.channel(h.ref().connectionId, text, 0);
  assert.equal(h.viewer.state, 'demoting');
  assert.equal(h.last('demote').reason, 'protocol-error');
});

test('a held ready starts when the superseded connection never answers its demotion', () => {
  // The phone reconnected and dropped its connection: no demote-ack comes.
  const h = harness();
  h.promote();
  const first = h.ref().connectionId;
  h.viewer.ready(['video/VP8'], TURN);
  assert.equal(h.viewer.state, 'demoting');
  h.fire(REMOTE_WEBRTC_DEMOTE_ACK_TIMEOUT_MS);
  const close = h.signals.filter((signal) => signal.type === 'close').at(-1);
  assert.deepEqual([close.connectionId, close.reason, close.retryAfterMs], [first, 'superseded', 0]);
  assert.equal(h.viewer.state, 'negotiating', 'the held ready started');
  const opened = h.sender.filter(([kind]) => kind === 'open').at(-1)[1];
  assert.notEqual(opened, first, 'a fresh connection id');
});

test('a viewer that leaves closes its connection and takes no further input', async () => {
  const h = harness();
  const epoch = h.promote();
  const id = h.ref().connectionId;
  h.viewer.stop();
  assert.equal(h.viewer.state, 'closed');
  assert.equal(h.last('close').reason, 'viewer-left');
  h.viewer.channel(id, h.input(epoch, 1, KEY), 0);
  await h.viewer.settled();
  assert.deepEqual(h.dispatched, []);
});
