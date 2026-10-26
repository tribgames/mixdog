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
  remoteWebrtcCandidatePath,
  remoteWebrtcCertificateMatches,
  remoteWebrtcInputOwner,
  remoteWebrtcJpegActive,
  isRemoteWebrtcCandidateLine,
  parseRemoteWebrtcCandidate,
  parseRemoteWebrtcIceServers,
  parseRemoteWebrtcSdp,
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
    iceTransportPolicy: 'all',
    geometry,
    inputEpoch: 1,
  };
  const read = readRemoteWebrtcDesktopSignal(offer);
  assert.deepEqual(read?.iceServers, [{ urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'p' }]);
  assert.equal(read?.iceTransportPolicy, 'all');
  // Direct first: STUN only, or no server at all (one LAN), is still an offer.
  assert.deepEqual(
    readRemoteWebrtcDesktopSignal({ ...offer, iceServers: [{ urls: 'stun:turn.example:3478' }] })?.iceServers,
    [{ urls: ['stun:turn.example:3478'] }]
  );
  assert.deepEqual(readRemoteWebrtcDesktopSignal({ ...offer, iceServers: [] })?.iceServers, []);
  // A host before direct-first sends `relay`; the phone applies it as sent.
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, iceTransportPolicy: 'relay' })?.iceTransportPolicy, 'relay');
  for (const policy of [undefined, 'none', 'ALL']) {
    assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, iceTransportPolicy: policy }), null);
  }
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, sdp: `${sdpWith(HEX_A)}a=ice-lite\r\n` }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, iceServers: [{ urls: 'https://x' }] }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, geometry: { ...geometry, pixelWidth: 1279 } }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, v: 2 }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, connectionId: 'short' }), null);
  assert.equal(readRemoteWebrtcDesktopSignal({ ...offer, generation: 0 }), null);
});

test('host, srflx, prflx and relay candidates (and end-of-candidates) are accepted; malformed ones are not', () => {
  const body = (line) => ({
    ...ref,
    type: 'candidate',
    candidate: { candidate: line, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
  });
  // Both signaling directions apply the same check: phone→PC (throws) and
  // PC→phone (null).
  const read = (line) => {
    const fromDesktop = readRemoteWebrtcDesktopSignal(body(line));
    let fromPhone;
    try {
      fromPhone = parseRemoteWebrtcClientSignal(body(line)).candidate.candidate;
    } catch (error) {
      assert.equal(fromDesktop, null, `PC→phone accepted what phone→PC refused: ${line}`);
      throw error;
    }
    assert.equal(fromDesktop?.candidate.candidate, fromPhone, `PC→phone refused: ${line}`);
    assert.equal(isRemoteWebrtcCandidateLine(line), true);
    return fromPhone;
  };
  for (const line of [
    'candidate:8 1 tcp 1518280447 192.168.0.10 50002 typ host tcptype passive generation 0',
    'candidate:9 1 TCP 1518280447 192.168.0.10 50003 typ host tcptype so',
    'candidate:10 1 udp 2122260223 1:2:3:4:5:6:7:8 50004 typ host',
    'candidate:11 1 udp 2122260223 1:2:3:4:5:6:192.0.2.1 50005 typ host',
    'candidate:12 1 udp 2122260223 1:2:3:4:5:6:7:: 50006 typ host',
    'candidate:1 1 udp 41885439 203.0.113.7 50123 typ relay raddr 0.0.0.0 rport 0 generation 0',
    'candidate:842163049 1 udp 2122260223 4f0c7e1a-2b9c-4d0e-8f1a-2b3c4d5e6f70.local 54321 typ host generation 0 ufrag abcd network-id 1',
    'candidate:3 1 udp 2122262783 2001:db8::1 50000 typ host generation 0',
    'candidate:4 1 UDP 2122260223 192.168.0.10 50001 typ host',
    'candidate:5 1 tcp 1518280447 192.168.0.10 9 typ host tcptype active generation 0',
    'candidate:2 1 udp 1686052607 198.51.100.4 40000 typ srflx raddr 10.0.0.2 rport 40000',
    'candidate:6 1 udp 1853824767 198.51.100.9 41000 typ prflx raddr 0.0.0.0 rport 0',
    'candidate:7 1 udp 1686052607 ::ffff:198.51.100.4 40000 typ srflx raddr :: rport 0',
  ]) {
    assert.equal(read(line), line);
  }
  assert.equal(parseRemoteWebrtcClientSignal({ ...ref, type: 'candidate', candidate: null }).candidate, null);
  assert.equal(
    parseRemoteWebrtcClientSignal({ ...ref, type: 'candidate', candidate: { candidate: '', sdpMid: '0' } }).candidate
      .candidate,
    ''
  );
  for (const line of [
    'x',
    'candidate:1 1 udp 2122260223 192.168.0.10 50001 typ host\r\na=evil',
    'candidate:1 1 udp 2122260223 192.168.0.10 50001 typ bogus',
    'candidate:1 1 sctp 2122260223 192.168.0.10 50001 typ host',
    'candidate:1 0 udp 2122260223 192.168.0.10 50001 typ host',
    'candidate:1 1 udp 4294967296 192.168.0.10 50001 typ host',
    'candidate:1 1 udp 2122260223 256.168.0.10 50001 typ host',
    'candidate:1 1 udp 2122260223 192.168.0.10 65536 typ host',
    'candidate:1 1 udp 2122260223 2001:db8::1::2 50001 typ host',
    'candidate:1 1 udp 2122260223 evil.example.com 50001 typ host',
    'candidate:1 1 udp 1686052607 198.51.100.4 40000 typ srflx raddr 10.0.0.2',
    'candidate:1 1 udp 1686052607 198.51.100.4 40000 typ srflx raddr nope rport 1',
    'candidate:1 1 udp 2122260223 192.168.0.10 50001 typ host generation',
    'candidate:1 1 udp 2122260223  192.168.0.10 50001 typ host',
    'candidate:has space 1 udp 2122260223 192.168.0.10 50001 typ host',
    // tcptype: exactly one known value on TCP, none on UDP.
    'candidate:5 1 tcp 1518280447 192.168.0.10 9 typ host',
    'candidate:5 1 tcp 1518280447 192.168.0.10 9 typ host generation 0',
    'candidate:5 1 tcp 1518280447 192.168.0.10 9 typ host tcptype nonsense',
    'candidate:5 1 tcp 1518280447 192.168.0.10 9 typ host tcptype active tcptype passive',
    'candidate:5 1 tcp 1518280447 192.168.0.10 9 typ host tcptype active TCPTYPE active',
    'candidate:1 1 udp 2122260223 192.168.0.10 50001 typ host tcptype active',
    // IPv6: an embedded IPv4 only as the last 32 bits of the text.
    'candidate:1 1 udp 2122260223 192.0.2.1:: 50001 typ host',
    'candidate:1 1 udp 2122260223 192.0.2.1::1 50001 typ host',
    'candidate:1 1 udp 2122260223 ::192.0.2.1:1 50001 typ host',
    'candidate:1 1 udp 1686052607 198.51.100.4 40000 typ srflx raddr 192.0.2.1:: rport 0',
    // Too many groups, more than one `::`, a group over 4 hex digits.
    'candidate:1 1 udp 2122260223 1:2:3:4:5:6:7:8:9 50001 typ host',
    'candidate:1 1 udp 2122260223 1:2:3:4:5:6:7:8:: 50001 typ host',
    'candidate:1 1 udp 2122260223 1:2:3:4:5:6:7:192.0.2.1 50001 typ host',
    'candidate:1 1 udp 2122260223 1::2::3 50001 typ host',
    'candidate:1 1 udp 2122260223 12345::1 50001 typ host',
    'candidate:1 1 udp 2122260223 ::ffff:192.0.2.256 50001 typ host',
  ]) {
    assert.throws(() => read(line), undefined, line);
    assert.equal(isRemoteWebrtcCandidateLine(line), false, line);
  }
});

test('the shared validators are exported for other transports, with the same rules', () => {
  assert.equal(parseRemoteWebrtcCandidate(null), null);
  assert.deepEqual(parseRemoteWebrtcCandidate({ candidate: '', sdpMid: '0' }), {
    candidate: '',
    sdpMid: '0',
    sdpMLineIndex: null,
    usernameFragment: null,
  });
  assert.throws(() => parseRemoteWebrtcCandidate({ candidate: 'x', sdpMid: '0' }));
  assert.deepEqual(parseRemoteWebrtcIceServers([{ urls: 'stun:a.example:3478' }]), [{ urls: ['stun:a.example:3478'] }]);
  assert.deepEqual(parseRemoteWebrtcIceServers([]), []);
  assert.throws(() => parseRemoteWebrtcIceServers([{ urls: [] }]));
  assert.throws(() => parseRemoteWebrtcIceServers([{ urls: 'https://x' }]));
  assert.equal(parseRemoteWebrtcSdp(sdpWith(HEX_A)), sdpWith(HEX_A));
  assert.throws(() => parseRemoteWebrtcSdp('o=- 1 2 IN IP4 127.0.0.1'));
  assert.throws(() => parseRemoteWebrtcSdp(`${sdpWith(HEX_A)}a=ice-lite\r\n`));
  assert.throws(() => parseRemoteWebrtcSdp(`v=0${'x'.repeat(65_536)}`));
});

test('the path is relay when either end of the selected pair is a TURN relay candidate', () => {
  const pair = (localType, remoteType) => ({ localType, remoteType, protocol: 'udp' });
  assert.equal(remoteWebrtcCandidatePath(pair('host', 'host')), 'direct');
  assert.equal(remoteWebrtcCandidatePath(pair('srflx', 'prflx')), 'direct');
  assert.equal(remoteWebrtcCandidatePath(pair('relay', 'srflx')), 'relay');
  assert.equal(remoteWebrtcCandidatePath(pair('host', 'relay')), 'relay');
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
