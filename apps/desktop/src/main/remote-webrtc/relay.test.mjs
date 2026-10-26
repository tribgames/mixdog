import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_WEBRTC_SIGNAL_EVENT, REMOTE_WEBRTC_VERSION } from '../../shared/remote-webrtc.ts';
import { createRemoteWebrtcRelay, remoteWebrtcSignalIsBarrier } from './relay.ts';
import { createRemoteWebrtcHost } from './host.ts';
import { createBrowserRemoteStreams } from '../remote-browser-streams.ts';

const HEX = Array.from({ length: 32 }, () => 'AB').join(':');
const SDP = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${HEX}\r\n`;
const source = { kind: 'browser', sessionId: 's1' };
const ref = { v: REMOTE_WEBRTC_VERSION, source, connectionId: 'c'.repeat(22), generation: 1 };
const geometry = { generation: 1, cssWidth: 400, cssHeight: 300, deviceScaleFactor: 1, pixelWidth: 400, pixelHeight: 300 };

function fixture({
  subscribed = true,
  screen = false,
  ice = [{ urls: 'turn:t.example:3478', username: 'u', credential: 'p' }],
  resolveIceServers = async () => ice,
} = {}) {
  const images = [];
  const forwarded = [];
  const sent = [];
  const left = [];
  const access = { subscribed, screen };
  const relay = createRemoteWebrtcRelay({
    subscribed: () => access.subscribed,
    awaitingFit: () => false,
    screenAuthorized: async () => access.screen,
    screenDisplays: async () => [{ screenId: '1', label: 'Display', primary: true, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1 }],
    setImages: (clientId, sessionId, enabled) => images.push([clientId, sessionId, enabled]),
    resolveIceServers,
    forward: async (clientId, signal, servers) => forwarded.push([clientId, signal.type, servers]),
    viewerLeft: async (clientId, sourceKey) => left.push([clientId, sourceKey]),
    send: async (clientId, payload) => sent.push([clientId, payload]),
  });
  return { relay, images, forwarded, sent, left, access };
}

/** ICE resolutions the test settles one by one. */
function deferredIce() {
  const pending = [];
  const resolveIceServers = () => new Promise((resolve) => pending.push(resolve));
  const settle = (index) => pending[index]([{ urls: 'turn:t.example:3478', username: 'u', credential: 'p' }]);
  return { pending, resolveIceServers, settle };
}

const offer = {
  ...ref,
  type: 'offer',
  sdp: SDP,
  fingerprints: [{ algorithm: 'sha-256', value: HEX }],
  iceServers: [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'p' }],
  iceTransportPolicy: 'relay',
  geometry,
  inputEpoch: 1,
};

test('a signal is refused unless the client streams the source it names', () => {
  const f = fixture({ subscribed: false });
  assert.throws(() => f.relay.accept('c1', { v: REMOTE_WEBRTC_VERSION, source, type: 'ready', receiveCodecs: [] }), /not streamed/);
  assert.throws(() => fixture().relay.accept('c1', { type: 'ready' }), /invalid/);
});

test('ready is forwarded with freshly resolved ICE servers; only the ownership acks are barriers', async () => {
  const f = fixture();
  const ready = f.relay.accept('c1', { v: REMOTE_WEBRTC_VERSION, source, type: 'ready', receiveCodecs: ['video/VP8'] });
  await f.relay.forward('c1', ready);
  assert.deepEqual(f.forwarded, [['c1', 'ready', [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'p' }]]]);
  assert.equal(remoteWebrtcSignalIsBarrier(ready), false);
  assert.equal(remoteWebrtcSignalIsBarrier({ type: 'promote-ack' }), true);
  assert.equal(remoteWebrtcSignalIsBarrier({ type: 'demote-ack' }), true);
});

test('a ready still resolving ICE when the viewer leaves is never forwarded', async () => {
  const readySignal = { v: REMOTE_WEBRTC_VERSION, source, type: 'ready', receiveCodecs: ['video/VP8'] };

  // The subscription ends and the departure completes while ICE resolves.
  const ice = deferredIce();
  const f = fixture({ resolveIceServers: ice.resolveIceServers });
  const pending = f.relay.forward('c1', f.relay.accept('c1', readySignal));
  f.access.subscribed = false;
  f.relay.viewerLeft('c1', 's1');
  ice.settle(0);
  await pending;
  assert.deepEqual(f.left, [['c1', 'browser:s1']]);
  assert.deepEqual(f.forwarded, [], 'the departed viewer is not recreated');

  // Left and streamed again meanwhile: the old attempt is still stale; the
  // new stream's own ready goes through.
  const again = deferredIce();
  const g = fixture({ resolveIceServers: again.resolveIceServers });
  const old = g.relay.forward('c1', g.relay.accept('c1', readySignal));
  g.relay.viewerLeft('c1', 's1');
  const fresh = g.relay.forward('c1', g.relay.accept('c1', readySignal));
  again.settle(1);
  await fresh;
  again.settle(0);
  await old;
  assert.deepEqual(
    g.forwarded.map(([, type]) => type),
    ['ready'],
    'only the current attempt is forwarded'
  );

  // A newer ready supersedes an older one whose ICE resolves later.
  const order = deferredIce();
  const h = fixture({ resolveIceServers: order.resolveIceServers });
  const first = h.relay.forward('c1', h.relay.accept('c1', readySignal));
  const second = h.relay.forward('c1', h.relay.accept('c1', { ...readySignal, videoLimit: { maxWidth: 1000, maxHeight: 750 } }));
  order.settle(1);
  await second;
  order.settle(0);
  await first;
  assert.equal(h.forwarded.length, 1);

  // Unsubscribed without a departure yet: refused, not forwarded.
  const lapse = deferredIce();
  const u = fixture({ resolveIceServers: lapse.resolveIceServers });
  const lapsed = u.relay.forward('c1', u.relay.accept('c1', readySignal));
  u.access.subscribed = false;
  lapse.settle(0);
  await assert.rejects(lapsed, /not streamed/);
  assert.deepEqual(u.forwarded, []);

  // A screen grant revoked while ICE resolves.
  const screenIce = deferredIce();
  const s = fixture({ screen: true, resolveIceServers: screenIce.resolveIceServers });
  const screenReady = { v: REMOTE_WEBRTC_VERSION, source: { kind: 'screen', screenId: '1' }, type: 'ready', receiveCodecs: ['video/VP8'] };
  const screenPending = s.relay.forward('c1', s.relay.accept('c1', screenReady));
  await new Promise((resolve) => setImmediate(resolve));
  s.access.screen = false;
  screenIce.settle(0);
  await assert.rejects(screenPending, /not allowed/);
  assert.deepEqual(s.forwarded, []);
});

test('screen readies whose authorization checks finish out of order: only the newer one is forwarded', async () => {
  const checks = [];
  const f = fixture();
  const relay = createRemoteWebrtcRelay({
    subscribed: () => true,
    awaitingFit: () => false,
    // The first check of each ready is held; later ones answer at once.
    screenAuthorized: () => (checks.length < 2 ? new Promise((resolve) => checks.push(resolve)) : Promise.resolve(true)),
    screenDisplays: async () => [],
    setImages: () => {},
    resolveIceServers: async () => [{ urls: 'turn:t.example:3478', username: 'u', credential: 'p' }],
    forward: async (clientId, signal) => f.forwarded.push([clientId, signal.type, signal.videoLimit ?? null]),
    viewerLeft: async () => {},
    send: async () => {},
  });
  const screenSource = { kind: 'screen', screenId: '1' };
  const older = relay.forward('c1', relay.accept('c1', { v: REMOTE_WEBRTC_VERSION, source: screenSource, type: 'ready', receiveCodecs: ['video/VP8'] }));
  const limit = { maxWidth: 1920, maxHeight: 1080 };
  const newer = relay.forward(
    'c1',
    relay.accept('c1', { v: REMOTE_WEBRTC_VERSION, source: screenSource, type: 'ready', receiveCodecs: ['video/VP8'], videoLimit: limit })
  );
  assert.equal(checks.length, 2);
  checks[1](true);
  await newer;
  checks[0](true);
  await older;
  assert.deepEqual(f.forwarded, [['c1', 'ready', limit]], 'only the newer ready');
});

test('a take-over joining an unfitted stream is promoted only on media-ready for the fitted generation, after its settled picture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const FIT = { width: 411, height: 782, deviceScaleFactor: 2.625 };
  const fitted = { generation: 2, cssWidth: 411, cssHeight: 782, deviceScaleFactor: 2.625, pixelWidth: 1078, pixelHeight: 2052 };
  const streamFrame = (seq, extra = {}) => ({
    sessionId: 's1',
    seq,
    frameId: `rbf_${seq}`,
    documentId: 'p1:1',
    url: 'https://a.test/',
    title: 't',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    width: 400,
    height: 300,
    viewportWidth: 400,
    viewportHeight: 300,
    image: { mimeType: 'image/jpeg', data: `img${seq}` },
    ...extra,
  });
  const streams = createBrowserRemoteStreams({ isLive: () => true, send: async () => {}, request: async () => {} });
  const page = { documentId: 'p1:1', geometry };
  const commands = [];
  const signals = [];
  let emit = () => {};
  const host = createRemoteWebrtcHost({
    sender: { send: (command) => commands.push(command), onEvent: (listener) => (emit = listener) },
    sendSignal: async (_clientId, signal) => {
      signals.push(signal);
    },
    sources: () => ({ source, start() {}, stop() {}, page: () => page, dispatch: async () => {} }),
    report: () => {},
  });
  const relay = createRemoteWebrtcRelay({
    subscribed: (clientId, sessionId) => streams.subscribed(clientId, sessionId),
    awaitingFit: (clientId, sessionId) => streams.awaitingFit(clientId, sessionId),
    screenAuthorized: async () => false,
    screenDisplays: async () => [],
    setImages: (clientId, sessionId, enabled) => streams.setImages(clientId, sessionId, enabled),
    resolveIceServers: async () => [{ urls: 'turn:t.example:3478', username: 'u', credential: 'p' }],
    forward: (clientId, signal, iceServers) => host.signal(clientId, signal, iceServers),
    viewerLeft: async () => {},
    send: async () => {},
  });
  const phone = (signal) => relay.forward('c2', relay.accept('c2', { v: REMOTE_WEBRTC_VERSION, source, ...signal }));
  /** A picture of the source's current geometry reaches the sender. */
  const picture = () => {
    host.frame('browser:s1', { documentId: 'p1:1', geometry: page.geometry, mimeType: 'image/jpeg', data: 'AA' });
    const sent = commands.filter((command) => command.type === 'frame').at(-1);
    emit({ type: 'frame-done', sourceKey: 'browser:s1', frameId: sent.frameId, ok: true });
  };
  const promoted = () => signals.some((signal) => signal.type === 'promote');

  // A watcher streams the agent's page unfitted; the take-over joins.
  streams.subscribe('c1', 's1', { maxWidth: 1080, maxHeight: 2100 });
  streams.publish(streamFrame(1));
  streams.subscribe('c2', 's1', { maxWidth: 1080, maxHeight: 2100, fit: FIT });

  // Its WebRTC view connects while the page is still unfitted (generation 1).
  await phone({ type: 'ready', receiveCodecs: ['video/VP8'] });
  const open = commands.find((command) => command.type === 'open');
  emit({ type: 'offer', connectionId: open.connectionId, sdp: SDP });
  const offer = signals.find((signal) => signal.type === 'offer');
  const ref = { connectionId: offer.connectionId, generation: offer.generation };
  await phone({ ...ref, type: 'answer', sdp: SDP, fingerprints: [{ algorithm: 'sha-256', value: HEX }] });
  emit({ type: 'connected', connectionId: open.connectionId, remoteCertificate: { fingerprint: HEX, fingerprintAlgorithm: 'sha-256' } });
  await phone({ type: 'geometry-ack', geometryGeneration: 1 });
  picture();
  await phone({ ...ref, type: 'media-ready', documentId: 'p1:1', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 });
  assert.equal(promoted(), false, 'the unfitted geometry never promotes a take-over');

  // The fit lands: the fitted generation is locked and pictured, but its
  // settled JPEG picture has not gone out to this phone yet.
  page.geometry = fitted;
  host.geometryChanged('browser:s1', fitted);
  await phone({ type: 'geometry-ack', geometryGeneration: 2 });
  picture();
  const fittedReady = { ...ref, type: 'media-ready', documentId: 'p1:1', geometryGeneration: 2, pixelWidth: 1078, pixelHeight: 2052 };
  await phone(fittedReady);
  assert.equal(promoted(), false, 'not before its first settled picture');

  // Its first settled picture goes out; an old-generation media-ready still
  // does not promote, the fitted one does.
  streams.acknowledge('c2', 's1', 1);
  streams.publish(streamFrame(2, { viewportWidth: 411, viewportHeight: 782, fitSettled: true }));
  assert.equal(streams.awaitingFit('c2', 's1'), false);
  await phone({ ...ref, type: 'media-ready', documentId: 'p1:1', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 });
  assert.equal(promoted(), false, 'a media-ready for the old generation is stale');
  await phone(fittedReady);
  const promote = signals.find((signal) => signal.type === 'promote');
  assert.ok(promote);
  assert.equal(promote.geometryGeneration, 2);
});

test('relay input is refused from the decoded promote-ack until the matching demote-ack', async () => {
  const f = fixture();
  await f.relay.send('c1', offer);
  assert.equal(f.sent[0][1].event, REMOTE_WEBRTC_SIGNAL_EVENT);
  await f.relay.send('c1', { ...ref, type: 'promote', inputEpoch: 2, geometryGeneration: 1 });
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), true, 'promotion alone moves nothing');
  // A stale ack (wrong epoch) moves nothing either.
  f.relay.accept('c1', { ...ref, type: 'promote-ack', inputEpoch: 1 });
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), true);
  f.relay.accept('c1', { ...ref, type: 'promote-ack', inputEpoch: 2 });
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), false);
  assert.equal(f.relay.relayInputAllowed('c2', 's1'), true, 'per client');
  assert.deepEqual(f.images, [['c1', 's1', false]], 'JPEG images stop for that client only');

  await f.relay.send('c1', { ...ref, type: 'demote', inputEpoch: 3, reason: 'ice-failed' });
  assert.deepEqual(f.images.at(-1), ['c1', 's1', true], 'JPEG comes back at once');
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), false, 'no page input until the phone acks');
  f.relay.accept('c1', { ...ref, type: 'demote-ack', inputEpoch: 2 });
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), false);
  f.relay.accept('c1', { ...ref, type: 'demote-ack', inputEpoch: 3 });
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), true);
});

test('a promote-ack after a demote is stale; close and departure hand input back to the relay', async () => {
  const f = fixture();
  await f.relay.send('c1', offer);
  await f.relay.send('c1', { ...ref, type: 'promote', inputEpoch: 2, geometryGeneration: 1 });
  await f.relay.send('c1', { ...ref, type: 'demote', inputEpoch: 3, reason: 'superseded' });
  f.relay.accept('c1', { ...ref, type: 'promote-ack', inputEpoch: 2 });
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), false, 'still waiting for the demote-ack');
  await f.relay.send('c1', { ...ref, type: 'close', reason: 'superseded' });
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), true);

  await f.relay.send('c1', offer);
  await f.relay.send('c1', { ...ref, type: 'promote', inputEpoch: 2, geometryGeneration: 1 });
  f.relay.accept('c1', { ...ref, type: 'promote-ack', inputEpoch: 2 });
  f.relay.viewerLeft('c1', 's1');
  assert.equal(f.relay.relayInputAllowed('c1', 's1'), true);
  assert.deepEqual(f.images.at(-1), ['c1', 's1', true]);
  assert.deepEqual(f.left, [['c1', 'browser:s1']]);
});

test('a screen source and its display list need the screen grant', async () => {
  const ready = { v: REMOTE_WEBRTC_VERSION, source: { kind: 'screen', screenId: '1' }, type: 'ready', receiveCodecs: [] };
  const denied = fixture({ screen: false });
  const signal = denied.relay.accept('c1', ready);
  await assert.rejects(denied.relay.forward('c1', signal), /not allowed/);
  await assert.rejects(denied.relay.screenDisplays('c1'), /not allowed/);
  assert.deepEqual(denied.forwarded, []);
  const granted = fixture({ screen: true });
  await granted.relay.forward('c1', granted.relay.accept('c1', ready));
  assert.equal(granted.forwarded.length, 1);
  assert.equal((await granted.relay.screenDisplays('c1'))[0].screenId, '1');
});

test('a desktop signal that breaks the contract never reaches the phone', async () => {
  const f = fixture();
  await assert.rejects(f.relay.send('c1', { ...offer, iceTransportPolicy: 'all' }));
  assert.deepEqual(f.sent, []);
});
