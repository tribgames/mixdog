import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_WEBRTC_VERSION } from '../../shared/remote-webrtc.ts';
import { createRemoteWebrtcHost } from './host.ts';

const HEX = Array.from({ length: 32 }, () => 'AB').join(':');
const SDP = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${HEX}\r\n`;
const TURN = [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'p' }];
const source = { kind: 'browser', sessionId: 's1' };
const geometry = { generation: 1, cssWidth: 400, cssHeight: 300, deviceScaleFactor: 1, pixelWidth: 400, pixelHeight: 300 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a demotion the phone caused by closing reaches it before the answer to that close', async () => {
  const commands = [];
  const signals = [];
  let emit = () => {};
  const gates = new Map();
  const host = createRemoteWebrtcHost({
    sender: { send: (command) => commands.push(command), onEvent: (listener) => (emit = listener) },
    // The demote's delivery is held until the test releases it.
    sendSignal: (_clientId, signal) => {
      signals.push(signal);
      if (signal.type !== 'demote') return Promise.resolve();
      return new Promise((resolve) => gates.set('demote', resolve));
    },
    sources: () => ({
      source,
      start() {},
      stop() {},
      page: () => ({ documentId: 'p1:1', geometry }),
      dispatch: async () => {},
    }),
    report: () => {},
  });
  await host.signal('c1', { v: REMOTE_WEBRTC_VERSION, source, type: 'ready', receiveCodecs: ['video/VP8'] }, TURN);
  const open = commands.find((command) => command.type === 'open');
  emit({ type: 'offer', connectionId: open.connectionId, sdp: SDP });
  const offer = signals.find((signal) => signal.type === 'offer');
  const ref = { v: REMOTE_WEBRTC_VERSION, source, connectionId: offer.connectionId, generation: offer.generation };
  await host.signal('c1', { ...ref, type: 'answer', sdp: SDP, fingerprints: [{ algorithm: 'sha-256', value: HEX }] });
  emit({ type: 'connected', connectionId: open.connectionId, remoteCertificate: { fingerprint: HEX, fingerprintAlgorithm: 'sha-256' } });
  await host.signal('c1', { v: REMOTE_WEBRTC_VERSION, source, type: 'geometry-ack', geometryGeneration: 1 });
  host.frame('browser:s1', { documentId: 'p1:1', geometry, mimeType: 'image/jpeg', data: 'AA' });
  const frame = commands.find((command) => command.type === 'frame');
  emit({ type: 'frame-done', sourceKey: 'browser:s1', frameId: frame.frameId, ok: true });
  await host.signal('c1', { ...ref, type: 'media-ready', documentId: 'p1:1', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 });
  const promote = signals.find((signal) => signal.type === 'promote');
  await host.signal('c1', { ...ref, type: 'promote-ack', inputEpoch: promote.inputEpoch });

  let answered = false;
  const reply = host.signal('c1', { ...ref, type: 'close', reason: 'channel-failed' }).then(() => (answered = true));
  await flush();
  assert.equal(signals.at(-1).type, 'demote');
  assert.equal(answered, false, 'the close is not answered before its demote is handed over');
  gates.get('demote')();
  await reply;
  assert.equal(answered, true);
});

test('a captured source switches to a drawn track for raw pictures and back, and hears each delivery', async () => {
  const screen = { kind: 'screen', screenId: '1' };
  const commands = [];
  let emit = () => {};
  let plan = { sourceId: 'screen:1:0', width: 400, height: 300, maxFrameRate: 30 };
  const delivered = [];
  const host = createRemoteWebrtcHost({
    sender: { send: (command) => commands.push(command), onEvent: (listener) => (emit = listener) },
    sendSignal: () => Promise.resolve(),
    sources: () => ({
      source: screen,
      start() {},
      stop() {},
      page: () => ({ documentId: null, geometry }),
      dispatch: async () => {},
      capturePlan: () => plan,
      delivered: (epoch) => delivered.push(epoch),
    }),
    report: () => {},
  });
  const of = (type) => commands.filter((command) => command.type === type);
  // Helper path before the first connection: the drawn track at its open, no capture.
  await host.signal('c1', { v: REMOTE_WEBRTC_VERSION, source: screen, type: 'geometry-ack', geometryGeneration: 1 });
  host.drawnTrack('screen:1', true);
  assert.deepEqual(of('source-draw'), [], 'nothing to switch before a connection');
  await host.signal('c1', { v: REMOTE_WEBRTC_VERSION, source: screen, type: 'ready', receiveCodecs: ['video/VP8'] }, TURN);
  assert.deepEqual(
    commands.filter((command) => command.type === 'source-draw' || command.type === 'open').map((command) => command.type),
    ['source-draw', 'open']
  );
  assert.deepEqual(of('source-capture'), [], 'no capture replaces the drawn track');
  // A raw picture goes as the rows to crop and scale; its frame-done tells the source its run.
  const pixels = new Uint8Array(800 * 300 * 4);
  const rows = pixels.subarray(0, 800 * 4 * 300);
  const raw = (epoch) => ({
    documentId: null,
    geometry,
    epoch,
    mimeType: 'image/x-bgrx',
    pixels: rows,
    width: 800,
    height: 300,
    stride: 3200,
    source: { x: 400, y: 0, width: 400, height: 300 },
    target: { x: 0, y: 0, width: 400, height: 300 },
  });
  host.frame('screen:1', raw(2));
  const [frame] = of('frame');
  assert.equal(frame.mimeType, 'image/x-bgrx');
  assert.deepEqual([frame.width, frame.height, frame.stride, frame.pixelWidth], [800, 300, 3200, 400]);
  assert.deepEqual(frame.source, { x: 400, y: 0, width: 400, height: 300 });
  assert.equal(frame.pixels, rows, 'a tight array goes as it is');
  assert.equal('data' in frame, false);
  emit({ type: 'frame-done', sourceKey: 'screen:1', frameId: frame.frameId, ok: true });
  assert.deepEqual(delivered, [2]);
  emit({ type: 'frame-done', sourceKey: 'screen:1', frameId: frame.frameId, ok: true });
  assert.deepEqual(delivered, [2], 'only for the picture in flight');
  // A view of a larger buffer is sent as its own bytes (the one picture sent, only).
  host.frame('screen:1', { ...raw(2), pixels: pixels.subarray(3200, 3200 * 2) });
  assert.equal(of('frame').at(-1).pixels.byteLength, 3200);
  assert.equal(of('frame').at(-1).pixels.buffer.byteLength, 3200);
  // A display change while drawing doesn't reopen the capture yet.
  plan = { ...plan, width: 800, height: 600 };
  host.captureChanged('screen:1');
  assert.deepEqual(of('source-capture'), []);

  // The reviewer's probe: a frame in flight, the path to capture and back to
  // the drawn track; the old frame's ok acknowledgement then lands.
  const inFlight = of('frame').at(-1);
  host.frame('screen:1', raw(2));
  host.drawnTrack('screen:1', false);
  assert.deepEqual(of('source-capture'), [{ type: 'source-capture', sourceKey: 'screen:1', plan }]);
  host.drawnTrack('screen:1', true);
  assert.equal(of('source-draw').length, 2);
  emit({ type: 'frame-done', sourceKey: 'screen:1', frameId: inFlight.frameId, ok: true });
  assert.deepEqual(delivered, [2], 'an acknowledgement from before the transitions delivers nothing');
  assert.equal(of('frame').at(-1), inFlight, 'the waiting picture of the old path was dropped');
  host.drawnTrack('screen:1', true);
  assert.equal(of('source-draw').length, 2, 'idempotent');
});

test('a sender crash resets each source’s track; the next connection sets up the selected path first', async () => {
  const screen = { kind: 'screen', screenId: '1' };
  const commands = [];
  let emit = () => {};
  const plan = { sourceId: 'screen:1:0', width: 400, height: 300, maxFrameRate: 30 };
  const host = createRemoteWebrtcHost({
    sender: { send: (command) => commands.push(command), onEvent: (listener) => (emit = listener) },
    sendSignal: () => Promise.resolve(),
    sources: () => ({
      source: screen,
      start() {},
      stop() {},
      page: () => ({ documentId: null, geometry }),
      dispatch: async () => {},
      capturePlan: () => plan,
    }),
    report: () => {},
  });
  const ready = { v: REMOTE_WEBRTC_VERSION, source: screen, type: 'ready', receiveCodecs: ['video/VP8'] };
  const setup = () =>
    commands
      .filter((command) => ['source-capture', 'source-draw', 'open'].includes(command.type))
      .map((command) => command.type);
  const reopen = async () => {
    // The crash failed the connection; the phone's viewer leaves and comes back.
    host.viewerLeft('c1', 'screen:1');
    await host.signal('c1', ready, TURN);
  };
  await host.signal('c1', ready, TURN);
  assert.deepEqual(setup(), ['source-capture', 'open']);

  // The renderer dies, its tracks with it: the capture is opened again first.
  emit(null);
  await reopen();
  assert.deepEqual(setup(), ['source-capture', 'open', 'source-capture', 'open']);

  // On the drawn path when it dies: the drawn track again, not the capture.
  host.drawnTrack('screen:1', true);
  emit(null);
  commands.length = 0;
  await reopen();
  assert.deepEqual(setup(), ['source-draw', 'open']);
});

test('a ready that widens the video limit mid-negotiation offers only the reconciled, widened geometry', async () => {
  const commands = [];
  const signals = [];
  let emit = () => {};
  const widened = { generation: 2, cssWidth: 400, cssHeight: 300, deviceScaleFactor: 2.5, pixelWidth: 1000, pixelHeight: 750 };
  const page = { documentId: 'p1:1', geometry };
  const limits = [];
  const host = createRemoteWebrtcHost({
    sender: { send: (command) => commands.push(command), onEvent: (listener) => (emit = listener) },
    sendSignal: (_clientId, signal) => {
      signals.push(signal);
      return Promise.resolve();
    },
    sources: () => ({
      source,
      start() {},
      stop() {},
      page: () => page,
      dispatch: async () => {},
      // As the browser source: a wider limit drops the locked geometry until
      // the next frame locks the new one.
      videoLimit: (limit) => {
        limits.push(limit);
        page.geometry = null;
      },
    }),
    report: () => {},
  });
  const opens = () => commands.filter((command) => command.type === 'open');
  const offers = () => signals.filter((signal) => signal.type === 'offer');

  await host.signal('c1', { v: REMOTE_WEBRTC_VERSION, source, type: 'ready', receiveCodecs: ['video/VP8'] }, TURN);
  const first = opens()[0];
  emit({ type: 'offer', connectionId: first.connectionId, sdp: SDP });
  assert.deepEqual(offers()[0].geometry, geometry);

  // The video is smaller than the page's native size: the phone asks again.
  await host.signal(
    'c1',
    {
      v: REMOTE_WEBRTC_VERSION,
      source,
      type: 'ready',
      receiveCodecs: ['video/VP8'],
      videoLimit: { maxWidth: 1000, maxHeight: 750 },
    },
    TURN
  );
  assert.deepEqual(limits, [{ maxWidth: 1000, maxHeight: 750 }]);
  assert.ok(
    commands.some((command) => command.type === 'close' && command.connectionId === first.connectionId),
    'the first connection is superseded'
  );
  assert.equal(opens().length, 1, 'no new connection while the geometry is unlocked');
  // A late callback of the superseded connection offers nothing.
  emit({ type: 'offer', connectionId: first.connectionId, sdp: SDP });
  assert.equal(offers().length, 1);

  // The next frame locks the widened geometry: only now the attempt starts.
  page.geometry = widened;
  host.geometryChanged('browser:s1', widened);
  assert.equal(opens().length, 2);
  const second = opens()[1];
  assert.notEqual(second.connectionId, first.connectionId);
  emit({ type: 'offer', connectionId: second.connectionId, sdp: SDP });
  assert.equal(offers().length, 2);
  assert.deepEqual(offers()[1].geometry, widened);
  assert.equal(offers()[1].connectionId, second.connectionId);
  assert.ok(offers().every((offer) => offer.geometry), 'no offer without a geometry');
  const geometrySignals = signals.filter((signal) => signal.type === 'geometry');
  assert.deepEqual(geometrySignals.at(-1).geometry, widened, 'the phone hears the widened geometry before the offer');
});
