#!/usr/bin/env node
// Records, from Node's product at b6f10295a, the window-process WebRTC host that owns one viewer per paired client x
// source (apps/desktop/src/main/remote-webrtc/host.ts, with the REAL viewer.ts under it). The sender window, the
// sources, the signal transport and the timers are scripted: the inputs are chosen here, every outcome (sender
// command, signal sent to the relay, source call, report, settle state) is what Node's host did.
//
// host.json   scripted scenarios; the log is every dependency call, in order, per step.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-live-view-host.mjs --tree <git archive of b6f10295a with node_modules>
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, exactProductIdentity, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// The host draws connection ids from randomBytes: a counter instead, so ids are the same in every run.
const nodeCrypto = createRequire(import.meta.url)('node:crypto');
let idSeq = 0;
nodeCrypto.randomBytes = () => ({ toString: () => `connection-id-${String(++idSeq).padStart(4, '0')}` });
syncBuiltinESMExports();

const args = parseArgs();
const tree = resolveTree(args);
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const recorder = 'benchmarks/rust-core/recorders/record-live-view-host.mjs';
const finalDir = join(FIXTURES_ROOT, 'live-view-host');
const stage = stageSet(finalDir);
const { createRemoteWebrtcHost } = await importFrom(tree, 'apps/desktop/src/main/remote-webrtc/host.ts');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const SRC = { kind: 'browser', sessionId: 'sess_1' };
const SRC2 = { kind: 'browser', sessionId: 'sess_2' };
const KEY = 'browser:sess_1';
const KEY2 = 'browser:sess_2';
const hex = (bytes, seed = 1) => Array.from({ length: bytes }, (_, i) => ((i * 7 + seed) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP256 = hex(32);
const fp256 = { algorithm: 'sha-256', value: FP256 };
const SDP = `v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${FP256}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n`;
const HOST = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0 ufrag abcd network-id 1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
const GEOMETRY = { generation: 1, cssWidth: 390, cssHeight: 844, deviceScaleFactor: 3, pixelWidth: 1170, pixelHeight: 2532 };
const GEOMETRY2 = { ...GEOMETRY, generation: 2, pixelWidth: 800, pixelHeight: 600 };
const ICE = [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c' }];
const cert = { fingerprintAlgorithm: 'sha-256', fingerprint: FP256 };
const A = 'client_A';
const B = 'client_B';
const C1 = 'connection-id-0001';
const C2 = 'connection-id-0002';
const sig = (type, extra = {}, connectionId = C1, generation = 1, source = SRC) => ({ v: 1, source, connectionId, generation, type, ...extra });
const readySig = (extra = {}, source = SRC) => ({ v: 1, source, type: 'ready', receiveCodecs: ['video/VP8'], ...extra });
const picture = (data, geometry = GEOMETRY, documentId = 'p1:2') => ({ documentId, geometry, mimeType: 'image/jpeg', data });

// A scenario's world: the host over scripted dependencies, one log, settle handles for what Node left pending.
async function hostScenario(name, steps, options = {}) {
  idSeq = 0;
  const trace = [];
  const log = (...entry) => trace.push(clone(entry));
  const pages = new Map([[KEY, { documentId: null, geometry: null }], [KEY2, { documentId: null, geometry: null }]]);
  const streamed = new Map([[KEY, true], [KEY2, true]]);
  const dispatches = [];
  const resizes = [];
  const sends = [];
  const timers = new Map();
  let timerSeq = 0;
  let clock = 1_000_000;
  let listener = null;
  const sourceFor = (source) => {
    const key = source.kind === 'browser' ? `browser:${source.sessionId}` : 'screen';
    return {
      source,
      start: () => log('source', key, 'start'),
      stop: () => log('source', key, 'stop'),
      page: () => pages.get(key),
      dispatch: (control) => new Promise((resolve, reject) => {
        dispatches.push({ resolve, reject });
        log('source', key, 'dispatch', control);
      }),
      resize: (request) => new Promise((resolve, reject) => {
        resizes.push({ resolve, reject });
        log('source', key, 'resize', request);
      }),
      videoLimit: (limit) => log('source', key, 'videoLimit', limit),
    };
  };
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  globalThis.setTimeout = (run, ms) => {
    const handle = ++timerSeq;
    timers.set(handle, run);
    log('setTimer', handle, ms);
    return { unref() {}, handle };
  };
  globalThis.clearTimeout = (timer) => {
    timers.delete(timer.handle);
    log('clearTimer', timer.handle);
  };
  Date.now = () => clock;
  const host = createRemoteWebrtcHost({
    sender: {
      send: (command) => {
        // The measurement line asks the sender for its statistics; it is a diagnostic, not part of the contract.
        if (command.type === 'stats') return;
        log('sender', command);
      },
      onEvent: (fn) => {
        listener = fn;
      },
    },
    sendSignal: (clientId, signal) =>
      new Promise((resolve, reject) => {
        log('sendSignal', clientId, signal);
        if (options.holdSignals) sends.push({ resolve, reject });
        else resolve(undefined);
      }),
    sources: (source, viewer) => {
      log('resolve', source, viewer);
      const key = source.kind === 'browser' ? `browser:${source.sessionId}` : 'screen';
      if (source.kind !== 'browser' || !streamed.get(key)) return null;
      return sourceFor(source);
    },
    report: (event, data) => log('report', event, data),
  });
  const calls = [];
  const recorded = [];
  try {
    for (const step of steps) {
      const before = trace.length;
      let threw = null;
      try {
        switch (step.op) {
          case 'page':
            pages.set(step.key, { documentId: step.documentId ?? null, geometry: step.geometry ?? null });
            break;
          case 'streamed':
            streamed.set(step.key, step.value);
            break;
          case 'tick':
            clock += step.ms;
            break;
          case 'signal': {
            const call = { state: 'pending' };
            calls.push(call);
            host.signal(step.client, step.raw, step.iceServers).then(
              () => {
                call.state = 'ok';
              },
              (error) => {
                call.state = `threw:${error instanceof Error ? error.message : String(error)}`;
              }
            );
            break;
          }
          case 'sender':
            listener(step.event);
            break;
          case 'senderGone':
            listener(null);
            break;
          case 'viewerLeft':
            host.viewerLeft(step.client, step.sourceKey);
            break;
          case 'geometryChanged':
            host.geometryChanged(step.sourceKey, step.geometry);
            break;
          case 'frame':
            host.frame(step.sourceKey, step.picture);
            break;
          case 'channelPush':
            // Node serializes the message itself; the text it sends is part of the recorded input.
            step.text = JSON.stringify(step.message);
            host.channelPush(step.sourceKey, step.message);
            break;
          case 'dispose':
            host.dispose();
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
          case 'resizeDone':
            if (step.ok) resizes[step.index].resolve();
            else resizes[step.index].reject(new Error(step.message ?? 'resize failed'));
            break;
          case 'sendDone':
            if (step.ok) sends[step.index].resolve();
            else sends[step.index].reject(new Error(step.message ?? 'send failed'));
            break;
          default:
            throw new Error(`unknown host op ${step.op}`);
        }
      } catch (error) {
        // A scenario step must be applicable: Node refusing one means the scenario is wrong.
        throw new Error(`scenario ${name} step ${step.op}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await flush();
      recorded.push({ ...(threw ? { threw } : {}), trace: clone(trace.slice(before)), signals: calls.map((call) => call.state) });
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Date.now = realNow;
  }
  return { name, options, steps, recorded };
}

const PAGE = { op: 'page', key: KEY, documentId: 'p1:2', geometry: GEOMETRY };
const signalA = (raw, iceServers = ICE) => ({ op: 'signal', client: A, raw, iceServers });
const OFFER = { op: 'sender', event: { type: 'offer', connectionId: C1, sdp: SDP } };
const ANSWER = signalA(sig('answer', { sdp: SDP, fingerprints: [fp256] }));
const CONNECTED = { op: 'sender', event: { type: 'connected', connectionId: C1, remoteCertificate: cert } };
// A picture of the current page has to be delivered before the phone's media-ready counts.
const FIRST_PICTURE = [{ op: 'frame', sourceKey: KEY, picture: picture('AAAA') }, { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 1, ok: true } }];
const toConnected = [PAGE, signalA(readySig()), ...FIRST_PICTURE, signalA({ v: 1, source: SRC, type: 'geometry-ack', geometryGeneration: 1 }), OFFER, ANSWER, CONNECTED];
const mediaReady = signalA(sig('media-ready', { documentId: 'p1:2', geometryGeneration: 1, pixelWidth: 1170, pixelHeight: 2532 }));
const toPromoting = [...toConnected, mediaReady];
const toWebrtc = [...toPromoting, signalA(sig('promote-ack', { inputEpoch: 2 }))];
const pointer = (phase) => ({ type: 'pointer', documentId: 'p1:2', phase, button: 'left', x: 5, y: 6, buttons: phase === 'mouseReleased' ? 0 : 1, modifiers: 0, clickCount: 1 });
const inputMsg = (seq, control) => JSON.stringify({ v: 1, kind: 'input', epoch: 2, seq, geometryGeneration: 1, sentAt: 100 + seq, control });
const channel = (text, receivedAt = 1_000_100, connectionId = C1) => ({ op: 'sender', event: { type: 'channel', connectionId, text, receivedAt } });

const scenarios = [
  await hostScenario('a signal needs a valid client id, a valid signal and a streamed source', [
    { op: 'signal', client: 'bad id', raw: readySig(), iceServers: ICE },
    { op: 'signal', client: '', raw: readySig(), iceServers: ICE },
    { op: 'signal', client: A, raw: { v: 1, type: 'ready' }, iceServers: ICE },
    { op: 'signal', client: A, raw: 'x', iceServers: ICE },
    { op: 'signal', client: A, raw: { v: 1, source: { kind: 'screen', screenId: 'screen-1' }, type: 'ready', receiveCodecs: ['video/VP8'] }, iceServers: ICE },
    { op: 'streamed', key: KEY, value: false },
    signalA(readySig()),
    { op: 'streamed', key: KEY, value: true },
    signalA(readySig()),
  ]),
  await hostScenario('a new viewer gets the locked geometry first, then the ready opens the connection', [
    signalA(readySig()),
    PAGE,
    signalA(readySig({ receiveCodecs: ['video/VP8', 'video/H264'] })),
  ]),
  await hostScenario('a ready with a video limit widens the source before the offer; ICE servers that are not a list are none', [
    PAGE,
    signalA(readySig({ videoLimit: { maxWidth: 1920, maxHeight: 1080 } }), 'not a list'),
    { op: 'sender', event: { type: 'offer', connectionId: C1, sdp: SDP } },
  ]),
  await hostScenario('negotiation: offer, answer, candidates both ways, DTLS', [
    ...toConnected,
    signalA(sig('candidate', { candidate: HOST })),
    { op: 'sender', event: { type: 'candidate', connectionId: C1, candidate: HOST } },
    { op: 'sender', event: { type: 'candidate', connectionId: C1, candidate: null } },
    { op: 'sender', event: { type: 'candidate', connectionId: 'unknown-connection', candidate: HOST } },
    { op: 'sender', event: { type: 'offer', connectionId: 'unknown-connection', sdp: SDP } },
  ]),
  await hostScenario('a connection promoted to webrtc carries input and the source gets it in order', [
    ...toWebrtc,
    channel(inputMsg(1, pointer('mousePressed'))),
    channel(inputMsg(2, pointer('mouseReleased'))),
    { op: 'dispatchDone', index: 0, ok: true },
    { op: 'dispatchDone', index: 1, ok: false, message: 'refused' },
  ]),
  await hostScenario('the viewer leaving while the channel holds a button releases it through the source', [
    ...toWebrtc,
    channel(inputMsg(1, pointer('mousePressed'))),
    { op: 'dispatchDone', index: 0, ok: true },
    signalA(sig('close', { reason: 'viewer-left' })),
    { op: 'dispatchDone', index: 1, ok: true },
  ]),
  await hostScenario('a close of viewer-left names the connection or does nothing', [
    ...toWebrtc,
    signalA(sig('close', { reason: 'viewer-left' }, C2)),
    signalA(sig('close', { reason: 'ice-failed' })),
    signalA(sig('demote-ack', { inputEpoch: 3 })),
  ]),
  await hostScenario('a resize request reaches the source; a failure is reported', [
    PAGE,
    signalA({ v: 1, source: SRC, type: 'resize-request', resize: { mode: 'fit-client', cssWidth: 400, cssHeight: 800, deviceScaleFactor: 2 } }),
    { op: 'resizeDone', index: 0, ok: false, message: 'no such page' },
    signalA({ v: 1, source: SRC, type: 'resize-request', resize: { mode: 'fit-client', cssWidth: 410, cssHeight: 810, deviceScaleFactor: 2 } }),
    { op: 'resizeDone', index: 1, ok: true },
  ]),
  await hostScenario('geometry changes go to every viewer of the source; no geometry ends them', [
    PAGE,
    signalA(readySig()),
    { op: 'signal', client: B, raw: readySig(), iceServers: ICE },
    { op: 'page', key: KEY, documentId: 'p1:2', geometry: GEOMETRY2 },
    { op: 'geometryChanged', sourceKey: KEY, geometry: GEOMETRY2 },
    { op: 'geometryChanged', sourceKey: KEY2, geometry: GEOMETRY2 },
    { op: 'geometryChanged', sourceKey: KEY, geometry: null },
    signalA(readySig()),
  ]),
  await hostScenario('the viewer leaves: stopped, closed, its connection ended', [
    ...toConnected,
    { op: 'viewerLeft', client: A, sourceKey: KEY },
    { op: 'viewerLeft', client: A, sourceKey: KEY },
    { op: 'viewerLeft', client: B, sourceKey: KEY },
    signalA(readySig()),
  ]),
  await hostScenario('a sender that is gone fails every live connection', [
    ...toConnected,
    { op: 'signal', client: B, raw: readySig(), iceServers: ICE },
    { op: 'sender', event: { type: 'offer', connectionId: C2, sdp: SDP } },
    { op: 'senderGone' },
  ]),
  await hostScenario('a failed capture fails the connections of that source only', [
    ...toConnected,
    { op: 'sender', event: { type: 'source-captured', sourceKey: KEY2, ok: false, detail: 'other' } },
    { op: 'sender', event: { type: 'source-captured', sourceKey: KEY, ok: false, detail: 'lost' } },
    { op: 'sender', event: { type: 'source-captured', sourceKey: KEY, ok: true } },
  ]),
  await hostScenario('the sender reports a failure of a connection', [
    ...toConnected,
    { op: 'sender', event: { type: 'failed', connectionId: C2, reason: 'ice-failed' } },
    { op: 'sender', event: { type: 'failed', connectionId: C1, reason: 'ice-failed' } },
    signalA(sig('demote-ack', { inputEpoch: 2 })),
  ]),
  await hostScenario('the signals a phone signal causes are sent before it settles', [
    PAGE,
    signalA(readySig()),
    OFFER,
    signalA(sig('answer', { sdp: SDP, fingerprints: [fp256] })),
    { op: 'sendDone', index: 0, ok: true },
    { op: 'sendDone', index: 1, ok: true },
  ], { holdSignals: true }),
  await hostScenario('a signal that could not be sent is reported and does not fail the call', [
    PAGE,
    signalA(readySig()),
    OFFER,
    { op: 'sendDone', index: 0, ok: false, message: 'relay is down' },
    { op: 'sendDone', index: 1, ok: false, message: 'relay is down' },
  ], { holdSignals: true }),
  await hostScenario('a phone close that demotes sends the demote before the call settles', [
    ...toWebrtc,
    signalA(sig('close', { reason: 'channel-failed' })),
  ]),
  await hostScenario('the negotiation timeout fails the connection back to JPEG', [
    PAGE,
    signalA(readySig()),
    OFFER,
    { op: 'fireTimer', handle: 1 },
    { op: 'fireTimer', handle: 1 },
  ]),
  await hostScenario('the source stops when its last connection closes, not before', [
    PAGE,
    signalA(readySig()),
    { op: 'signal', client: B, raw: readySig(), iceServers: ICE },
    { op: 'viewerLeft', client: A, sourceKey: KEY },
    { op: 'viewerLeft', client: B, sourceKey: KEY },
  ]),
  await hostScenario('pictures: one in flight per source, the newest supersedes the waiting one', [
    { op: 'frame', sourceKey: KEY, picture: picture('AAAA') },
    PAGE,
    signalA(readySig()),
    { op: 'frame', sourceKey: KEY, picture: picture('BBBB') },
    { op: 'frame', sourceKey: KEY, picture: picture('CCCC') },
    { op: 'frame', sourceKey: KEY, picture: picture('DDDD') },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 1, ok: true } },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 99, ok: true } },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 2, ok: false } },
  ]),
  await hostScenario('a static page: the newest delivered picture goes again to a connection that comes up', [
    PAGE,
    signalA(readySig()),
    { op: 'frame', sourceKey: KEY, picture: picture('AAAA') },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 1, ok: true } },
    OFFER,
    signalA(sig('answer', { sdp: SDP, fingerprints: [fp256] })),
    CONNECTED,
  ]),
  await hostScenario('a static page: a second viewer connecting gets the newest picture too', [
    PAGE,
    signalA(readySig()),
    { op: 'frame', sourceKey: KEY, picture: picture('AAAA') },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 1, ok: true } },
    { op: 'signal', client: B, raw: readySig(), iceServers: ICE },
    { op: 'sender', event: { type: 'offer', connectionId: C2, sdp: SDP } },
    { op: 'signal', client: B, raw: sig('answer', { sdp: SDP, fingerprints: [fp256] }, C2), iceServers: [] },
    { op: 'sender', event: { type: 'connected', connectionId: C2, remoteCertificate: cert } },
  ]),
  await hostScenario('a picture that arrives while one is waiting is the one sent after the connection comes up', [
    PAGE,
    signalA(readySig()),
    { op: 'frame', sourceKey: KEY, picture: picture('AAAA') },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 1, ok: true } },
    { op: 'frame', sourceKey: KEY, picture: picture('BBBB') },
    OFFER,
    signalA(sig('answer', { sdp: SDP, fingerprints: [fp256] })),
    CONNECTED,
  ]),
  await hostScenario('a picture of an earlier document does not count as a current one (media-ready waits)', [
    PAGE,
    signalA(readySig()),
    { op: 'frame', sourceKey: KEY, picture: picture('AAAA', GEOMETRY, 'p0:1') },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 1, ok: true } },
    signalA({ v: 1, source: SRC, type: 'geometry-ack', geometryGeneration: 1 }),
    OFFER,
    ANSWER,
    CONNECTED,
    mediaReady,
    { op: 'frame', sourceKey: KEY, picture: picture('BBBB') },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 2, ok: true } },
    { op: 'sender', event: { type: 'frame-done', sourceKey: KEY, frameId: 3, ok: true } },
    mediaReady,
  ]),
  await hostScenario('channel pushes go to each viewer of the source whose channel is up', [
    ...toWebrtc,
    { op: 'signal', client: B, raw: readySig(), iceServers: ICE },
    { op: 'channelPush', sourceKey: KEY, message: { v: 1, kind: 'screen-status', status: 'x' } },
    { op: 'channelPush', sourceKey: KEY2, message: { v: 1, kind: 'screen-status', status: 'y' } },
  ]),
  await hostScenario('dispose stops every viewer', [
    ...toWebrtc,
    { op: 'signal', client: B, raw: readySig(), iceServers: ICE },
    { op: 'dispose' },
    signalA(readySig()),
  ]),
  await hostScenario('a second ready supersedes the connection and a new one opens after the hand-back', [
    ...toWebrtc,
    signalA(readySig()),
    signalA(sig('demote-ack', { inputEpoch: 3 })),
    { op: 'sender', event: { type: 'offer', connectionId: C2, sdp: SDP } },
  ]),
  await hostScenario('a phone receiver report is measured, not forwarded', [
    ...toWebrtc,
    channel(JSON.stringify({ v: 1, kind: 'stats', stats: { framesDecoded: 1 } })),
  ]),
];

writeJson(join(stage, 'host.json'), { domain: 'live-view-host', recorder, scenarios });
writeSetManifest(stage, {
  set: 'live-view-host',
  recorder,
  command: `node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <tree>`,
  identity: exactProductIdentity(tree, NODE_COMMIT),
});
commitStage(stage, finalDir);
console.log(`recorded ${scenarios.length} host scenarios`);
