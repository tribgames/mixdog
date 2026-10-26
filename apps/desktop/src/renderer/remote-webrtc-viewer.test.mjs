import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRemoteWebrtcChannelFromClient,
  parseRemoteWebrtcClientSignal,
  parseRemoteWebrtcDesktopSignal,
  readRemoteWebrtcDesktopSignal,
} from '../shared/remote-webrtc.ts';
import { createRemoteBrowserInputQueue } from './remote-browser-input.ts';
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
  iceTransportPolicy: 'relay',
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
function harness({ documentId = 'p1:0', holdClose = false, refuse = null } = {}) {
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

test('the offer is answered relay-only through TURN with this side’s fingerprints; early candidates wait', async () => {
  const h = harness();
  h.viewer.start();
  assert.deepEqual(h.signals('ready')[0].receiveCodecs, ['video/VP8', 'video/H264']);
  h.viewer.handle(offer(1));
  // A candidate before the remote description is set waits for it.
  h.viewer.handle(
    signal(1, { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 203.0.113.9 3478 typ relay', sdpMid: '0' } })
  );
  await settle();
  const peer = h.peers[0];
  assert.equal(peer.configuration.iceTransportPolicy, 'relay', 'every path goes through the VPS TURN server');
  assert.deepEqual(peer.configuration.iceServers, turn);
  assert.equal(peer.remote.sdp, sdp(DESKTOP_FP));
  assert.equal(peer.added.length, 1, 'the queued candidate was added after the description');
  const [answer] = h.signals('answer');
  assert.deepEqual(answer.fingerprints, [PHONE_FP]);
  assert.equal(answer.connectionId, id(1));
  assert.deepEqual(h.signals('geometry-ack').map((entry) => entry.geometryGeneration), [1]);
  assert.equal(h.viewer.state, 'negotiating');
});

test('only a relay-only offer through TURN reaches a peer; without TURN the JPEG view stays', async () => {
  // The phone drops (never builds a peer for) an offer allowing direct paths
  // or naming no TURN server with credentials.
  assert.equal(readRemoteWebrtcDesktopSignal(offerBody(1, { iceTransportPolicy: 'all' })), null);
  assert.equal(readRemoteWebrtcDesktopSignal(offerBody(1, { iceTransportPolicy: undefined })), null);
  assert.equal(readRemoteWebrtcDesktopSignal(offerBody(1, { iceServers: [{ urls: ['stun:stun.mixdog.test:3478'] }] })), null);
  assert.equal(readRemoteWebrtcDesktopSignal(offerBody(1, { iceServers: [{ urls: ['turns:turn.mixdog.test:443'] }] })), null);

  // A host without TURN closes instead of offering: JPEG keeps input, and the
  // retry waits for the desktop's cooldown.
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
    h.signals('media-ready').map(({ documentId, geometryGeneration, pixelWidth, pixelHeight }) => [
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
      data: JSON.stringify({ v: 1, kind: 'input-ack', epoch: 2, seq, outcome, sentAt: 1_000, queuedMs: 0, dispatchMs: 0 }),
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
    g.wire.slice(original).flatMap((entry) => (entry.relay ? [entry.relay] : entry.signal === 'demote-ack' ? ['ack'] : [])),
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
      ['in', { type: 'inbound-rtp', kind: 'video', framesReceived: 3, framesDecoded: 3, frameWidth: 1280, frameHeight: 720 }],
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
  const scaled = { generation: 1, cssWidth: 1280, cssHeight: 720, deviceScaleFactor: 2, pixelWidth: 1280, pixelHeight: 720 };
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

test('turn-unavailable before any offer: JPEG stays, nothing retries until the view or relay comes back', async () => {
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
