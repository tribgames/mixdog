#!/usr/bin/env node
// Records, from Node's product at b6f10295a, the phone live view over WebRTC that Rust must serve once the
// desktop's sender window is gone: the REAL wire contract (apps/desktop/src/shared/remote-webrtc.ts parse/validate
// functions), the REAL service-side relay (main/remote-webrtc/relay.ts) and the REAL per-viewer transport state
// machine (main/remote-webrtc/viewer.ts), each driven by scripted inputs. The inputs are chosen here; every outcome
// (parsed value, error text, dependency call, effect, state) is what Node answered.
//
// signals.json   parse/validate outcomes over a generated corpus (valid messages and field-by-field mutations).
// relay.json     scripted scenarios: deps are promises the scenario settles step by step; the log is every dep call.
// viewer.json    scripted scenarios: effects are logged, timers fire and dispatches settle only when a step says so.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-live-view.mjs --tree <git archive of b6f10295a with node_modules>
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, exactProductIdentity, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const recorder = 'benchmarks/rust-core/recorders/record-live-view.mjs';
const finalDir = join(FIXTURES_ROOT, 'live-view');
const stage = stageSet(finalDir);
const shared = await importFrom(tree, 'apps/desktop/src/shared/remote-webrtc.ts');
const { createRemoteWebrtcRelay, remoteWebrtcSignalIsBarrier } = await importFrom(tree, 'apps/desktop/src/main/remote-webrtc/relay.ts');
const viewerModule = await importFrom(tree, 'apps/desktop/src/main/remote-webrtc/viewer.ts');
const budget = await importFrom(tree, 'apps/desktop/src/shared/remote-frame-budget.ts');

const outcome = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------------------------------------------------------
// The inputs: valid messages of every kind, then each field replaced by junk or removed.
// ---------------------------------------------------------------------------------------------------------------
const SRC = { kind: 'browser', sessionId: 'sess_1' };
const SCREEN = { kind: 'screen', screenId: 'screen-1' };
const CID = 'connection-id-0001';
const hex = (bytes, seed = 1) => Array.from({ length: bytes }, (_, i) => ((i * 7 + seed) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP256 = hex(32);
const FP384 = hex(48, 3);
const FP512 = hex(64, 5);
const sdpWith = (...prints) =>
  `v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n${prints.map((p) => `a=fingerprint:${p.algorithm} ${p.value}\r\n`).join('')}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`;
const fp256 = { algorithm: 'sha-256', value: FP256 };
const SDP = sdpWith(fp256);
const ref = (source = SRC) => ({ v: 1, source, connectionId: CID, generation: 1 });
const HOST = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0 ufrag abcd network-id 1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
const GEOMETRY = { generation: 1, cssWidth: 390, cssHeight: 844, deviceScaleFactor: 3, pixelWidth: 1170, pixelHeight: 2532 };
const ICE = [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c' }];

const CLIENT_VALID = {
  ready: { v: 1, source: SRC, type: 'ready', receiveCodecs: ['video/VP8', 'video/H264'] },
  'ready-limit': { v: 1, source: SRC, type: 'ready', receiveCodecs: ['video/VP8'], videoLimit: { maxWidth: 1920, maxHeight: 1080 } },
  'ready-screen': { v: 1, source: SCREEN, type: 'ready', receiveCodecs: [] },
  'geometry-ack': { v: 1, source: SRC, type: 'geometry-ack', geometryGeneration: 1 },
  'resize-page': { v: 1, source: SRC, type: 'resize-request', resize: { mode: 'page' } },
  'resize-fit': { v: 1, source: SRC, type: 'resize-request', resize: { mode: 'fit-client', cssWidth: 390, cssHeight: 700, deviceScaleFactor: 2.5 } },
  answer: { ...ref(), type: 'answer', sdp: SDP, fingerprints: [fp256] },
  'candidate-null': { ...ref(), type: 'candidate', candidate: null },
  'candidate-line': { ...ref(), type: 'candidate', candidate: HOST },
  'candidate-end': { ...ref(), type: 'candidate', candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: null, usernameFragment: null } },
  'media-ready': { ...ref(), type: 'media-ready', documentId: 'p1:2', geometryGeneration: 1, pixelWidth: 1170, pixelHeight: 2532 },
  'media-ready-screen': { ...ref(SCREEN), type: 'media-ready', documentId: null, geometryGeneration: 1, pixelWidth: 1170, pixelHeight: 2532 },
  'promote-ack': { ...ref(), type: 'promote-ack', inputEpoch: 2 },
  'demote-ack': { ...ref(), type: 'demote-ack', inputEpoch: 3 },
  close: { ...ref(), type: 'close', reason: 'viewer-left' },
  'close-detail': { ...ref(), type: 'close', reason: 'ice-failed', detail: 'no pair' },
};
const DESKTOP_VALID = {
  geometry: { v: 1, source: SRC, type: 'geometry', geometry: GEOMETRY },
  offer: { ...ref(), type: 'offer', sdp: SDP, fingerprints: [fp256], iceServers: ICE, iceTransportPolicy: 'all', geometry: GEOMETRY, inputEpoch: 1 },
  'offer-relay-policy': { ...ref(), type: 'offer', sdp: SDP, fingerprints: [fp256], iceServers: [], iceTransportPolicy: 'relay', geometry: GEOMETRY, inputEpoch: 1 },
  candidate: { ...ref(), type: 'candidate', candidate: HOST },
  'candidate-null': { ...ref(), type: 'candidate', candidate: null },
  promote: { ...ref(), type: 'promote', inputEpoch: 2, geometryGeneration: 1 },
  demote: { ...ref(), type: 'demote', inputEpoch: 2, reason: 'channel-failed' },
  close: { ...ref(), type: 'close', reason: 'superseded' },
  'close-retry': { ...ref(), type: 'close', reason: 'ice-failed', retryAfterMs: 0 },
};
const CHANNEL_VALID = {
  pointer: { v: 1, kind: 'input', epoch: 2, seq: 1, geometryGeneration: 1, sentAt: 12.5, control: { type: 'pointer', documentId: 'p1:2', phase: 'mousePressed', button: 'left', x: 10.5, y: 20, buttons: 1, modifiers: 0, clickCount: 1 } },
  wheel: { v: 1, kind: 'input', epoch: 2, seq: 2, geometryGeneration: 1, sentAt: 13, control: { type: 'wheel', documentId: 'p1:2', x: 1, y: 2, deltaX: 0, deltaY: -120 } },
  text: { v: 1, kind: 'input', epoch: 2, seq: 3, geometryGeneration: 1, sentAt: 14, control: { type: 'text', documentId: 'p1:2', text: 'hello' } },
  key: { v: 1, kind: 'input', epoch: 2, seq: 4, geometryGeneration: 1, sentAt: 15, control: { type: 'key', documentId: 'p1:2', key: 'Enter' } },
  composition: { v: 1, kind: 'input', epoch: 2, seq: 5, geometryGeneration: 1, sentAt: 16, control: { type: 'composition', documentId: 'p1:2', text: 'ni', selectionStart: 1, selectionEnd: 2 } },
  'composition-end': { v: 1, kind: 'input', epoch: 2, seq: 6, geometryGeneration: 1, sentAt: 17, control: { type: 'composition-end', documentId: 'p1:2', text: 'ni' } },
  stats: {
    v: 1,
    kind: 'stats',
    stats: {
      connectionId: CID, generation: 1, at: 1000, codec: 'video/VP8', decoderImplementation: 'libvpx', framesReceived: 10, framesDecoded: 9, framesDropped: 1,
      totalDecodeTimeMs: 12.5, jitterBufferDelayMs: 3, freezeCount: 0, inputRoundTripMs: 20, inputToVisibleMs: 40, frameWidth: 1170, frameHeight: 2532,
      candidatePair: { localType: 'host', remoteType: 'relay', protocol: 'udp', relayProtocol: 'tls', currentRoundTripTimeMs: 5, availableOutgoingBitrate: 1000 },
    },
  },
  'stats-min': { v: 1, kind: 'stats', stats: { connectionId: CID, generation: 1, at: 0, framesReceived: 0, framesDecoded: 0, framesDropped: 0, totalDecodeTimeMs: 0 } },
  'screen-input': { v: 1, kind: 'screen-input', epoch: 2, seq: 1, geometryGeneration: 1, sentAt: 1, control: { type: 'pointer', phase: 'move', x: 1, y: 1 } },
  'screen-frame-seen': { v: 1, kind: 'screen-frame-seen', epoch: 1 },
};

const DELETE = Symbol('delete');
const JUNK = [DELETE, null, 0, -1, 1, 1.5, 9007199254740992, '', 'x', true, [], {}, 'a'.repeat(300)];
const EXTRA = {
  v: [2, '1'],
  type: ['nope', 'READY', 'ready ', 'promote', 'offer'],
  kind: ['browser ', 'Browser', 'screen', 'nope'],
  mode: ['fit-client', 'page', 'Page', 'full'],
  sessionId: ['a'.repeat(256), 'a'.repeat(257), 'has space', 'ok_-1'],
  screenId: ['a'.repeat(256), 'a'.repeat(257), 'bad!'],
  connectionId: ['a'.repeat(15), 'a'.repeat(16), 'a'.repeat(64), 'a'.repeat(65), 'has+plus_is_16chars', 'connection-id-0001'],
  generation: [2, 9007199254740991],
  geometryGeneration: [2, 9007199254740991],
  inputEpoch: [2, 9007199254740991],
  epoch: [2, 9007199254740991],
  seq: [2, 9007199254740991],
  reason: ['viewer-left', 'superseded', 'unsupported', 'turn-unavailable', 'negotiation-timeout', 'ice-failed', 'dtls-failed', 'fingerprint-mismatch', 'media-timeout', 'channel-failed', 'sender-failed', 'unauthorized', 'protocol-error', 'other'],
  detail: ['a'.repeat(200), 'a'.repeat(201)],
  sdp: ['v=0', 'v=1\r\n', 'v=0\r\na=ice-lite\r\n', '  v=0', `${SDP}a=ice-lite\r\n`, `${SDP}a=ice-lite`, sdpWith(fp256, fp256), sdpWith({ algorithm: 'sha-256', value: FP256.toLowerCase() }), sdpWith(fp256, { algorithm: 'sha-384', value: FP384 }), sdpWith({ algorithm: 'sha-256', value: hex(32, 9) }), 'v=0\r\n'],
  fingerprints: [[], [fp256, fp256], [fp256, { algorithm: 'sha-384', value: FP384 }, { algorithm: 'sha-512', value: FP512 }, fp256], [{ algorithm: 'SHA-256', value: FP256 }], [{ algorithm: 'sha-256', value: FP256.toLowerCase() }], [{ algorithm: 'sha-1', value: hex(20) }], [{ algorithm: 'sha-256', value: hex(31) }], [{ algorithm: 'sha-256', value: `${FP256}:00` }], [{ algorithm: 'md5', value: hex(16) }]],
  algorithm: ['SHA-256', 'sha-384', 'sha-512', 'sha-1'],
  value: [FP256.toLowerCase(), FP256.replace(/:/g, ''), hex(31), hex(33)],
  documentId: ['p1:2', 'p0:1', 'p1:', 'P1:1', 'p10:20', `p1:${'9'.repeat(70)}`, 'p1:2 ', 'p1:-1'],
  pixelWidth: [1, 2, 3, 4096, 4098, 1170],
  pixelHeight: [1, 2, 3, 4096, 4098],
  cssWidth: [1, 199, 200, 3840, 3841, 16384, 16385],
  cssHeight: [1, 199, 200, 3840, 3841, 16384, 16385],
  deviceScaleFactor: [0, 0.49, 0.5, 4, 4.01, 32, 33],
  maxWidth: [63, 64, 4096, 4097],
  maxHeight: [63, 64, 4096, 4097],
  receiveCodecs: [Array.from({ length: 32 }, () => 'video/VP8'), Array.from({ length: 33 }, () => 'video/VP8'), ['audio/opus'], ['video/'], [`video/${'a'.repeat(32)}`], [`video/${'a'.repeat(33)}`], ['video/h264+x.y-z'], [7]],
  iceTransportPolicy: ['all', 'relay', 'ALL', 'none'],
  iceServers: [[], Array.from({ length: 16 }, () => ({ urls: ['stun:a'] })), Array.from({ length: 17 }, () => ({ urls: ['stun:a'] })), [{ urls: 'stun:a' }], [{ urls: [] }], [{ urls: Array.from({ length: 17 }, () => 'stun:a') }], [{ urls: ['http://a'] }], [{ urls: ['turns:a'], username: 'u'.repeat(512), credential: 'c'.repeat(513) }], [{ urls: ['stuns:a'], username: 1 }], [{}], ['x']],
  urls: ['stun:a', ['turn:a b'], ['TURN:a']],
  retryAfterMs: [0, 9007199254740991, 9007199254740992, -1],
  candidate: [{ candidate: 'x' }, { candidate: '', sdpMid: null, sdpMLineIndex: null }, { candidate: '', sdpMid: 'a'.repeat(32) }, { candidate: '', sdpMid: 'a'.repeat(33) }, { candidate: '', sdpMLineIndex: 255 }, { candidate: '', sdpMLineIndex: 256 }, { candidate: '', sdpMid: '0', usernameFragment: 'u'.repeat(256) }, { candidate: '', sdpMid: '0', usernameFragment: 'u'.repeat(257) }, { candidate: 'a'.repeat(1024), sdpMid: '0' }, { candidate: HOST.candidate }],
  sdpMid: ['0', 'a'.repeat(32), 'a'.repeat(33)],
  sdpMLineIndex: [0, 255, 256, -1],
  usernameFragment: ['u'.repeat(256), 'u'.repeat(257)],
  phase: ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseDown'],
  button: ['none', 'left', 'middle', 'right', 'back'],
  x: [0, 100000, 100001, -0.5],
  y: [0, 100000, 100001],
  buttons: [0, 7, 8],
  modifiers: [0, 15, 16],
  clickCount: [0, 3, 4],
  deltaX: [-20000, 20000, 20001],
  deltaY: [-20000, 20000, -20001],
  text: ['a'.repeat(32000), 'a'.repeat(32001)],
  key: ['a'.repeat(64), 'a'.repeat(65)],
  selectionStart: [0, 1, 3, 1.5],
  selectionEnd: [0, 1, 2, 3, 1.5],
  sentAt: [0, -1, 1e300],
  at: [0, -1],
  localType: ['host', 'srflx', 'prflx', 'relay', 'peer-reflexive'],
  remoteType: ['host', 'relay', 'x'],
  protocol: ['udp', 'tcp', 'tls'],
  relayProtocol: ['udp', 'tcp', 'tls', 'quic'],
  codec: ['a'.repeat(128), 'a'.repeat(129)],
};
const KEEP_JUNK_OFF = new Set(['v']); // `v` takes only its own list so a bad version is not buried in noise
const setPath = (root, path, value) => {
  const copy = clone(root);
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key];
  const last = path.at(-1);
  if (value === DELETE) delete node[last];
  else node[last] = clone(value);
  return copy;
};
const pathsOf = (value, prefix = []) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).flatMap((key) => [[...prefix, key], ...pathsOf(value[key], [...prefix, key])])
    : [];
function corpusOf(valid) {
  const seen = new Set();
  const out = [];
  const add = (input) => {
    const key = JSON.stringify(input);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(input);
  };
  for (const base of Object.values(valid)) {
    add(base);
    for (const path of pathsOf(base)) {
      const name = path.at(-1);
      const values = [...(KEEP_JUNK_OFF.has(name) ? [DELETE] : JUNK), ...(EXTRA[name] ?? [])];
      for (const value of values) add(setPath(base, path, value));
    }
  }
  for (const junk of [null, 0, 'x', [], true]) add(junk);
  return out;
}

const signals = {};
signals.client = corpusOf(CLIENT_VALID).map((input) => ({ input, ...outcome(() => shared.parseRemoteWebrtcClientSignal(input)) }));
signals.desktop = corpusOf(DESKTOP_VALID).map((input) => ({ input, ...outcome(() => shared.parseRemoteWebrtcDesktopSignal(input)) }));
signals.channel = [
  ...corpusOf(CHANNEL_VALID).map((input) => JSON.stringify(input)),
  'not json', '', '[]', 'null', '1', '"x"', '{"v":1}', '{"v":2,"kind":"input"}', '{"v":1,"kind":"nope"}', JSON.stringify({ v: 1, kind: 'input', epoch: 1, seq: 1, geometryGeneration: 1, sentAt: 1, control: { type: 'navigate', documentId: 'p1:1', url: 'x' } }),
  JSON.stringify({ v: 1, kind: 'input', epoch: 1, seq: 1, geometryGeneration: 1, sentAt: 1, control: { type: 'answer-dialog', documentId: 'p1:1', accept: true, requestId: 'r' } }),
].map((text) => ({ text, ...outcome(() => shared.parseRemoteWebrtcChannelFromClient(text)) }));
const CANDIDATE_LINES = [
  'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host',
  'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0 ufrag abcd network-id 1 network-cost 10',
  'CANDIDATE:1 1 UDP 2122260223 192.168.1.2 54321 TYP HOST',
  'candidate:abc+/= 1 udp 1 1.2.3.4 1 typ host',
  `candidate:${'a'.repeat(32)} 1 udp 1 1.2.3.4 1 typ host`,
  `candidate:${'a'.repeat(33)} 1 udp 1 1.2.3.4 1 typ host`,
  'candidate: 1 udp 1 1.2.3.4 1 typ host',
  'candidate:1 0 udp 1 1.2.3.4 1 typ host',
  'candidate:1 1 udp 1 1.2.3.4 1 typ host extra',
  'candidate:1 256 udp 1 1.2.3.4 1 typ host',
  'candidate:1 257 udp 1 1.2.3.4 1 typ host',
  'candidate:1 1000 udp 1 1.2.3.4 1 typ host',
  'candidate:1 1 udp 4294967295 1.2.3.4 1 typ host',
  'candidate:1 1 udp 4294967296 1.2.3.4 1 typ host',
  'candidate:1 1 udp 4294967295 1.2.3.4 65535 typ host',
  'candidate:1 1 udp 1 1.2.3.4 65536 typ host',
  'candidate:1 1 udp 1 1.2.3.4 99999 typ host',
  'candidate:1 1 udp 1 1.2.3.4 123456 typ host',
  'candidate:1 1 sctp 1 1.2.3.4 1 typ host',
  'candidate:1 1 udp 1 1.2.3.4 1 typ bogus',
  'candidate:1 1 udp 1 256.1.1.1 1 typ host',
  'candidate:1 1 udp 1 1.2.3 1 typ host',
  'candidate:1 1 udp 1 01.002.3.255 1 typ host',
  'candidate:1 1 udp 1 1.2.3.4.5 1 typ host',
  'candidate:1 1 udp 1 ::1 1 typ host',
  'candidate:1 1 udp 1 :: 1 typ host',
  'candidate:1 1 udp 1 2001:db8::1 1 typ host',
  'candidate:1 1 udp 1 2001:db8:0:0:0:0:0:1 1 typ host',
  'candidate:1 1 udp 1 2001:db8:0:0:0:0:0:0:1 1 typ host',
  'candidate:1 1 udp 1 1:2:3:4:5:6:7::8 1 typ host',
  'candidate:1 1 udp 1 1:2:3:4:5:6:7:: 1 typ host',
  'candidate:1 1 udp 1 ::ffff:1.2.3.4 1 typ host',
  'candidate:1 1 udp 1 ::1.2.3.4 1 typ host',
  'candidate:1 1 udp 1 1.2.3.4::1 1 typ host',
  'candidate:1 1 udp 1 ::ffff:1.2.3.256 1 typ host',
  'candidate:1 1 udp 1 1::2::3 1 typ host',
  'candidate:1 1 udp 1 12345::1 1 typ host',
  'candidate:1 1 udp 1 g::1 1 typ host',
  'candidate:1 1 udp 1 abcd-ef.local 1 typ host',
  'candidate:1 1 udp 1 a.b.c.d.local 1 typ host',
  'candidate:1 1 udp 1 a.b.c.d.e.local 1 typ host',
  'candidate:1 1 udp 1 -a.local 1 typ host',
  'candidate:1 1 udp 1 a-.local 1 typ host',
  'candidate:1 1 udp 1 example.com 1 typ host',
  'candidate:1 1 udp 1 LOCAL 1 typ host',
  'candidate:1 1 udp 1 A.LOCAL 1 typ host',
  'candidate:1 1 udp 1 1.2.3.4 1 typ srflx raddr 0.0.0.0 rport 0',
  'candidate:1 1 udp 1 1.2.3.4 1 typ srflx raddr 0.0.0.0',
  'candidate:1 1 udp 1 1.2.3.4 1 typ srflx rport 0',
  'candidate:1 1 udp 1 1.2.3.4 1 typ relay raddr 10.0.0.1 rport 65536',
  'candidate:1 1 udp 1 1.2.3.4 1 typ relay raddr bad rport 1',
  'candidate:1 1 udp 1 1.2.3.4 1 typ relay raddr 10.0.0.1 rport 1 generation 0',
  'candidate:1 1 tcp 1 1.2.3.4 9 typ host',
  'candidate:1 1 tcp 1 1.2.3.4 9 typ host tcptype active',
  'candidate:1 1 tcp 1 1.2.3.4 9 typ host tcptype passive',
  'candidate:1 1 tcp 1 1.2.3.4 9 typ host tcptype so',
  'candidate:1 1 tcp 1 1.2.3.4 9 typ host tcptype TCP',
  'candidate:1 1 TCP 1 1.2.3.4 9 typ host TCPTYPE ACTIVE',
  'candidate:1 1 tcp 1 1.2.3.4 9 typ host tcptype active tcptype passive',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host tcptype active',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host generation',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host generation 0 ufrag',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host Generation 0',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host 1abc 0',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host a-b-1 \u007f',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host a-b-1 !~',
  `candidate:1 1 udp 1 1.2.3.4 9 typ host a-b-1 ${'v'.repeat(256)}`,
  `candidate:1 1 udp 1 1.2.3.4 9 typ host a-b-1 ${'v'.repeat(257)}`,
  `candidate:1 1 udp 1 1.2.3.4 9 typ host ${'a'.repeat(32)} 1`,
  `candidate:1 1 udp 1 1.2.3.4 9 typ host ${'a'.repeat(33)} 1`,
  'candidate:1 1 udp 1 1.2.3.4 9 typ host raddr 1.2.3.4 rport 1',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host typ 1',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host  generation 0',
  'candidate:1 1 udp 1 1.2.3.4 9 typ host generation 0 ',
  ' candidate:1 1 udp 1 1.2.3.4 9 typ host',
  'a=candidate:1 1 udp 1 1.2.3.4 9 typ host',
  '',
];
signals.candidateLines = CANDIDATE_LINES.map((line) => ({ line, ok: shared.isRemoteWebrtcCandidateLine(line) }));
const SDPS = [SDP, sdpWith(fp256, fp256), sdpWith(fp256, { algorithm: 'sha-384', value: FP384 }), sdpWith({ algorithm: 'SHA-256', value: FP256.toLowerCase() }), sdpWith({ algorithm: 'sha-1', value: hex(20) }), 'v=0\r\na=fingerprint:sha-256 zz\r\n', 'v=0\na=fingerprint:sha-256 ' + FP256 + '\n', 'v=0\r\na=fingerprint:sha-256 ' + FP256 + '   \r\n', 'v=0\r\n a=fingerprint:sha-256 ' + FP256 + '\r\n', 'v=0\r\n'];
signals.sdpFingerprints = SDPS.map((sdp) => ({ sdp, ...outcome(() => shared.remoteWebrtcSdpFingerprints(sdp)) }));
const certs = [
  { fingerprintAlgorithm: 'sha-256', fingerprint: FP256 },
  { fingerprintAlgorithm: 'SHA-256', fingerprint: FP256.toLowerCase() },
  { fingerprintAlgorithm: 'sha-384', fingerprint: FP384 },
  { fingerprintAlgorithm: 'sha-1', fingerprint: hex(20) },
  { fingerprintAlgorithm: 'sha-256', fingerprint: hex(32, 9) },
  { fingerprintAlgorithm: 'sha-256' },
  { fingerprint: FP256 },
  { fingerprintAlgorithm: 7, fingerprint: FP256 },
  [],
  null,
  'x',
];
signals.certificates = certs.map((certificate) => ({ declared: [fp256], certificate, matches: shared.remoteWebrtcCertificateMatches([fp256], certificate) }));
signals.certificates.push({ declared: [], certificate: certs[0], matches: shared.remoteWebrtcCertificateMatches([], certs[0]) });
const STATES = ['relay', 'negotiating', 'connected', 'promoting', 'webrtc', 'demoting', 'cooldown', 'closed'];
signals.states = STATES.map((state) => ({
  state,
  next: STATES.filter((to) => shared.canRemoteWebrtcTransition(state, to)),
  jpegActive: shared.remoteWebrtcJpegActive(state),
  inputOwner: shared.remoteWebrtcInputOwner(state),
}));
signals.sourceKeys = [SRC, SCREEN, { kind: 'browser', sessionId: 'a:b' }].map((source) => ({ source, key: shared.remoteWebrtcSourceKey(source) }));
signals.barriers = Object.entries(CLIENT_VALID).map(([name, raw]) => ({ name, raw, barrier: remoteWebrtcSignalIsBarrier(shared.parseRemoteWebrtcClientSignal(raw)) }));
writeJson(join(stage, 'signals.json'), { domain: 'live-view-signals', recorder, constants: { version: shared.REMOTE_WEBRTC_VERSION, inputChannel: shared.REMOTE_WEBRTC_INPUT_CHANNEL, signalMethod: shared.REMOTE_WEBRTC_SIGNAL_METHOD, signalEvent: shared.REMOTE_WEBRTC_SIGNAL_EVENT, iceTransportPolicy: shared.REMOTE_WEBRTC_ICE_TRANSPORT_POLICY, negotiationTimeoutMs: viewerModule.REMOTE_WEBRTC_NEGOTIATION_TIMEOUT_MS, demoteAckTimeoutMs: viewerModule.REMOTE_WEBRTC_DEMOTE_ACK_TIMEOUT_MS, pendingFrames: budget.REMOTE_CLIENT_PENDING_FRAMES }, ...signals });

// ---------------------------------------------------------------------------------------------------------------
// The relay (service end).
// ---------------------------------------------------------------------------------------------------------------
const FOLDS = {
  accept: 0, // keep the object shape readable
};
void FOLDS;
async function relayScenario(name, steps) {
  const log = [];
  const pending = [];
  const state = { subscribed: new Set(), awaitingFit: new Set() };
  const origins = new Map();
  const originOf = (id) => {
    if (!origins.has(id)) origins.set(id, { id });
    return origins.get(id);
  };
  const deferred = (kind, args) =>
    new Promise((resolve, reject) => {
      const index = pending.filter((entry) => entry.kind === kind).length;
      pending.push({ kind, index, resolve, reject });
      log.push(['call', kind, index, ...args]);
    });
  const relay = createRemoteWebrtcRelay({
    subscribed: (clientId, sessionId) => {
      const answer = state.subscribed.has(`${clientId}|${sessionId}`);
      log.push(['subscribed', clientId, sessionId, answer]);
      return answer;
    },
    awaitingFit: (clientId, sessionId) => {
      const answer = state.awaitingFit.has(`${clientId}|${sessionId}`);
      log.push(['awaitingFit', clientId, sessionId, answer]);
      return answer;
    },
    screenAuthorized: (clientId, origin) => deferred('screenAuthorized', [clientId, origin.id]),
    setImages: (clientId, sessionId, enabled) => log.push(['setImages', clientId, sessionId, enabled]),
    resolveIceServers: () => deferred('resolveIceServers', []),
    forward: (clientId, signal, iceServers, origin) => deferred('forward', [clientId, clone(signal), clone(iceServers ?? null), origin.id]),
    viewerLeft: (clientId, sourceKey) => {
      log.push(['viewerLeft', clientId, sourceKey]);
      return Promise.resolve();
    },
    screenDisplays: () => deferred('screenDisplays', []),
    send: (clientId, payload) => {
      log.push(['send', clientId, clone(payload)]);
      return Promise.resolve();
    },
  });
  const running = new Map();
  const recorded = [];
  for (const step of steps) {
    const before = log.length;
    const done = [];
    const track = (id, promise) => {
      running.set(id, promise);
      promise.then(
        (value) => done.push({ id, ok: true, value: value === undefined ? null : clone(value) }),
        (error) => done.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
      );
    };
    let result;
    switch (step.op) {
      case 'set':
        state.subscribed = new Set((step.subscribed ?? []).map(([c, s]) => `${c}|${s}`));
        state.awaitingFit = new Set((step.awaitingFit ?? []).map(([c, s]) => `${c}|${s}`));
        break;
      case 'accept':
        result = outcome(() => relay.accept(step.client, step.raw));
        break;
      case 'forward': {
        const signal = shared.parseRemoteWebrtcClientSignal(step.raw);
        track(step.id, relay.forward(step.client, signal, originOf(step.origin)));
        break;
      }
      case 'screenDisplays':
        track(step.id, relay.screenDisplays(step.client, originOf(step.origin)));
        break;
      case 'resolve':
      case 'reject': {
        const entry = pending.find((e) => e.kind === step.kind && e.index === step.index);
        if (!entry) throw new Error(`${name}: nothing pending as ${step.kind}[${step.index}]`);
        if (step.op === 'resolve') entry.resolve(step.value ?? undefined);
        else entry.reject(new TypeError(step.message));
        break;
      }
      case 'send':
        track(step.id, relay.send(step.client, step.raw));
        break;
      case 'relayInputAllowed':
        result = { ok: true, value: relay.relayInputAllowed(step.client, step.session) };
        break;
      case 'connectionRemoved':
        relay.connectionRemoved(step.client);
        break;
      case 'viewerLeft':
        relay.viewerLeft(step.client, step.session);
        break;
      default:
        throw new Error(`unknown relay op ${step.op}`);
    }
    await flush();
    recorded.push({ ...(result ? { result } : {}), done, log: clone(log.slice(before)) });
  }
  return { name, steps, recorded };
}

const R = 'client_1';
const rb = (type, extra = {}) => ({ ...ref(), type, ...extra });
const rs = (id, signal, origin = 'o1') => ({ op: 'forward', id, client: R, raw: signal, origin });
const offerOut = (conn = CID, extra = {}) => ({ ...ref(), connectionId: conn, type: 'offer', sdp: SDP, fingerprints: [fp256], iceServers: [], iceTransportPolicy: 'all', geometry: GEOMETRY, inputEpoch: 1, ...extra });
const relayScenarios = [
  await relayScenario('accept needs a subscription for a browser source and none for a screen', [
    { op: 'accept', client: R, raw: CLIENT_VALID.ready },
    { op: 'set', subscribed: [[R, 'sess_1']] },
    { op: 'accept', client: R, raw: CLIENT_VALID.ready },
    { op: 'accept', client: R, raw: CLIENT_VALID['ready-screen'] },
    { op: 'accept', client: R, raw: { v: 1, type: 'nope' } },
    { op: 'accept', client: R, raw: null },
  ]),
  await relayScenario('a ready resolves the ice servers, then forwards with them', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    rs('r1', CLIENT_VALID.ready),
    { op: 'resolve', kind: 'resolveIceServers', index: 0, value: [{ urls: 'stun:a' }, { urls: ['turn:b', 'turn:c'], username: 'u', credential: 'p' }, { urls: ['stun:d'], credential: 7 }] },
    { op: 'resolve', kind: 'forward', index: 0 },
  ]),
  await relayScenario('a newer ready makes the older one stale at each await', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    rs('r1', CLIENT_VALID.ready),
    rs('r2', CLIENT_VALID['ready-limit']),
    { op: 'resolve', kind: 'resolveIceServers', index: 0, value: [] },
    { op: 'resolve', kind: 'resolveIceServers', index: 1, value: [{ urls: ['stun:z'] }] },
    { op: 'resolve', kind: 'forward', index: 0 },
  ]),
  await relayScenario('a ready whose client stopped streaming is refused after the ice servers', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    rs('r1', CLIENT_VALID.ready),
    { op: 'set', subscribed: [] },
    { op: 'resolve', kind: 'resolveIceServers', index: 0, value: [] },
  ]),
  await relayScenario('the viewer leaving drops a ready still resolving', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    rs('r1', CLIENT_VALID.ready),
    { op: 'viewerLeft', client: R, session: 'sess_1' },
    { op: 'resolve', kind: 'resolveIceServers', index: 0, value: [] },
  ]),
  await relayScenario('an ice server lookup that fails ends the ready with its error', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    rs('r1', CLIENT_VALID.ready),
    { op: 'reject', kind: 'resolveIceServers', index: 0, message: 'no turn' },
  ]),
  await relayScenario('a screen ready is authorized for the connection that delivered it, twice', [
    rs('r1', CLIENT_VALID['ready-screen']),
    { op: 'resolve', kind: 'screenAuthorized', index: 0, value: true },
    { op: 'resolve', kind: 'resolveIceServers', index: 0, value: [] },
    { op: 'resolve', kind: 'screenAuthorized', index: 1, value: true },
    { op: 'resolve', kind: 'forward', index: 0 },
  ]),
  await relayScenario('a screen ready that is not allowed is refused', [
    rs('r1', CLIENT_VALID['ready-screen']),
    { op: 'resolve', kind: 'screenAuthorized', index: 0, value: false },
  ]),
  await relayScenario('a screen ready allowed first and denied after the ice servers is refused', [
    rs('r1', CLIENT_VALID['ready-screen']),
    { op: 'resolve', kind: 'screenAuthorized', index: 0, value: true },
    { op: 'resolve', kind: 'resolveIceServers', index: 0, value: [] },
    { op: 'resolve', kind: 'screenAuthorized', index: 1, value: false },
  ]),
  await relayScenario('connectionRemoved cancels the screen readys still resolving and no others', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    rs('r1', CLIENT_VALID['ready-screen']),
    rs('r2', CLIENT_VALID.ready),
    { op: 'connectionRemoved', client: R },
    { op: 'resolve', kind: 'screenAuthorized', index: 0, value: true },
    { op: 'resolve', kind: 'resolveIceServers', index: 0, value: [] },
    { op: 'resolve', kind: 'forward', index: 0 },
  ]),
  await relayScenario('non-ready signals forward at once; a screen one needs authorization', [
    rs('a1', rb('answer', { sdp: SDP, fingerprints: [fp256] })),
    { op: 'resolve', kind: 'forward', index: 0 },
    rs('a2', rb('answer', { sdp: SDP, fingerprints: [fp256], source: SCREEN })),
    { op: 'resolve', kind: 'screenAuthorized', index: 0, value: false },
    rs('a3', rb('answer', { sdp: SDP, fingerprints: [fp256], source: SCREEN })),
    { op: 'resolve', kind: 'screenAuthorized', index: 1, value: true },
    { op: 'reject', kind: 'forward', index: 1, message: 'window gone' },
  ]),
  await relayScenario('a media-ready is dropped while the take-over awaits its fitted picture', [
    { op: 'set', subscribed: [[R, 'sess_1']], awaitingFit: [[R, 'sess_1']] },
    rs('m1', CLIENT_VALID['media-ready']),
    { op: 'set', subscribed: [[R, 'sess_1']], awaitingFit: [] },
    rs('m2', CLIENT_VALID['media-ready']),
    { op: 'resolve', kind: 'forward', index: 0 },
    rs('m3', { ...CLIENT_VALID['media-ready-screen'] }),
    { op: 'resolve', kind: 'screenAuthorized', index: 0, value: true },
    { op: 'resolve', kind: 'forward', index: 1 },
  ]),
  await relayScenario('the ownership gate: offer, promote, promote-ack, demote, demote-ack', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'send', id: 's1', client: R, raw: DESKTOP_VALID.offer },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'accept', client: R, raw: CLIENT_VALID['promote-ack'] },
    { op: 'send', id: 's2', client: R, raw: DESKTOP_VALID.promote },
    { op: 'accept', client: R, raw: { ...CLIENT_VALID['promote-ack'], inputEpoch: 3 } },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'accept', client: R, raw: CLIENT_VALID['promote-ack'] },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'send', id: 's3', client: R, raw: { ...DESKTOP_VALID.demote, inputEpoch: 3 } },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'accept', client: R, raw: { ...CLIENT_VALID['demote-ack'], inputEpoch: 2 } },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'accept', client: R, raw: CLIENT_VALID['demote-ack'] },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
  ]),
  await relayScenario('an ack of another connection, or before its promote, settles nothing', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    { op: 'send', id: 's1', client: R, raw: DESKTOP_VALID.offer },
    { op: 'accept', client: R, raw: { ...CLIENT_VALID['promote-ack'], connectionId: 'connection-id-0002' } },
    { op: 'accept', client: R, raw: CLIENT_VALID['promote-ack'] },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'send', id: 's2', client: R, raw: { ...DESKTOP_VALID.promote, connectionId: 'connection-id-0002' } },
    { op: 'accept', client: R, raw: CLIENT_VALID['promote-ack'] },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'send', id: 's3', client: R, raw: { ...DESKTOP_VALID.demote, inputEpoch: 5 } },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'accept', client: R, raw: { ...CLIENT_VALID['demote-ack'], inputEpoch: 5 } },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
  ]),
  await relayScenario('a new offer, a close and the viewer leaving give the JPEG back', [
    { op: 'set', subscribed: [[R, 'sess_1']] },
    { op: 'send', id: 's1', client: R, raw: DESKTOP_VALID.offer },
    { op: 'send', id: 's2', client: R, raw: DESKTOP_VALID.promote },
    { op: 'accept', client: R, raw: CLIENT_VALID['promote-ack'] },
    { op: 'send', id: 's3', client: R, raw: offerOut('connection-id-0002') },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'send', id: 's4', client: R, raw: { ...DESKTOP_VALID.promote, connectionId: 'connection-id-0002' } },
    { op: 'accept', client: R, raw: { ...CLIENT_VALID['promote-ack'], connectionId: 'connection-id-0002' } },
    { op: 'send', id: 's5', client: R, raw: { ...DESKTOP_VALID.close, connectionId: CID } },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'send', id: 's6', client: R, raw: { ...DESKTOP_VALID.close, connectionId: 'connection-id-0002' } },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
    { op: 'send', id: 's7', client: R, raw: offerOut('connection-id-0003') },
    { op: 'send', id: 's8', client: R, raw: { ...DESKTOP_VALID.promote, connectionId: 'connection-id-0003' } },
    { op: 'accept', client: R, raw: { ...CLIENT_VALID['promote-ack'], connectionId: 'connection-id-0003' } },
    { op: 'viewerLeft', client: R, session: 'sess_1' },
    { op: 'relayInputAllowed', client: R, session: 'sess_1' },
  ]),
  await relayScenario('send validates a desktop signal and passes the rest through', [
    { op: 'send', id: 's1', client: R, raw: { ...DESKTOP_VALID.offer, inputEpoch: 0 } },
    { op: 'send', id: 's2', client: R, raw: DESKTOP_VALID.geometry },
    { op: 'send', id: 's3', client: R, raw: DESKTOP_VALID.candidate },
    { op: 'send', id: 's4', client: R, raw: { ...DESKTOP_VALID['close-retry'], source: SCREEN } },
    { op: 'send', id: 's5', client: R, raw: 'x' },
  ]),
  await relayScenario('screenDisplays needs the connection authorized', [
    { op: 'screenDisplays', id: 'd1', client: R, origin: 'o1' },
    { op: 'resolve', kind: 'screenAuthorized', index: 0, value: false },
    { op: 'screenDisplays', id: 'd2', client: R, origin: 'o2' },
    { op: 'resolve', kind: 'screenAuthorized', index: 1, value: true },
    { op: 'resolve', kind: 'screenDisplays', index: 0, value: [{ id: 'display-1' }] },
  ]),
];
writeJson(join(stage, 'relay.json'), { domain: 'live-view-relay', recorder, scenarios: relayScenarios });

// ---------------------------------------------------------------------------------------------------------------
// The viewer (per client × source transport state machine).
// ---------------------------------------------------------------------------------------------------------------
async function viewerScenario(name, source, steps) {
  const trace = [];
  const page = { documentId: null, geometry: null, framesSinceCurrent: 0 };
  let clock = 1_000_000;
  let timerSeq = 0;
  const timers = new Map();
  let idSeq = 0;
  const dispatches = [];
  const releases = [];
  const log = (...entry) => trace.push(clone(entry));
  const effects = {
    signal: (signal) => log('signal', signal),
    open: (connection) => log('open', connection),
    answer: (id, sdp) => log('answer', id, sdp),
    candidate: (id, candidate) => log('candidate', id, candidate),
    channelSend: (id, text) => log('channelSend', id, text),
    close: (id) => log('close', id),
    dispatch: (control) =>
      new Promise((resolve, reject) => {
        dispatches.push({ resolve, reject });
        log('dispatch', control);
      }),
    release: (list) =>
      new Promise((resolve) => {
        releases.push({ resolve });
        log('release', list);
      }),
    page: () => page,
    newConnectionId: () => `connection-id-${String(++idSeq).padStart(4, '0')}`,
    now: () => clock,
    setTimer: (run, ms) => {
      const handle = ++timerSeq;
      timers.set(handle, run);
      log('setTimer', handle, ms);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
      log('clearTimer', handle);
    },
    report: (event, data) => log('report', event, data),
    receiverStats: (stats) => log('receiverStats', stats),
    frameSeen: (epoch) => log('frameSeen', epoch),
    helperGrant: (grant) => log('helperGrant', grant),
    helperInstall: (key) => log('helperInstall', key),
    helperCredential: (key, credential) => log('helperCredential', key, credential),
    promoted: () => log('promoted'),
  };
  const viewer = viewerModule.createRemoteWebrtcViewer(source, effects);
  const recorded = [];
  for (const step of steps) {
    const before = trace.length;
    let threw = null;
    try {
      switch (step.op) {
        case 'page':
          page.documentId = step.documentId ?? null;
          page.geometry = step.geometry ?? null;
          page.framesSinceCurrent = step.framesSinceCurrent ?? 0;
          break;
        case 'tick':
          clock += step.ms;
          break;
        case 'ready':
          viewer.ready(step.receiveCodecs, step.iceServers);
          break;
        case 'geometryChanged':
          viewer.geometryChanged();
          break;
        case 'geometryAck':
          viewer.geometryAck(step.generation);
          break;
        case 'signal':
          viewer.signal(shared.parseRemoteWebrtcClientSignal(step.raw));
          break;
        case 'senderOffer':
          viewer.senderOffer(step.connectionId, step.sdp);
          break;
        case 'senderCandidate':
          viewer.senderCandidate(step.connectionId, step.candidate);
          break;
        case 'senderConnected':
          viewer.senderConnected(step.connectionId, step.certificate);
          break;
        case 'senderFailed':
          viewer.senderFailed(step.connectionId, step.reason);
          break;
        case 'channel':
          viewer.channel(step.connectionId, step.text, step.receivedAt);
          break;
        case 'push':
          viewer.push(step.text);
          break;
        case 'fail':
          viewer.fail(step.reason);
          break;
        case 'stop':
          viewer.stop();
          break;
        case 'fireTimer': {
          const run = timers.get(step.handle);
          timers.delete(step.handle);
          if (run) run();
          else log('noTimer', step.handle);
          break;
        }
        case 'dispatchDone':
          if (step.ok) dispatches[step.index].resolve();
          else dispatches[step.index].reject(new Error(step.message ?? 'dispatch failed'));
          break;
        case 'releaseDone':
          releases[step.index].resolve();
          break;
        default:
          throw new Error(`unknown viewer op ${step.op}`);
      }
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    await flush();
    recorded.push({ ...(threw ? { threw } : {}), trace: clone(trace.slice(before)), view: { state: viewer.state, epoch: viewer.epoch, connectionId: viewer.connectionId, generation: viewer.generation } });
  }
  return { name, source, steps, recorded };
}

const C1 = 'connection-id-0001';
const C2 = 'connection-id-0002';
const sig = (type, extra = {}, connectionId = C1, generation = 1, source = SRC) => ({ v: 1, source, connectionId, generation, type, ...extra });
const PAGE = { op: 'page', documentId: 'p1:2', geometry: GEOMETRY, framesSinceCurrent: 1 };
const ready = { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: ICE };
const cert = { fingerprintAlgorithm: 'sha-256', fingerprint: FP256 };
const mediaReady = (extra = {}, connectionId = C1, generation = 1) => ({ op: 'signal', raw: sig('media-ready', { documentId: 'p1:2', geometryGeneration: 1, pixelWidth: 1170, pixelHeight: 2532, ...extra }, connectionId, generation) });
const inputMsg = (seq, control, extra = {}) => JSON.stringify({ v: 1, kind: 'input', epoch: 2, seq, geometryGeneration: 1, sentAt: 100 + seq, control, ...extra });
const point = (phase, button = 'left') => ({ type: 'pointer', documentId: 'p1:2', phase, button, x: 5, y: 6, buttons: phase === 'mouseReleased' ? 0 : 1, modifiers: 0, clickCount: 1 });
const keyc = { type: 'key', documentId: 'p1:2', key: 'a' };
// Up to `connected`: ready, offer, answer, DTLS.
const toConnected = [
  PAGE,
  { op: 'geometryChanged' },
  { op: 'geometryAck', generation: 1 },
  ready,
  { op: 'senderOffer', connectionId: C1, sdp: SDP },
  { op: 'signal', raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }) },
  { op: 'senderConnected', connectionId: C1, certificate: cert },
];
const toPromoting = [...toConnected, mediaReady()];
const toWebrtc = [...toPromoting, { op: 'signal', raw: sig('promote-ack', { inputEpoch: 2 }) }];
const toDemoting = [...toWebrtc, { op: 'fail', reason: 'channel-failed' }];

const viewerScenarios = [
  await viewerScenario('the happy path: ready, offer, answer, dtls, media-ready, promote-ack', SRC, [
    ...toWebrtc,
    { op: 'push', text: '{"v":1,"kind":"x"}' },
    { op: 'senderCandidate', connectionId: C1, candidate: HOST },
    { op: 'signal', raw: sig('candidate', { candidate: HOST }) },
    { op: 'signal', raw: sig('candidate', { candidate: null }) },
    { op: 'senderCandidate', connectionId: C1, candidate: null },
    { op: 'stop' },
  ]),
  await viewerScenario('a ready waits for the locked geometry', SRC, [
    ready,
    { op: 'page', documentId: 'p1:2', geometry: GEOMETRY, framesSinceCurrent: 0 },
    { op: 'geometryChanged' },
    { op: 'geometryChanged' },
    { op: 'senderOffer', connectionId: C1, sdp: SDP },
    { op: 'senderOffer', connectionId: C1, sdp: SDP },
  ]),
  await viewerScenario('an offer with no fingerprint, or without a geometry, fails the attempt', SRC, [
    PAGE,
    ready,
    { op: 'senderOffer', connectionId: C1, sdp: 'v=0\r\n' },
    { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: [] },
    { op: 'senderOffer', connectionId: 'connection-id-9999', sdp: SDP },
  ]),
  await viewerScenario('the negotiation timeout falls back to the relay view for good', SRC, [
    PAGE,
    ready,
    { op: 'fireTimer', handle: 1 },
    ready,
    { op: 'geometryChanged' },
  ]),
  await viewerScenario('a certificate that is not the answered fingerprint ends the attempt', SRC, [
    PAGE,
    ready,
    { op: 'senderOffer', connectionId: C1, sdp: SDP },
    { op: 'senderConnected', connectionId: C1, certificate: cert },
    { op: 'signal', raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }) },
    { op: 'signal', raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }) },
    { op: 'senderConnected', connectionId: C1, certificate: { fingerprintAlgorithm: 'sha-256', fingerprint: hex(32, 9) } },
    ready,
  ]),
  await viewerScenario('an answer before the offer, or for another connection, is ignored', SRC, [
    PAGE,
    ready,
    { op: 'signal', raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }) },
    { op: 'senderOffer', connectionId: C1, sdp: SDP },
    { op: 'signal', raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }, C2) },
    { op: 'signal', raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }, C1, 2) },
    { op: 'signal', raw: sig('candidate', { candidate: HOST }, C2) },
    { op: 'signal', raw: sig('candidate', { candidate: HOST }) },
  ]),
  await viewerScenario('media-ready promotes only for the current document, geometry and a delivered frame', SRC, [
    ...toConnected,
    mediaReady({ documentId: 'p9:9' }),
    mediaReady({ geometryGeneration: 2 }),
    mediaReady({ pixelWidth: 1000 }),
    mediaReady({ pixelHeight: 2000 }),
    { op: 'page', documentId: 'p1:2', geometry: GEOMETRY, framesSinceCurrent: 0 },
    mediaReady(),
    { op: 'page', documentId: 'p1:2', geometry: null, framesSinceCurrent: 1 },
    mediaReady(),
    PAGE,
    mediaReady({}, C2),
    mediaReady(),
    mediaReady(),
  ]),
  await viewerScenario('media-ready needs the geometry acknowledged', SRC, [
    PAGE,
    { op: 'geometryChanged' },
    ready,
    { op: 'senderOffer', connectionId: C1, sdp: SDP },
    { op: 'signal', raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }) },
    { op: 'senderConnected', connectionId: C1, certificate: cert },
    mediaReady(),
    { op: 'geometryAck', generation: 7 },
    mediaReady(),
    { op: 'geometryAck', generation: 1 },
    mediaReady(),
  ]),
  await viewerScenario('channel input is held until the promote-ack, then applied in order', SRC, [
    ...toPromoting,
    { op: 'channel', connectionId: C1, text: inputMsg(1, point('mousePressed')), receivedAt: 1_000_050 },
    { op: 'channel', connectionId: C1, text: inputMsg(1, point('mousePressed')), receivedAt: 1_000_051 },
    { op: 'channel', connectionId: C1, text: inputMsg(2, point('mouseReleased')), receivedAt: 1_000_052 },
    { op: 'channel', connectionId: C1, text: inputMsg(3, keyc, { epoch: 1 }), receivedAt: 1_000_053 },
    { op: 'signal', raw: sig('promote-ack', { inputEpoch: 1 }) },
    { op: 'signal', raw: sig('promote-ack', { inputEpoch: 2 }) },
    { op: 'tick', ms: 7 },
    { op: 'dispatchDone', index: 0, ok: true },
    { op: 'tick', ms: 3 },
    { op: 'dispatchDone', index: 1, ok: true },
    { op: 'channel', connectionId: C1, text: inputMsg(4, keyc), receivedAt: 1_000_070 },
    { op: 'dispatchDone', index: 2, ok: false, message: 'refused' },
    { op: 'channel', connectionId: C1, text: inputMsg(5, keyc), receivedAt: 1_000_071 },
    { op: 'channel', connectionId: C1, text: inputMsg(2, keyc), receivedAt: 1_000_072 },
    { op: 'dispatchDone', index: 3, ok: true },
  ]),
  await viewerScenario('coordinate input needs the current acknowledged geometry generation', SRC, [
    ...toWebrtc,
    { op: 'channel', connectionId: C1, text: inputMsg(1, point('mouseMoved', 'none'), { geometryGeneration: 2 }), receivedAt: 1_000_050 },
    { op: 'channel', connectionId: C1, text: inputMsg(2, { type: 'wheel', documentId: 'p1:2', x: 1, y: 2, deltaX: 0, deltaY: 5 }), receivedAt: 1_000_051 },
    { op: 'channel', connectionId: C1, text: inputMsg(3, { type: 'text', documentId: 'p1:2', text: 'hi' }, { geometryGeneration: 9 }), receivedAt: 1_000_052 },
    { op: 'dispatchDone', index: 0, ok: true },
    { op: 'dispatchDone', index: 1, ok: true },
  ]),
  await viewerScenario('a demotion releases the buttons the channel pressed and drops later input', SRC, [
    ...toWebrtc,
    { op: 'channel', connectionId: C1, text: inputMsg(1, point('mousePressed')), receivedAt: 1_000_050 },
    { op: 'channel', connectionId: C1, text: inputMsg(2, point('mousePressed', 'right')), receivedAt: 1_000_051 },
    { op: 'channel', connectionId: C1, text: inputMsg(3, keyc), receivedAt: 1_000_052 },
    { op: 'dispatchDone', index: 0, ok: true },
    { op: 'fail', reason: 'channel-failed' },
    { op: 'dispatchDone', index: 1, ok: true },
    { op: 'releaseDone', index: 0 },
    { op: 'signal', raw: sig('demote-ack', { inputEpoch: 3 }) },
    { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: [] },
  ]),
  await viewerScenario('demote waits for the ack and closes at the ack window', SRC, [
    ...toDemoting,
    { op: 'fireTimer', handle: 2 },
    { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: ICE },
    { op: 'senderOffer', connectionId: 'connection-id-0002', sdp: SDP },
  ]),
  await viewerScenario('a demote-ack closes the connection and allows another attempt', SRC, [
    ...toDemoting,
    { op: 'signal', raw: sig('demote-ack', { inputEpoch: 2 }) },
    { op: 'signal', raw: sig('demote-ack', { inputEpoch: 3 }) },
    ready,
    { op: 'senderOffer', connectionId: C2, sdp: SDP },
  ]),
  await viewerScenario('a new ready supersedes a live connection, in each live state', SRC, [
    ...toConnected,
    { op: 'ready', receiveCodecs: ['video/H264'], iceServers: [] },
    { op: 'senderOffer', connectionId: C2, sdp: SDP },
    { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: [] },
  ]),
  await viewerScenario('a new ready while webrtc owns the view demotes it and then starts the held ready', SRC, [
    ...toWebrtc,
    { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: ICE },
    { op: 'signal', raw: sig('demote-ack', { inputEpoch: 3 }) },
    { op: 'senderOffer', connectionId: C2, sdp: SDP },
  ]),
  await viewerScenario('a sender failure before promotion falls back; after it, demotes', SRC, [
    ...toConnected,
    { op: 'senderFailed', connectionId: C2, reason: 'ice-failed' },
    { op: 'senderFailed', connectionId: C1, reason: 'dtls-failed' },
    ready,
    { op: 'geometryChanged' },
  ]),
  await viewerScenario('a phone close ends the connection; its reason is the demotion reason', SRC, [
    ...toWebrtc,
    { op: 'signal', raw: sig('close', { reason: 'ice-failed', detail: 'gone' }) },
    { op: 'signal', raw: sig('demote-ack', { inputEpoch: 3 }) },
    ready,
  ]),
  await viewerScenario('stop closes the viewer from every state', SRC, [
    ...toWebrtc,
    { op: 'channel', connectionId: C1, text: inputMsg(1, point('mousePressed')), receivedAt: 1_000_050 },
    { op: 'stop' },
    { op: 'dispatchDone', index: 0, ok: true },
    { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: [] },
    { op: 'stop' },
  ]),
  await viewerScenario('stop while promoting and while negotiating', SRC, [...toPromoting, { op: 'stop' }]),
  await viewerScenario('stop while negotiating', SRC, [PAGE, ready, { op: 'stop' }]),
  await viewerScenario('stop before any attempt, with a held ready', SRC, [ready, { op: 'stop' }, { op: 'geometryChanged' }]),
  await viewerScenario('channel messages: stats, junk, screen kinds and another connection', SRC, [
    ...toWebrtc,
    { op: 'channel', connectionId: C1, text: JSON.stringify(CHANNEL_VALID.stats), receivedAt: 1 },
    { op: 'channel', connectionId: C2, text: 'x', receivedAt: 1 },
    { op: 'channel', connectionId: C1, text: JSON.stringify(CHANNEL_VALID['screen-frame-seen']), receivedAt: 2 },
  ]),
  await viewerScenario('a channel message that does not parse ends the connection', SRC, [...toWebrtc, { op: 'channel', connectionId: C1, text: 'not json', receivedAt: 1 }]),
  await viewerScenario('a screen input to a browser viewer ends the connection', SRC, [...toWebrtc, { op: 'channel', connectionId: C1, text: JSON.stringify(CHANNEL_VALID['screen-input']), receivedAt: 1 }]),
  await viewerScenario('a screen-helper-enroll to a browser viewer ends the connection', SRC, [
    ...toWebrtc,
    { op: 'channel', connectionId: C1, text: JSON.stringify({ v: 1, kind: 'screen-helper-enroll', publicKey: 'k' }), receivedAt: 1 },
  ]),
  await viewerScenario('channel messages before promotion are ignored', SRC, [
    ...toConnected,
    { op: 'channel', connectionId: C1, text: inputMsg(1, keyc), receivedAt: 1 },
    { op: 'push', text: 'early' },
  ]),
  await viewerScenario('held input past the budget ends the connection', SRC, [
    ...toPromoting,
    ...Array.from({ length: budget.REMOTE_CLIENT_PENDING_FRAMES + 1 }, (_, i) => ({ op: 'channel', connectionId: C1, text: inputMsg(i + 1, keyc), receivedAt: 1_000_100 + i })),
  ]),
  await viewerScenario('queued input past the budget ends the connection', SRC, [
    ...toWebrtc,
    ...Array.from({ length: budget.REMOTE_CLIENT_PENDING_FRAMES + 3 }, (_, i) => ({ op: 'channel', connectionId: C1, text: inputMsg(i + 1, keyc), receivedAt: 1_000_100 + i })),
  ]),
  await viewerScenario('geometry changes are signalled to the phone and a new viewer gets the lock first', SRC, [
    { op: 'geometryChanged' },
    PAGE,
    { op: 'geometryChanged' },
    { op: 'page', documentId: 'p1:2', geometry: { ...GEOMETRY, generation: 2, pixelWidth: 800, pixelHeight: 600 }, framesSinceCurrent: 0 },
    { op: 'geometryChanged' },
    { op: 'geometryAck', generation: 2 },
    { op: 'geometryAck', generation: 1 },
  ]),
  await viewerScenario('an offer is only accepted once, in negotiating', SRC, [PAGE, ready, { op: 'senderOffer', connectionId: C1, sdp: SDP }, { op: 'senderOffer', connectionId: C1, sdp: SDP }, { op: 'senderCandidate', connectionId: C1, candidate: HOST }, { op: 'senderCandidate', connectionId: C2, candidate: HOST }]),
  await viewerScenario('a failure that came after promotion allows a retry; before it does not', SRC, [
    ...toWebrtc,
    { op: 'fail', reason: 'media-timeout' },
    { op: 'signal', raw: sig('demote-ack', { inputEpoch: 3 }) },
    ready,
    { op: 'senderOffer', connectionId: C2, sdp: SDP },
    { op: 'fail', reason: 'sender-failed' },
    { op: 'ready', receiveCodecs: ['video/VP8'], iceServers: [] },
  ]),
  await viewerScenario('a close from the phone while negotiating', SRC, [PAGE, ready, { op: 'signal', raw: sig('close', { reason: 'unsupported' }) }, ready]),
  await viewerScenario('fail with nothing to fail', SRC, [{ op: 'fail', reason: 'sender-failed' }, PAGE, { op: 'fail', reason: 'sender-failed' }]),
  await viewerScenario('a promote-ack for a stale epoch or state is ignored', SRC, [
    ...toConnected,
    { op: 'signal', raw: sig('promote-ack', { inputEpoch: 1 }) },
    mediaReady(),
    { op: 'signal', raw: sig('promote-ack', { inputEpoch: 1 }) },
    { op: 'signal', raw: sig('promote-ack', { inputEpoch: 2 }) },
    { op: 'signal', raw: sig('promote-ack', { inputEpoch: 2 }) },
  ]),
  await viewerScenario('a ready after a closed viewer, and the connection after a stop', SRC, [PAGE, ready, { op: 'stop' }, { op: 'signal', raw: sig('close', { reason: 'ice-failed' }) }, { op: 'senderFailed', connectionId: C1, reason: 'ice-failed' }]),
];
writeJson(join(stage, 'viewer.json'), { domain: 'live-view-viewer', recorder, scenarios: viewerScenarios });

writeSetManifest(stage, {
  set: 'live-view',
  recorder,
  command: `node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <tree>`,
  identity: exactProductIdentity(tree, NODE_COMMIT),
});
commitStage(stage, finalDir);
console.log(`recorded ${signals.client.length} client, ${signals.desktop.length} desktop, ${signals.channel.length} channel, ${relayScenarios.length} relay and ${viewerScenarios.length} viewer scenarios`);
