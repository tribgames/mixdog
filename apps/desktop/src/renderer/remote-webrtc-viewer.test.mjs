import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRemoteWebrtcChannelFromClient,
  parseRemoteWebrtcClientSignal,
  parseRemoteWebrtcDesktopSignal,
  readRemoteWebrtcDesktopSignal,
} from '../shared/remote-webrtc.ts';
import { generateSecureDesktopControllerKey } from '../shared/secure-desktop-grant.ts';
import { createRemoteBrowserInputQueue } from './remote-browser-input.ts';
import { createScreenCursorStore } from './remote-screen-touch.ts';
import { createScreenCursorTracker } from './remote-screen-state.ts';
import { readRemoteWebrtcReceiverStats } from './remote-webrtc-stats.ts';
import { createRemoteWebrtcViewer } from './remote-webrtc-viewer.ts';
import { remoteVideoLimit } from './remote-view-zoom.ts';
import { routeRemoteInput } from './use-remote-webrtc.ts';

const hex = (byte) => Array.from({ length: 32 }, () => byte).join(':');
const DESKTOP_FP = { algorithm: 'sha-256', value: hex('AB') };
const PHONE_FP = { algorithm: 'sha-256', value: hex('CD') };
const sdp = (fp) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:${fp.algorithm} ${fp.value}\r\n`;
const source = { kind: 'browser', sessionId: 's1' };
const geometry = (generation = 1) => ({
  generation,
  cssWidth: 1280,
  cssHeight: 720,
  deviceScaleFactor: 1,
  pixelWidth: 1280,
  pixelHeight: 720,
});
const id = (n) => `conn${String(n).padStart(16, '0')}`;
const turn = [{ urls: ['turns:turn.mixdog.test:443?transport=tcp'], username: 'u', credential: 'c' }];
const offerBody = (generation, extra = {}) => ({
  v: 1,
  source,
  type: 'offer',
  connectionId: id(generation),
  generation,
  sdp: sdp(DESKTOP_FP),
  fingerprints: [DESKTOP_FP],
  iceServers: turn,
  iceTransportPolicy: 'all',
  geometry: geometry(),
  inputEpoch: 1,
  ...extra,
});
const offer = (generation, extra = {}) => parseRemoteWebrtcDesktopSignal(offerBody(generation, extra));
const signal = (generation, body) =>
  parseRemoteWebrtcDesktopSignal({ v: 1, source, connectionId: id(generation), generation, ...body });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await tick();
};

class FakeChannel {
  constructor() {
    this.label = 'mixdog-input';
    this.readyState = 'open';
    this.sent = [];
  }
  send(text) {
    if (this.readyState !== 'open') throw new Error('channel closed');
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePeer {
  constructor(configuration, peers) {
    this.configuration = configuration;
    this.added = [];
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.closed = false;
    this.report = new Map();
    peers.push(this);
  }
  async setRemoteDescription(description) {
    this.remote = description;
  }
  async createAnswer() {
    return { type: 'answer', sdp: sdp(PHONE_FP) };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async addIceCandidate(candidate) {
    this.added.push(candidate);
  }
  async getStats() {
    return this.report;
  }
  close() {
    this.closed = true;
  }
  /** DTLS up with `certificate` as the peer's; the channel and track arrive. */
  connect(certificate = DESKTOP_FP) {
    this.report.set('t', { id: 't', type: 'transport', dtlsState: 'connected', remoteCertificateId: 'rc' });
    this.report.set('rc', {
      id: 'rc',
      type: 'certificate',
      fingerprint: certificate.value,
      fingerprintAlgorithm: certificate.algorithm,
    });
    this.channel = new FakeChannel();
    this.ondatachannel({ channel: this.channel });
    this.ontrack({ receiver: { jitterBufferTarget: null }, streams: ['stream'], track: {} });
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
    this.onconnectionstatechange();
  }
}

/** A viewer wired to a pipelined relay queue, with every wire event in order. */
function harness({ documentId = 'p1:0', holdClose = false, refuse = null, extra = {} } = {}) {
  const wire = [];
  const heldCloses = [];
  const peers = [];
  const failures = [];
  const timers = [];
  const relayGates = [];
  const queue = createRemoteBrowserInputQueue({
    send: (input, order) => {
      wire.push({ relay: input.type, phase: input.phase, seq: order?.seq });
      return new Promise((resolve, reject) => relayGates.push({ resolve, reject }));
    },
    pipelined: () => true,
    failure: (message) => failures.push(message),
    settled() {},
    streamId: 'stream-0000000000000000',
  });
  let dropped = 0;
  const streams = [];
  const clock = { now: 1_000 };
  const viewer = createRemoteWebrtcViewer({
    source,
    signal: async (body) => {
      wire.push({ signal: body.type, ...body });
      if (holdClose && body.type === 'close') await new Promise((resolve) => heldCloses.push(resolve));
      if (refuse === body.type) throw new Error(`${body.type} refused`);
    },
    fence: (work) => queue.fence(work),
    createPeer: (configuration) => new FakePeer(configuration, peers),
    receiveCodecs: () => ['video/VP8', 'video/H264'],
    documentId: () => documentId,
    dropInput: () => {
      dropped += 1;
    },
    changed() {},
    stream: (stream) => streams.push(stream),
    failure: (message) => failures.push(message),
    statsIntervalMs: 2_000,
    log() {},
    ...extra,
    now: () => clock.now,
    timers: {
      setTimeout: (callback, ms) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimeout() {},
      setInterval: () => 0,
      clearInterval() {},
    },
  });
  const route = (control) => routeRemoteInput(viewer, queue, control, (message) => failures.push(message));
  return {
    viewer,
    queue,
    wire,
    peers,
    failures,
    timers,
    streams,
    clock,
    route,
    signals: (type) => wire.filter((entry) => entry.signal === type),
    answerRelay: () => relayGates.splice(0).forEach((gate) => gate.resolve()),
    releaseClose: () => heldCloses.splice(0).forEach((resolve) => resolve()),
    dropped: () => dropped,
  };
}

const click = (phase, documentId = 'p1:0') => ({
  type: 'pointer',
  phase,
  x: 10,
  y: 20,
  button: phase === 'mouseMoved' ? 'none' : 'left',
  buttons: phase === 'mousePressed' ? 1 : 0,
  modifiers: 0,
  clickCount: 1,
  documentId,
});

/** Offer → answer → DTLS verified → a frame at the locked size → media-ready. */
async function connect(h, generation = 1) {
  h.viewer.start();
  h.viewer.handle(offer(generation));
  await settle();
  h.peers.at(-1).connect();
  await settle();
  h.viewer.framePresented({ width: 1280, height: 720 });
  await settle();
}

test('the offer is answered direct-first with this side’s fingerprints; early candidates of every type wait', async () => {
  const h = harness();
  h.viewer.start();
  assert.deepEqual(h.signals('ready')[0].receiveCodecs, ['video/VP8', 'video/H264']);
  h.viewer.handle(offer(1));
  // Candidates before the remote description is set wait for it: a host
  // (mDNS name), a server-reflexive and a relay one.
  for (const line of [
    'candidate:1 1 udp 2122260223 0a1b2c3d-4e5f-4061-8172-839405162738.local 54321 typ host generation 0',
    'candidate:2 1 udp 1686052607 198.51.100.4 40000 typ srflx raddr 0.0.0.0 rport 0 generation 0',
    'candidate:3 1 udp 1 203.0.113.9 3478 typ relay',
  ]) {
    h.viewer.handle(signal(1, { type: 'candidate', candidate: { candidate: line, sdpMid: '0' } }));
  }
  await settle();
  const peer = h.peers[0];
  assert.equal(peer.configuration.iceTransportPolicy, 'all', 'direct pairs first, the TURN server as the fallback');
  assert.deepEqual(peer.configuration.iceServers, turn);
  assert.equal(peer.remote.sdp, sdp(DESKTOP_FP));
  assert.equal(peer.added.length, 3, 'the queued candidates were added after the description');
  const [answer] = h.signals('answer');
  assert.deepEqual(answer.fingerprints, [PHONE_FP]);
  assert.equal(answer.connectionId, id(1));
  assert.deepEqual(
    h.signals('geometry-ack').map((entry) => entry.geometryGeneration),
    [1]
  );
  assert.equal(h.viewer.state, 'negotiating');
});

test('a STUN-only or server-less offer still builds a peer; an older host’s relay policy is applied as sent', async () => {
  for (const iceServers of [[{ urls: ['stun:stun.mixdog.test:3478'] }], []]) {
    const h = harness();
    h.viewer.start();
    h.viewer.handle(offer(1, { iceServers }));
    await settle();
    assert.deepEqual(h.peers[0].configuration, { iceServers, iceTransportPolicy: 'all' });
    assert.equal(h.signals('answer').length, 1);
  }
  const older = harness();
  older.viewer.start();
  older.viewer.handle(offer(1, { iceTransportPolicy: 'relay' }));
  await settle();
  assert.equal(older.peers[0].configuration.iceTransportPolicy, 'relay');
  // Malformed policies and candidates never reach a peer.
  assert.equal(readRemoteWebrtcDesktopSignal(offerBody(1, { iceTransportPolicy: undefined })), null);
  assert.equal(readRemoteWebrtcDesktopSignal(offerBody(1, { iceTransportPolicy: 'none' })), null);
  assert.equal(
    readRemoteWebrtcDesktopSignal({
      v: 1,
      source,
      connectionId: id(1),
      generation: 1,
      type: 'candidate',
      candidate: { candidate: 'candidate:1 1 udp 1 203.0.113.9 3478 typ relay\r\na=x', sdpMid: '0' },
    }),
    null
  );
});

test('ICE that finds no working pair falls back to the JPEG view; relay input works again', async () => {
  const h = harness();
  h.viewer.start();
  h.viewer.handle(offer(1));
  await settle();
  const peer = h.peers[0];
  peer.connectionState = 'failed';
  peer.iceConnectionState = 'failed';
  peer.onconnectionstatechange();
  await settle();
  assert.equal(h.signals('close').at(-1).reason, 'ice-failed');
  assert.equal(peer.closed, true);
  assert.equal(h.viewer.owner, 'relay');
  assert.notEqual(h.viewer.state, 'webrtc');
  // The desktop answers with its close: the JPEG view stays, no timer retry.
  h.viewer.handle(signal(1, { type: 'close', reason: 'ice-failed' }));
  assert.equal(h.viewer.state, 'cooldown');
  h.route(click('mousePressed'));
  await settle();
  assert.equal(h.wire.at(-1).relay, 'pointer');
});

test('a close from an older host without TURN keeps the JPEG view and relay input', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'close', reason: 'turn-unavailable', retryAfterMs: 60_000 }));
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.viewer.owner, 'relay');
  assert.equal(h.peers[0].closed, true);
  h.route(click('mousePressed'));
  await settle();
  assert.equal(h.wire.at(-1).relay, 'pointer');
});

test('stale generations are ignored; a newer offer supersedes the old peer', async () => {
  const h = harness();
  await connect(h, 2);
  const before = h.wire.length;
  h.viewer.handle(offer(1));
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 9, geometryGeneration: 1 }));
  h.viewer.handle(signal(1, { type: 'close', reason: 'superseded' }));
  h.viewer.handle(signal(2, { type: 'candidate', candidate: null }));
  await settle();
  assert.equal(h.peers.length, 1, 'no peer for the stale offer');
  assert.equal(h.viewer.owner, 'relay', 'the stale promote moved nothing');
  assert.equal(h.viewer.state, 'connected');
  assert.equal(h.wire.length, before);
  assert.deepEqual(h.peers[0].added, [null], 'end of candidates of the current connection');

  h.viewer.handle(offer(3));
  await settle();
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.peers.length, 2);
  assert.equal(h.viewer.state, 'negotiating');
});

test('a peer certificate other than the signaled one closes with fingerprint-mismatch; JPEG keeps input', async () => {
  const h = harness();
  h.viewer.start();
  h.viewer.handle(offer(1));
  await settle();
  h.peers[0].connect({ algorithm: 'sha-256', value: hex('EE') });
  await settle();
  const [close] = h.signals('close');
  assert.equal(close.reason, 'fingerprint-mismatch');
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.signals('media-ready').length, 0);
  h.route(click('mousePressed'));
  await settle();
  assert.deepEqual(h.wire.at(-1), { relay: 'pointer', phase: 'mousePressed', seq: 1 });
});

test('media-ready waits for a decoded frame at the locked size of the current document', async () => {
  const h = harness();
  h.viewer.start();
  h.viewer.handle(offer(1));
  await settle();
  h.peers[0].connect();
  await settle();
  h.viewer.framePresented({ width: 640, height: 360 });
  assert.equal(h.signals('media-ready').length, 0, 'not at the locked pixel size');
  h.viewer.framePresented({ width: 1280, height: 720 });
  h.viewer.framePresented({ width: 1280, height: 720 });
  await settle();
  assert.deepEqual(
    h
      .signals('media-ready')
      .map(({ documentId, geometryGeneration, pixelWidth, pixelHeight }) => [
        documentId,
        geometryGeneration,
        pixelWidth,
        pixelHeight,
      ]),
    [['p1:0', 1, 1280, 720]]
  );
  assert.equal(h.viewer.state, 'connected');
});

test('promotion barrier: promote-ack follows the answered relay input; channel input streams with rising seq', async () => {
  const h = harness();
  await connect(h);
  // A tap on the relay still waiting for its replies.
  h.route(click('mouseMoved'));
  h.route(click('mousePressed'));
  await settle();
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  assert.equal(h.viewer.owner, 'channel');
  assert.equal(h.viewer.showsVideo, true);
  // Input from now on rides the channel at once, not the relay.
  await h.route(click('mouseReleased'));
  await h.route({ type: 'text', text: 'a', documentId: 'p1:0' });
  await settle();
  assert.equal(h.signals('promote-ack').length, 0, 'the relay input is unanswered');
  h.answerRelay();
  await settle();
  const ack = h.signals('promote-ack')[0];
  assert.equal(ack.inputEpoch, 2);
  const order = h.wire.map((entry) => entry.relay ?? entry.signal);
  assert.ok(order.lastIndexOf('pointer') < order.indexOf('promote-ack'), 'after the last relay input');
  const channel = h.peers[0].channel.sent.filter((message) => message.kind === 'input');
  assert.deepEqual(
    channel.map(({ epoch, seq, geometryGeneration, control }) => [epoch, seq, geometryGeneration, control.type]),
    [
      [2, 1, 1, 'pointer'],
      [2, 2, 1, 'text'],
    ]
  );
  assert.equal(h.wire.filter((entry) => entry.relay).length, 2, 'nothing went to both paths');
  assert.equal(h.viewer.state, 'webrtc');
  // Navigation is not page input: it stays on the relay.
  h.route({ type: 'reload' });
  await settle();
  assert.equal(h.wire.at(-1).relay, 'reload');
});

test('demotion drops unsent input, acks before the next relay input, and replays nothing', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await settle();
  await h.route(click('mousePressed'));
  const channelBefore = h.peers[0].channel.sent.length;
  h.viewer.handle(signal(1, { type: 'demote', inputEpoch: 3, reason: 'channel-failed' }));
  assert.equal(h.dropped(), 1, 'coalesced and held input dropped');
  assert.equal(h.viewer.owner, 'relay');
  // Typing right after: waits for the ack, then rides the relay once.
  h.route({ type: 'text', text: 'b', documentId: 'p1:0' });
  await settle();
  const order = h.wire.map((entry) => entry.relay ?? entry.signal);
  const ackAt = order.indexOf('demote-ack');
  assert.ok(ackAt >= 0);
  assert.equal(h.signals('demote-ack')[0].inputEpoch, 3);
  assert.deepEqual(order.slice(ackAt + 1), ['text']);
  assert.equal(h.peers[0].channel.sent.length, channelBefore, 'nothing more on the channel');
  assert.equal(h.wire.filter((entry) => entry.relay === 'pointer').length, 0, 'the channel press is not replayed');
  // The video stays the picture until the JPEG view shows a frame again.
  assert.equal(h.viewer.showsVideo, true);
  h.viewer.relayPresented();
  assert.equal(h.viewer.showsVideo, false);
  assert.equal(h.peers[0].closed, true);
  // The desktop answers the ack with the connection's close; until then no ready.
  assert.equal(h.viewer.state, 'demoting');
  h.viewer.start();
  assert.equal(h.signals('ready').length, 1);
  // retryAfterMs 0: another attempt is welcome, with the next relay frame.
  h.viewer.handle(signal(1, { type: 'close', reason: 'channel-failed', retryAfterMs: 0 }));
  assert.equal(h.viewer.state, 'relay');
  assert.equal(h.signals('ready').length, 1, 'not at once');
  h.viewer.start();
  assert.equal(h.signals('ready').length, 2);
});

test('a close without retryAfterMs after a demotion: no new attempt until a new stream', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await settle();
  h.viewer.handle(signal(1, { type: 'demote', inputEpoch: 3, reason: 'superseded' }));
  await settle();
  h.viewer.handle(signal(1, { type: 'close', reason: 'superseded' }));
  assert.equal(h.viewer.state, 'cooldown');
  h.viewer.start();
  assert.equal(h.signals('ready').length, 1);
  h.viewer.stop();
  h.viewer.start();
  assert.equal(h.signals('ready').length, 2, 'a new stream offers again');
});

test('screen-cursor reaches the screenCursor callback only at the current geometry generation', async () => {
  const cursors = [];
  const statuses = [];
  const h = harness({
    extra: { screenCursor: (cursor) => cursors.push(cursor), screenStatus: (s) => statuses.push(s) },
  });
  const push = (message) => h.peers[0].channel.onmessage({ data: JSON.stringify({ v: 1, ...message }) });
  await connect(h);
  const at = (generation, x = 10, y = 20) => push({ kind: 'screen-cursor', x, y, generation });
  at(1);
  assert.deepEqual(cursors, [{ x: 10, y: 20 }]);
  // Older, newer-than-adopted and malformed messages are dropped.
  at(0);
  at(2, 1, 1);
  push({ kind: 'screen-cursor', x: -1, y: 5, generation: 1 });
  push({ kind: 'screen-cursor', x: 1.5, y: 5, generation: 1 });
  assert.equal(cursors.length, 1);
  // Once the geometry moves on, the new generation is the one that counts.
  h.viewer.handle(parseRemoteWebrtcDesktopSignal({ v: 1, source, type: 'geometry', geometry: geometry(2) }));
  await settle();
  at(1);
  at(2, 7, 8);
  assert.deepEqual(cursors, [
    { x: 10, y: 20 },
    { x: 7, y: 8 },
  ]);
  // A cursor never reads as a status or an ack.
  assert.deepEqual(statuses, []);
});

const screenSource = { kind: 'screen', screenId: 'screen-1' };
async function connectScreen(h, generation = 1) {
  h.viewer.start();
  h.viewer.handle(offer(generation, { source: screenSource }));
  await settle();
  h.peers.at(-1).connect();
  await settle();
}

test('helper messages go over the verified channel of a screen source only, and never queue', async () => {
  const { publicKey } = await generateSecureDesktopControllerKey();
  const b64 = (bytes, byte) => Buffer.alloc(bytes, byte).toString('base64');
  const install = { v: 1, kind: 'screen-helper-install', publicKey };
  const grant = { v: 1, kind: 'screen-helper-grant', epoch: 3, challenge: b64(16, 2), signature: b64(64, 3) };
  const h = harness({ extra: { source: screenSource } });
  assert.equal(h.viewer.sendHelperMessage(install), false, 'no connection yet');
  assert.equal(h.viewer.videoEpoch, null);
  await connectScreen(h);
  const channel = h.peers[0].channel;
  const helper = () => channel.sent.filter((message) => message.kind.startsWith('screen-helper'));

  assert.equal(h.viewer.sendHelperMessage(install), true);
  assert.equal(h.viewer.sendHelperMessage(grant), true);
  assert.deepEqual(helper(), [install, grant]);

  // The run epoch is the newest announced; an older announcement does not move it.
  channel.onmessage({ data: JSON.stringify({ v: 1, kind: 'screen-video', epoch: 3, path: 'helper' }) });
  assert.equal(h.viewer.videoEpoch, 3);
  channel.onmessage({ data: JSON.stringify({ v: 1, kind: 'screen-video', epoch: 2, path: 'capture' }) });
  assert.equal(h.viewer.videoEpoch, 3);

  h.viewer.stop();
  assert.equal(h.viewer.videoEpoch, null, 'a new session announces its own runs');
  assert.equal(h.viewer.sendHelperMessage(grant), false, 'a stopped viewer has no channel to send on');
  assert.equal(helper().length, 2);

  // A connection whose certificate does not match the desktop's carries nothing.
  const forged = harness({ extra: { source: screenSource } });
  forged.viewer.start();
  forged.viewer.handle(offer(1, { source: screenSource }));
  await settle();
  forged.peers[0].connect({ algorithm: DESKTOP_FP.algorithm, value: PHONE_FP.value });
  await settle();
  assert.equal(forged.viewer.sendHelperMessage(grant), false);
  assert.equal(forged.peers[0].channel.sent.filter((message) => message.kind.startsWith('screen-helper')).length, 0);

  // A browser source has no helper.
  const browser = harness();
  await connect(browser);
  assert.equal(browser.viewer.sendHelperMessage(install), false);
});

test('a malformed helper message is refused before it reaches the channel', async () => {
  const h = harness({ extra: { source: screenSource } });
  await connectScreen(h);
  const channel = h.peers[0].channel;
  const before = channel.sent.length;
  assert.equal(h.viewer.sendHelperMessage({ v: 1, kind: 'screen-helper-install', publicKey: 'short' }), false);
  assert.equal(
    h.viewer.sendHelperMessage({ v: 1, kind: 'screen-helper-grant', epoch: 1, challenge: 'x', signature: 'y' }),
    false
  );
  assert.equal(channel.sent.length, before);
  assert.equal(channel.readyState, 'open', 'the connection is not failed by it');
  assert.equal(
    h.viewer.sendHelperMessage({
      v: 1,
      kind: 'screen-helper-install',
      publicKey: (await generateSecureDesktopControllerKey()).publicKey,
    }),
    true
  );
});

test('a helper challenge reaches the callback for a screen source, current session only', async () => {
  const b64 = (byte) => Buffer.alloc(16, byte).toString('base64');
  const message = (epoch) => ({
    data: JSON.stringify({ v: 1, kind: 'screen-helper-challenge', epoch, nonce: b64(1), challenge: b64(2) }),
  });
  const seen = [];
  const h = harness({ extra: { source: screenSource, screenHelperChallenge: (challenge) => seen.push(challenge) } });
  await connectScreen(h);
  const channel = h.peers[0].channel;
  channel.onmessage(message(4));
  channel.onmessage({
    data: JSON.stringify({ v: 1, kind: 'screen-helper-challenge', epoch: 4, nonce: 'bad', challenge: b64(2) }),
  });
  assert.deepEqual(seen, [{ epoch: 4, nonce: b64(1), challenge: b64(2) }], 'the malformed one is dropped');

  const lingering = channel.onmessage;
  h.viewer.stop();
  lingering?.(message(5));
  assert.equal(seen.length, 1, 'a session that has ended is not answered');

  const browserSeen = [];
  const browser = harness({ extra: { screenHelperChallenge: (challenge) => browserSeen.push(challenge) } });
  await connect(browser);
  browser.peers[0].channel.onmessage(message(1));
  assert.deepEqual(browserSeen, []);
});

test('screen-frame-seen: once per run, for a frame received after the announcement', async () => {
  const h = harness({ extra: { source: screenSource } });
  await connectScreen(h);
  const channel = h.peers[0].channel;
  const push = (message) => channel.onmessage({ data: JSON.stringify({ v: 1, ...message }) });
  const seen = () => channel.sent.filter((message) => message.kind === 'screen-frame-seen');
  const frame = (receiveTime) => h.viewer.framePresented({ width: 1280, height: 720, receiveTime });

  frame(5_000);
  assert.equal(seen().length, 0, 'no run announced yet');
  h.clock.now = 2_000;
  push({ kind: 'screen-video', epoch: 1, path: 'helper' });
  frame(1_999);
  frame(2_000);
  assert.equal(seen().length, 0, 'a frame received before (or at) the announcement is no evidence');
  h.viewer.framePresented({ width: 1280, height: 720 });
  assert.equal(seen().length, 0, 'no receiveTime: nothing is claimed');
  frame(2_001);
  assert.deepEqual(seen(), [{ v: 1, kind: 'screen-frame-seen', epoch: 1 }]);
  frame(2_500);
  push({ kind: 'screen-video', epoch: 1, path: 'helper' });
  frame(2_900);
  assert.equal(seen().length, 1, 'exactly once per epoch, a repeat does not re-arm');

  // A new run re-arms it; an older epoch does not.
  h.clock.now = 3_000;
  push({ kind: 'screen-video', epoch: 2, path: 'capture' });
  frame(3_100);
  assert.deepEqual(seen().at(-1), { v: 1, kind: 'screen-frame-seen', epoch: 2 });
  assert.equal(seen().length, 2);
  h.clock.now = 4_000;
  push({ kind: 'screen-video', epoch: 1, path: 'helper' });
  frame(4_100);
  assert.equal(seen().length, 2, 'a stale epoch is ignored');
  push({ kind: 'screen-video', epoch: 0, path: 'helper' });
  push({ kind: 'screen-video', epoch: 3, path: 'other' });
  frame(4_200);
  assert.equal(seen().length, 2, 'malformed runs are ignored');
});

test('screen-frame-seen: a new session starts from nothing', async () => {
  const h = harness({ extra: { source: screenSource } });
  await connectScreen(h);
  const first = h.peers[0].channel;
  h.clock.now = 2_000;
  first.onmessage({ data: JSON.stringify({ v: 1, kind: 'screen-video', epoch: 5, path: 'helper' }) });
  h.viewer.stop();
  h.viewer.framePresented({ width: 1280, height: 720, receiveTime: 2_100 });
  assert.equal(first.sent.filter((message) => message.kind === 'screen-frame-seen').length, 0);
  await connectScreen(h, 2);
  const second = h.peers.at(-1).channel;
  h.clock.now = 3_000;
  // A restarted desktop viewer counts its epochs from the start again.
  second.onmessage({ data: JSON.stringify({ v: 1, kind: 'screen-video', epoch: 1, path: 'capture' }) });
  h.viewer.framePresented({ width: 1280, height: 720, receiveTime: 3_100 });
  assert.deepEqual(
    second.sent.filter((message) => message.kind === 'screen-frame-seen'),
    [{ v: 1, kind: 'screen-frame-seen', epoch: 1 }]
  );
});

test('screen-frame-seen is never sent for a browser source', async () => {
  const h = harness();
  await connect(h);
  const channel = h.peers[0].channel;
  h.clock.now = 2_000;
  channel.onmessage({ data: JSON.stringify({ v: 1, kind: 'screen-video', epoch: 1, path: 'helper' }) });
  h.viewer.framePresented({ width: 1280, height: 720, receiveTime: 2_100 });
  assert.equal(channel.sent.filter((message) => message.kind === 'screen-frame-seen').length, 0);
});

test('a replacement desktop session at the same geometry generation inherits no cursor', async () => {
  let h;
  const tracker = createScreenCursorTracker(() => h.viewer.geometry?.generation ?? null);
  const store = createScreenCursorStore(tracker.read, tracker.stamp);
  h = harness({ extra: { screenCursor: tracker.set, sessionEnded: tracker.clear } });
  const report = (x, y) =>
    h.peers.at(-1).channel.onmessage({ data: JSON.stringify({ v: 1, kind: 'screen-cursor', x, y, generation: 1 }) });

  // Hide → show: the same viewer stops and starts again; the desktop's new
  // viewer is offered the same generation.
  await connect(h);
  report(10, 20);
  store.set({ x: 800, y: 400 });
  assert.deepEqual(tracker.read(), { x: 10, y: 20 });
  assert.deepEqual(store.get(), { x: 800, y: 400 });
  h.viewer.stop();
  assert.equal(tracker.read(), null, 'stop');
  assert.equal(store.get(), null);
  await connect(h, 2);
  assert.equal(h.viewer.geometry.generation, 1, 'the replacement session reuses the geometry generation');
  assert.equal(tracker.read(), null, 'show again: nothing carried over');
  assert.equal(store.get(), null);
  report(30, 40);
  assert.deepEqual(tracker.read(), { x: 30, y: 40 }, 'a fresh report is taken');

  // A lost connection (retry): the same.
  store.set({ x: 800, y: 400 });
  h.peers.at(-1).channel.onclose();
  assert.equal(tracker.read(), null, 'connection lost');
  assert.equal(store.get(), null);
});

test('a screen-keys combo goes out as one screen-input message', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  h.answerRelay();
  await settle();
  const keys = [
    { vk: 0xa4, scan: 0x38, extended: false },
    { vk: 0x09, scan: 0x0f, extended: false },
  ];
  assert.equal(h.viewer.sendInput({ type: 'screen-keys', keys }), true);
  const sent = h.peers[0].channel.sent.filter((message) => message.kind === 'screen-input');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].control, { type: 'screen-keys', keys });
  assert.deepEqual(parseRemoteWebrtcChannelFromClient(JSON.stringify(sent[0])).control, { type: 'screen-keys', keys });
});

test('a screen key, combo or text queued fine but rejected by the host reaches screenInputRejected', async () => {
  let rejected = 0;
  const h = harness({ extra: { screenInputRejected: () => (rejected += 1) } });
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  h.answerRelay();
  await settle();
  const combo = {
    type: 'screen-keys',
    keys: [
      { vk: 0xa4, scan: 0x38, extended: false },
      { vk: 0x09, scan: 0x0f },
    ],
  };
  assert.equal(h.viewer.sendInput(combo), true, 'the channel took it');
  assert.equal(h.viewer.sendInput({ type: 'screen-text', text: 'a' }), true);
  assert.equal(h.viewer.sendInput({ type: 'screen-wheel', x: 1, y: 1, deltaX: 0, deltaY: 120 }), true);
  const seqs = h.peers[0].channel.sent.filter((message) => message.kind === 'screen-input').map((m) => m.seq);
  const ack = (seq, outcome) =>
    h.peers[0].channel.onmessage({
      data: JSON.stringify({
        v: 1,
        kind: 'input-ack',
        epoch: 2,
        seq,
        outcome,
        sentAt: 1_000,
        queuedMs: 0,
        dispatchMs: 0,
      }),
    });
  assert.equal(rejected, 0, 'nothing is said while it is only queued');
  ack(seqs[0], 'rejected');
  assert.equal(rejected, 1);
  ack(seqs[1], 'applied');
  assert.equal(rejected, 1);
  ack(seqs[2], 'rejected');
  assert.equal(rejected, 1, 'a refused wheel is dropped quietly');
  assert.equal(h.failures.length, 0, 'the browser typing message is not used');
});

test('a rejected channel ack is final for that input only; later input still streams', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  h.answerRelay();
  await settle();
  await h.route({ type: 'text', text: 'a', documentId: 'p1:0' });
  await h.route(click('mousePressed'));
  const channel = h.peers[0].channel;
  const ack = (seq, outcome) =>
    channel.onmessage({
      data: JSON.stringify({
        v: 1,
        kind: 'input-ack',
        epoch: 2,
        seq,
        outcome,
        sentAt: 1_000,
        queuedMs: 0,
        dispatchMs: 0,
      }),
    });
  ack(1, 'rejected');
  ack(2, 'applied');
  await h.route(click('mouseReleased'));
  assert.equal(h.viewer.owner, 'channel');
  assert.deepEqual(
    channel.sent.filter((message) => message.kind === 'input').map((message) => message.seq),
    [1, 2, 3]
  );
  assert.equal(h.failures.length, 1, 'the refused text is said once');
});

test('an undelivered promote-ack hands back instead of entering webrtc; a reconnect then offers again', async () => {
  const h = harness({ refuse: 'promote-ack' });
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await h.route(click('mousePressed'));
  await settle();
  assert.notEqual(h.viewer.state, 'webrtc');
  assert.equal(h.signals('close').at(-1).reason, 'protocol-error');
  assert.equal(h.viewer.owner, 'relay', 'the close was answered: the relay owns input');
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.peers[0].closed, true);
  const relayBefore = h.wire.filter((entry) => entry.relay).length;
  assert.equal(relayBefore, 0, 'the channel press is not replayed on the relay');
  h.viewer.reconnected();
  h.viewer.start();
  assert.equal(h.signals('ready').length, 2, 'a fresh relay offers again');
});

test('a reconnect while the promote-ack is in flight ends the attempt without replaying input', async () => {
  const h = harness();
  await connect(h);
  // Relay input still unanswered holds the ack back.
  h.route(click('mouseMoved'));
  await settle();
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await h.route(click('mousePressed'));
  assert.equal(h.viewer.state, 'promoting');
  const channelSent = h.peers[0].channel.sent.length;
  h.viewer.reconnected();
  assert.equal(h.viewer.state, 'relay');
  assert.equal(h.viewer.owner, 'relay');
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.dropped(), 1);
  h.answerRelay();
  await settle();
  assert.equal(h.signals('promote-ack').length, 0, 'the ended attempt is not acknowledged');
  assert.equal(h.wire.filter((entry) => entry.relay === 'pointer').length, 1, 'only the earlier relay move');
  assert.equal(h.peers[0].channel.sent.length, channelSent);
  h.viewer.start();
  assert.equal(h.signals('ready').length, 2);
});

test('a channel failure while promoted holds input until the desktop demotes; no input is duplicated', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await settle();
  h.peers[0].channel.readyState = 'closed';
  h.peers[0].channel.onclose();
  await settle();
  assert.equal(h.signals('close').at(-1).reason, 'channel-failed');
  // The close call is answered (here at once) without a demotion: the desktop
  // no longer streams this viewer, so the relay owns input again.
  assert.equal(h.viewer.owner, 'relay');

  // The close call stays unanswered while the desktop demotes: input that
  // failed on the channel, and input meanwhile, is refused, not moved.
  const g = harness({ holdClose: true });
  await connect(g);
  g.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await settle();
  g.peers[0].channel.send = () => {
    throw new Error('closing');
  };
  const original = g.wire.length;
  await g.route(click('mousePressed'));
  await settle();
  assert.equal(g.signals('close').at(-1).reason, 'channel-failed');
  assert.equal(g.viewer.owner, 'held');
  await g.route({ type: 'text', text: 'pw', documentId: 'p1:0' });
  assert.equal(g.failures.filter((message) => /switching/.test(message)).length, 2, 'each refusal is said');
  assert.equal(g.wire.slice(original).filter((entry) => entry.relay).length, 0, 'not moved to the relay');
  g.viewer.handle(signal(1, { type: 'demote', inputEpoch: 3, reason: 'channel-failed' }));
  g.releaseClose();
  await settle();
  assert.equal(g.viewer.owner, 'relay');
  g.route(click('mousePressed'));
  await settle();
  assert.deepEqual(
    g.wire
      .slice(original)
      .flatMap((entry) => (entry.relay ? [entry.relay] : entry.signal === 'demote-ack' ? ['ack'] : [])),
    ['ack', 'pointer'],
    'only input made after the demotion, after its ack'
  );
});

test('a desktop close names when to offer again; the retry sends one ready', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'close', reason: 'media-timeout', retryAfterMs: 30_000 }));
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.timers.at(-1).ms, 30_000);
  assert.equal(h.signals('ready').length, 1);
  h.timers.at(-1).callback();
  assert.equal(h.viewer.state, 'relay');
  assert.equal(h.signals('ready').length, 1, 'ready goes with the next relay frame');
  h.viewer.start();
  assert.equal(h.signals('ready').length, 2);
});

test('ready carries the page’s native size as the video limit; receiver stats carry frame size and timings', async () => {
  // CSS size × the page's device scale factor, bounded by the contract's 4096.
  assert.deepEqual(remoteVideoLimit({ cssWidth: 1707, cssHeight: 960, deviceScaleFactor: 1.5 }), {
    maxWidth: 2560,
    maxHeight: 1440,
  });
  assert.deepEqual(remoteVideoLimit({ cssWidth: 2560, cssHeight: 1440, deviceScaleFactor: 2 }), {
    maxWidth: 4096,
    maxHeight: 2880,
  });
  assert.equal(remoteVideoLimit({ cssWidth: 0, cssHeight: 0, deviceScaleFactor: 2 }), null);

  const stats = readRemoteWebrtcReceiverStats(
    new Map([
      [
        'in',
        { type: 'inbound-rtp', kind: 'video', framesReceived: 3, framesDecoded: 3, frameWidth: 1280, frameHeight: 720 },
      ],
    ]),
    { connectionId: id(1), generation: 1 },
    5,
    { inputRoundTripMs: 40, inputToVisibleMs: 90 }
  );
  assert.equal(stats.frameWidth, 1280);
  assert.equal(stats.frameHeight, 720);
  assert.equal(stats.inputToVisibleMs, 90);
  assert.equal(stats.inputRoundTripMs, 40);
  // The contract's own parser takes it.
  assert.deepEqual(parseRemoteWebrtcChannelFromClient(JSON.stringify({ v: 1, kind: 'stats', stats })).stats, stats);

  // Before any geometry the stream's frame bound stands: no limit.
  const h = harness();
  h.viewer.start();
  assert.equal(h.signals('ready')[0].videoLimit, undefined);
  // An offer below the page's native size: ready again with it, unanswered.
  const scaled = {
    generation: 1,
    cssWidth: 1280,
    cssHeight: 720,
    deviceScaleFactor: 2,
    pixelWidth: 1280,
    pixelHeight: 720,
  };
  h.viewer.handle(offer(1, { geometry: scaled }));
  await settle();
  assert.equal(h.peers.length, 0, 'the downscaled offer is not answered');
  const { signal: _type, ...ready } = h.signals('ready')[1];
  assert.deepEqual(parseRemoteWebrtcClientSignal(ready).videoLimit, { maxWidth: 2560, maxHeight: 1440 });
  // Its close is stale; the wider offer is answered.
  h.viewer.handle(signal(1, { type: 'close', reason: 'superseded' }));
  h.viewer.handle(offer(2, { geometry: { ...scaled, generation: 2, pixelWidth: 2560, pixelHeight: 1440 } }));
  await settle();
  assert.equal(h.peers.length, 1);
  assert.equal(h.viewer.state, 'negotiating');
  // A host that cannot widen offers the same again: asked once, then answered.
  const o = harness();
  o.viewer.start();
  o.viewer.handle(offer(1, { geometry: scaled }));
  o.viewer.handle(offer(2, { geometry: { ...scaled, generation: 2 } }));
  await settle();
  assert.equal(o.signals('ready').length, 2);
  assert.equal(o.peers.length, 1);
});

test('leaving the view ends it locally (the stream’s end ends the desktop viewer) and returns input to the relay', async () => {
  const h = harness();
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await settle();
  const before = h.wire.length;
  h.viewer.stop();
  assert.equal(h.wire.length, before, 'no close: the desktop would only demote a viewer it is ending');
  assert.equal(h.viewer.owner, 'relay');
  assert.equal(h.viewer.showsVideo, false);
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.streams.at(-1), null);
  // The desktop's own viewer-left close and a late demote are of a forgotten connection.
  h.viewer.handle(signal(1, { type: 'close', reason: 'viewer-left' }));
  h.viewer.handle(signal(1, { type: 'demote', inputEpoch: 3, reason: 'viewer-left' }));
  await settle();
  assert.equal(h.wire.length, before);
  // Back on screen: a new desktop viewer counts generations from 1 again.
  h.viewer.start();
  assert.equal(h.signals('ready').length, 2);
  h.viewer.handle(parseRemoteWebrtcDesktopSignal({ ...offerBody(1), connectionId: 'fresh00000000000000001' }));
  await settle();
  assert.equal(h.peers.length, 2, 'a new viewer’s first offer is not stale');
  assert.equal(h.viewer.state, 'negotiating');
});

test('every adopted geometry is acknowledged, the offer’s too, even at a generation already acked', async () => {
  const h = harness();
  h.viewer.start();
  h.viewer.handle(parseRemoteWebrtcDesktopSignal({ v: 1, source, type: 'geometry', geometry: geometry(1) }));
  // A new desktop viewer sends the locked geometry first, then offers it.
  h.viewer.handle(parseRemoteWebrtcDesktopSignal({ v: 1, source, type: 'geometry', geometry: geometry(1) }));
  h.viewer.handle(offer(1));
  // An older generation is not adopted.
  h.viewer.handle(parseRemoteWebrtcDesktopSignal({ v: 1, source, type: 'geometry', geometry: geometry(2) }));
  h.viewer.handle(parseRemoteWebrtcDesktopSignal({ v: 1, source, type: 'geometry', geometry: geometry(1) }));
  await settle();
  assert.deepEqual(
    h.signals('geometry-ack').map((entry) => entry.geometryGeneration),
    [1, 1, 1, 2]
  );
  assert.equal(h.viewer.geometry.generation, 2);
});

test('an older host’s turn-unavailable before any offer: JPEG stays, nothing retries until the view or relay comes back', async () => {
  const h = harness();
  h.viewer.start();
  h.viewer.handle(signal(1, { type: 'close', reason: 'turn-unavailable' }));
  assert.equal(h.viewer.state, 'cooldown');
  assert.equal(h.peers.length, 0);
  assert.equal(h.timers.length, 0, 'no timer retry');
  h.viewer.start();
  assert.equal(h.signals('ready').length, 1);
  h.viewer.reconnected();
  assert.equal(h.signals('ready').length, 1, 'ready waits for the next relay frame');
  h.viewer.start();
  assert.equal(h.signals('ready').length, 2);
});

test('media-ready is repeated once per stats interval while the desktop has not promoted', async () => {
  const h = harness();
  await connect(h);
  assert.equal(h.signals('media-ready').length, 1);
  h.clock.now += 1_999;
  h.viewer.framePresented({ width: 1280, height: 720 });
  assert.equal(h.signals('media-ready').length, 1);
  h.clock.now += 1;
  h.viewer.framePresented({ width: 1280, height: 720 });
  assert.equal(h.signals('media-ready').length, 2);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  h.clock.now += 5_000;
  h.viewer.framePresented({ width: 1280, height: 720 });
  assert.equal(h.signals('media-ready').length, 2, 'never once promoted');
});

test('regression: a disposed viewer never offers again, though its changed listener restarts it on the relay state', async () => {
  // The screen view's listener: back at the relay state, offer again.
  let h = null;
  h = harness({
    extra: {
      changed() {
        if (h && h.viewer.state === 'relay') h.viewer.start();
      },
    },
  });
  await connect(h);
  h.viewer.handle(signal(1, { type: 'promote', inputEpoch: 2, geometryGeneration: 1 }));
  await settle();
  const readies = h.signals('ready').length;
  // The view is left (or replaced after a lost connection) while promoted.
  h.viewer.dispose();
  await settle();
  assert.equal(h.signals('ready').length, readies, 'no ready from a disposed viewer');
  assert.equal(h.viewer.state, 'closed');
  h.viewer.start();
  assert.equal(h.signals('ready').length, readies);
});

test('regression: only a started viewer takes an offer; unstarted, stopped or disposed it opens no peer', async () => {
  const h = harness();
  h.viewer.handle(offer(1));
  await settle();
  assert.equal(h.peers.length, 0, 'never started: no peer');
  h.viewer.start();
  h.viewer.stop();
  h.viewer.handle(offer(2));
  await settle();
  assert.equal(h.peers.length, 0, 'stopped: no peer');
  assert.equal(h.signals('answer').length, 0, 'and no answer');
  h.viewer.start();
  h.viewer.handle(offer(3));
  await settle();
  assert.equal(h.peers.length, 1, 'started: the offer is taken');
  assert.equal(h.signals('answer').length, 1);
  h.viewer.dispose();
  h.viewer.handle(offer(4));
  await settle();
  assert.equal(h.peers.length, 1, 'disposed: no peer');
});

test('regression: the viewer’s signal call is refused, never thrown, while no host is connected', async () => {
  const { remoteWebrtcSignal } = await import('./remote-webrtc-bridge.ts');
  const sent = [];
  const api = {
    remoteBrowserWebrtc: 1,
    remoteBrowserWebrtcSignal: async (body) => sent.push(body),
    onRemoteBrowserWebrtc: () => () => {},
    remoteBrowserControlOrdered: async () => {},
  };
  const call = remoteWebrtcSignal(api);
  await call({ type: 'ready' });
  assert.equal(sent.length, 1, 'through the shim while a host is connected');
  // The relay leg dropped: the shim's host members are gone.
  api.remoteBrowserWebrtc = 0;
  api.remoteBrowserWebrtcSignal = undefined;
  let pending = null;
  assert.doesNotThrow(() => {
    pending = call({ type: 'ready' });
  });
  await assert.rejects(pending, /No connected host/);
  assert.equal(sent.length, 1);
});
