#!/usr/bin/env node
// Records, from Node's product at b6f10295a, the phone's live Browser Use view as the relay serves it: the REAL relay-client call
// dispatch (apps/desktop/src/main/remote-relay-client-calls.ts: `browserRemoteStream` with `requiredSessionId` and
// `normalizeRemoteBrowserStreamOptions`, `browserRemoteStreamAck`), the REAL per-client stream pacing
// (apps/desktop/src/main/remote-browser-streams.ts: subscriptions, their 4 s lapse and renewal, the largest options told to the desktop,
// a take-over's fit, the JPEG frames with one in flight, the ack and the 1.5 s resend, the cached newest frame) and the REAL WebRTC relay
// (apps/desktop/src/main/remote-webrtc/relay.ts) wired to them as remote-relay.ts:360-404 wires them (`subscribed`, `awaitingFit`,
// `setImages`, `onDrop` -> `viewerLeft`), for the hand-over of a phone's view to and from WebRTC. The inputs are chosen here; every outcome
// is what Node did.
//
// What is recorded is what crosses the relay's boundary: the reply frame a phone gets for a call, the pushes it gets (`browserRemoteFrame`,
// `browserRemoteWebrtc`), the stream requests the relay sends the desktop (`browserRemote('stream', [sessionId, options])`), and the
// relay's answers to the WebRTC steps and state questions. The relay's calls into the window process (`forward`, `viewerLeft`) are not:
// in the core that window is the core's own live-view host, which has no boundary there.
//
// The product is b6f10295a with `node-patches/node-fix-unpair-keeps-stream.patch` applied (a clear Node bug fixed on both sides: an unpair named the
// credential to streams keyed by connection, so it dropped nothing, and an unpaired connection the relay left open could subscribe again
// and was sent frames and WebRTC signals, also ones whose encryption was under way at the unpair). The tree must be exactly that
// (`nodeTreeIdentity` with `--patch`); the screen-access publisher is the REAL one (remote-screen/screen-access-publisher.ts), wired as the
// patched remote-relay.ts wires it: `allowed` of the streams and the `mayWrite` of both live-view sends are its `viewAllowed`, and an
// unpair records the unpair, then drops the streams of every connection `revokeCredential` names (`revokeClient`). The delivery
// (`sendEncryptedFrame`) is a stand-in that runs the patched order: encrypt (at once, or held by a `hold` step until `release`), then
// ask `mayWrite` in the step that writes.
//
// Time is the recorder's own: `Date.now` and every timer the relay arms go to a virtual clock that moves only by an explicit `advance`
// step and runs due timers in due-time then registration order, one at a time, with the microtasks drained between them.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-browser-streams.mjs --tree <git archive of b6f10295a with the patch applied and node_modules> --patch benchmarks/rust-core/recorders/node-patches/node-fix-unpair-keeps-stream.patch [--only <scenario name>]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only') ?? null;
if (!args.get('patch')) throw new Error('pass --patch benchmarks/rust-core/recorders/node-patches/node-fix-unpair-keeps-stream.patch, the fix the tree carries');
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim();
// Checked before anything is loaded from the tree.
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const recorder = 'benchmarks/rust-core/recorders/record-browser-streams.mjs';
const RECORDER_FILES = [
  recorder,
  'benchmarks/rust-core/recorders/lib/common.mjs',
  'benchmarks/rust-core/recorders/lib/ts-register.mjs',
  'benchmarks/rust-core/recorders/lib/ts-resolve-hooks.mjs',
];
const finalDir = join(FIXTURES_ROOT, 'browser-streams');

// ── the virtual clock and timer queue ──
const CLOCK_START = Date.UTC(2031, 0, 1);
const clock = { now: CLOCK_START, seq: 0, timers: new Map() };
const realSetImmediate = globalThis.setImmediate;
globalThis.setTimeout = (fn, ms) => {
  const id = ++clock.seq;
  const timer = { id, fn, due: clock.now + Math.max(0, ms || 0), seq: id, unref() { return timer; }, ref() { return timer; } };
  clock.timers.set(id, timer);
  return timer;
};
globalThis.clearTimeout = (timer) => void (timer && clock.timers.delete(timer.id));
globalThis.setInterval = () => {
  throw new Error('the browser streams arm no interval');
};
Date.now = () => clock.now;
// Not a wait for time: the world has no I/O and no real timers, so every pending effect is a promise chain, and Node runs the whole
// microtask queue (chains included) before one check-phase turn comes.
const drain = () => new Promise((resolve) => realSetImmediate(resolve));
const advance = async (ms) => {
  const target = clock.now + ms;
  for (;;) {
    let next;
    for (const timer of clock.timers.values()) {
      if (timer.due <= target && (!next || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq))) next = timer;
    }
    if (!next) break;
    clock.now = next.due;
    clock.timers.delete(next.id);
    next.fn();
    await drain();
  }
  clock.now = target;
};

const { createBrowserRemoteStreams } = await importFrom(tree, 'apps/desktop/src/main/remote-browser-streams.ts');
const { createRelayClientCallDispatch } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-client-calls.ts');
const { createRemoteWebrtcRelay } = await importFrom(tree, 'apps/desktop/src/main/remote-webrtc/relay.ts');
const { createScreenAccessPublisher } = await importFrom(tree, 'apps/desktop/src/main/remote-screen/screen-access-publisher.ts');

const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

// ── the inputs ──
const A = 'phone_A';
const B = 'phone_B';
const C = 'phone_C';
const S1 = 'sess_1';
const S2 = 'sess_2';
const jpeg = (label) => Buffer.from(`jpeg bytes of ${label}`).toString('base64');
/** A frame of the desktop's live view of `session` (`DesktopRemoteBrowserStreamFrame`), with a picture unless `image: null`. */
const frame = (session, seq, extra = {}) => {
  const { image = { mimeType: 'image/jpeg', data: jpeg(`${session}#${seq}`) }, ...rest } = extra;
  return {
    frameId: `frame-${seq}`,
    sessionId: session,
    seq,
    documentId: 'p1:1',
    url: 'https://example.test/page',
    title: 'Example page',
    loading: false,
    canGoBack: false,
    canGoForward: true,
    width: 800,
    height: 600,
    viewportWidth: 400,
    viewportHeight: 300,
    ...(image ? { image } : {}),
    ...rest,
  };
};
const FIT = { width: 390, height: 844, deviceScaleFactor: 3 };
const FIT2 = { width: 412, height: 915, deviceScaleFactor: 2.625 };
const stream = (client, session, options) => ({ op: 'call', client, method: 'browserRemoteStream', params: [session, options] });
const ack = (client, session, seq) => ({ op: 'call', client, method: 'browserRemoteStreamAck', params: [session, seq] });
const publish = (f) => ({ op: 'frame', frame: f });
const advanceBy = (ms) => ({ op: 'advance', ms });
const query = (client, session) => ({ op: 'query', client, session });
const leave = (client) => ({ op: 'leave', client });
/** The paired device each phone's connection acts as: phone_A and phone_C are two connections of one device. */
const CREDENTIALS = { [A]: 'cred_1', [B]: 'cred_2', [C]: 'cred_1' };
/** The device's unpair as the patched desktop runs it: recorded (in force), then `revokeClient`'s drop of every connection's streams. */
const unpair = (credential) => ({ op: 'unpair', credential });
/** The device's access ends (recorded, its connections revoked) but its drop never reaches the streams: the send-time refusal alone. */
const revokeOnly = (credential) => ({ op: 'revokeOnly', credential });
/** A phone's raw signal through the relay's `accept` (a `ready` carries no connection reference). */
const phoneRaw = (client, raw) => ({ op: 'accept', client, raw });
const ready = (session) => ({ v: 1, source: { kind: 'browser', sessionId: session }, type: 'ready', receiveCodecs: ['video/VP8', 'video/H264'] });
/** `browserStreams.dispose()`: the relay closing (remote-relay.ts:658, `close`). */
const dispose = () => ({ op: 'dispose' });
/** From here on every push's encryption is held (still running) until `release` completes them, in the order they began. */
const hold = () => ({ op: 'hold' });
const release = () => ({ op: 'release' });
const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 01:08:0F:16:1D:24:2B:32:39:40:47:4E:55:5C:63:6A:71:78:7F:86:8D:94:9B:A2:A9:B0:B7:BE:C5:CC:D3:DA\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const FP = { algorithm: 'sha-256', value: '01:08:0F:16:1D:24:2B:32:39:40:47:4E:55:5C:63:6A:71:78:7F:86:8D:94:9B:A2:A9:B0:B7:BE:C5:CC:D3:DA' };
const GEOMETRY = { generation: 1, cssWidth: 390, cssHeight: 844, deviceScaleFactor: 3, pixelWidth: 1170, pixelHeight: 2532 };
const ref = (session, connectionId = 'connection-id-0001') => ({ v: 1, source: { kind: 'browser', sessionId: session }, connectionId, generation: 1 });
/** A desktop (window) signal to the phone, through the relay's `send`. */
const desktop = (client, session, type, extra = {}) => ({ op: 'send', client, raw: { ...ref(session), type, ...extra } });
/** A phone's signal, through the relay's decode-time `accept`. */
const phone = (client, session, type, extra = {}) => ({ op: 'accept', client, raw: { ...ref(session), type, ...extra } });
const offer = (client, session) => desktop(client, session, 'offer', { sdp: SDP, fingerprints: [FP], iceServers: [], iceTransportPolicy: 'all', geometry: GEOMETRY, inputEpoch: 1 });

const SCENARIOS = [
  ['the options and the session id are checked as Node checks them', [
    stream(A, '', { maxWidth: 800, maxHeight: 600 }),
    stream(A, '   ', { maxWidth: 800, maxHeight: 600 }),
    stream(A, 'sess 1', { maxWidth: 800, maxHeight: 600 }),
    stream(A, 's'.repeat(257), { maxWidth: 800, maxHeight: 600 }),
    stream(A, S1, 5),
    stream(A, S1, 'big'),
    stream(A, S1, []),
    stream(A, S1, {}),
    stream(A, S1, { maxWidth: '800', maxHeight: 600 }),
    stream(A, S1, { maxWidth: 63, maxHeight: 600 }),
    stream(A, S1, { maxWidth: 4097, maxHeight: 600 }),
    stream(A, S1, { maxWidth: 800 }),
    stream(A, S1, { maxWidth: 800, maxHeight: 63.9 }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: 'phone' }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: 3 }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: [] }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: { width: 199, height: 844, deviceScaleFactor: 3 } }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: { width: 390, height: 3841, deviceScaleFactor: 3 } }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: { width: 390.5, height: 844, deviceScaleFactor: 3 } }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: { width: 390, height: 844, deviceScaleFactor: 0.4 } }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: { width: 390, height: 844, deviceScaleFactor: 4.5 } }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: { width: 390, height: 844, deviceScaleFactor: '3' } }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: { width: 390, height: 844 } }),
    query(A, S1),
    stream(A, ` ${S1} `, { maxWidth: 800.4, maxHeight: 600.5, extra: true }),
    query(A, S1),
    stream(A, S1, { maxWidth: 64, maxHeight: 4096, fit: { width: 200, height: 3840, deviceScaleFactor: 0.5, extra: 1 } }),
    stream(A, S1, null),
    query(A, S1),
    stream(A, S1, null),
  ]],
  ['a subscription lapses 4 s after its last renewal', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    advanceBy(3999),
    query(A, S1),
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    advanceBy(3999),
    query(A, S1),
    advanceBy(1),
    query(A, S1),
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    advanceBy(4000),
    query(A, S1),
    stream(A, S1, { maxWidth: 1000, maxHeight: 700 }),
    advanceBy(3000),
    stream(B, S1, { maxWidth: 500, maxHeight: 900 }),
    advanceBy(1000),
    query(A, S1),
    query(B, S1),
    advanceBy(3000),
    query(B, S1),
  ]],
  ['the largest options of the subscribers go to the desktop as they come and go', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    stream(B, S1, { maxWidth: 1200, maxHeight: 400 }),
    stream(C, S1, { maxWidth: 300, maxHeight: 900 }),
    stream(A, S2, { maxWidth: 640, maxHeight: 480 }),
    stream(B, S1, { maxWidth: 200, maxHeight: 200 }),
    stream(B, S1, null),
    stream(C, S2, { maxWidth: 1920, maxHeight: 1080 }),
    advanceBy(2000),
    stream(A, S1, { maxWidth: 700, maxHeight: 500 }),
    advanceBy(2000),
    stream(C, S1, null),
    stream(A, S2, null),
    advanceBy(2000),
    stream(C, S2, null),
    stream(A, S1, null),
  ]],
  ['a take-over is fitted once and shown no picture until its fitted one', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
    query(A, S1),
    stream(B, S1, { maxWidth: 900, maxHeight: 500, fit: FIT2 }),
    stream(C, S1, { maxWidth: 300, maxHeight: 300 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2, { fitSettled: true, image: null })),
    ack(C, S1, 1),
    publish(frame(S1, 3, { fitSettled: true })),
    query(A, S1),
    query(B, S1),
    ack(A, S1, 1),
    ack(B, S1, 1),
    ack(C, S1, 2),
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: null }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT2 }),
    query(A, S1),
    publish(frame(S1, 4, { fitFailed: true })),
    query(A, S1),
    stream(B, S1, null),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: null }),
    stream(C, S1, null),
    stream(A, S1, null),
  ]],
  ['one frame in flight: the newest goes next, after its ack', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    publish(frame(S1, 3)),
    ack(A, S1, 2),
    ack(A, S2, 1),
    ack(A, S1, '1'),
    ack(A, S1, 1),
    publish(frame(S1, 4, { image: null, title: 'Facts only' })),
    ack(A, S1, 3),
    publish(frame(S1, 5)),
    publish(frame(S1, 6, { image: null, loading: true })),
    ack(A, S1, 5),
    ack(A, S1, 6),
    publish(frame(S1, 7, { image: null })),
    publish(frame(S2, 1)),
    stream(A, S1, null),
    publish(frame(S1, 8)),
  ]],
  ['a frame not acknowledged goes again after 1.5 s', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    advanceBy(1000),
    publish(frame(S1, 2)),
    advanceBy(499),
    publish(frame(S1, 3)),
    advanceBy(1),
    advanceBy(1499),
    ack(A, S1, 2),
    advanceBy(1),
    ack(A, S1, 3),
    publish(frame(S1, 4)),
    advanceBy(1500),
    publish(frame(S1, 5)),
    ack(A, S1, 4),
  ]],
  ['a subscriber joining mid-stream gets the newest frame', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2, { image: null, title: 'Second' })),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    ack(A, S1, 1),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 3, { image: null, fitSettled: true })),
    stream(C, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
    stream(A, S2, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 4, { fitSettled: true })),
    stream(C, S1, null),
    stream(C, S1, { maxWidth: 800, maxHeight: 600 }),
  ]],
  ['the view goes to WebRTC and comes back', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    ack(A, S1, 1),
    ack(B, S1, 1),
    offer(A, S1),
    desktop(A, S1, 'promote', { inputEpoch: 2, geometryGeneration: 1 }),
    phone(A, S1, 'promote-ack', { inputEpoch: 2 }),
    publish(frame(S1, 2)),
    ack(A, S1, 2),
    publish(frame(S1, 3, { image: null, title: 'Facts while WebRTC owns the view' })),
    phone(A, S1, 'promote-ack', { inputEpoch: 2 }),
    desktop(A, S1, 'demote', { inputEpoch: 3, reason: 'channel-failed' }),
    ack(A, S1, 3),
    phone(A, S1, 'demote-ack', { inputEpoch: 3 }),
    publish(frame(S1, 4)),
    ack(A, S1, 4),
    offer(A, S1),
    desktop(A, S1, 'promote', { inputEpoch: 5, geometryGeneration: 1 }),
    phone(A, S1, 'promote-ack', { inputEpoch: 5 }),
    publish(frame(S1, 5)),
    desktop(A, S1, 'close', { reason: 'ice-failed' }),
    ack(A, S1, 5),
    offer(A, S1),
    desktop(A, S1, 'promote', { inputEpoch: 6, geometryGeneration: 1 }),
    phone(A, S1, 'promote-ack', { inputEpoch: 6 }),
    stream(A, S1, null),
    phone(A, S1, 'promote-ack', { inputEpoch: 6 }),
    phone(C, S1, 'promote-ack', { inputEpoch: 6 }),
  ]],
  ['a demote or a close gives the phone the frame withheld while WebRTC owned the view', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    ack(A, S1, 1),
    offer(A, S1),
    desktop(A, S1, 'promote', { inputEpoch: 2, geometryGeneration: 1 }),
    phone(A, S1, 'promote-ack', { inputEpoch: 2 }),
    publish(frame(S1, 2)),
    ack(A, S1, 2),
    desktop(A, S1, 'demote', { inputEpoch: 3, reason: 'channel-failed' }),
    ack(A, S1, 2),
    phone(A, S1, 'demote-ack', { inputEpoch: 3 }),
    offer(A, S1),
    desktop(A, S1, 'promote', { inputEpoch: 4, geometryGeneration: 1 }),
    phone(A, S1, 'promote-ack', { inputEpoch: 4 }),
    publish(frame(S1, 3)),
    ack(A, S1, 3),
    desktop(A, S1, 'close', { reason: 'ice-failed' }),
    ack(A, S1, 3),
  ]],
  ['a phone that left is dropped at the next frame or its lapse', [
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    stream(A, S2, { maxWidth: 640, maxHeight: 480 }),
    leave(A),
    query(A, S1),
    publish(frame(S1, 1)),
    query(A, S1),
    query(A, S2),
    advanceBy(4000),
    query(A, S2),
    query(B, S1),
  ]],
  ['a phone that left with a frame in flight is sent nothing more', [
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    leave(A),
    advanceBy(1500),
    publish(frame(S1, 3)),
    query(A, S1),
    advanceBy(1500),
    query(B, S1),
  ]],
  ['an unpaired phone is dropped at once, its frame in flight and its resend with it', [
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    stream(A, S2, { maxWidth: 640, maxHeight: 480 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    unpair('cred_1'),
    query(A, S1),
    query(A, S2),
    publish(frame(S1, 3)),
    advanceBy(1500),
    ack(A, S1, 1),
    query(B, S1),
  ]],
  ['an unpaired phone that alone streams a session stops the desktop view', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    unpair('cred_1'),
    query(A, S1),
    publish(frame(S1, 3)),
    advanceBy(1500),
  ]],
  // The relay refused the revocation, so the connections stay open: they may not subscribe again, a WebRTC `ready` and every other signal
  // of theirs is refused, and a window signal or a frame for them goes nowhere.
  ['an unpaired device whose connections stay open is refused and sent nothing', [
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    stream(C, S1, { maxWidth: 640, maxHeight: 480 }),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    offer(A, S1),
    unpair('cred_1'),
    query(A, S1),
    query(C, S1),
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    stream(C, S2, { maxWidth: 640, maxHeight: 480 }),
    phoneRaw(A, ready(S1)),
    phone(A, S1, 'answer', { sdp: SDP, fingerprints: [FP] }),
    offer(A, S1),
    desktop(A, S1, 'close', { reason: 'ice-failed' }),
    publish(frame(S1, 2)),
    ack(A, S1, 1),
    advanceBy(1500),
    stream(A, S1, null),
    query(B, S1),
  ]],
  // The patched delivery asks again at the write, after the encryption: a frame and a window signal for the phone are being encrypted
  // when its device is unpaired, then their encryption completes. Neither is written; the signal's send still resolves.
  ['an unpair while a frame and a signal for the phone are encrypted: neither is written', [
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    hold(),
    publish(frame(S1, 1)),
    offer(A, S1),
    unpair('cred_1'),
    release(),
    query(A, S1),
  ]],
  ['a missed drop: an unpaired phone still subscribed is sent no frame and no resend', [
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    revokeOnly('cred_1'),
    query(A, S1),
    publish(frame(S1, 3)),
    advanceBy(1500),
    ack(B, S1, 1),
    phoneRaw(A, ready(S1)),
    offer(A, S1),
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    advanceBy(2500),
    query(B, S1),
  ]],
  ['the relay closing ends every subscription and every resend', [
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    stream(A, S2, { maxWidth: 640, maxHeight: 480 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    dispose(),
    query(A, S1),
    query(B, S1),
    query(A, S2),
    publish(frame(S1, 3)),
    advanceBy(1500),
  ]],
  ['a stale ack after a resend is ignored', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    advanceBy(1500),
    ack(A, S1, 1),
    publish(frame(S1, 3)),
    advanceBy(1499),
    ack(A, S1, 2),
    ack(A, S1, 2),
    advanceBy(1500),
  ]],
  ['a resend pending when the phone unsubscribes is not sent', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    stream(A, S1, null),
    advanceBy(1500),
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    advanceBy(1500),
  ]],
  ['a phone joining during a pending resend gets the newest frame at once', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    advanceBy(700),
    stream(B, S1, { maxWidth: 900, maxHeight: 700 }),
    advanceBy(799),
    publish(frame(S1, 3)),
    advanceBy(1),
    ack(B, S1, 2),
    advanceBy(1500),
  ]],
  ['a fit that failed, then a renewal: the take-over watches unfitted', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
    publish(frame(S1, 1, { fitFailed: true })),
    query(A, S1),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
    query(A, S1),
    ack(A, S1, 1),
    publish(frame(S1, 2)),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: null }),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT2 }),
    query(A, S1),
    ack(A, S1, 2),
    publish(frame(S1, 3, { fitSettled: true })),
    query(A, S1),
  ]],
  // The orders the core's interleaving tests force (live_view_streams_replay.rs `GATED`): each pair of steps as Node runs it, one
  // after the other on its one thread.
  ['gate: a lapse, then a fresh subscribe', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    advanceBy(4000),
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
  ]],
  ['gate: a resend, then an unsubscribe', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    advanceBy(1500),
    stream(A, S1, null),
  ]],
  ['gate: an ack, then a newer frame resent', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    ack(A, S1, 1),
    publish(frame(S1, 3)),
    advanceBy(1500),
  ]],
  ['gate: a resend, then a phone joins', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600 }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2)),
    advanceBy(1500),
    stream(B, S1, { maxWidth: 900, maxHeight: 700 }),
  ]],
  ['gate: a fit failure, then a renewal', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
    publish(frame(S1, 1, { fitFailed: true })),
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
  ]],
  // One phone's subscription lapses (its view leaves the relay), then another phone's WebRTC view takes over its images.
  ['gate: a lapse, then a promote-ack', [
    stream(B, S1, { maxWidth: 800, maxHeight: 600 }),
    advanceBy(2000),
    stream(A, S1, { maxWidth: 1200, maxHeight: 900 }),
    offer(A, S1),
    desktop(A, S1, 'promote', { inputEpoch: 2, geometryGeneration: 1 }),
    advanceBy(2000),
    phone(A, S1, 'promote-ack', { inputEpoch: 2 }),
  ]],
  ['a settled metadata frame over a settled picture ends a take-over wait', [
    stream(A, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
    publish(frame(S1, 1)),
    publish(frame(S1, 2, { fitSettled: true })),
    publish(frame(S1, 3, { fitSettled: true, image: null, title: 'Settled facts' })),
    query(A, S1),
    ack(A, S1, 1),
    query(A, S1),
    stream(C, S1, { maxWidth: 800, maxHeight: 600, fit: FIT2 }),
    query(C, S1),
    publish(frame(S1, 4, { image: null, title: 'Unsettled facts' })),
    stream(B, S1, { maxWidth: 800, maxHeight: 600, fit: FIT }),
    query(B, S1),
  ]],
];

// ── one scenario's world ──
async function record(name, steps) {
  clock.now = CLOCK_START;
  clock.timers.clear();
  const live = new Set([A, B, C]);
  let effects = [];
  const log = (...entry) => effects.push(clone(entry));
  // The relay's client registry (remote-relay-clients.ts): one connection object per phone, E2EE-established, under its credential.
  const registry = new Map([A, B, C].map((client) => [client, { credentialId: CREDENTIALS[client], channel: {} }]));
  // The unpairs in force (desktop-service.ts `unpairPending`): recorded before `revokeClient` runs, never confirmed here.
  const unpaired = new Set();
  // Encryptions held by a `hold` step: each completes, in the order it began, at the `release` step.
  let held = null;
  // `sendEncryptedFrame` as the patched delivery runs it (remote-relay-delivery.ts): a client no longer in the registry gets nothing
  // (:90-93); the payload is encrypted (at once, or held), then `mayWrite` is asked in the same step as the write.
  const deliver = (clientId, payload, mayWrite) => {
    if (!live.has(clientId)) return Promise.resolve();
    const sealed = clone(payload);
    const write = () => {
      if (!mayWrite || mayWrite()) log('push', clientId, sealed);
    };
    if (!held) {
      write();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      held.push(() => {
        write();
        resolve();
      });
    });
  };
  // The live view's two sends, as the patched remote-relay.ts passes them: asked again at the write.
  const mayView = (clientId) => () => access.viewAllowed(clientId);
  const access = createScreenAccessPublisher({
    client: (clientId) => registry.get(clientId),
    clients: () => registry.entries(),
    unpaired: (credentialId) => unpaired.has(credentialId),
    label: () => 'Paired phone',
    // The window's screen access (excluded: no boundary in the core).
    send: async () => undefined,
  });
  for (const client of registry.values()) access.admitted(client);
  const streams = createBrowserRemoteStreams({
    isLive: (clientId) => live.has(clientId),
    send: (clientId, payload) => deliver(clientId, payload, mayView(clientId)),
    request: async (sessionId, options) => log('request', sessionId, options),
    onDrop: (clientId, sessionId) => webrtc.viewerLeft(clientId, sessionId),
    allowed: (clientId) => access.viewAllowed(clientId),
  });
  // As remote-relay.ts:371-404 builds it, over scripted window calls (not recorded: the core's counterpart has no boundary there).
  const webrtc = createRemoteWebrtcRelay({
    subscribed: (clientId, sessionId) => streams.subscribed(clientId, sessionId),
    awaitingFit: (clientId, sessionId) => streams.awaitingFit(clientId, sessionId),
    screenAuthorized: async () => false,
    screenDisplays: async () => [],
    setImages: (clientId, sessionId, enabled) => streams.setImages(clientId, sessionId, enabled),
    resolveIceServers: async () => [],
    forward: async () => undefined,
    viewerLeft: async () => undefined,
    send: (clientId, payload) => deliver(clientId, payload, mayView(clientId)),
  });
  const dispatch = createRelayClientCallDispatch({
    host: {},
    methods: {},
    attached: () => true,
    live: () => true,
    sendEncryptedFrame: async (clientId, payload) => log('reply', clientId, payload),
    acknowledgePaintProbe: () => null,
    resyncClient: () => undefined,
    recordCall: () => undefined,
    browserStreams: streams,
    browserTabs: { watch: async () => [] },
    webrtc,
  });
  const recorded = [];
  let id = 0;
  for (const step of steps) {
    effects = [];
    switch (step.op) {
      case 'call': {
        const frameOut = step.method === 'browserRemoteStream' ? { id: ++id, method: step.method, params: step.params } : { method: step.method, params: step.params };
        const outcome = await dispatch(step.client, {}, frameOut, JSON.stringify(frameOut).length);
        if (outcome.execution) await outcome.execution;
        break;
      }
      case 'frame':
        streams.publish(clone(step.frame));
        break;
      case 'advance':
        await advance(step.ms);
        break;
      case 'leave':
        // The registry's removal (remote-relay.ts `onRemoved`).
        live.delete(step.client);
        registry.delete(step.client);
        webrtc.connectionRemoved(step.client);
        access.removed(step.client);
        break;
      case 'unpair':
        unpaired.add(step.credential);
        for (const connectionId of access.revokeCredential(step.credential)) streams.dropClient(connectionId);
        break;
      case 'revokeOnly':
        unpaired.add(step.credential);
        access.revokeCredential(step.credential);
        break;
      case 'dispose':
        streams.dispose();
        break;
      case 'query':
        log('state', { subscribed: streams.subscribed(step.client, step.session), awaitingFit: streams.awaitingFit(step.client, step.session) });
        break;
      case 'accept':
        try {
          webrtc.accept(step.client, clone(step.raw));
          log('accepted');
        } catch (error) {
          log('refused', error instanceof Error ? error.message : String(error));
        }
        break;
      case 'send': {
        // Its answer is recorded when the send settles: at once, or at the `release` of an encryption held.
        const settled = webrtc.send(step.client, clone(step.raw)).then(
          () => log('sent'),
          (error) => log('refused', error instanceof Error ? error.message : String(error))
        );
        if (!held) await settled;
        break;
      }
      case 'hold':
        held = [];
        break;
      case 'release': {
        const waiting = held;
        held = null;
        for (const complete of waiting) complete();
        break;
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
    await drain();
    recorded.push(effects);
  }
  return { name, steps, recorded };
}

const chosen = only ? SCENARIOS.filter(([name]) => name === only) : SCENARIOS;
if (!chosen.length) throw new Error(`no scenario named ${only}`);
const scenarios = [];
for (const [name, steps] of chosen) scenarios.push(await record(name, steps));
if (only) {
  // One scenario, for working on it: printed, the committed fixture untouched.
  console.log(JSON.stringify(scenarios[0], null, 2));
} else {
  const excluded = [
    {
      what: "the relay's calls into the window process: `forward` (remote-relay.ts:383-399, the window's `webrtcSignal`), `viewerLeft` (:400-401, `webrtcViewerLeft`), `screenAuthorized`, `screenDisplays`, `resolveIceServers`, and the screen-access publisher's `send` (the window's `screenAccess`)",
      why: "scripted here (`forward`/`viewerLeft`/`send` resolve, no screen access, no displays, no ICE servers): in the core that window is the live view's own host (live_view.rs `LiveHost`), with no boundary to compare; its signals are recorded where they leave the relay (`browserRemoteWebrtc` pushes)",
    },
    {
      what: "the relay-client call dispatch's other methods and its host/method table (`host: {}`, `methods: {}`, `browserTabs`)",
      why: 'only the live-view calls (`browserRemoteStream`, `browserRemoteStreamAck`) are driven; nothing else is called',
    },
    {
      what: 'a push to a phone no longer in the relay client registry',
      why: 'not recorded, as `sendEncryptedFrame` delivers none (remote-relay-delivery.ts:90-93): the phone receives nothing',
    },
  ];
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'streams.json'), { domain: 'browser-streams', recorder, clockStart: CLOCK_START, scenarios });
  writeSetManifest(stage, {
    set: 'browser-streams',
    recorder,
    command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <b6f10295a with the patch> --patch ${identity.patch.file}`,
    extra: {
      exact: true,
      recorderSha256: sha256(readFileSync(join(REPO_ROOT, recorder))),
      // Every file of the recorder that decides what is loaded, how TypeScript resolves and how the fixture is written.
      recorderFiles: RECORDER_FILES.map((path) => ({ path, sha256: sha256(readFileSync(join(REPO_ROOT, path))) })),
      excluded,
      replayProjections: [],
      nodeVersion: process.version,
      productCommit: NODE_COMMIT,
      // What the recording holds: the scenarios driven one step at a time, and the sequential runs of the core's forced interleavings.
      inventory: (() => {
        const gates = scenarios.filter((scenario) => scenario.name.startsWith('gate: ')).length;
        const sequential = scenarios.length - gates;
        return {
          scenarios: scenarios.length,
          sequential,
          gates,
          exclusions: excluded.length,
          statement: `${scenarios.length} scenarios: ${sequential} sequential and ${gates} gates (each gate a pair the core forces into its losing interleaving, recorded as the one order Node's single thread runs); ${excluded.length} documented exclusions, listed under \`excluded\`.`,
        };
      })(),
      inputs: {
        file: 'streams.json',
        clockStart: CLOCK_START,
        clients: [A, B, C],
        sessions: [S1, S2],
        scenarios: scenarios.map((scenario) => ({ name: scenario.name, steps: scenario.steps.length })),
      },
    },
    identity,
  });
  commitStage(stage, finalDir);
  console.log(`recorded ${scenarios.length} browser-stream scenarios`);
}
