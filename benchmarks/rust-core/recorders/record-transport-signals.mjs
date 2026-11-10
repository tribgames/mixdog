#!/usr/bin/env node
// Records, from Node's product at b6f10295a, the MXT transport's signalling and media-adapter message contracts
// (apps/desktop/src/shared/remote-transport.ts parseRemoteTransportSignal / readRemoteTransportMedia): the REAL
// validators answer a generated corpus (valid messages and field-by-field mutations). Every outcome (normalized value
// or error text) is what Node answered.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-transport-signals.mjs --tree <exact git archive of b6f10295a with node_modules> --commit b6f10295a2f698afc85332467192de28500bd146
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-transport-signals.mjs';
const finalDir = join(FIXTURES_ROOT, 'remote-transport-signals');
const stage = stageSet(finalDir);
const shared = await importFrom(tree, 'apps/desktop/src/shared/remote-transport.ts');

const outcome = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const hex = (bytes, seed = 1) => Array.from({ length: bytes }, (_, i) => ((i * 7 + seed) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP256 = hex(32);
const FP384 = hex(48, 3);
const sdpWith = (...prints) =>
  `v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n${prints.map((p) => `a=fingerprint:${p.algorithm} ${p.value}\r\n`).join('')}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
const fp256 = { algorithm: 'sha-256', value: FP256 };
const SDP = sdpWith(fp256);
const SESSION = 'A'.repeat(43);
const CONN = 'connection-id-0001';
const ref = { v: 1, sessionId: SESSION, connectionId: CONN, generation: 1 };
const HOST = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0 ufrag abcd network-id 1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
const ICE = [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c' }];
const FRAME = 'A'.repeat(48);

const SIGNALS = {
  offer: { ...ref, t: 'offer', sdp: SDP, fingerprints: [fp256], iceServers: ICE },
  answer: { ...ref, t: 'answer', sdp: SDP, fingerprints: [fp256] },
  'candidate-line': { ...ref, t: 'candidate', candidate: HOST },
  'candidate-null': { ...ref, t: 'candidate', candidate: null },
  close: { ...ref, t: 'close', reason: 'restart' },
  'close-detail': { ...ref, t: 'close', reason: 'stall', detail: 'silent' },
};
const MEDIA = {
  request: { type: 'transport-media', op: 'request', id: 'req-1', assetId: '0123abcd-4567', variant: 'original', range: 'bytes=0-99', enc: 'e2ee1' },
  'request-open': { type: 'transport-media', op: 'request', id: 'req-2', assetId: '0123abcd-4567', variant: 'download', range: '', enc: 'e2ee1' },
  cancel: { type: 'transport-media', op: 'cancel', id: 'req-1' },
  head: { type: 'transport-media', op: 'head', id: 'req-1', status: 200 },
  chunk: { type: 'transport-media', op: 'chunk', id: 'req-1', frame: FRAME },
  end: { type: 'transport-media', op: 'end', id: 'req-1' },
  error: { type: 'transport-media', op: 'error', id: 'req-1' },
};

const DELETE = Symbol('delete');
const JUNK = [DELETE, null, 0, -1, 1, 1.5, 9007199254740992, '', 'x', true, [], {}, 'a'.repeat(300)];
const EXTRA = {
  v: [2, '1'],
  t: ['nope', 'OFFER', 'offer ', 'close', 'answer', 'candidate'],
  type: ['transport-media', 'Transport-Media', 'transport-fragment'],
  op: ['request', 'cancel', 'head', 'chunk', 'end', 'error', 'nope', 'REQUEST'],
  sessionId: ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}-`, `${'A'.repeat(42)}_`],
  connectionId: ['a'.repeat(7), 'a'.repeat(8), 'a'.repeat(64), 'a'.repeat(65), 'has+plus_is_16chars'],
  generation: [2, 9007199254740991],
  reason: ['superseded', 'negotiation-timeout', 'ice-failed', 'dtls-failed', 'fingerprint-mismatch', 'channel-failed', 'stall', 'restart', 'peer-host-unavailable', 'session-ended', 'revoked', 'suspended', 'protocol-error', 'other', 'Restart'],
  detail: ['a'.repeat(200), 'a'.repeat(201)],
  sdp: ['v=0', 'v=1\r\n', '  v=0', `${SDP}a=ice-lite\r\n`, sdpWith(fp256, fp256), sdpWith({ algorithm: 'sha-256', value: FP256.toLowerCase() }), sdpWith(fp256, { algorithm: 'sha-384', value: FP384 }), 'v=0\r\n', `v=0\r\n${'a=x\r\n'.repeat(8000)}`, `v=0\r\n${'a=x\r\n'.repeat(12000)}`],
  fingerprints: [[], [fp256, fp256], [fp256, { algorithm: 'sha-384', value: FP384 }, fp256, fp256], [{ algorithm: 'SHA-256', value: FP256 }], [{ algorithm: 'sha-1', value: hex(20) }], [{ algorithm: 'sha-256', value: hex(31) }]],
  iceServers: [[], Array.from({ length: 16 }, () => ({ urls: ['stun:a'] })), Array.from({ length: 17 }, () => ({ urls: ['stun:a'] })), [{ urls: 'stun:a' }], [{ urls: [] }], [{ urls: ['http://a'] }], [{ urls: ['turns:a'], username: 'u'.repeat(512), credential: 'c'.repeat(513) }], [{}], ['x']],
  candidate: [{ candidate: 'x' }, { candidate: '', sdpMid: null, sdpMLineIndex: null }, { candidate: '', sdpMid: 'a'.repeat(33) }, { candidate: '', sdpMLineIndex: 256 }, { candidate: 'a'.repeat(1024), sdpMid: '0' }, { candidate: HOST.candidate }],
  id: ['a'.repeat(64), 'a'.repeat(65), 'has space', 'ok_-1', 'x'],
  assetId: ['0123abcd', '0123abc', '0123ABCD-4567', 'g123abcd-4567', 'a'.repeat(64), 'a'.repeat(65), '../etc/passwd'],
  variant: ['a'.repeat(32), 'a'.repeat(33), 'has space', 'x'],
  range: ['bytes=0-', 'bytes=-5', 'bytes=-', 'bytes=1-2-3', 'bytes=12345678901234567-', 'items=0-1', 'bytes=0-1', 'a'.repeat(64), 'a'.repeat(65)],
  enc: ['e2ee1', 'a'.repeat(16), 'a'.repeat(17), 'e 1'],
  status: [200, 403, 404, 405, 412, 416, 500, 201, 302, 502, '200'],
  frame: ['A'.repeat(39), 'A'.repeat(40), 'A'.repeat(5000), `${'A'.repeat(40)}=`, `${'A'.repeat(40)}+`, 'A'.repeat(87382), 'A'.repeat(87381)],
};
const KEEP_JUNK_OFF = new Set(['v']);
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

const roles = ['desktop', 'client'];
const signals = [];
for (const from of roles) {
  for (const input of corpusOf(SIGNALS)) signals.push({ from, input, ...outcome(() => shared.parseRemoteTransportSignal(input, from)) });
}
const media = [];
for (const from of roles) {
  for (const input of corpusOf(MEDIA)) media.push({ from, input, ...outcome(() => shared.readRemoteTransportMedia(input, from)) });
}
writeJson(join(stage, 'signals.json'), { domain: 'remote-transport-signals', recorder, signals, media });

writeSetManifest(stage, {
  set: 'remote-transport-signals',
  recorder,
  command: `node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${signals.length} signal and ${media.length} media outcomes`);
