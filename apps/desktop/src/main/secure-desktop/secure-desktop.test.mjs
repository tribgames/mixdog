import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createSecureDesktopClient } from './client.ts';
import { secureDesktopExePath, stateFilePath } from './paths.ts';
import {
  FrameParser,
  MAX_VIDEO_LEN,
  PROTOCOL_VERSION,
  clientAuthTag,
  decodeBody,
  decodeNonce,
  encodeControl,
  encodeVideo,
  generateNonce,
  serverAuthTag,
} from './protocol.ts';

/** Encode a raw (possibly schema-invalid) control payload, bypassing typing. */
function rawControl(json) {
  const body = Buffer.from(json, 'utf8');
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32LE(1 + body.length, 0);
  out[4] = 1;
  body.copy(out, 5);
  return out;
}

const WIN_ENV = {
  isPackaged: false,
  platform: 'win32',
  resourcesPath: 'C:\\app\\resources',
  cwd: 'C:\\src',
  programData: 'C:\\ProgramData',
};

// 32 bytes 0x00..0x1f, base64 — also the shared known-answer vector's key.
const KAT_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const STATE = { secret: KAT_SECRET, pipeName: '\\\\.\\pipe\\mixdog-secure-desktop', productVersion: '0.1.0' };

/** A client-side duplex plus the bytes the "server" sees and a way to reply. */
function makePipePair() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const clientTransport = Duplex.from({ writable: toServer, readable: toClient });
  const serverParser = new FrameParser();
  const received = [];
  toServer.on('data', (chunk) => {
    for (const frame of serverParser.push(chunk)) received.push(frame);
  });
  return {
    clientTransport,
    received,
    sendToClient(buffer) {
      toClient.write(buffer);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test('control frames round-trip, including split chunks', () => {
  const frame = encodeControl({ type: 'control', active: true });
  const parser = new FrameParser();
  const half = Math.floor(frame.length / 2);
  assert.equal(parser.push(frame.subarray(0, half)).length, 0, 'a partial frame yields nothing');
  const out = parser.push(frame.subarray(half));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'control');
  assert.deepEqual(out[0].message, { type: 'control', active: true });
});

test('video frames carry header and raw pixels, mismatches are rejected', () => {
  const header = {
    seq: 3,
    width: 2,
    height: 2,
    stride: 8,
    format: 'bgra',
    timestampMs: 123,
    originX: -5,
    originY: 0,
    desktop: 'Winlogon',
    dirty: [{ x: 0, y: 0, width: 1, height: 2 }],
  };
  const pixels = Buffer.alloc(16, 9);
  const parsed = new FrameParser().push(encodeVideo(header, pixels));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'video');
  assert.deepEqual(parsed[0].header, header);
  assert.equal(parsed[0].pixels.length, 16);

  // A body whose pixel length disagrees with stride*height must throw.
  const bad = encodeVideo(header, Buffer.alloc(4));
  assert.throws(() => decodeBody(bad.subarray(4)));
});

test('the parser refuses malformed, zero-length, and oversized frames', () => {
  const parser = new FrameParser();

  // A declared body length over the cap is rejected before any allocation.
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(MAX_VIDEO_LEN + 1, 0);
  assert.throws(() => parser.push(oversized), /maximum size/);

  // A zero-length frame is malformed.
  const zero = Buffer.alloc(4);
  zero.writeUInt32LE(0, 0);
  assert.throws(() => new FrameParser().push(zero), /empty frame/);

  // A video header length that runs past the payload is rejected.
  const header = Buffer.from(JSON.stringify({ seq: 1 }), 'utf8');
  const payload = Buffer.alloc(1 + 4 + header.length);
  payload[0] = 2; // KIND_VIDEO
  payload.writeUInt32LE(header.length + 100, 1); // header len past the buffer
  header.copy(payload, 5);
  assert.throws(() => decodeBody(payload), /out of range/);

  // An unknown kind and an empty body are both errors.
  assert.throws(() => decodeBody(Buffer.from([9, 1, 2, 3])), /unknown frame kind/);
  assert.throws(() => decodeBody(Buffer.alloc(0)), /empty frame body/);
});

test('client is a no-op when the service is not installed', async () => {
  const client = createSecureDesktopClient({ environment: WIN_ENV, readState: () => undefined });
  assert.equal(client.available, false);
  await assert.rejects(client.connect(), /not installed/);
  // None of these throw or do anything observable.
  client.setActive(true);
  client.pointerMove(1, 2);
  client.pointerButton('left', true, 3, 4);
  client.text('ignored');
  client.key(true, 0x41);
  client.close();
});

test('client handshakes, surfaces frames and desktop changes, and sends input', async () => {
  const pipe = makePipePair();
  const client = createSecureDesktopClient({
    environment: WIN_ENV,
    readState: () => STATE,
    createConnection: () => pipe.clientTransport,
  });
  assert.equal(client.available, true);

  const frames = [];
  const desktops = [];
  const errors = [];
  client.on('frame', (header, pixels) => frames.push({ header, pixels }));
  client.on('desktop-changed', (desktop, session) => desktops.push({ desktop, session }));
  client.on('error', (code, message) => errors.push({ code, message }));

  const connectPromise = client.connect();
  await settle();

  // The client opens with only a nonce — never the secret.
  assert.equal(pipe.received.length, 1);
  const hello = pipe.received[0].message;
  assert.equal(hello.type, 'client-hello');
  assert.equal(hello.protocol, PROTOCOL_VERSION);
  assert.ok(!JSON.stringify(hello).includes(STATE.secret));
  const clientNonce = decodeNonce(hello.clientNonce);
  assert.ok(clientNonce, 'client nonce has the exact length');

  // The (honest) server proves knowledge first.
  const serverNonceB64 = generateNonce();
  const serverNonce = decodeNonce(serverNonceB64);
  pipe.sendToClient(
    encodeControl({
      type: 'server-auth',
      protocol: PROTOCOL_VERSION,
      serverNonce: serverNonceB64,
      mac: serverAuthTag(STATE.secret, clientNonce, serverNonce),
    }),
  );
  await settle();
  const auth = pipe.received[1]?.message;
  assert.equal(auth?.type, 'client-auth');
  assert.equal(auth.mac, clientAuthTag(STATE.secret, serverNonce, clientNonce));

  // Input before server-hello must not leak onto the wire.
  client.key(true, 0x41);
  await settle();
  assert.equal(pipe.received.length, 2);

  pipe.sendToClient(
    encodeControl({ type: 'server-hello', protocol: PROTOCOL_VERSION, version: '0.1.0', session: 2, desktop: 'Default' }),
  );
  const serverHello = await connectPromise;
  assert.deepEqual(serverHello, { protocol: PROTOCOL_VERSION, version: '0.1.0', session: 2, desktop: 'Default' });
  assert.deepEqual(client.session(), serverHello, 'session() reports the authenticated session');

  // A frame and a desktop change should surface through the events.
  const header = {
    seq: 1,
    width: 2,
    height: 2,
    stride: 8,
    format: 'bgra',
    timestampMs: 7,
    originX: 0,
    originY: 0,
    desktop: 'Winlogon',
    dirty: [],
  };
  pipe.sendToClient(encodeVideo(header, Buffer.alloc(16, 42)));
  pipe.sendToClient(encodeControl({ type: 'desktop-changed', desktop: 'Winlogon', session: 2 }));
  await settle();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].header.desktop, 'Winlogon');
  assert.equal(frames[0].pixels.length, 16);
  assert.deepEqual(desktops[0], { desktop: 'Winlogon', session: 2 });
  assert.equal(client.session()?.desktop, 'Winlogon', 'session() follows desktop-changed');

  // Input and the active signal must reach the server with the exact shapes.
  client.setActive(true);
  client.pointerButton('left', true, 10, 20);
  client.key(false, 0x41, 0x1e, false);
  client.text('hi');
  await settle();

  const inputs = pipe.received
    .filter((frame) => frame.kind === 'control' && frame.message.type === 'input')
    .map((frame) => frame.message.event);
  assert.deepEqual(
    inputs.find((event) => event.kind === 'pointer-button'),
    { kind: 'pointer-button', button: 'left', down: true, x: 10, y: 20 },
  );
  assert.deepEqual(
    inputs.find((event) => event.kind === 'key'),
    { kind: 'key', down: false, vk: 0x41, scan: 0x1e, extended: false },
  );
  assert.deepEqual(
    inputs.find((event) => event.kind === 'text'),
    { kind: 'text', text: 'hi' },
  );
  assert.ok(
    pipe.received.some((frame) => frame.kind === 'control' && frame.message.type === 'control' && frame.message.active === true),
    'active control reached the server',
  );
  assert.equal(errors.length, 0);
});

test('auth tags match the known-answer vector shared with the Rust helper', () => {
  // Expected values computed independently with Python's hmac module.
  const cn = Buffer.alloc(16, 0xaa);
  const sn = Buffer.alloc(16, 0xbb);
  assert.equal(serverAuthTag(KAT_SECRET, cn, sn), 'dEuYYaY1byiY4cjlZ7augOQsK58KQpWFOJEHJbvkvPI=');
  assert.equal(clientAuthTag(KAT_SECRET, sn, cn), 'u6+CvqeI2faMMsAAXKRZ0rlEFHvLJi8d+7lKZq13vYQ=');
  assert.equal(decodeNonce('short'), undefined);
  assert.equal(decodeNonce(Buffer.alloc(17).toString('base64')), undefined);
});

/** Connect a client to a fake server and return what the server saw plus the
 *  connect() outcome once the server has answered with `serverAuth`. */
async function runAgainstFakeServer(serverAuth) {
  const pipe = makePipePair();
  let destroyed = false;
  const transport = pipe.clientTransport;
  const originalDestroy = transport.destroy.bind(transport);
  transport.destroy = (...args) => {
    destroyed = true;
    return originalDestroy(...args);
  };
  const client = createSecureDesktopClient({
    environment: WIN_ENV,
    readState: () => STATE,
    createConnection: () => transport,
  });
  const errors = [];
  client.on('error', (code) => errors.push(code));
  const outcome = client.connect().then(
    () => 'resolved',
    (error) => error.message,
  );
  await settle();
  const hello = pipe.received[0].message;
  pipe.sendToClient(serverAuth(hello));
  await settle();
  // Anything the app might try afterwards must not reach the fake server.
  client.setActive(true);
  client.text('secret-ish');
  await settle();
  return { received: pipe.received.map((f) => f.message), outcome: await outcome, destroyed, errors };
}

test('a fake server without the secret learns nothing usable', async () => {
  const wrongSecret = Buffer.alloc(32, 7).toString('base64');
  const result = await runAgainstFakeServer((hello) => {
    const sn = generateNonce();
    return encodeControl({
      type: 'server-auth',
      protocol: PROTOCOL_VERSION,
      serverNonce: sn,
      mac: serverAuthTag(wrongSecret, decodeNonce(hello.clientNonce), decodeNonce(sn)),
    });
  });
  // The squatter received exactly one message: a random nonce, no secret, no MAC.
  assert.equal(result.received.length, 1);
  assert.deepEqual(Object.keys(result.received[0]).sort(), ['clientNonce', 'protocol', 'type']);
  assert.ok(!JSON.stringify(result.received).includes(STATE.secret));
  assert.match(result.outcome, /unauthorized/);
  assert.ok(result.destroyed, 'the client dropped the connection');
  assert.deepEqual(result.errors, ['unauthorized']);
});

test('a replayed server MAC from an earlier connection is rejected', async () => {
  // A MAC recorded for a different client nonce cannot satisfy a fresh one.
  const recordedClientNonce = decodeNonce(generateNonce());
  const sn = generateNonce();
  const recordedMac = serverAuthTag(STATE.secret, recordedClientNonce, decodeNonce(sn));
  const result = await runAgainstFakeServer(() =>
    encodeControl({ type: 'server-auth', protocol: PROTOCOL_VERSION, serverNonce: sn, mac: recordedMac }),
  );
  assert.equal(result.received.length, 1, 'no client-auth was sent');
  assert.match(result.outcome, /unauthorized/);
});

test('a server that skips server-auth or sends video first is dropped', async () => {
  const skipped = await runAgainstFakeServer(() =>
    encodeControl({ type: 'server-hello', protocol: PROTOCOL_VERSION, version: 'x', session: 1, desktop: 'Default' }),
  );
  assert.equal(skipped.received.length, 1);
  assert.match(skipped.outcome, /expected server-auth/);
});

test('schema-invalid control and header payloads are rejected by the decoder', () => {
  const body = (frame) => frame.subarray(4);
  assert.throws(() => decodeBody(body(rawControl('null'))), /not an object/);
  assert.throws(() => decodeBody(body(rawControl('{"type":"control","active":null}'))), /malformed control/);
  assert.throws(() => decodeBody(body(rawControl('{"type":"bogus"}'))), /unknown control/);
  assert.throws(
    () => decodeBody(body(rawControl('{"type":"desktop-changed","desktop":"","session":1}'))),
    /malformed desktop-changed/,
  );
  assert.throws(
    () => decodeBody(body(rawControl('{"type":"input","event":{"kind":"key","down":true,"vk":70000,"scan":0,"extended":false}}'))),
    /malformed input/,
  );

  const header = {
    seq: 1, width: 2, height: 2, stride: 8, format: 'bgra', timestampMs: 1,
    originX: 0, originY: 0, desktop: 'Default', dirty: [],
  };
  const pixels = Buffer.alloc(16);
  const bad = (patch, re) => assert.throws(() => decodeBody(body(encodeVideo({ ...header, ...patch }, pixels))), re);
  bad({ width: 0 }, /malformed video header/);
  bad({ format: 'rgb' }, /malformed video header/);
  bad({ stride: 4 }, /stride smaller/);
  bad({ width: 1, stride: 0x4000_0000, height: 2 }, /exceed/);
  bad({ dirty: [null] }, /dirty rect/);
  // `null` header JSON is rejected, not dereferenced.
  const nullHeader = Buffer.from('null', 'utf8');
  const payload = Buffer.alloc(5 + nullHeader.length);
  payload[0] = 2;
  payload.writeUInt32LE(nullHeader.length, 1);
  nullHeader.copy(payload, 5);
  assert.throws(() => decodeBody(payload), /not an object/);
});

test('a null control after authentication closes the connection cleanly', async () => {
  const pipe = makePipePair();
  const client = createSecureDesktopClient({
    environment: WIN_ENV,
    readState: () => STATE,
    createConnection: () => pipe.clientTransport,
  });
  const errors = [];
  const closes = [];
  client.on('error', (code, message) => errors.push({ code, message }));
  client.on('close', () => closes.push(true));
  const connected = client.connect();
  await settle();
  const cn = decodeNonce(pipe.received[0].message.clientNonce);
  const snB64 = generateNonce();
  const sn = decodeNonce(snB64);
  pipe.sendToClient(
    encodeControl({ type: 'server-auth', protocol: PROTOCOL_VERSION, serverNonce: snB64, mac: serverAuthTag(STATE.secret, cn, sn) }),
  );
  await settle();
  pipe.sendToClient(
    encodeControl({ type: 'server-hello', protocol: PROTOCOL_VERSION, version: '0.1.0', session: 1, desktop: 'Default' }),
  );
  await connected;

  // Must not throw out of the data handler; must surface a protocol error and close.
  pipe.sendToClient(rawControl('null'));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'protocol');
  assert.equal(closes.length, 1);
  const before = pipe.received.length;
  client.setActive(true);
  await settle();
  assert.equal(pipe.received.length, before, 'nothing is sent after the close');
});

/** Drive an honest server through the handshake for `client` over `pipe`. */
async function authenticate(client, pipe, desktop = 'Default') {
  const connected = client.connect();
  await settle();
  const cn = decodeNonce(pipe.received[0].message.clientNonce);
  const snB64 = generateNonce();
  pipe.sendToClient(
    encodeControl({
      type: 'server-auth',
      protocol: PROTOCOL_VERSION,
      serverNonce: snB64,
      mac: serverAuthTag(STATE.secret, cn, decodeNonce(snB64)),
    }),
  );
  await settle();
  pipe.sendToClient(
    encodeControl({ type: 'server-hello', protocol: PROTOCOL_VERSION, version: '0.1.0', session: 3, desktop }),
  );
  return connected;
}

test('v4: grant challenges surface, grants / video runs / sas reach the helper, and the lock state is tracked', async () => {
  const pipe = makePipePair();
  const client = createSecureDesktopClient({
    environment: WIN_ENV,
    readState: () => STATE,
    createConnection: () => pipe.clientTransport,
  });
  const challenges = [];
  const desktops = [];
  client.on('grant-challenge', (challenge) => challenges.push(challenge));
  client.on('desktop-changed', (desktop, session, locked) => desktops.push({ desktop, session, locked }));
  await authenticate(client, pipe);
  assert.equal(client.session().locked, undefined, 'unknown lock state is absent');

  const nonce = generateNonce();
  const challenge = generateNonce();
  pipe.sendToClient(encodeControl({ type: 'grant-challenge', nonce, challenge }));
  pipe.sendToClient(encodeControl({ type: 'desktop-changed', desktop: 'Winlogon', session: 3, locked: true }));
  await settle();
  assert.deepEqual(challenges, [{ nonce, challenge }]);
  assert.deepEqual(desktops, [{ desktop: 'Winlogon', session: 3, locked: true }]);
  assert.equal(client.session().locked, true);
  pipe.sendToClient(encodeControl({ type: 'desktop-changed', desktop: 'Winlogon', session: 3 }));
  await settle();
  assert.equal('locked' in client.session(), false, 'an unknown state replaces a known one');

  const before = pipe.received.length;
  client.setVideoRun(5);
  await client.sendGrant({ challenge, epoch: 5, signature: 'c2ln' });
  await client.sas();
  await settle();
  assert.deepEqual(
    pipe.received.slice(before).map((frame) => frame.message),
    [
      { type: 'video-run', epoch: 5 },
      { type: 'grant', challenge, epoch: 5, signature: 'c2ln' },
      { type: 'sas' },
    ],
  );
  client.close();
  await assert.rejects(client.sas(), /not connected/);
});

test('v4 messages are schema-checked', () => {
  for (const json of [
    '{"type":"grant-challenge","nonce":1,"challenge":"c"}',
    '{"type":"grant","challenge":"c","epoch":-1,"signature":"s"}',
    '{"type":"grant","challenge":"c","epoch":1.5,"signature":"s"}',
    '{"type":"video-run","epoch":"1"}',
    '{"type":"desktop-changed","desktop":"Default","session":1,"locked":"yes"}',
  ]) {
    assert.throws(() => decodeBody(rawControl(json).subarray(4)), /malformed/, json);
  }
  assert.deepEqual(decodeBody(rawControl('{"type":"sas"}').subarray(4)).message, { type: 'sas' });
});

test('session() is undefined until authenticated and again after the connection ends', async () => {
  const pipe = makePipePair();
  const client = createSecureDesktopClient({
    environment: WIN_ENV,
    readState: () => STATE,
    createConnection: () => pipe.clientTransport,
  });
  assert.equal(client.session(), undefined);
  await authenticate(client, pipe, 'Winlogon');
  assert.deepEqual(client.session(), { protocol: PROTOCOL_VERSION, version: '0.1.0', session: 3, desktop: 'Winlogon' });
  // The returned object is a snapshot, not internal state.
  client.session().desktop = 'mutated';
  assert.equal(client.session().desktop, 'Winlogon');
  client.close();
  assert.equal(client.session(), undefined);
});

test('sendInput settles in bounded time: resolves on write, rejects when unconnected, closed, or stalled', async () => {
  // Not connected (and not installed): rejects immediately.
  const idle = createSecureDesktopClient({ environment: WIN_ENV, readState: () => STATE });
  await assert.rejects(idle.sendInput({ kind: 'pointer-move', x: 1, y: 1 }), /not connected/);

  // Connected: resolves once the frame is handed to the transport, and a
  // release reaches the server even though control was never activated.
  const pipe = makePipePair();
  const client = createSecureDesktopClient({
    environment: WIN_ENV,
    readState: () => STATE,
    createConnection: () => pipe.clientTransport,
  });
  await authenticate(client, pipe);
  await client.sendInput({ kind: 'key', down: false, vk: 0x10, scan: 0x2a, extended: false });
  await settle();
  assert.deepEqual(pipe.received.at(-1).message, {
    type: 'input',
    event: { kind: 'key', down: false, vk: 0x10, scan: 0x2a, extended: false },
  });

  // A transport whose writes never complete (a helper that stopped reading):
  // the promise rejects at the deadline instead of hanging.
  const stalled = makePipePair();
  const transport = stalled.clientTransport;
  const realWrite = transport.write.bind(transport);
  let stall = false;
  transport.write = (chunk, callback) => (stall ? true : realWrite(chunk, callback));
  const slow = createSecureDesktopClient({
    environment: WIN_ENV,
    readState: () => STATE,
    createConnection: () => transport,
    inputDeadlineMs: 50,
  });
  await authenticate(slow, stalled);
  stall = true;
  const started = Date.now();
  await assert.rejects(slow.sendInput({ kind: 'pointer-move', x: 2, y: 2 }), /within 50 ms/);
  assert.ok(Date.now() - started < 2_000, 'rejected near the deadline');

  // A pending write is rejected as soon as the connection ends.
  const pending = slow.sendInput({ kind: 'pointer-move', x: 3, y: 3 });
  transport.destroy();
  await assert.rejects(pending, /connection closed/);
});

test('desktop names are reported verbatim and validated by length', () => {
  const body = (frame) => frame.subarray(4);
  for (const name of ['Default', 'Winlogon', 'Screen-saver']) {
    const decoded = decodeBody(body(encodeControl({ type: 'desktop-changed', desktop: name, session: 1 })));
    assert.equal(decoded.message.desktop, name);
  }
  assert.throws(
    () => decodeBody(body(rawControl(JSON.stringify({ type: 'desktop-changed', desktop: 'x'.repeat(257), session: 1 })))),
    /malformed desktop-changed/,
  );
  assert.throws(
    () => decodeBody(body(rawControl('{"type":"desktop-changed","desktop":7,"session":1}'))),
    /malformed desktop-changed/,
  );
});

test('executable path resolves like the other native tools', () => {
  // The paths are joined with the host's `node:path`, so off Windows the join
  // inserts `/` after the Windows-style base. Only that separator is
  // normalised; the segments and the `.exe` name are still asserted literally.
  const asWindows = (path) => path.replaceAll('/', '\\');
  assert.equal(
    asWindows(secureDesktopExePath({ ...WIN_ENV, isPackaged: true })),
    'C:\\app\\resources\\native-tools\\mixdog-secure-desktop.exe',
  );
  assert.equal(
    asWindows(secureDesktopExePath({ ...WIN_ENV, isPackaged: false })),
    'C:\\src\\native\\mixdog-secure-desktop\\target\\release\\mixdog-secure-desktop.exe',
  );
  assert.equal(asWindows(stateFilePath(WIN_ENV)), 'C:\\ProgramData\\Mixdog\\SecureDesktop\\state.json');
});
