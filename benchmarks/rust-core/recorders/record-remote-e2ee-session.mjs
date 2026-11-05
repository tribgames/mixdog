#!/usr/bin/env node
// Full relay/E2EE session golden twin (P0-BENCH gap closed by WP-REMOTE, WORK-PACKAGES §3.1).
//
// The Node product's desktop relay leg (`startRemoteRelay`) runs against a local `ws` server that
// plays the relay, and a TEST PEER plays the phone: it answers the PC's challenge with the real
// browser-side handshake (shared/remote-e2ee.ts), exchanges encrypted boxes in both carrier forms
// (binary relay frames and JSON text frames), pairs a second container through a claim with a
// sealed approval, hands over sealed Web Push keys, and exercises the control envelopes
// (list-clients, revoke-client, pair code, ICE servers, media request). Every envelope in both
// directions is recorded. The key material is throwaway (a temp userData, never a real identity);
// it is recorded in clear on purpose, because the Rust core replays the transcript as
// known-answer vectors (identity, session keys, sealed claim, sealed web-push keys).
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-remote-e2ee-session.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { WebSocketServer } = await import(pathToFileURL(join(tree, 'node_modules/ws/wrapper.mjs')).href);
const work = mkdtempSync(join(tmpdir(), 'mixdog-remote-e2ee-'));
const userData = join(work, 'userData');
mkdirSync(userData, { recursive: true });
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_HOME = join(work, 'home');
process.env.MIXDOG_REMOTE_METER = '0';
const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const e2ee = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
const frameLib = await importFrom(tree, 'apps/relay/lib/relay-binary-frame.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// Capture the ephemeral key pairs the browser-side code generates, so the Rust core can play the
// same peer from the recorded private halves.
const generated = [];
const subtle = globalThis.crypto.subtle;
const generateKey = subtle.generateKey.bind(subtle);
subtle.generateKey = async (...a) => {
  const pair = await generateKey(...a);
  if (pair?.privateKey && a[0]?.name === 'ECDH') {
    generated.push({
      privateKeyJwk: await subtle.exportKey('jwk', pair.privateKey),
      publicKey: Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url'),
    });
  }
  return pair;
};

// ---- the relay stand-in --------------------------------------------------------------------
const transcript = [];
let socket = null;
const inbox = [];
const waiters = [];
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  socket = ws;
  ws.on('message', (raw, binary) => {
    let entry;
    if (binary) {
      const frame = frameLib.decodeRelayBinaryFrame(raw);
      entry = { dir: 'pc->relay', carrier: 'binary', ...(frame ? { clientId: frame.clientId, droppable: frame.droppable, text: frame.text, data: b64(frame.data) } : { undecodable: b64(raw) }) };
    } else {
      const envelope = JSON.parse(String(raw));
      entry = { dir: 'pc->relay', carrier: 'text', envelope };
    }
    transcript.push(entry);
    const waiter = waiters.findIndex((w) => w.match(entry));
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(entry);
    else inbox.push(entry);
  });
});
await new Promise((r) => wss.once('listening', r));
const port = wss.address().port;
const next = (match, what, ms = 8000) => {
  const at = inbox.findIndex(match);
  if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve };
    waiters.push(waiter);
    setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timed out waiting for ${what}`)); } }, ms);
  });
};
const sendJson = (envelope) => { transcript.push({ dir: 'relay->pc', carrier: 'text', envelope }); socket.send(JSON.stringify(envelope)); };
const sendBinary = (clientId, data, text) => {
  transcript.push({ dir: 'relay->pc', carrier: 'binary', clientId, text, data: b64(data) });
  socket.send(frameLib.encodeRelayBinaryFrame({ clientId, data, text }));
};
const ofType = (type) => (e) => e.carrier === 'text' && e.envelope.type === type;

// ---- the product -----------------------------------------------------------------------------
const host = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : /^(subscribe|on|watch)/.test(String(prop)) ? () => () => {} : async () => (prop === 'listSessions' ? [] : null)) });
const { startRemoteRelay } = await main('remote-relay');
const { resolveRemoteIceServers } = await main('remote-ice-servers');
const claims = [];
const handle = await startRemoteRelay({
  relayUrl: `ws://127.0.0.1:${port}`, userDataPath: userData, host, appVersion: '0.0.0-fixture', hostName: () => 'FIXTURE-PC',
  onClientClaim: async (claim) => { claims.push(claim); return { approved: claim.name !== 'DENIED' }; },
});
await next(ofType('set-client-token'), 'set-client-token');
const identity = JSON.parse((await import('node:fs')).readFileSync(join(userData, 'relay-e2ee.json'), 'utf8'));
const device = JSON.parse((await import('node:fs')).readFileSync(join(userData, 'relay-device.json'), 'utf8'));

sendJson({
  type: 'relay-capabilities', binaryFrames: 1, textFrames: 1, maxFrameBytes: 64 * 1024 * 1024,
  uplinkCapacityBytes: 8 * 1024 * 1024, uplinkBinaryCeilingBytes: 8 * 1024 * 1024 - 6 - 36, uplinkTextCeilingBytes: 8 * 1024 * 1024 - 6 - 36,
  nativePush: 1, nativePushPlatforms: ['fcm'], webPush: 1, ice: 1,
});
await sleep(200);

// ---- sessions: the same handshake once per carrier form -----------------------------------------
const sessions = [];
async function session(name, { binary }) {
  if (!binary) sendJson({ type: 'relay-capabilities', textFrames: 1, maxFrameBytes: 64 * 1024 * 1024, uplinkCapacityBytes: 8 * 1024 * 1024, uplinkBinaryCeilingBytes: 1000, uplinkTextCeilingBytes: 1000 });
  else sendJson({ type: 'relay-capabilities', binaryFrames: 1, textFrames: 1, maxFrameBytes: 64 * 1024 * 1024, uplinkCapacityBytes: 8 * 1024 * 1024, uplinkBinaryCeilingBytes: 8 * 1024 * 1024 - 6 - 36, uplinkTextCeilingBytes: 8 * 1024 * 1024 - 6 - 36, nativePush: 1, nativePushPlatforms: ['fcm'], webPush: 1, ice: 1 });
  await sleep(100);
  const clientId = crypto.randomUUID();
  const browserClientId = crypto.randomUUID().replaceAll('-', '');
  sendJson({ type: 'client-open', clientId, browserClientId });
  const challengeFrame = await next((e) => e.carrier === 'text' && e.envelope.type === 'frame' && e.envelope.clientId === clientId, 'challenge');
  const challenge = JSON.parse(challengeFrame.envelope.data);
  const { hello, channel } = await e2ee.createRelayE2EEClientHandshake(handle.pairing, challenge, {});
  const clientKey = generated[generated.length - 1];
  sendJson({ type: 'frame', clientId, data: JSON.stringify(hello) });
  const frames = [];
  const receive = async (entry) => {
    const plaintext = await channel.decryptJson(entry.carrier === 'binary' ? Buffer.from(entry.data, 'base64') : entry.envelope.data);
    frames.push({ dir: 'pc->phone', carrier: entry.carrier, wire: entry.carrier === 'binary' ? entry.data : entry.envelope.data, droppable: entry.droppable ?? false, plaintext });
    return plaintext;
  };
  const isMine = (e) => (e.carrier === 'binary' ? e.clientId === clientId : e.envelope.type === 'frame' && e.envelope.clientId === clientId);
  const ready = await receive(await next(isMine, 'e2ee-ready'));
  // The phone speaks: one encrypted frame in each direction (the product's method table answers
  // an unknown method with an error frame; only the envelope shape matters here).
  const sendFrame = async (payload) => {
    const wire = binary ? await channel.encryptBinary(payload) : await channel.encryptJson(payload);
    frames.push({ dir: 'phone->pc', carrier: binary ? 'binary' : 'text', wire: binary ? b64(wire) : wire, plaintext: payload });
    if (binary) sendBinary(clientId, wire, false); else sendJson({ type: 'frame', clientId, data: wire });
  };
  await sendFrame({ id: 1, method: 'recorder-ping', args: [] });
  await sleep(400);
  // Whatever else the PC sent on this channel (join frames, the answer) is recorded as plaintext.
  for (let guard = 0; guard < 8; guard += 1) {
    const more = inbox.findIndex(isMine);
    if (more < 0) break;
    await receive(inbox.splice(more, 1)[0]).catch(() => undefined);
  }
  // A replayed box is refused: the PC closes the client.
  sessions.push({ name, binary, clientId, browserClientId, challenge, hello, clientKey, ready, frames });
  return { clientId, challenge, channel };
}
const first = await session('binary', { binary: true });
await session('text', { binary: false });

// ---- tampered and unauthenticated hellos close the client -------------------------------------
{
  sendJson({ type: 'relay-capabilities', binaryFrames: 1, textFrames: 1, maxFrameBytes: 64 * 1024 * 1024, uplinkCapacityBytes: 8 * 1024 * 1024, uplinkBinaryCeilingBytes: 8 * 1024 * 1024 - 42, uplinkTextCeilingBytes: 8 * 1024 * 1024 - 42, webPush: 1, ice: 1 });
  const clientId = crypto.randomUUID();
  sendJson({ type: 'client-open', clientId, browserClientId: crypto.randomUUID().replaceAll('-', '') });
  const challenge = JSON.parse((await next((e) => e.carrier === 'text' && e.envelope.type === 'frame' && e.envelope.clientId === clientId, 'challenge 3')).envelope.data);
  const { hello } = await e2ee.createRelayE2EEClientHandshake(handle.pairing, challenge, {});
  sendJson({ type: 'frame', clientId, data: JSON.stringify({ ...hello, proof: 'A'.repeat(43) }) });
  const closed = await next(ofType('close-client'), 'close-client after a bad proof');
  sessions.push({ name: 'bad-proof', clientId, challenge, hello: { ...hello, proof: 'A'.repeat(43) }, closed: closed.envelope });
}

// ---- claims ------------------------------------------------------------------------------------------
const claimRecords = [];
for (const [claimId, name] of [['claim-approve-1', 'Phone A'], ['claim-deny-1', 'DENIED']]) {
  const pair = await e2ee.generateRelayClaimKeyPair();
  const stored = await e2ee.exportRelayClaimKeyPair(pair);
  sendJson({ type: 'client-claim', claimId, clientId: `c-${claimId}`, publicKey: pair.publicKey, name, platform: 'Android', browser: 'Chrome', method: 'code', expiresAt: Date.now() + 120000 });
  const answer = await next((e) => e.carrier === 'text' && (e.envelope.type === 'claim-approve' || e.envelope.type === 'claim-deny') && e.envelope.claimId === claimId, `answer to ${claimId}`);
  const opened = answer.envelope.sealed ? await e2ee.openSealedRelayE2EEPairingMaterial(answer.envelope.sealed, pair) : null;
  claimRecords.push({ claimId, name, claimKey: stored, answer: answer.envelope, opened });
}

// ---- relay-owned web push: sealed keys in, `webpush-ready` out -------------------------------------
const webPush = {};
{
  const endpoint = 'https://push.example.invalid/send/fixture-endpoint';
  const keys = { p256dh: (await e2ee.generateRelayClaimKeyPair()).publicKey, auth: Buffer.from('0123456789abcdef').toString('base64url') };
  const sealed = await e2ee.sealRelayWebPushKeys(handle.pairing, endpoint, keys);
  sendJson({ type: 'webpush-subscriptions', subscriptions: [{ endpoint, clientId: 'cred-web-1', sealed }] });
  const ready = await next(ofType('webpush-ready'), 'webpush-ready');
  Object.assign(webPush, { endpoint, keys, sealed, ready: ready.envelope });
  const registrations = await handle.pushRegistrations();
  webPush.registrations = [...registrations];
}

// ---- control requests ---------------------------------------------------------------------------------
const control = {};
{
  const list = handle.listClients();
  const req = await next(ofType('list-clients'), 'list-clients');
  sendJson({ type: 'clients-list', requestId: req.envelope.requestId, clients: [{ id: 'cred-a', name: 'Phone A', platform: 'Android', browser: 'Chrome', createdAt: 1, lastSeenAt: 2, online: true }] });
  control.listClients = { request: req.envelope, result: await list };
  const revoke = handle.revokeClient('0123456789abcdef');
  const rr = await next(ofType('revoke-client'), 'revoke-client');
  sendJson({ type: 'client-revoked', requestId: rr.envelope.requestId, ok: true });
  await revoke;
  control.revokeClient = { request: rr.envelope };
  const code = handle.pairCode('ensure');
  const pr = await next(ofType('pair-code-request'), 'pair-code-request');
  sendJson({ type: 'pair-code-issued', lease: pr.envelope.lease, ok: true, code: '123456', expiresInMs: 300000 });
  await sleep(100);
  control.pairCode = { initial: code, request: pr.envelope, afterIssue: handle.pairCode('ensure') };
  handle.pairCode('release');
  control.pairCodeClear = (await next(ofType('pair-code-clear'), 'pair-code-clear')).envelope;
  const ice = resolveRemoteIceServers();
  const ir = await next(ofType('ice-servers-request'), 'ice-servers-request');
  sendJson({ type: 'ice-servers', requestId: ir.envelope.requestId, ok: true, ttlSeconds: 3600, remainingMs: 3600000, servers: [{ urls: ['stun:stun.example.invalid:3478'] }, { urls: ['turn:turn.example.invalid:3478'], username: 'u', credential: 'c' }] });
  control.ice = { request: ir.envelope, result: await ice };
  const sid = first.challenge.challenge;
  sendJson({ type: 'media-request', id: 'm1', assetId: 'no-such-asset-0001', variant: 'original', method: 'GET', range: '', sid, enc: 'e2ee1' });
  const head = await next(ofType('media-head'), 'media-head');
  const end = await next(ofType('media-end'), 'media-end');
  control.mediaUnknownAsset = { head: head.envelope, end: end.envelope };
  sendJson({ type: 'media-request', id: 'm2', assetId: 'no-such-asset-0001', variant: 'original', method: 'GET', range: '', sid, enc: '' });
  control.mediaPlain = { head: (await next(ofType('media-head'), 'media-head 2')).envelope };
  await next(ofType('media-end'), 'media-end 2');
  sendJson({ type: 'frame-too-large', clientId: first.clientId, bytes: 99999999, limit: 1000 });
  await sleep(300);
}
await handle.close();
for (const c of wss.clients) c.terminate();
await new Promise((r) => wss.close(r));

const outDir = join(FIXTURES_ROOT, 'remote-e2ee');
writeJson(join(outDir, 'session.json'), {
  recorder: 'record-remote-e2ee-session.mjs',
  note: 'Throwaway key material from a temp userData; replayed as known-answer vectors by mixdog-remote.',
  device: { deviceId: device.deviceId, secretLength: device.deviceSecret.length },
  identity, claims: claimRecords, claimCallbacks: claims.map(({ requestedAt, expiresAt, ...rest }) => rest),
  webPush, control, sessions, transcript,
});
writeSetManifest(outDir, { set: 'remote-e2ee', recorder: 'benchmarks/rust-core/recorders/record-remote-e2ee-session.mjs', command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-remote-e2ee-session.mjs --tree <tree>', identityTree: tree });
rmSync(work, { recursive: true, force: true });
console.log(`remote-e2ee: ${sessions.length} sessions, ${transcript.length} envelopes`);
process.exit(0);
