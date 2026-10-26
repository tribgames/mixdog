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
