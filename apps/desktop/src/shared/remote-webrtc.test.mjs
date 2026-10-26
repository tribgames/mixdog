import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOTE_WEBRTC_VERSION,
  assertRemoteWebrtcSdpFingerprints,
  canRemoteWebrtcTransition,
  parseRemoteWebrtcChannelFromClient,
  parseRemoteWebrtcClientSignal,
  readRemoteWebrtcChannelFromDesktop,
  readRemoteWebrtcDesktopSignal,
  readRemoteWebrtcScreenCursor,
  readRemoteWebrtcScreenStatus,
  readRemoteWebrtcScreenVideo,
  parseRemoteScreenInput,
  MAX_REMOTE_SCREEN_COMBO_KEYS,
  remoteWebrtcCertificateMatches,
  remoteWebrtcInputOwner,
  remoteWebrtcJpegActive,
} from './remote-webrtc.ts';

test('screen-keys: an ordered combo of distinct keys, bounded', () => {
  const ctrl = { vk: 0xa2, scan: 0x1d, extended: false };
  const c = { vk: 0x43, scan: 0x2e, extended: false };
  assert.deepEqual(parseRemoteScreenInput({ type: 'screen-keys', keys: [ctrl, c] }), { type: 'screen-keys', keys: [ctrl, c] });
  assert.deepEqual(parseRemoteScreenInput({ type: 'screen-keys', keys: [{ vk: 0x43, scan: 0x2e }] }).keys, [c]);
  for (const keys of [
    [],
    [ctrl, ctrl],
    Array.from({ length: MAX_REMOTE_SCREEN_COMBO_KEYS + 1 }, (_, index) => ({ vk: 0x41 + index, scan: 0 })),
    [{ vk: 0, scan: 0 }],
    [{ vk: 300, scan: 1 }],
    'Ctrl+C',
  ]) {
    assert.throws(() => parseRemoteScreenInput({ type: 'screen-keys', keys }), undefined, JSON.stringify(keys));
  }
});

test('screen-cursor: whole video pixels of a geometry generation', () => {
  const message = { v: REMOTE_WEBRTC_VERSION, kind: 'screen-cursor', x: 10, y: 20, generation: 2 };
  assert.deepEqual(readRemoteWebrtcScreenCursor(JSON.stringify(message)), message);
  for (const bad of [{ x: -1 }, { x: 1.5 }, { generation: 0 }, { kind: 'screen-status' }, { y: 5000 }]) {
    assert.equal(readRemoteWebrtcScreenCursor(JSON.stringify({ ...message, ...bad })), null, JSON.stringify(bad));
  }
});

test('screen-video and screen-frame-seen: a positive run epoch, a known path', () => {
  const video = { v: REMOTE_WEBRTC_VERSION, kind: 'screen-video', epoch: 3, path: 'helper' };
  assert.deepEqual(readRemoteWebrtcScreenVideo(JSON.stringify(video)), video);
  assert.deepEqual(readRemoteWebrtcScreenVideo(JSON.stringify({ ...video, path: 'capture' })).path, 'capture');
  for (const bad of [{ epoch: 0 }, { epoch: 1.5 }, { path: 'gpu' }, { kind: 'screen-cursor' }]) {
    assert.equal(readRemoteWebrtcScreenVideo(JSON.stringify({ ...video, ...bad })), null, JSON.stringify(bad));
  }
  const seen = { v: REMOTE_WEBRTC_VERSION, kind: 'screen-frame-seen', epoch: 3 };
  assert.deepEqual(parseRemoteWebrtcChannelFromClient(JSON.stringify(seen)), seen);
  assert.throws(() => parseRemoteWebrtcChannelFromClient(JSON.stringify({ ...seen, epoch: 0 })));
  assert.throws(() => parseRemoteWebrtcChannelFromClient(JSON.stringify({ ...seen, epoch: 'x' })));
});

const HEX_A = Array.from({ length: 32 }, () => 'AB').join(':');
const HEX_B = Array.from({ length: 32 }, () => 'CD').join(':');
const sdpWith = (...hex) =>
  ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', ...hex.map((value) => `a=fingerprint:sha-256 ${value}`), ''].join(
    '\r\n'
  );
const source = { kind: 'browser', sessionId: 'session_1' };
const ref = { v: REMOTE_WEBRTC_VERSION, source, connectionId: 'c'.repeat(22), generation: 3 };
const geometry = {
  generation: 1,
  cssWidth: 1280,
  cssHeight: 800,
  deviceScaleFactor: 1,
  pixelWidth: 1280,
  pixelHeight: 800,
};

test('an answer is accepted only when its SDP names exactly the signaled fingerprints', () => {
  const declared = [{ algorithm: 'sha-256', value: HEX_A.toLowerCase() }];
  const answer = parseRemoteWebrtcClientSignal({ ...ref, type: 'answer', sdp: sdpWith(HEX_A), fingerprints: declared });
  assert.deepEqual(answer.fingerprints, [{ algorithm: 'sha-256', value: HEX_A }]);
  for (const sdp of [sdpWith(HEX_B), sdpWith(HEX_A, HEX_B), sdpWith()]) {
    assert.throws(
      () => parseRemoteWebrtcClientSignal({ ...ref, type: 'answer', sdp, fingerprints: declared }),
      /fingerprint/u
    );
  }
  assert.throws(() =>
    assertRemoteWebrtcSdpFingerprints(sdpWith(HEX_A), [{ algorithm: 'sha-256', value: HEX_B }])
  );
  // SHA-1 is refused outright.
  assert.throws(() =>
    parseRemoteWebrtcClientSignal({
      ...ref,
      type: 'answer',
      sdp: sdpWith(HEX_A),
      fingerprints: [{ algorithm: 'sha-1', value: HEX_A.slice(0, 59) }],
    })
  );
});

test('ready may state a video limit within the contract bound', () => {
  const ready = { v: REMOTE_WEBRTC_VERSION, source, type: 'ready', receiveCodecs: ['video/VP8'] };
  assert.equal(parseRemoteWebrtcClientSignal(ready).videoLimit, undefined);
  assert.deepEqual(
    parseRemoteWebrtcClientSignal({ ...ready, videoLimit: { maxWidth: 2560, maxHeight: 4096 } }).videoLimit,
    { maxWidth: 2560, maxHeight: 4096 }
  );
  assert.throws(() => parseRemoteWebrtcClientSignal({ ...ready, videoLimit: { maxWidth: 4097, maxHeight: 100 } }));
});

test('the connected certificate must be one the E2EE channel delivered', () => {
  const declared = [{ algorithm: 'sha-256', value: HEX_A }];
  assert.equal(remoteWebrtcCertificateMatches(declared, { fingerprintAlgorithm: 'sha-256', fingerprint: HEX_A }), true);
  assert.equal(remoteWebrtcCertificateMatches(declared, { fingerprintAlgorithm: 'sha-256', fingerprint: HEX_B }), false);
  assert.equal(remoteWebrtcCertificateMatches(declared, {}), false);
});

test('the desktop offer carries ICE servers, locked geometry and the relay epoch; ice-lite is refused', () => {
  const offer = {
    ...ref,
    type: 'offer',
    sdp: sdpWith(HEX_A),
    fingerprints: [{ algorithm: 'sha-256', value: HEX_A }],
    iceServers: [{ urls: 'turn:turn.example:3478?transport=udp', username: 'u', credential: 'p' }],
    iceTransportPolicy: 'relay',
    geometry,
    inputEpoch: 1,
  };
  const read = readRemoteWebrtcDesktopSignal(offer);
  assert.deepEqual(read?.iceServers, [{ urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'p' }]);
  assert.equal(read?.iceTransportPolicy, 'relay');
  // One path only: through TURN, under the relay policy.
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, iceTransportPolicy: 'all' }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, iceServers: [{ urls: 'stun:turn.example:3478' }] }), null);
  assert.equal(
    readRemoteWebrtcDesktopSignal({ ...offer, iceServers: [{ urls: 'turn:turn.example:3478' }] }),
    null,
    'TURN without a credential is no path'
  );
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, sdp: `${sdpWith(HEX_A)}a=ice-lite\r\n` }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, iceServers: [{ urls: 'https://x' }] }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, geometry: { ...geometry, pixelWidth: 1279 } }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, v: 2 }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, connectionId: 'short' }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, generation: 0 }), null);
});

test('only TURN relay candidates (and end-of-candidates) are accepted', () => {
  const relay = 'candidate:1 1 udp 41885439 203.0.113.7 50123 typ relay raddr 0.0.0.0 rport 0 generation 0';
  const signal = parseRemoteWebrtcClientSignal({
    ...ref,
    type: 'candidate',
    candidate: { candidate: relay, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
  });
  assert.equal(signal.candidate.candidate, relay);
  assert.equal(parseRemoteWebrtcClientSignal({ ...ref, type: 'candidate', candidate: null }).candidate, null);
  assert.equal(
    parseRemoteWebrtcClientSignal({ ...ref, type: 'candidate', candidate: { candidate: '', sdpMid: '0' } }).candidate
      .candidate,
    ''
  );
  for (const line of [
    'candidate:1 1 udp 2122260223 4f0c7e1a-2b.local 54321 typ host generation 0',
    'candidate:2 1 udp 1686052607 198.51.100.4 40000 typ srflx raddr 10.0.0.2 rport 40000',
    'x',
  ]) {
    assert.throws(() =>
      parseRemoteWebrtcClientSignal({ ...ref, type: 'candidate', candidate: { candidate: line, sdpMid: '0' } })
    );
  }
});

test('channel input is the document-bound page input set, never a dialog answer', () => {
  const envelope = (control) =>
    JSON.stringify({ v: REMOTE_WEBRTC_VERSION, kind: 'input', epoch: 2, seq: 7, geometryGeneration: 1, sentAt: 5, control });
  const key = parseRemoteWebrtcChannelFromClient(envelope({ type: 'key', key: 'Enter', documentId: 'p1:2' }));
  assert.deepEqual([key.epoch, key.seq, key.control.type], [2, 7, 'key']);
  assert.throws(() =>
    parseRemoteWebrtcChannelFromClient(
      envelope({ type: 'answer-dialog', requestId: 'r', accept: true, documentId: 'p1:2' })
    )
  );
  assert.throws(() => parseRemoteWebrtcChannelFromClient(envelope({ type: 'key', key: 'Enter', documentId: 'x' })));
  assert.throws(() => parseRemoteWebrtcChannelFromClient('{'));
  const ack = { v: REMOTE_WEBRTC_VERSION, kind: 'input-ack', epoch: 2, seq: 7, outcome: 'applied', sentAt: 5, queuedMs: 1, dispatchMs: 2 };
  assert.deepEqual(readRemoteWebrtcChannelFromDesktop(JSON.stringify(ack)), ack);
  assert.equal(readRemoteWebrtcChannelFromDesktop(JSON.stringify({ ...ack, outcome: 'maybe' })), null);
});

test('screen sources: screen-input on the channel, a document-less media-ready, screen-status', () => {
  const screenRef = { ...ref, source: { kind: 'screen', screenId: '1' } };
  const media = { type: 'media-ready', geometryGeneration: 1, pixelWidth: 400, pixelHeight: 300 };
  assert.equal(parseRemoteWebrtcClientSignal({ ...screenRef, ...media, documentId: null }).documentId, null);
  assert.throws(() => parseRemoteWebrtcClientSignal({ ...screenRef, ...media, documentId: 'p1:1' }));
  assert.throws(() => parseRemoteWebrtcClientSignal({ ...ref, ...media, documentId: null }), 'a page needs its document');

  const envelope = (control) =>
    JSON.stringify({ v: REMOTE_WEBRTC_VERSION, kind: 'screen-input', epoch: 1, seq: 1, geometryGeneration: 1, sentAt: 0, control });
  const key = parseRemoteWebrtcChannelFromClient(envelope({ type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e }));
  assert.deepEqual(key.control, { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false });
  assert.equal(parseRemoteWebrtcChannelFromClient(envelope({ type: 'screen-release' })).control.type, 'screen-release');
  assert.throws(() => parseRemoteWebrtcChannelFromClient(envelope({ type: 'screen-pointer', action: 'move', x: 5000, y: 0 })));
  assert.throws(() => parseRemoteWebrtcChannelFromClient(envelope({ type: 'key', key: 'Enter', documentId: 'p1:1' })));

  const status = { state: 'secure-desktop', reason: 'uac', helper: 'missing', control: false };
  assert.deepEqual(
    readRemoteWebrtcScreenStatus(JSON.stringify({ v: REMOTE_WEBRTC_VERSION, kind: 'screen-status', status }))?.status,
    status
  );
  assert.equal(readRemoteWebrtcScreenStatus(JSON.stringify({ v: REMOTE_WEBRTC_VERSION, kind: 'screen-status', status: { ...status, state: 'x' } })), null);
});

test('the transport machine keeps JPEG until WebRTC owns the view and has no input owner mid-demotion', () => {
  assert.equal(canRemoteWebrtcTransition('relay', 'webrtc'), false);
  assert.equal(canRemoteWebrtcTransition('negotiating', 'demoting'), false);
  assert.equal(canRemoteWebrtcTransition('promoting', 'demoting'), true);
  assert.equal(canRemoteWebrtcTransition('webrtc', 'cooldown'), false);
  assert.equal(canRemoteWebrtcTransition('closed', 'relay'), false);
  assert.deepEqual(
    ['relay', 'negotiating', 'connected', 'promoting', 'webrtc', 'demoting', 'cooldown', 'closed'].map((state) => [
      remoteWebrtcJpegActive(state),
      remoteWebrtcInputOwner(state),
    ]),
    [
      [true, 'relay'],
      [true, 'relay'],
      [true, 'relay'],
      [true, 'relay'],
      [false, 'channel'],
      [true, null],
      [true, 'relay'],
      [false, null],
    ]
  );
});
