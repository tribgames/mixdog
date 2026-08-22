import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import {
  admitFrame,
  admitIngress,
  browserSocketOriginAllowed,
  CLAIM_TTL_MS,
  decodeHookResponseBody,
  DeviceStore,
  INGRESS_RESERVATION_BYTES,
  MAX_FRAME_BYTES,
  MAX_HOOK_RESPONSE_BODY_BYTES,
  MAX_INFLIGHT_BYTES,
  MAX_INGRESS_BYTES,
  MAX_PENDING_CLAIMS_PER_DEVICE,
  MAX_PHONE_CONNECTIONS_PER_MINUTE,
  MAX_PHONE_CLIENTS_PER_DEVICE,
  MAX_UPLINK_CAPACITY_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  mediaResponseHeaders,
  phoneClientCapacityAvailable,
  RateLimiter,
  readDeviceCredentials,
  registrableDeviceId,
  relayInflightBytes,
  relayIngressStats,
  resetRelayIngressStats,
  routedClientId,
  sendToPhone,
  startRelay,
  UNDECLARED_CAPACITY_BYTES,
  uplinkCapacityFor,
  uplinkCeilings,
} from './server.mjs';
import {
  encodingAccepted,
  resolveStaticTarget,
  selectPrecompressed,
  sendStaticFile,
} from './lib/static-http.mjs';
import {
  decodeRelayBinaryFrame,
  encodeRelayBinaryFrame,
} from './lib/relay-binary-frame.mjs';

// Desktops and hook workers mint UUID device ids; fixtures use real random
// ones so nothing here passes because the value was guessable.
const DEVICE_ID = randomUUID();
const DESKTOP_AUTH = `Basic ${Buffer.from(`${DEVICE_ID}:0123456789abcdef`).toString('base64')}`;

/** A socket stand-in for the forwarding policy: records what was handed over
 *  and only "flushes" when the test says so. */
function fakePhone({ buffered = 0 } = {}) {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: buffered,
    sent: [],
    closed: null,
    send(data, callback) {
      this.sent.push(data);
      this.bufferedAmount += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      this.flush = () => {
        this.bufferedAmount = 0;
        callback?.();
      };
    },
    close(code, reason) { this.closed = { code, reason }; },
  };
}

test('precompressed siblings are negotiated and never served directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-precompressed-'));
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  const target = join(assets, 'index-AbCdEf123.css');
  writeFileSync(target, `body{color:red}${' '.repeat(2048)}`);
  writeFileSync(`${target}.br`, 'brotli-body-placeholder');
  writeFileSync(`${target}.gz`, 'gzip-body-placeholder');

  const head = (acceptEncoding, file = target) => {
    let headers = {};
    sendStaticFile(
      { method: 'HEAD', headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} },
      { writeHead(status, next) { headers = next; }, end() {}, destroy() {} },
      file,
    );
    return headers;
  };

  const brotli = head('gzip, deflate, br');
  assert.equal(brotli['Content-Encoding'], 'br');
  assert.equal(brotli['Content-Length'], statSync(`${target}.br`).size);
  assert.equal(brotli.Vary, 'Accept-Encoding');

  const gzipOnly = head('gzip');
  assert.equal(gzipOnly['Content-Encoding'], 'gzip');
  assert.equal(gzipOnly['Content-Length'], statSync(`${target}.gz`).size);

  const identity = head('');
  assert.equal(identity['Content-Encoding'], undefined);
  assert.equal(identity['Content-Length'], statSync(target).size);

  // A raw build with nothing staged beside it keeps the on-the-fly gzip path,
  // whose length is unknown until the stream ends.
  const plain = join(assets, 'plain-Zz9YyXx87.css');
  writeFileSync(plain, `body{color:blue}${' '.repeat(2048)}`);
  const live = head('br, gzip', plain);
  assert.equal(live['Content-Encoding'], 'gzip');
  assert.equal(live['Content-Length'], undefined);

  // The encoded copies answer through negotiation only: fetched directly they
  // would arrive as an undeclared encoding under the wrong content type.
  assert.equal(resolveStaticTarget(dir, '/assets/index-AbCdEf123.css.br').status, 404);
  assert.equal(resolveStaticTarget(dir, '/assets/index-AbCdEf123.css.gz').status, 404);
  assert.equal(resolveStaticTarget(dir, '/assets/index-AbCdEf123.css').status, 200);
});

/** HEAD a file through the real static handler and return its headers. */
const staticHead = (target, acceptEncoding) => {
  let headers = {};
  sendStaticFile(
    { method: 'HEAD', headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} },
    { writeHead(_status, next) { headers = next; }, end() {}, destroy() {} },
    target,
  );
  return headers;
};

test('encoding negotiation honours q=0 on staged AND live-gzip bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-negotiation-'));
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  const staged = join(assets, 'index-Q0AbCdEf1.css');
  writeFileSync(staged, `body{color:red}${' '.repeat(2048)}`);
  writeFileSync(`${staged}.gz`, 'gzip-body-placeholder');
  // No sibling beside this one on purpose: with a `.gz` present the refusal is
  // honoured by sibling SELECTION, which says nothing about the live gzip path
  // a raw build (LAN/dev server) actually runs on.
  const live = join(assets, 'live-Q0ZzYyXx9.css');
  writeFileSync(live, `body{color:blue}${' '.repeat(2048)}`);

  // q=0 is a refusal, not a weak preference: a client that says it cannot
  // decode gzip/br must never be handed an encoded body.
  assert.equal(encodingAccepted('gzip;q=0', 'gzip'), false);
  assert.equal(encodingAccepted('gzip;q=0.001', 'gzip'), true);
  assert.equal(encodingAccepted('*;q=0', 'gzip'), false);
  assert.equal(encodingAccepted('*', 'br'), true);

  // Staged sibling path.
  assert.equal(staticHead(staged, 'gzip;q=0')['Content-Encoding'], undefined);
  assert.equal(staticHead(staged, 'br;q=0, gzip;q=0')['Content-Encoding'], undefined);
  assert.equal(staticHead(staged, '*;q=0')['Content-Encoding'], undefined);
  assert.equal(staticHead(staged, 'gzip;q=0.5')['Content-Encoding'], 'gzip');

  // Live compression path: the same refusals, decided where the response body
  // is produced by createGzip instead of read off disk.
  assert.equal(selectPrecompressed(live, 'br, gzip'), null);
  const compressed = staticHead(live, 'gzip');
  assert.equal(compressed['Content-Encoding'], 'gzip');
  // Live gzip has no known length until the stream ends.
  assert.equal(compressed['Content-Length'], undefined);
  const refused = staticHead(live, 'gzip;q=0');
  assert.equal(refused['Content-Encoding'], undefined);
  assert.equal(refused['Content-Length'], statSync(live).size);
  assert.equal(staticHead(live, '*;q=0')['Content-Encoding'], undefined);
  assert.equal(staticHead(live, 'br;q=0, gzip;q=0')['Content-Encoding'], undefined);
  // br is only ever served from a staged sibling, so a br-only client on the
  // live path gets identity rather than a body it cannot decode.
  assert.equal(staticHead(live, 'br')['Content-Encoding'], undefined);
});

test('a symlinked precompressed sibling is never negotiated', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-negotiation-symlink-'));
  const outside = join(dir, 'outside');
  const assets = join(dir, 'assets');
  mkdirSync(outside);
  mkdirSync(assets);
  const target = join(assets, 'index-Sy0AbCdE1.css');
  writeFileSync(target, `body{color:red}${' '.repeat(2048)}`);
  writeFileSync(`${target}.gz`, 'gzip-body-placeholder');
  writeFileSync(join(outside, 'secret.br'), 'outside');
  try {
    symlinkSync(join(outside, 'secret.br'), `${target}.br`, 'file');
  } catch {
    // Reported as a skip, never a silent pass: the link IS the test, so a host
    // that cannot create one has verified nothing here.
    t.skip('creating a file symlink requires elevation on this host');
    return;
  }
  // A negotiated sibling never passes through resolveStaticTarget, so this
  // check is the only thing between a public asset URL and whatever the link
  // points at.
  assert.equal(selectPrecompressed(target, 'br'), null);
  assert.equal(selectPrecompressed(target, 'br, gzip').encoding, 'gzip');
  const headers = staticHead(target, 'br, gzip');
  assert.equal(headers['Content-Encoding'], 'gzip');
  assert.equal(headers['Content-Length'], statSync(`${target}.gz`).size);
});

test('static responses apply browser security headers without changing HEAD behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-static-'));
  const target = join(dir, 'index.html');
  writeFileSync(target, '<!doctype html><title>Mixdog</title>');
  let status = 0;
  let headers = {};
  let ended = false;
  sendStaticFile(
    { method: 'HEAD', headers: {} },
    {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = nextHeaders;
      },
      end() { ended = true; },
      destroy() {},
    },
    target,
  );
  assert.equal(status, 200);
  assert.equal(ended, true);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(
    headers['Content-Security-Policy'].match(/script-src[^;]*/)?.[0],
    "script-src 'self'",
  );
  assert.match(headers['Permissions-Policy'], /camera=\(self\)/);

  const assets = join(dir, 'assets');
  mkdirSync(assets);
  const hashedAsset = join(assets, 'index-AbCdEf123.js');
  writeFileSync(hashedAsset, 'export const ready = true;');
  sendStaticFile(
    { method: 'HEAD', headers: {} },
    {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = nextHeaders;
      },
      end() { ended = true; },
      destroy() {},
    },
    hashedAsset,
  );
  assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable');

  // boot.js has no content hash but is version-locked to index.html: a cached
  // copy paired with a fresh bundle mismatches the viewport projection.
  const boot = join(dir, 'boot.js');
  writeFileSync(boot, 'window.mixdogBoot = true;');
  sendStaticFile(
    { method: 'HEAD', headers: {} },
    {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = nextHeaders;
      },
      end() { ended = true; },
      destroy() {},
    },
    boot,
  );
  assert.equal(headers['Cache-Control'], 'no-cache');
});

test('inlined renderer boot script receives only its exact CSP hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-inline-boot-'));
  const source = 'window.mixdogBoot = true;';
  const target = join(dir, 'index.html');
  writeFileSync(join(dir, 'boot.js'), source);
  writeFileSync(target, `<!doctype html><script>${source}</script>`);
  let headers = {};
  sendStaticFile(
    { method: 'HEAD', headers: {} },
    {
      writeHead(_status, nextHeaders) { headers = nextHeaders; },
      end() {},
      destroy() {},
    },
    target,
  );
  const hash = createHash('sha256').update(source).digest('base64');
  assert.equal(
    headers['Content-Security-Policy'].match(/script-src[^;]*/)?.[0],
    `script-src 'self' 'sha256-${hash}'`,
  );
});

test('binary relay envelopes preserve routing metadata without base64', () => {
  const encoded = encodeRelayBinaryFrame({
    clientId: '12345678-abcd-4321-abcd-1234567890ab',
    data: Buffer.from([0, 1, 2, 255]),
    droppable: true,
  });
  const decoded = decodeRelayBinaryFrame(encoded);
  assert.equal(decoded.clientId, '12345678-abcd-4321-abcd-1234567890ab');
  assert.equal(decoded.droppable, true);
  assert.deepEqual([...decoded.data], [0, 1, 2, 255]);
});

test('static target resolution rejects symlink and junction escapes', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-relay-static-path-'));
  const root = join(base, 'renderer');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'index.html'), 'inside');
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(resolveStaticTarget(root, '/index.html').status, 200);
  assert.deepEqual(
    resolveStaticTarget(root, '/linked/secret.txt'),
    { status: 403, target: '' },
  );
});

test('renderer boot logic is self-hosted for the relay script policy', () => {
  const html = readFileSync(new URL('../desktop/src/renderer/index.html', import.meta.url), 'utf8');
  const boot = readFileSync(new URL('../desktop/src/renderer/public/boot.js', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../desktop/electron.vite.config.ts', import.meta.url), 'utf8');
  assert.match(html, /<script src="\.\/boot\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>\s*\S/);
  assert.match(boot, /mixdog\.desktop-theme-preference/);
  assert.match(boot, /mixdog-boot-error/);
  assert.match(config, /name: 'mixdog-inline-boot-script'/);
  assert.match(config, /`<script>\$\{source\}<\/script>`/);
});

test('device authentication accepts headers and rejects URL credentials', () => {
  const header = `Basic ${Buffer.from('header-device:header-secret').toString('base64')}`;
  assert.deepEqual(
    readDeviceCredentials(
      { headers: { authorization: header } },
      new URL('https://relay.example/desktop?device=query-device&secret=query-secret'),
    ),
    { deviceId: 'header-device', secret: 'header-secret' },
  );
  assert.deepEqual(
    readDeviceCredentials(
      { headers: {} },
      new URL('https://relay.example/desktop?device=query-device&secret=query-secret'),
    ),
    { deviceId: '', secret: '' },
  );
});

test('webhook relay responses enforce strict base64 and byte limits', () => {
  assert.equal(decodeHookResponseBody(Buffer.from('ok').toString('base64')).toString(), 'ok');
  assert.throws(() => decodeHookResponseBody('not base64!'), /invalid hook response body/);
  assert.throws(
    () => decodeHookResponseBody('A'.repeat(Math.ceil(MAX_HOOK_RESPONSE_BODY_BYTES / 3) * 4 + 4)),
    /invalid hook response body/,
  );
});

test('device store persists owner-only and refuses corrupt authentication state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-store-'));
  const store = new DeviceStore(dir);
  assert.equal(store.authenticate(DEVICE_ID, '0123456789abcdef'), true);
  store.setClientToken(DEVICE_ID, 'fedcba9876543210');
  store.save();
  const path = join(dir, 'devices.json');
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  assert.match(persisted[DEVICE_ID].secretHash, /^[0-9a-f]{64}$/);
  assert.match(persisted[DEVICE_ID].clientTokenHash, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, '{corrupt');
  assert.throws(() => new DeviceStore(dir), /failed to load device store/);
});

test('a new registration is persisted before the credential authenticates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-tofu-persist-'));
  const store = new DeviceStore(dir);
  const path = join(dir, 'devices.json');
  const deviceId = randomUUID();
  assert.equal(store.authenticate(deviceId, '0123456789abcdef'), true);
  // Trust-on-first-use mints a credential: it is on disk before it is honored,
  // or the desktop authenticates only until the next relay restart.
  assert.equal(existsSync(path), true);
  assert.ok(JSON.parse(readFileSync(path, 'utf8'))[deviceId]);
  assert.deepEqual([...new DeviceStore(dir).devices.keys()], [deviceId]);

  // A write that cannot land must leave nothing live behind it.
  writeFileSync(join(dir, 'blocked'), 'not a directory');
  store.path = join(dir, 'blocked', 'devices.json');
  const rejected = randomUUID();
  assert.equal(store.authenticate(rejected, '0123456789abcdef'), false);
  assert.equal(store.isKnown(rejected), false);
  // The same holds for a CHANGED pairing token.
  assert.equal(store.setClientToken(deviceId, 'fedcba9876543210'), false);
  assert.equal(store.deviceIdForClientToken('fedcba9876543210'), null);
});

test('client activity updates coalesce into one debounced rewrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-touch-debounce-'));
  const store = new DeviceStore(dir);
  const path = join(dir, 'devices.json');
  const deviceId = randomUUID();
  store.authenticate(deviceId, '0123456789abcdef');
  assert.ok(store.registerClient(deviceId, 'bbbbbbbb', {}));
  const before = statSync(path).mtimeMs;
  // lastSeenAt is not a credential: a redial stampede must not turn into one
  // whole-file synchronous rewrite per touch.
  for (let index = 0; index < 500; index += 1) {
    assert.equal(store.touchClient(deviceId, 'bbbbbbbb', {}), true);
  }
  assert.equal(statSync(path).mtimeMs, before);
  assert.ok(store.saveTimer);
  await delay(400);
  // ...and the debounced beat is what commits them, once.
  assert.equal(store.saveTimer, null);
  assert.ok(JSON.parse(readFileSync(path, 'utf8'))[deviceId].clients.bbbbbbbb.lastSeenAt > 0);
});

test('frame admission bounds every leg without stalling its neighbours', () => {
  const megabyte = 1024 * 1024;
  // An idle leg may always take one frame of any supported size: the budget
  // bounds ACCUMULATION, never the payload a supported client may send.
  assert.equal(
    admitFrame({ queued: 0, size: MAX_FRAME_BYTES, budget: 8 * megabyte, inflight: 0 }),
    'send',
  );
  // A leg that is not draining does not get another one, and the decision is
  // taken BEFORE the enqueue so nothing overshoots by a whole frame.
  assert.equal(admitFrame({ queued: 7 * megabyte, size: 2 * megabyte, budget: 8 * megabyte }), 'slow');
  assert.equal(
    admitFrame({ queued: 7 * megabyte, size: 2 * megabyte, budget: 8 * megabyte, droppable: true }),
    'drop',
  );
  assert.equal(admitFrame({ queued: 0, size: 2 * megabyte, inflight: MAX_INFLIGHT_BYTES }), 'busy');
  assert.equal(
    admitFrame({ queued: 0, size: 2 * megabyte, inflight: MAX_INFLIGHT_BYTES, droppable: true }),
    'drop',
  );

  const congested = fakePhone({ buffered: 8 * megabyte });
  const healthy = fakePhone();
  const frame = 'x'.repeat(2 * megabyte);
  const before = relayInflightBytes();
  // A droppable push to a congested leg is dropped with one resync hint...
  assert.equal(sendToPhone(congested, frame, true), false);
  assert.deepEqual(congested.sent, ['{"resync":1}']);
  assert.equal(congested.closed, null);
  // ...a critical one cuts that leg instead of queueing past its budget...
  assert.equal(sendToPhone(congested, frame, false), false);
  assert.equal(congested.closed.code, 4008);
  // ...and neither outcome touches the sibling leg.
  assert.equal(sendToPhone(healthy, frame, false), true);
  assert.equal(healthy.sent.length, 1);
  assert.equal(healthy.closed, null);
  assert.equal(relayInflightBytes(), before + Buffer.byteLength(frame));
  healthy.flush();
  assert.equal(relayInflightBytes(), before);
});

test('trust-on-first-use refuses to bind a guessable device id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-tofu-'));
  const store = new DeviceStore(dir);
  // A short, predictable id could be preclaimed before the real device dials,
  // locking its owner out of a route the attacker now holds the secret for.
  assert.equal(registrableDeviceId('00000001'), false);
  assert.equal(registrableDeviceId(randomUUID()), true);
  assert.equal(store.authenticate('00000001', '0123456789abcdef'), false);
  assert.equal(store.isKnown('00000001'), false);
  const deviceId = randomUUID();
  assert.equal(store.authenticate(deviceId, '0123456789abcdef'), true);
  assert.equal(store.authenticate(deviceId, 'wrong-secret-value'), false);
});

test('a revocation that cannot be persisted is reported as a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-revoke-persist-'));
  const store = new DeviceStore(dir);
  const deviceId = randomUUID();
  assert.equal(store.authenticate(deviceId, '0123456789abcdef'), true);
  store.setClientToken(deviceId, 'fedcba9876543210');
  store.save();
  // Persistence is the durability boundary for Unpair: a write that cannot
  // land must not be acknowledged, or the credential returns after a restart.
  writeFileSync(join(dir, 'blocked'), 'not a directory');
  store.path = join(dir, 'blocked', 'devices.json');
  assert.equal(store.revoke(deviceId), false);
  assert.equal(store.isKnown(deviceId), true);
  assert.equal(store.deviceIdForClientToken('fedcba9876543210'), deviceId);
});

test('desktop media metadata cannot make the relay origin serve active content', () => {
  const headers = mediaResponseHeaders({
    'content-type': 'image/svg+xml',
    'content-length': 12,
    'set-cookie': 'session=stolen',
    'content-security-policy': "default-src *",
  });
  assert.equal(headers['Content-Type'], 'application/octet-stream');
  assert.equal(headers['Content-Length'], '12');
  assert.equal(headers['Set-Cookie'], undefined);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Content-Disposition'], 'attachment');
  assert.equal(headers['Content-Security-Policy'], "default-src 'none'; sandbox");
  const passthrough = mediaResponseHeaders({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes' });
  assert.equal(passthrough['Content-Type'], 'video/mp4');
  assert.equal(passthrough['Accept-Ranges'], 'bytes');
});

test('browser credentials are isolated per desktop and individually revocable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-browser-store-'));
  const store = new DeviceStore(dir);
  assert.equal(store.authenticate(DEVICE_ID, '0123456789abcdef'), true);
  store.setClientToken(DEVICE_ID, 'fedcba9876543210');
  const first = store.registerClient(DEVICE_ID, 'bbbbbbbb', {
    name: 'iPhone · Safari',
    platform: 'iPhone',
    browser: 'Safari',
  });
  const second = store.registerClient(DEVICE_ID, 'cccccccc', {
    name: 'Windows · Edge',
    platform: 'Windows',
    browser: 'Edge',
  });
  assert.equal(store.clientAccessForToken(first.token)?.clientId, 'bbbbbbbb');
  assert.equal(store.clientAccessForToken(second.token)?.clientId, 'cccccccc');
  assert.equal(
    store.listClients(DEVICE_ID, new Set(['bbbbbbbb']))
      .find((row) => row.id === 'bbbbbbbb')?.online,
    true,
  );
  assert.equal(store.revokeClient(DEVICE_ID, 'bbbbbbbb'), true);
  assert.equal(store.clientAccessForToken(first.token), null);
  assert.equal(store.clientAccessForToken(second.token)?.deviceId, DEVICE_ID);
  store.save();
  const restored = new DeviceStore(dir);
  assert.deepEqual(restored.listClients(DEVICE_ID, new Set()).map((row) => row.id), ['cccccccc']);
});

test('browser registration exchanges a pairing token for an individual credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-browser-http-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  try {
    relay.store.authenticate(DEVICE_ID, '0123456789abcdef');
    relay.store.setClientToken(DEVICE_ID, 'fedcba9876543210');
    const origin = `http://127.0.0.1:${relay.port}`;
    const response = await fetch(`${origin}/client/register?token=fedcba9876543210`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'bbbbbbbb',
        name: 'Android · Chrome',
        platform: 'Android',
        browser: 'Chrome',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(relay.store.clientAccessForToken(body.token), {
      deviceId: DEVICE_ID,
      clientId: 'bbbbbbbb',
    });
  } finally {
    await relay.close();
  }
});

test('per-device browser capacity preserves normal clients and bounds floods', () => {
  assert.equal(MAX_PHONE_CLIENTS_PER_DEVICE, 32);
  assert.equal(phoneClientCapacityAvailable(0), true);
  assert.equal(phoneClientCapacityAvailable(MAX_PHONE_CLIENTS_PER_DEVICE - 1), true);
  assert.equal(phoneClientCapacityAvailable(MAX_PHONE_CLIENTS_PER_DEVICE), false);
  assert.equal(MAX_PHONE_CONNECTIONS_PER_MINUTE, 120);
  const limiter = new RateLimiter(2, 60_000);
  assert.equal(limiter.allow('device-a'), true);
  assert.equal(limiter.allow('device-a'), true);
  assert.equal(limiter.allow('device-a'), false);
});

test('installability assets bypass the pairing gate; the app shell never does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-public-assets-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  writeFileSync(join(renderer, 'manifest.webmanifest'), '{"name":"Mixdog"}');
  writeFileSync(join(renderer, 'mixdog-192.png'), 'png');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  try {
    const origin = `http://127.0.0.1:${relay.port}`;
    // Browsers fetch the manifest and its icons without cookies; a 401 there
    // silently breaks "install app" into an icon-less shortcut.
    assert.equal((await fetch(`${origin}/manifest.webmanifest`)).status, 200);
    assert.equal((await fetch(`${origin}/mixdog-192.png`)).status, 200);
    assert.equal((await fetch(`${origin}/`)).status, 401);
    assert.equal((await fetch(`${origin}/index.html`)).status, 401);
  } finally {
    await relay.close();
  }
});

test('a malformed media path answers 400 and leaves the relay serving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-bad-encoding-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  try {
    const origin = `http://127.0.0.1:${relay.port}`;
    // Percent-decoding throws on this input, and the request is
    // unauthenticated: it must become a response, never a crash loop for the
    // whole fleet.
    assert.equal((await fetch(`${origin}/media/%`)).status, 400);
    assert.equal((await fetch(`${origin}/media/%ZZ`)).status, 400);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  } finally {
    await relay.close();
  }
});

test('an unknown query token is never persisted as the pairing cookie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-fixation-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  writeFileSync(join(renderer, 'manifest.webmanifest'), '{"name":"Mixdog"}');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const origin = `http://127.0.0.1:${relay.port}`;
    // A public asset link carrying someone else's token would otherwise plant
    // an HttpOnly session cookie the visitor can neither see nor clear.
    const planted = await fetch(`${origin}/manifest.webmanifest?token=${'f'.repeat(64)}`);
    assert.equal(planted.status, 200);
    assert.equal(String(planted.headers.get('set-cookie') || '').includes('mixdog_token'), false);
    const paired = await fetch(`${origin}/manifest.webmanifest?token=${registered.token}`);
    assert.match(String(paired.headers.get('set-cookie')), /mixdog_token=/);
  } finally {
    await relay.close();
  }
});

test('the device route opens the shell and aims its manifest back at that route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-device-route-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  writeFileSync(
    join(renderer, 'manifest.webmanifest'),
    JSON.stringify({ id: '/', name: 'Mixdog', start_url: '/', scope: '/' }),
  );
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  try {
    relay.store.authenticate(DEVICE_ID, '0123456789abcdef');
    const origin = `http://127.0.0.1:${relay.port}`;
    // A route naming a desktop this relay never registered reveals nothing.
    assert.equal((await fetch(`${origin}/d/cccccccc/`)).status, 401);
    // Nor does the bare app shell: it is for approved browsers only.
    assert.equal((await fetch(`${origin}/`)).status, 401);
    const shell = await fetch(`${origin}/d/${DEVICE_ID}/`);
    assert.equal(shell.status, 200);
    // The cookie carries the route across the root asset requests that follow.
    assert.match(String(shell.headers.get('set-cookie')), new RegExp(`mixdog_device=${DEVICE_ID}`));
    const manifest = await (await fetch(`${origin}/d/${DEVICE_ID}/manifest.webmanifest`)).json();
    // An install captures start_url, so it is what tells the installed app
    // which desktop to ask for approval.
    assert.equal(manifest.start_url, `/d/${DEVICE_ID}/`);
    assert.equal(manifest.scope, `/d/${DEVICE_ID}/`);
    assert.equal(manifest.id, `/d/${DEVICE_ID}/`);
  } finally {
    await relay.close();
  }
});

test('an approval mints the credential; the relay only routes the request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-claim-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  const origin = `http://127.0.0.1:${relay.port}`;
  const publicKey = 'k'.repeat(87);
  let desktop = null;
  try {
    relay.store.authenticate(DEVICE_ID, '0123456789abcdef');
    desktop = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: DESKTOP_AUTH },
    });
    await new Promise((opened, failed) => {
      desktop.once('open', opened);
      desktop.once('error', failed);
    });
    const forwarded = new Promise((received) => {
      desktop.on('message', (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        if (value.type === 'client-claim') received(value);
      });
    });
    const started = await fetch(`${origin}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        clientId: 'bbbbbbbb',
        publicKey,
        name: 'iPhone · Web app',
      }),
    });
    assert.equal(started.status, 202);
    const { claimId } = await started.json();
    const request = await forwarded;
    assert.equal(request.claimId, claimId);
    assert.equal(request.clientId, 'bbbbbbbb');
    assert.equal(request.publicKey, publicKey);
    assert.ok(request.expiresAt > Date.now());
    assert.ok(request.expiresAt <= Date.now() + CLAIM_TTL_MS);
    // Pending means pending: no credential exists before the desktop answers.
    assert.equal((await (await fetch(`${origin}/claim/${claimId}`)).json()).status, 'pending');
    desktop.send(JSON.stringify({ type: 'claim-approve', claimId, sealed: { box: 'opaque' } }));
    let answer = { status: 'pending' };
    for (let attempt = 0; attempt < 40 && answer.status === 'pending'; attempt += 1) {
      await delay(25);
      answer = await (await fetch(`${origin}/claim/${claimId}`)).json();
    }
    assert.equal(answer.status, 'approved');
    assert.match(answer.token, /^[0-9a-f]{64}$/);
    // The relay forwards the sealed material without a key to open it.
    assert.deepEqual(answer.sealed, { box: 'opaque' });
    assert.equal(relay.store.deviceIdForClientToken(answer.token), DEVICE_ID);
    // One-shot: the credential leaves this relay exactly once.
    assert.equal((await (await fetch(`${origin}/claim/${claimId}`)).json()).status, 'expired');
  } finally {
    try { desktop?.close(); } catch { /* already closed */ }
    await relay.close();
  }
});

test('a reopened request resumes instead of prompting the desktop again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-claim-resume-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  const origin = `http://127.0.0.1:${relay.port}`;
  let desktop = null;
  try {
    relay.store.authenticate(DEVICE_ID, '0123456789abcdef');
    desktop = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: DESKTOP_AUTH },
    });
    await new Promise((opened, failed) => {
      desktop.once('open', opened);
      desktop.once('error', failed);
    });
    let prompts = 0;
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'client-claim') prompts += 1;
    });
    const claim = (publicKey) => fetch(`${origin}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ deviceId: DEVICE_ID, clientId: 'bbbbbbbb', publicKey }),
    }).then((response) => response.json());
    // A phone that reloads mid-approval re-sends the same request; the user is
    // already looking at that prompt, so it must not raise another.
    const first = await claim('k'.repeat(87));
    const again = await claim('k'.repeat(87));
    assert.equal(again.claimId, first.claimId);
    // A different container is a different request and does get its own.
    const other = await claim('m'.repeat(87));
    assert.notEqual(other.claimId, first.claimId);
    await delay(120);
    assert.equal(prompts, 2);
  } finally {
    try { desktop?.close(); } catch { /* already closed */ }
    await relay.close();
  }
});

test('a claim for an unknown desktop is refused and never reaches a leg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-claim-unknown-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  const origin = `http://127.0.0.1:${relay.port}`;
  try {
    const refused = await fetch(`${origin}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        deviceId: 'dddddddd',
        clientId: 'bbbbbbbb',
        publicKey: 'k'.repeat(87),
      }),
    });
    assert.equal(refused.status, 404);
    // Cross-origin callers cannot open a claim at all.
    const crossOrigin = await fetch(`${origin}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({
        deviceId: 'dddddddd',
        clientId: 'bbbbbbbb',
        publicKey: 'k'.repeat(87),
      }),
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await relay.close();
  }
});

test('phone /ws accepts only per-browser credentials; others close 4005', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-ws-4005-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  try {
    relay.store.authenticate(DEVICE_ID, '0123456789abcdef');
    relay.store.setClientToken(DEVICE_ID, 'fedcba9876543210');
    const origin = `http://127.0.0.1:${relay.port}`;
    const closeOf = (tokenValue) => new Promise((resolveClose, rejectClose) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${tokenValue}`, {
        headers: { Origin: origin },
      });
      ws.on('close', (code) => resolveClose(code));
      ws.on('error', rejectClose);
    });
    // Legacy shared bootstrap tokens and unknown tokens are not retryable:
    // the phone must drop its pairing and rescan.
    assert.equal(await closeOf('fedcba9876543210'), 4005);
    assert.equal(await closeOf('0123456789abcdef0123456789abcdef'), 4005);
    // A real per-browser credential with the desktop offline is retryable —
    // plain HTTP rejection, never the 4005 rescan close.
    const registered = relay.store.registerClient(DEVICE_ID, 'bbbbbbbb', {});
    await assert.rejects(closeOf(registered.token), /401/);
  } finally {
    await relay.close();
  }
});

test('phone websocket survives a desktop leg redial and is re-announced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-redial-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  const sockets = [];
  const openSocket = (url, options) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const nextClientOpen = (ws) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('client-open timed out')), 2_000);
    const onMessage = (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type !== 'client-open') return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(value.clientId);
    };
    ws.on('message', onMessage);
  });
  try {
    relay.store.authenticate(DEVICE_ID, '0123456789abcdef');
    const registered = relay.store.registerClient(DEVICE_ID, 'bbbbbbbb', {});
    const desktopUrl = `ws://127.0.0.1:${relay.port}/desktop`;
    const desktopOptions = { headers: { Authorization: DESKTOP_AUTH } };
    const firstDesktop = await openSocket(desktopUrl, desktopOptions);
    const firstOpen = nextClientOpen(firstDesktop);
    const phone = await openSocket(
      `ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`,
      { headers: { Origin: `http://127.0.0.1:${relay.port}` } },
    );
    const relayClientId = await firstOpen;
    let phoneClosed = false;
    phone.once('close', () => { phoneClosed = true; });

    firstDesktop.close();
    await delay(100);
    assert.equal(phoneClosed, false);

    const secondDesktop = new WebSocket(desktopUrl, desktopOptions);
    sockets.push(secondDesktop);
    const secondOpen = nextClientOpen(secondDesktop);
    await new Promise((resolve, reject) => {
      secondDesktop.once('open', resolve);
      secondDesktop.once('error', reject);
    });
    assert.equal(await secondOpen, relayClientId);
    await delay(100);
    assert.equal(phoneClosed, false);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

const basicAuth = (deviceId, secret = '0123456789abcdef') =>
  `Basic ${Buffer.from(`${deviceId}:${secret}`).toString('base64')}`;

const openWebSocket = (url, options) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, options);
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});

/** The phone shim's dispatch for a CLEARTEXT frame, in its own order
 *  (apps/desktop/src/renderer/remote-shim.ts:1195-1246). Only `pong` and
 *  `resync` are handled before decryption; everything else is fed to
 *  decryptJson, which throws for cleartext and closes the socket. An E2EE phone
 *  therefore DISCONNECTS on any refusal that does not ride one of these keys —
 *  which is what a plain `{type:'frame-too-large'}` control frame did. */
const shimCleartextBranch = (frame) => {
  if (frame && typeof frame === 'object' && 'pong' in frame) return 'pong';
  if (frame && typeof frame === 'object' && 'resync' in frame) return 'resync';
  return 'decrypt';
};

test('an oversize frame is a payload error both phone kinds surface', async () => {
  // The default ceiling matches the desktop leg's own budget, so gallery
  // originals still cross as single RPC frames while its media lane is off.
  assert.equal(MAX_FRAME_BYTES, 64 * 1024 * 1024);
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-oversize-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 1024 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    let forwarded = 0;
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') forwarded += 1;
    });
    const received = [];
    const refusal = new Promise((resolve) => {
      phone.on('message', (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        received.push(value);
        if (value.error === 'frame-too-large') resolve(value);
      });
    });
    phone.send(JSON.stringify({ big: 'x'.repeat(4096) }));
    const error = await refusal;
    assert.ok(error.bytes > error.limit);
    assert.equal(error.limit, 1024);
    // The refusal has to reach a phone that is ENCRYPTED as well as a raw one:
    // it rides the one cleartext key the shim already understands, so an older
    // build recovers with a resync instead of closing the socket, and a build
    // that reads `error` fails the oversize call with a payload error.
    assert.equal(error.resync, 1);
    assert.equal(shimCleartextBranch(error), 'resync');
    // The leg survives: cutting the socket would surface as "relay
    // disconnected" for the whole session over one bad frame.
    phone.send(JSON.stringify({ small: 1 }));
    await delay(150);
    assert.equal(forwarded, 1);
    assert.equal(phone.readyState, WebSocket.OPEN);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    // Exactly one refusal for one bad frame.
    assert.equal(received.filter((value) => value.error === 'frame-too-large').length, 1);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('an oversize desktop frame is answered on that leg and names the client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-oversize-desktop-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 4096 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const notices = [];
    let clientId = '';
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'client-open') clientId = value.clientId;
      if (value.type === 'frame-too-large') notices.push(value);
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    let delivered = 0;
    phone.on('message', () => { delivered += 1; });
    for (let attempt = 0; attempt < 40 && !clientId; attempt += 1) await delay(25);
    assert.match(clientId, /^[0-9a-f-]{8,64}$/);

    // The phone that made this call is still waiting for an answer, so the
    // refusal has to name the leg it belongs to: only the desktop can produce
    // an answer that phone is able to decrypt.
    desktop.send(JSON.stringify({ type: 'frame', clientId, data: 'y'.repeat(8192) }));
    for (let attempt = 0; attempt < 40 && notices.length < 1; attempt += 1) await delay(25);
    assert.equal(notices[0].clientId, clientId);
    assert.ok(notices[0].bytes > notices[0].limit);
    assert.equal(notices[0].limit, 4096);

    // Binary envelopes carry the id in a 6-byte header, so it is readable
    // without decoding an oversize payload.
    desktop.send(encodeRelayBinaryFrame({ clientId, data: Buffer.alloc(8192, 1) }));
    for (let attempt = 0; attempt < 40 && notices.length < 2; attempt += 1) await delay(25);
    assert.equal(notices[1].clientId, clientId);

    // Neither leg is dropped, and nothing oversize reached the phone.
    assert.equal(delivered, 0);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a frame past the ceiling is refused while it is still arriving, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-oversize-early-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 64 * 1024,
    // Transport capacity, the point past which ws destroys the socket instead
    // of delivering anything.
    maxPayloadBytes: 256 * 1024,
    ingressWindowBytes: 8 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    let forwarded = 0;
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') forwarded += 1;
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });
    let closeCode = null;
    phone.on('close', (code) => { closeCode = code; });
    // This leg states what its receiver takes, so the ceiling below is this
    // relay's own policy rather than the floor an undeclared leg is held to.
    await declareDesktopLanes(desktop, { maxPayloadBytes: 1024 * 1024 });
    // Half a frame proves the timing. The meter reads the payload length
    // DECLARED in the WebSocket header, so a message the transport can never
    // carry is answered while most of it is still on the wire. That is the only
    // moment anything can be said about it: ws destroys such a socket with
    // 1009, and the user is told nothing but "relay disconnected".
    const oversize = 4 * 1024 * 1024;
    const { header, masked } = maskedTextFrame('x'.repeat(oversize));
    phone._socket.write(Buffer.concat([header, masked.subarray(0, 64 * 1024)]));
    for (let attempt = 0; attempt < 80 && refusals.length < 1; attempt += 1) await delay(25);
    assert.equal(refusals.length, 1);
    // Like for like: application payload bytes against the application limit,
    // and the size declared for this message rather than the part that landed.
    assert.equal(refusals[0].bytes, oversize);
    assert.equal(refusals[0].limit, 64 * 1024);
    // Nothing was delivered, and nothing ever will be.
    assert.equal(forwarded, 0);
    for (let attempt = 0; attempt < 80 && closeCode === null; attempt += 1) await delay(25);
    // The refusal precedes the transport's own answer, and is not repeated.
    assert.equal(closeCode, 1009);
    assert.equal(refusals.length, 1);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a frame at exactly the ceiling is forwarded, never warned about', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-exact-limit-'));
  const limit = 64 * 1024;
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: limit });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const arrived = [];
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') arrived.push(value.data);
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });

    // A leg that states its receiver is held to this relay's policy ceiling.
    await declareDesktopLanes(desktop, { maxPayloadBytes: 1024 * 1024 });
    // Exactly at the ceiling is SUPPORTED traffic. A meter counting raw wire
    // bytes charges this frame its 14-byte header and mask key too, warns the
    // desktop about a payload that was never oversize, and forwards it anyway.
    const exact = 'e'.repeat(limit);
    phone.send(exact);
    for (let attempt = 0; attempt < 40 && arrived.length < 1; attempt += 1) await delay(25);
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0], exact);
    assert.deepEqual(refusals, []);

    // One byte over is refused, once, with numbers the desktop can compare
    // against the size it recorded for the call.
    phone.send('e'.repeat(limit + 1));
    for (let attempt = 0; attempt < 40 && refusals.length < 1; attempt += 1) await delay(25);
    await delay(200);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].bytes, limit + 1);
    assert.equal(refusals[0].limit, limit);
    assert.equal(arrived.length, 1);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a nested clientId in the payload never attributes a refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-oversize-spoof-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 4096 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const notices = [];
    const opened = new Promise((resolve) => {
      desktop.on('message', (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        if (value.type === 'client-open') resolve(value.clientId);
        if (value.type === 'frame-too-large') notices.push(value);
      });
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const clientId = await opened;
    // A payload is attacker-shaped bytes. This one carries a `clientId` field
    // of its own, which a prefix SEARCH would report as the route.
    const nested = '{\\"clientId\\":\\"aaaaaaaa\\"}';

    // Envelope field first: the top-level id is the route, and it wins.
    desktop.send(`{"type":"frame","clientId":"${clientId}","data":"${nested}${'y'.repeat(8192)}"}`);
    for (let attempt = 0; attempt < 40 && notices.length < 1; attempt += 1) await delay(25);
    assert.equal(notices[0].clientId, clientId);

    // Payload first: the envelope's own id sits behind a payload no prefix
    // could hold, and the walk reaches it anyway because it does not stop until
    // the object closes. The id planted INSIDE the payload is never a
    // candidate — it is a nested string, not a top-level key.
    const hostile = `{"type":"frame","data":"${nested}${'y'.repeat(8192)}","clientId":"${clientId}"}`;
    desktop.send(hostile);
    for (let attempt = 0; attempt < 40 && notices.length < 2; attempt += 1) await delay(25);
    assert.equal(notices[1].clientId, JSON.parse(hostile).clientId);
    assert.equal(notices[1].clientId, clientId);
    assert.notEqual(notices[1].clientId, 'aaaaaaaa');
    // The size is still exact, so the desktop can still recognise the call.
    assert.equal(notices[1].bytes, Buffer.byteLength(hostile));
    assert.equal(notices[1].limit, 4096);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a burst of control frames pins no ingress reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-ingress-control-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    // Tiny window: if control frames counted as message bytes at all, this
    // many of them would reserve — and never give it back.
    ingressWindowBytes: 4 * 1024,
    ingressReservationBytes: 1024 * 1024,
    maxIngressBytes: 2 * 1024 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const arrived = [];
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') arrived.push(value.data);
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    await delay(100);
    resetRelayIngressStats();

    for (let index = 0; index < 50_000; index += 1) phone.ping();
    // The stream is ordered, so this frame landing means every ping ahead of
    // it has been metered.
    phone.send('after-the-burst');
    for (let attempt = 0; attempt < 400 && arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(arrived, ['after-the-burst']);

    const stats = relayIngressStats();
    // Control frames are answered by ws and never become a message: they hold
    // no memory, so they are charged nothing and pin nothing.
    assert.equal(stats.peak, 0);
    assert.equal(stats.reserved, 0);
    assert.equal(stats.waiting, 0);
    assert.equal(stats.deferrals, 0);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a message that cannot be enveloped for the desktop is refused, not delivered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-uplink-envelope-'));
  const limit = 64 * 1024;
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: limit,
    // The desktop leg's receiver, sized exactly like this relay's ceiling —
    // the shipped desktop cap (apps/desktop/src/main/remote-relay.ts).
    uplinkCapacityBytes: limit,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
      // The desktop receiver is what kills the shared leg, so the probe has it.
      maxPayload: limit,
    });
    sockets.push(desktop);
    let desktopClose = null;
    desktop.on('close', (code) => { desktopClose = code; });
    let forwarded = 0;
    desktop.on('message', (raw, isBinary) => {
      if (isBinary) { forwarded += 1; return; }
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') forwarded += 1;
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });

    // Comfortably inside the desktop's cap even after enveloping: unchanged.
    phone.send(Buffer.alloc(32 * 1024, 7));
    for (let attempt = 0; attempt < 40 && forwarded < 1; attempt += 1) await delay(25);
    assert.equal(forwarded, 1);

    // Exactly at this relay's ceiling. The routing header rides on top, so the
    // frame the relay would SEND is past the desktop receiver, which answers by
    // destroying the socket every phone on this desktop shares.
    phone.send(Buffer.alloc(limit, 9));
    for (let attempt = 0; attempt < 40 && refusals.length < 1; attempt += 1) await delay(25);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].bytes, limit);
    // The limit quoted is what would have fitted through that envelope.
    assert.ok(refusals[0].limit < limit);
    await delay(200);
    assert.equal(forwarded, 1);
    assert.equal(desktopClose, null);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);

    // Text rides a JSON envelope, whose escaping grows the message: that growth
    // is measured too, not assumed away.
    const quotes = '"'.repeat(48 * 1024);
    phone.send(quotes);
    for (let attempt = 0; attempt < 40 && refusals.length < 2; attempt += 1) await delay(25);
    assert.equal(refusals.length, 2);
    assert.equal(refusals[1].bytes, Buffer.byteLength(quotes));
    assert.ok(refusals[1].limit < Buffer.byteLength(quotes));
    await delay(150);
    assert.equal(forwarded, 1);
    assert.equal(desktopClose, null);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('messages coalesced into one read are refused at most once each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-coalesced-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 4096 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const notices = [];
    const opened = new Promise((resolve) => {
      desktop.on('message', (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        if (value.type === 'client-open') resolve(value.clientId);
        if (value.type === 'frame-too-large') notices.push(value);
      });
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const received = [];
    phone.on('message', (raw) => received.push(String(raw)));
    const clientId = await opened;

    // TCP hands over whatever has arrived, so two messages routinely land in
    // one read. Refusal state that lives on the LEG is overwritten by the
    // second message's header before the first one is delivered, and the first
    // is then refused twice.
    const oversize = `{"type":"frame","clientId":"${clientId}","data":"${'y'.repeat(5000)}"}`;
    const ordinary = `{"type":"frame","clientId":"${clientId}","data":"ok"}`;
    const first = maskedTextFrame(oversize);
    const second = maskedTextFrame(ordinary);
    desktop._socket.write(Buffer.concat([first.header, first.masked, second.header, second.masked]));

    for (let attempt = 0; attempt < 40 && received.length < 1; attempt += 1) await delay(25);
    // The ordinary message rode through untouched...
    assert.deepEqual(received, ['ok']);
    await delay(200);
    // ...and the oversize one was refused exactly once, at its own size.
    assert.equal(notices.length, 1);
    assert.equal(notices[0].bytes, Buffer.byteLength(oversize));
    assert.equal(notices[0].limit, 4096);
    assert.equal(notices[0].clientId, clientId);
    assert.equal(desktop.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a fragmented message past transport capacity is refused before the close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-fragmented-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 64 * 1024,
    maxPayloadBytes: 256 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    let closeCode = null;
    desktop.on('close', (code) => { closeCode = code; });
    const notices = [];
    const opened = new Promise((resolve) => {
      desktop.on('message', (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        if (value.type === 'client-open') resolve(value.clientId);
        if (value.type === 'frame-too-large') notices.push(value);
      });
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const clientId = await opened;

    // A message split across frames only overruns the transport on a LATER
    // fragment, so a check that looks at single frames never sees it coming and
    // the leg dies with 1009 and no explanation at all.
    const fragment = 200 * 1024;
    const head = `{"type":"frame","clientId":"${clientId}","data":"`;
    const first = maskedTextFrame(head + 'y'.repeat(fragment - head.length), { fin: false });
    const second = maskedTextFrame('z'.repeat(fragment), { opcode: 0x0, fin: true });
    desktop._socket.write(Buffer.concat([first.header, first.masked]));
    await delay(150);
    // The first fragment is within capacity: nothing to say yet.
    assert.deepEqual(notices, []);

    desktop._socket.write(Buffer.concat([second.header, second.masked]));
    for (let attempt = 0; attempt < 80 && notices.length < 1; attempt += 1) await delay(25);
    assert.equal(notices.length, 1);
    // Everything the sender declared for this message, against the application
    // ceiling it broke.
    assert.equal(notices[0].bytes, fragment * 2);
    assert.equal(notices[0].limit, 64 * 1024);
    // This message is refused while it is still arriving, and the transport
    // destroys the socket before the rest of it can land — so the only evidence
    // is the head, which cannot prove that no later top-level `clientId`
    // follows. The notice therefore names NOBODY rather than the first id it
    // saw: the desktop reads an unattributed refusal as "not mine to fail",
    // while a wrong name fails another client's call outright.
    assert.equal(notices[0].clientId, undefined);
    assert.notEqual(notices[0].clientId, clientId);
    for (let attempt = 0; attempt < 80 && closeCode === null; attempt += 1) await delay(25);
    assert.equal(closeCode, 1009);
    assert.equal(notices.length, 1);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a declared frame that never completes is not described as a message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-declared-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 4096 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    let forwarded = 0;
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') forwarded += 1;
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });

    // 5000 bytes promised, 512 handed over. A declaration is not a message: as
    // long as the transport can still carry it, nothing is refused, because
    // nothing has been said yet.
    const declared = 5000;
    const { header, masked } = maskedTextFrame('q'.repeat(declared));
    phone._socket.write(Buffer.concat([header, masked.subarray(0, 512)]));
    await delay(300);
    assert.deepEqual(refusals, []);
    assert.equal(forwarded, 0);
    assert.equal(phone.readyState, WebSocket.OPEN);

    // Completing it makes the message real, and it is refused once, at the size
    // that actually arrived.
    phone._socket.write(masked.subarray(512));
    for (let attempt = 0; attempt < 40 && refusals.length < 1; attempt += 1) await delay(25);
    await delay(150);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].bytes, declared);
    assert.equal(refusals[0].limit, 4096);
    assert.equal(forwarded, 0);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

/** Open a desktop leg and wait until the relay has taken its lane declaration
 *  (the relay answers `relay-capabilities` first, so one round trip settles). */
const declareDesktopLanes = async (desktop, lanes) => {
  desktop.send(JSON.stringify({ type: 'desktop-lanes', media: false, ...lanes }));
  await delay(120);
};

test('a desktop leg is held to the capacity it declares, not to configuration', async () => {
  // Configuration may only LOWER what a leg said about itself, and a leg that
  // has declared nothing on this connection is held to the conservative floor,
  // never to the roomiest receiver this project happens to ship.
  assert.equal(uplinkCapacityFor(64 * 1024, 128 * 1024), 64 * 1024);
  assert.equal(uplinkCapacityFor(256 * 1024, 128 * 1024), 128 * 1024);
  assert.equal(uplinkCapacityFor(undefined, 128 * 1024), UNDECLARED_CAPACITY_BYTES);
  assert.equal(
    uplinkCapacityFor(undefined, MAX_UPLINK_CAPACITY_BYTES),
    UNDECLARED_CAPACITY_BYTES,
  );
  assert.equal(uplinkCapacityFor(0, 128 * 1024), UNDECLARED_CAPACITY_BYTES);

  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-capacity-skew-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 128 * 1024,
    // Configured larger than the leg below can actually receive: version skew,
    // or simply a stale number in a unit file.
    uplinkCapacityBytes: 128 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
      // What this leg REALLY accepts.
      maxPayload: 64 * 1024,
    });
    sockets.push(desktop);
    let closeCode = null;
    desktop.on('close', (code) => { closeCode = code; });
    const arrived = [];
    desktop.on('message', (raw, isBinary) => {
      if (isBinary) arrived.push(decodeRelayBinaryFrame(raw).data.length);
    });
    await declareDesktopLanes(desktop, { maxPayloadBytes: 64 * 1024 });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });

    // At the configured capacity but past the DECLARED one: forwarding this is
    // a 1006 for every phone on that desktop, so it is a payload error here.
    phone.send(Buffer.alloc(64 * 1024, 9));
    for (let attempt = 0; attempt < 40 && refusals.length < 1; attempt += 1) await delay(25);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].bytes, 64 * 1024);
    // The ceiling is the declared capacity minus the fixed routing header.
    assert.equal(refusals[0].limit, 64 * 1024 - 42);
    await delay(200);
    assert.deepEqual(arrived, []);
    assert.equal(closeCode, null);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);

    // What the leg CAN take still flows, untouched.
    phone.send(Buffer.alloc(60 * 1024, 3));
    for (let attempt = 0; attempt < 40 && arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(arrived, [60 * 1024]);
    assert.equal(refusals.length, 1);
    assert.equal(closeCode, null);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('the refused limit is a stable property of the path, and is honoured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-stable-limit-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
    uplinkCapacityBytes: 64 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const arrived = [];
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') arrived.push(value.data);
    });
    await declareDesktopLanes(desktop, { maxPayloadBytes: 64 * 1024 });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });

    // Same size, wildly different escaping: a browser LEARNS the limit it is
    // told, so it must not depend on whatever payload happened to be refused.
    const size = 48 * 1024;
    phone.send('"'.repeat(size));
    for (let attempt = 0; attempt < 40 && refusals.length < 1; attempt += 1) await delay(25);
    phone.send('a'.repeat(size));
    for (let attempt = 0; attempt < 40 && refusals.length < 2; attempt += 1) await delay(25);
    assert.equal(refusals.length, 2);
    assert.equal(refusals[0].bytes, size);
    assert.equal(refusals[1].bytes, size);
    assert.equal(refusals[0].limit, refusals[1].limit);
    const learned = refusals[0].limit;

    // The learned number is honoured in both directions. The worst content the
    // path can be handed, at exactly that size, is carried...
    const worst = '"'.repeat(learned);
    phone.send(worst);
    for (let attempt = 0; attempt < 40 && arrived.length < 1; attempt += 1) await delay(25);
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0], worst);
    assert.equal(refusals.length, 2);

    // ...and nothing above it is, however harmless it looks. A client that
    // stops at the learned limit therefore never withholds traffic this relay
    // would have accepted, and never sends any it would refuse.
    phone.send('a'.repeat(learned + 1));
    for (let attempt = 0; attempt < 40 && refusals.length < 3; attempt += 1) await delay(25);
    assert.equal(refusals.length, 3);
    assert.equal(refusals[2].bytes, learned + 1);
    assert.equal(refusals[2].limit, learned);
    await delay(150);
    assert.equal(arrived.length, 1);
    assert.equal(phone.readyState, WebSocket.OPEN);
    assert.equal(desktop.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a declared text-frame leg carries text in the envelope that cannot inflate', async () => {
  // The arithmetic behind the handoff: 64 MiB of quotes is 128 MiB of JSON and
  // 64 MiB of NULs approaches 384 MiB, so NO fixed receiver headroom carries a
  // 64 MiB policy through a JSON envelope. The envelope with a fixed header
  // does, which is why the policy rides that one.
  const uuid = randomUUID();
  const jsonPath = uplinkCeilings({ capacity: MAX_WS_PAYLOAD_BYTES, clientId: uuid });
  assert.equal(jsonPath.binary, MAX_FRAME_BYTES);
  assert.ok(jsonPath.text < MAX_FRAME_BYTES);
  const framedPath = uplinkCeilings({
    capacity: MAX_WS_PAYLOAD_BYTES,
    clientId: uuid,
    textFrames: true,
  });
  assert.equal(framedPath.text, MAX_FRAME_BYTES);

  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-text-frames-'));
  const capacity = 256 * 1024;
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
    uplinkCapacityBytes: capacity,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const received = [];
    desktop.on('message', (raw, isBinary) => {
      if (isBinary) {
        const frame = decodeRelayBinaryFrame(raw);
        received.push({
          form: frame.text ? 'text-binary' : 'binary',
          clientId: frame.clientId,
          data: frame.text ? Buffer.from(frame.data).toString('utf8') : frame.data,
        });
        return;
      }
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') received.push({ form: 'json', data: value.data });
    });
    await declareDesktopLanes(desktop, { maxPayloadBytes: capacity, textFrames: 1 });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });

    // 100 KiB of quotes: 200 KiB as JSON — past what that envelope can promise
    // on this leg — and a flat 42 bytes of header in the one that cannot
    // inflate. It arrives whole, as text, on the leg that declared it.
    const payload = '"'.repeat(100 * 1024);
    phone.send(payload);
    for (let attempt = 0; attempt < 40 && received.length < 1; attempt += 1) await delay(25);
    assert.equal(received.length, 1);
    assert.equal(received[0].form, 'text-binary');
    assert.equal(received[0].data, payload);
    assert.deepEqual(refusals, []);

    // The text ceiling on that leg IS the binary one now, and past it the
    // refusal is still exactly one.
    phone.send('a'.repeat(capacity));
    for (let attempt = 0; attempt < 40 && refusals.length < 1; attempt += 1) await delay(25);
    await delay(150);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].bytes, capacity);
    assert.equal(refusals[0].limit, capacity - 42);
    assert.equal(received.length, 1);
    assert.equal(phone.readyState, WebSocket.OPEN);
    assert.equal(desktop.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('capacity configuration is clamped on both inputs and normalises nonsense', () => {
  const gigabyte = 1024 * 1024 * 1024;
  // Neither a peer's claim nor an operator's configuration can raise this relay
  // above the largest frame its own protocol works in.
  assert.equal(uplinkCapacityFor(gigabyte, gigabyte), MAX_UPLINK_CAPACITY_BYTES);
  assert.equal(uplinkCapacityFor(gigabyte, undefined), MAX_UPLINK_CAPACITY_BYTES);
  assert.equal(
    uplinkCapacityFor(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    MAX_UPLINK_CAPACITY_BYTES,
  );
  // An undeclared leg stays at the conservative floor however large the
  // configured clamp is: a capacity nobody declared is a capacity nobody
  // promised.
  assert.equal(UNDECLARED_CAPACITY_BYTES, 64 * 1024);
  assert.equal(uplinkCapacityFor(undefined, gigabyte), UNDECLARED_CAPACITY_BYTES);
  // Malformed values are normalised HERE, never carried onward — this is the
  // one place a capacity enters the relay, so the number every path reads is
  // the number every path publishes.
  assert.equal(uplinkCapacityFor(NaN, NaN), UNDECLARED_CAPACITY_BYTES);
  assert.equal(uplinkCapacityFor(Infinity, Infinity), UNDECLARED_CAPACITY_BYTES);
  assert.equal(uplinkCapacityFor(-1, 128 * 1024), UNDECLARED_CAPACITY_BYTES);
  assert.equal(uplinkCapacityFor(0, 128 * 1024), UNDECLARED_CAPACITY_BYTES);
  assert.equal(uplinkCapacityFor('nonsense', 128 * 1024), UNDECLARED_CAPACITY_BYTES);
  assert.equal(uplinkCapacityFor(128 * 1024, -1), 128 * 1024);
  assert.equal(uplinkCapacityFor(65_536.9, 128 * 1024), 65_536);
  // A capacity too small to carry the relay's own routing envelope is not a
  // usable declaration: it normalises up to the protocol minimum instead of
  // publishing a ceiling of zero that an empty message would still overrun.
  assert.equal(uplinkCapacityFor(10, gigabyte), 1024);
  // ...and configuration may still only LOWER what a leg said about itself.
  assert.equal(uplinkCapacityFor(256 * 1024, 128 * 1024), 128 * 1024);
  assert.equal(uplinkCapacityFor(64 * 1024, 128 * 1024), 64 * 1024);
});

test('a claim is trusted on the connection that made it, and on no other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-overstated-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 1024 * 1024 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    // This leg ENFORCES 64 KiB and CLAIMS 128 KiB: a lie, or a build whose
    // declaration drifted from its own receiver.
    const openDesktop = async ({ receives = 64 * 1024, declares = 128 * 1024 } = {}) => {
      const ws = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
        headers: { Authorization: basicAuth(deviceId) },
        maxPayload: receives,
      });
      sockets.push(ws);
      ws.send(JSON.stringify({ type: 'desktop-lanes', media: false, maxPayloadBytes: declares }));
      return ws;
    };
    const first = await openDesktop();
    let firstClosed = null;
    first.on('close', (code) => { firstClosed = code; });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    let phoneClosed = null;
    phone.on('close', (code) => { phoneClosed = code; });
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });
    await delay(150);

    // Inside the claim, past the real receiver.
    phone.send(Buffer.alloc(64 * 1024, 1));
    for (let attempt = 0; attempt < 80 && firstClosed === null; attempt += 1) await delay(25);
    // The leg dies once — a claim cannot be checked before it is used — and NO
    // client is accused for it: the relay cannot know which frame the receiver
    // refused, so it names nobody. The phone keeps the socket its session runs
    // on and its path is untouched.
    assert.ok(firstClosed !== null);
    assert.deepEqual(refusals, []);
    assert.equal(phoneClosed, null);
    assert.equal(phone.readyState, WebSocket.OPEN);

    // A claim cannot be checked before it is used, and the close that follows
    // names neither a frame nor a client — so nothing is kept from it. The
    // desktop redials and repeats the same claim: it is believed again, and it
    // dies of it again. That is the honest cost of trusting declarations only.
    // What must never happen is the verdict OUTLIVING the connection that
    // earned it: not on a leg that has declared nothing (which runs at the
    // floor), and not on the phone beside this one.
    const second = await openDesktop();
    let secondClosed = null;
    second.on('close', (code) => { secondClosed = code; });
    await delay(200);
    phone.send(Buffer.alloc(64 * 1024, 2));
    for (let attempt = 0; attempt < 80 && secondClosed === null; attempt += 1) await delay(25);
    assert.ok(secondClosed !== null);
    assert.deepEqual(refusals, []);
    assert.equal(phoneClosed, null);
    assert.equal(phone.readyState, WebSocket.OPEN);

    // An honest claim on a fresh connection is a new statement and is trusted
    // in full, with no penalty inherited from either failure before it: there
    // is nowhere in this relay for one to have been recorded.
    const third = await openDesktop({ receives: 256 * 1024, declares: 256 * 1024 });
    const recovered = [];
    third.on('message', (raw, isBinary) => {
      if (isBinary) recovered.push(decodeRelayBinaryFrame(raw).data.length);
    });
    await delay(200);
    phone.send(Buffer.alloc(64 * 1024, 3));
    for (let attempt = 0; attempt < 80 && recovered.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(recovered, [64 * 1024]);
    assert.deepEqual(refusals, []);
    assert.equal(third.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('the text envelope is acknowledged per connection, never inferred', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-text-ack-'));
  // The desktop reviewer's repro: a receiver that takes 4400 bytes and a
  // 3050-byte text message, which only fits when the wrapper is the fixed one.
  const capacity = 4400;
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
    uplinkCapacityBytes: capacity,
  });
  const sockets = [];
  const openLeg = async (deviceId, lanes) => {
    // The capabilities frame can share a read with the handshake response, so
    // the listener goes on BEFORE the socket opens or the frame is lost.
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(ws);
    const capabilities = [];
    const arrived = [];
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const frame = decodeRelayBinaryFrame(raw);
        arrived.push({
          form: frame.text ? 'text-binary' : 'binary',
          data: frame.text ? Buffer.from(frame.data).toString('utf8') : frame.data,
        });
        return;
      }
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'relay-capabilities') capabilities.push(value);
      if (value.type === 'frame') arrived.push({ form: 'json', data: value.data });
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'desktop-lanes', media: false, ...lanes }));
    await delay(150);
    return { ws, capabilities, arrived };
  };
  const openPhone = async (deviceId) => {
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });
    await delay(100);
    return { phone, refusals };
  };
  try {
    // A leg that declares nothing is answered with nothing extra: one
    // capabilities frame, and no acknowledgement to infer anything from.
    const legacyId = randomUUID();
    relay.store.authenticate(legacyId, '0123456789abcdef');
    const legacy = await openLeg(legacyId, {});
    assert.equal(legacy.capabilities.length, 1);
    assert.equal(legacy.capabilities[0].binaryFrames, 1);
    assert.equal(legacy.capabilities[0].textFrames, undefined);
    assert.equal(legacy.capabilities[0].uplinkCapacityBytes, capacity);
    assert.equal(legacy.capabilities[0].uplinkBinaryCeilingBytes, capacity - 42);
    // JSON worst case, floor((4400 - 76) / 6): the ceiling the reviewer measured.
    assert.equal(legacy.capabilities[0].uplinkTextCeilingBytes, 720);

    const legacyPhone = await openPhone(legacyId);
    legacyPhone.phone.send('t'.repeat(3050));
    for (let attempt = 0; attempt < 40 && legacyPhone.refusals.length < 1; attempt += 1) {
      await delay(25);
    }
    // Published equals enforced: the frame a fixed-wrapper guess would have
    // passed is refused at exactly the advertised ceiling, and never forwarded.
    assert.equal(legacyPhone.refusals.length, 1);
    assert.equal(legacyPhone.refusals[0].limit, legacy.capabilities[0].uplinkTextCeilingBytes);
    assert.deepEqual(legacy.arrived, []);

    // A leg that declares the text envelope is answered on that connection.
    const modernId = randomUUID();
    relay.store.authenticate(modernId, '0123456789abcdef');
    const modern = await openLeg(modernId, { textFrames: 1, maxPayloadBytes: capacity });
    assert.equal(modern.capabilities.length, 2);
    const ack = modern.capabilities[1];
    assert.equal(ack.textFrames, 1);
    assert.equal(ack.uplinkCapacityBytes, capacity);
    assert.equal(ack.uplinkBinaryCeilingBytes, capacity - 42);
    // With the acknowledgement the text path IS the binary path.
    assert.equal(ack.uplinkTextCeilingBytes, capacity - 42);

    const modernPhone = await openPhone(modernId);
    const payload = 't'.repeat(3050);
    modernPhone.phone.send(payload);
    for (let attempt = 0; attempt < 40 && modern.arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(modern.arrived, [{ form: 'text-binary', data: payload }]);
    assert.deepEqual(modernPhone.refusals, []);

    // ...and the acknowledged ceiling is what that leg enforces, too.
    modernPhone.phone.send('t'.repeat(capacity));
    for (let attempt = 0; attempt < 40 && modernPhone.refusals.length < 1; attempt += 1) {
      await delay(25);
    }
    assert.equal(modernPhone.refusals.length, 1);
    assert.equal(modernPhone.refusals[0].limit, ack.uplinkTextCeilingBytes);
    assert.equal(modern.arrived.length, 1);
    assert.equal(modern.ws.readyState, WebSocket.OPEN);
    assert.equal(legacy.ws.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a close the relay cannot attribute accuses no client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-blameless-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 1024 * 1024 });
  const sockets = [];
  const deviceId = randomUUID();
  const origin = `http://127.0.0.1:${relay.port}`;
  const openPhone = async (clientId) => {
    const registered = relay.store.registerClient(deviceId, clientId, {});
    const phone = await openWebSocket(
      `ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`,
      { headers: { Origin: origin } },
    );
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });
    return { phone, refusals };
  };
  try {
    relay.store.authenticate(deviceId, '0123456789abcdef');
    // Enforces 64 KiB, claims 128 KiB.
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
      maxPayload: 64 * 1024,
    });
    sockets.push(desktop);
    let desktopClosed = null;
    desktop.on('close', (code) => { desktopClosed = code; });
    desktop.send(JSON.stringify({
      type: 'desktop-lanes',
      media: false,
      maxPayloadBytes: 128 * 1024,
    }));
    await delay(150);
    const attacker = await openPhone('aa000001');
    const victim = await openPhone('aa000002');
    await delay(100);

    // The receiver stops reading, so both frames queue behind it. The one it
    // eventually refuses is the FIRST — while the LARGEST belongs to somebody
    // else entirely.
    desktop.pause();
    attacker.phone.send(Buffer.alloc(70 * 1024, 1));
    await delay(150);
    victim.phone.send(Buffer.alloc(100 * 1024, 2));
    await delay(200);
    desktop.resume();
    for (let attempt = 0; attempt < 80 && desktopClosed === null; attempt += 1) await delay(25);
    assert.ok(desktopClosed !== null);
    await delay(300);

    // Neither phone is accused: an accusation the relay cannot prove shrinks
    // the wrong client's path, and one client must never degrade another's.
    assert.deepEqual(victim.refusals, []);
    assert.deepEqual(attacker.refusals, []);
    assert.equal(victim.phone.readyState, WebSocket.OPEN);
    assert.equal(attacker.phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a 1009 on a leg that was only sent safe frames costs it nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-unrelated-close-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 1024 * 1024 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    // An honest leg: it takes 128 KiB and says 128 KiB.
    const openDesktop = async () => {
      const ws = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
        headers: { Authorization: basicAuth(deviceId) },
        maxPayload: 128 * 1024,
      });
      sockets.push(ws);
      const arrived = [];
      ws.on('message', (raw, isBinary) => {
        if (isBinary) arrived.push(decodeRelayBinaryFrame(raw).data.length);
      });
      ws.send(JSON.stringify({
        type: 'desktop-lanes',
        media: false,
        maxPayloadBytes: 128 * 1024,
      }));
      await delay(150);
      return { ws, arrived };
    };
    const first = await openDesktop();
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const refusals = [];
    phone.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.error === 'frame-too-large') refusals.push(value);
    });
    await delay(100);

    // Healthy traffic, all of it inside the conservative floor.
    phone.send(Buffer.alloc(32 * 1024, 1));
    for (let attempt = 0; attempt < 40 && first.arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(first.arrived, [32 * 1024]);

    // ...then this leg closes with 1009 for a reason of its own.
    first.ws.close(1009, 'unrelated');
    await delay(250);
    const second = await openDesktop();
    await delay(150);

    // A close that cannot be about the relay's uplink teaches it nothing: a
    // 100 KiB frame, far above the floor and well inside the honest
    // declaration, still flows after the redial.
    phone.send(Buffer.alloc(100 * 1024, 2));
    for (let attempt = 0; attempt < 80 && second.arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(second.arrived, [100 * 1024]);
    assert.deepEqual(refusals, []);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a critical fan-out defers what the box cannot carry and closes no healthy leg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-fanout-'));
  // Real sockets against a box budget that cannot hold this broadcast for all
  // 32 legs at once — the shape that used to close 30 of them with 4009.
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxInflightBytes: 256 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const origin = `http://127.0.0.1:${relay.port}`;
    const legs = [];
    for (let index = 0; index < MAX_PHONE_CLIENTS_PER_DEVICE; index += 1) {
      const registered = relay.store.registerClient(
        deviceId,
        index.toString(16).padStart(8, '0'),
        {},
      );
      const phone = await openWebSocket(
        `ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`,
        { headers: { Origin: origin } },
      );
      sockets.push(phone);
      const leg = { socket: phone, payloads: 0, hints: 0, closed: null };
      phone.on('message', (raw) => {
        const text = String(raw);
        if (text.startsWith('{"resync"')) leg.hints += 1;
        else leg.payloads += 1;
      });
      phone.on('close', (code) => { leg.closed = code; });
      legs.push(leg);
    }
    await delay(150);
    const baseline = relayInflightBytes();
    // Critical: a full snapshot is the recovery frame, so it is never dropped
    // silently — but the whole fan-out runs before ONE flush callback can
    // release, so the ceiling it fills is the loop's own doing.
    desktop.send(JSON.stringify({
      type: 'broadcast',
      critical: true,
      data: 'x'.repeat(120 * 1024),
    }));
    await delay(500);

    const served = legs.filter((leg) => leg.payloads > 0).length;
    const deferred = legs.filter((leg) => leg.hints > 0).length;
    // The ceiling really was reached: 2 × 120 KiB fits in 256 KiB, the rest
    // does not.
    assert.equal(served, 2);
    assert.equal(deferred, legs.length - served);
    for (const leg of legs) {
      // Every leg is still here. A deferred one was told to resync, which is
      // how it recovers the snapshot it did not get.
      assert.equal(leg.closed, null);
      assert.equal(leg.socket.readyState, WebSocket.OPEN);
    }
    assert.equal(desktop.readyState, WebSocket.OPEN);
    // Nothing leaked out of the accounting once the served legs drained.
    assert.equal(relayInflightBytes(), baseline);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('ingress admission bounds arriving frames to the box, not to leg count', async () => {
  // ws assembles a whole message before any handler runs, so the reservation
  // has to cover a leg's WORST case for reserved bytes to bound real memory.
  assert.equal(INGRESS_RESERVATION_BYTES, MAX_WS_PAYLOAD_BYTES);
  assert.equal(MAX_INGRESS_BYTES, 2 * MAX_WS_PAYLOAD_BYTES);
  assert.equal(admitIngress({ pending: 1024 }), 'read');
  assert.equal(admitIngress({ pending: 512 * 1024 }), 'reserve');
  assert.equal(
    admitIngress({ pending: 512 * 1024, reserved: MAX_INGRESS_BYTES - INGRESS_RESERVATION_BYTES }),
    'reserve',
  );
  assert.equal(admitIngress({ pending: 512 * 1024, reserved: MAX_INGRESS_BYTES }), 'wait');
  // A leg that already holds its reservation reads to the end regardless: that
  // is what keeps the pool free of half-received frames waiting on each other.
  assert.equal(
    admitIngress({ pending: 64 * 1024 * 1024, holding: true, reserved: MAX_INGRESS_BYTES }),
    'read',
  );

  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-ingress-'));
  const ceiling = 512 * 1024;
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxIngressBytes: ceiling,
    ingressReservationBytes: 256 * 1024,
    ingressWindowBytes: 16 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const payload = 'z'.repeat(1024 * 1024);
    const legCount = 8;
    const arrived = [];
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') arrived.push(value.data);
    });
    const origin = `http://127.0.0.1:${relay.port}`;
    const phones = [];
    for (let index = 0; index < legCount; index += 1) {
      const registered = relay.store.registerClient(
        deviceId,
        `aa${index.toString(16).padStart(6, '0')}`,
        {},
      );
      const phone = await openWebSocket(
        `ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`,
        { headers: { Origin: origin } },
      );
      sockets.push(phone);
      phones.push(phone);
    }
    // The receiving leg states what it takes, so these frames are bounded by
    // ingress admission alone.
    await declareDesktopLanes(desktop, { maxPayloadBytes: 8 * 1024 * 1024 });
    await delay(100);
    resetRelayIngressStats();
    // Every leg pushes a supported frame at the same moment. Without a gate
    // this is legCount × maxPayload of heap before a single handler runs.
    for (const phone of phones) phone.send(payload);
    for (let attempt = 0; attempt < 200 && arrived.length < legCount; attempt += 1) {
      await delay(25);
    }
    const stats = relayIngressStats();
    assert.equal(arrived.length, legCount);
    // Byte-for-byte: bounding memory must not cost payload fidelity.
    for (const data of arrived) assert.equal(data, payload);
    // The gate engaged — every one of these frames is far past the free
    // window, so each one had to be charged to the pool — and it never handed
    // out more than the box budget however many legs arrived together.
    assert.ok(stats.peak >= 256 * 1024);
    assert.ok(stats.peak <= ceiling);
    assert.equal(stats.reserved, 0);
    assert.equal(stats.waiting, 0);
    for (const phone of phones) assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

/** One masked client -> server WebSocket frame, header and body apart, so a
 *  test can leave it half-delivered the way a phone on a slow uplink does.
 *  `opcode`/`fin` build fragmented messages; `declared` writes a length the
 *  body does not honour, which is what a sender promising bytes it never sends
 *  looks like on the wire. */
const maskedTextFrame = (payload, { opcode = 0x1, fin = true, declared = null } = {}) => {
  const body = Buffer.from(payload, 'utf8');
  const length = declared ?? body.length;
  const first = (fin ? 0x80 : 0x00) | opcode;
  const mask = Buffer.from([0x0a, 0x0b, 0x0c, 0x0d]);
  let header;
  if (length < 126) {
    header = Buffer.from([first, 0x80 | length, ...mask]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(8);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }
  return { header, masked };
};

test('a leg parked for ingress admission waits instead of losing its frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-ingress-wait-'));
  // One reservation IS the whole pool here, so a second supported frame cannot
  // be admitted until the first lands: the wait path, driven end to end.
  const reservation = 256 * 1024;
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxIngressBytes: reservation,
    ingressReservationBytes: reservation,
    ingressWindowBytes: 16 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const arrived = [];
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') arrived.push(value.data);
    });
    const origin = `http://127.0.0.1:${relay.port}`;
    const openPhone = async (clientId) => {
      const registered = relay.store.registerClient(deviceId, clientId, {});
      const phone = await openWebSocket(
        `ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`,
        { headers: { Origin: origin } },
      );
      sockets.push(phone);
      return phone;
    };
    const stalled = await openPhone('aa000001');
    const parked = await openPhone('aa000002');
    // The receiving leg states what it takes, so these frames are bounded by
    // ingress admission alone.
    await declareDesktopLanes(desktop, { maxPayloadBytes: 8 * 1024 * 1024 });
    await delay(100);
    resetRelayIngressStats();

    const payload = 'w'.repeat(512 * 1024);
    const { header, masked } = maskedTextFrame(payload);
    // Half a frame, then silence.
    stalled._socket.write(Buffer.concat([header, masked.subarray(0, 64 * 1024)]));
    await delay(150);
    assert.equal(relayIngressStats().reserved, reservation);

    // The pool is spoken for, so this leg is PARKED: its bytes stay on its own
    // side of the wire. It is not cut, and its frame is not dropped.
    parked.send(payload);
    await delay(200);
    assert.equal(relayIngressStats().waiting, 1);
    assert.equal(arrived.length, 0);
    assert.equal(parked.readyState, WebSocket.OPEN);

    // The stalled frame completes, the parked leg is admitted next, and both
    // payloads arrive whole.
    stalled._socket.write(masked.subarray(64 * 1024));
    for (let attempt = 0; attempt < 200 && arrived.length < 2; attempt += 1) await delay(25);
    assert.equal(arrived.length, 2);
    for (const data of arrived) assert.equal(data, payload);
    const stats = relayIngressStats();
    assert.ok(stats.deferrals >= 1);
    assert.equal(stats.waiting, 0);
    assert.equal(stats.reserved, 0);
    assert.equal(stalled.readyState, WebSocket.OPEN);
    assert.equal(parked.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('webhook ingress caps bodies that are still arriving, not just landed ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-hook-cap-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxHookPending: 2 });
  const uploads = [];
  let agent = null;
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    agent = await openWebSocket(`ws://127.0.0.1:${relay.port}/hookleg`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    let forwarded = 0;
    agent.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'http') forwarded += 1;
    });
    const path = `/hook/${deviceId}/webhook/test`;
    const url = `http://127.0.0.1:${relay.port}${path}`;
    // A body that STARTS and never ends. This is the case a cap counting only
    // landed `pending` entries misses entirely: the request already holds a
    // slot, a socket and a growing buffer, and it has not reached the agent at
    // all. The write callback is the handshake — head and first chunk are on
    // the wire before the probe runs.
    const startSlowUpload = () => new Promise((resolve) => {
      const upload = httpRequest({
        hostname: '127.0.0.1',
        port: relay.port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      });
      upload.on('error', () => { /* torn down by the test */ });
      upload.on('response', (response) => { response.resume(); });
      upload.write('{"partial":', () => resolve(upload));
    });
    uploads.push(await startSlowUpload());
    uploads.push(await startSlowUpload());
    await delay(100);

    const probe = await fetch(url, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(probe.status, 503);
    assert.deepEqual(await probe.json(), { error: 'agent busy' });
    // Neither slow body ever ended, so nothing was forwarded: the cap was
    // enforced against requests that are still on the wire.
    assert.equal(forwarded, 0);

    // ...and a caller that hangs up mid-body gives its reservation back.
    for (const upload of uploads) upload.destroy();
    await delay(100);
    const accepted = fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2_000) })
      .catch(() => null);
    for (let attempt = 0; attempt < 40 && forwarded < 1; attempt += 1) await delay(25);
    assert.equal(forwarded, 1);
    await Promise.allSettled([accepted]);
  } finally {
    for (const upload of uploads) {
      try { upload.destroy(); } catch { /* already gone */ }
    }
    try { agent?.close(); } catch { /* already closed */ }
    await relay.close();
  }
});

test('pending claims give each desktop a bounded share of the pool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-claim-share-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  let desktop = null;
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    const origin = `http://127.0.0.1:${relay.port}`;
    const claim = (index) => fetch(`${origin}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        deviceId,
        clientId: 'bbbbbbbb',
        publicKey: String(index).padStart(2, '0').repeat(43),
      }),
    });
    for (let index = 0; index < MAX_PENDING_CLAIMS_PER_DEVICE; index += 1) {
      assert.equal((await claim(index)).status, 202);
    }
    // One desktop (or one caller) filling the whole 64-slot pool would lock
    // every other install out of approval until the entries expire.
    const refused = await claim(90);
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { status: 'busy' });
  } finally {
    try { desktop?.close(); } catch { /* already closed */ }
    await relay.close();
  }
});

test('a wrong secret for a KNOWN device id is charged and then refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-auth-charge-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const attempt = () => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
        headers: { Authorization: basicAuth(deviceId, 'wrong-secret-value') },
      });
      ws.on('open', () => { ws.terminate(); resolve(200); });
      ws.on('error', (error) => resolve(Number(/(\d{3})/.exec(error.message)?.[1] || 0)));
    });
    let status = 0;
    let unauthorized = 0;
    for (let index = 0; index < 80 && status !== 429; index += 1) {
      status = await attempt();
      if (status === 401) unauthorized += 1;
    }
    // A registered id must not be a free oracle: every guess is charged like
    // any other unauthenticated attempt, and the bucket runs out.
    assert.equal(status, 429);
    assert.ok(unauthorized > 0);
  } finally {
    await relay.close();
  }
});

test('a leg revocation that cannot persist keeps both the pairing and the phone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-revoke-leg-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const answerOf = (type) => new Promise((resolve) => {
      const onMessage = (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        if (value.type !== type) return;
        desktop.off('message', onMessage);
        resolve(value);
      };
      desktop.on('message', onMessage);
    });
    writeFileSync(join(dir, 'blocked'), 'not a directory');
    relay.store.path = join(dir, 'blocked', 'devices.json');

    const deviceAnswer = answerOf('device-revoked');
    desktop.send(JSON.stringify({ type: 'revoke-device' }));
    assert.equal((await deviceAnswer).ok, false);

    const clientAnswer = answerOf('client-revoked');
    desktop.send(JSON.stringify({
      type: 'revoke-client',
      requestId: 'r1',
      clientId: 'bbbbbbbb',
    }));
    assert.equal((await clientAnswer).ok, false);

    await delay(120);
    // Nothing was revoked, so nothing may be reported or closed as revoked.
    assert.equal(relay.store.isKnown(deviceId), true);
    assert.equal(relay.store.clientAccessForToken(registered.token)?.clientId, 'bbbbbbbb');
    assert.equal(phone.readyState, WebSocket.OPEN);
    assert.equal(desktop.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a proxied media answer is neutralized at the relay origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-media-wiring-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  let desktop = null;
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    desktop.on('message', (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type !== 'media-request') return;
      // A compromised or buggy desktop answering with an active type and its
      // own headers must not get either past this hop.
      desktop.send(JSON.stringify({
        type: 'media-head',
        id: value.id,
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': 5,
          'set-cookie': 'session=stolen',
          'content-security-policy': 'default-src *',
        },
      }));
      desktop.send(JSON.stringify({
        type: 'media-chunk',
        id: value.id,
        data: Buffer.from('<h1>x').toString('base64'),
      }));
      desktop.send(JSON.stringify({ type: 'media-end', id: value.id }));
    });
    desktop.send(JSON.stringify({ type: 'desktop-lanes', media: true }));
    await delay(100);
    const response = await fetch(
      `http://127.0.0.1:${relay.port}/media/${randomUUID()}?token=${registered.token}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'), 'attachment');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(String(response.headers.get('content-security-policy')), /default-src 'none'/);
    assert.equal(await response.text(), '<h1>x');
  } finally {
    try { desktop?.close(); } catch { /* already closed */ }
    await relay.close();
  }
});

// ---------------------------------------------------------------------------
// Capacity is a DECLARATION made on ONE connection, never something the relay
// infers from a failure and remembers. The repros below are the five ways the
// old inference-and-memory mechanism moved a limit nobody declared: a redial
// that restored a roomy default, an unrelated close that poisoned a later leg,
// one phone's traffic shrinking another's path, a refusal that named a client
// the router would not have used, and a raw configured value that was published
// but never enforced.
// ---------------------------------------------------------------------------

// What a leg that has declared nothing on the CURRENT connection is held to
// (server.mjs UNDECLARED_CAPACITY_BYTES), and the fixed routing header one
// client id costs in the binary envelope.
const UNDECLARED_FLOOR = UNDECLARED_CAPACITY_BYTES;
const ROUTING_HEADER = 42;

/** A phone leg plus the refusals it was sent, for the device fixtures below. */
const openPhoneLeg = async (relay, deviceId, clientId, sockets) => {
  const registered = relay.store.registerClient(deviceId, clientId, {});
  const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
    headers: { Origin: `http://127.0.0.1:${relay.port}` },
  });
  sockets.push(phone);
  const refusals = [];
  phone.on('message', (raw) => {
    let value;
    try { value = JSON.parse(String(raw)); } catch { return; }
    if (value.error === 'frame-too-large') refusals.push(value);
  });
  return { phone, refusals };
};

test('a redialed leg carries nothing it has not declared on that connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-redial-capacity-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const openDesktop = async ({ receives, declares = 0 }) => {
      const ws = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
        headers: { Authorization: basicAuth(deviceId) },
        maxPayload: receives,
      });
      sockets.push(ws);
      const arrived = [];
      ws.on('message', (raw, isBinary) => {
        if (isBinary) arrived.push(decodeRelayBinaryFrame(raw).data.length);
      });
      if (declares > 0) {
        ws.send(JSON.stringify({ type: 'desktop-lanes', media: false, maxPayloadBytes: declares }));
      }
      await delay(150);
      return { ws, arrived };
    };

    // Enforces 64 KiB, claims 128 KiB: a lie, or a build whose declaration
    // drifted from its own receiver.
    const first = await openDesktop({ receives: 64 * 1024, declares: 128 * 1024 });
    let firstClosed = null;
    first.ws.on('close', (code) => { firstClosed = code; });
    const { phone, refusals } = await openPhoneLeg(relay, deviceId, 'bbbbbbbb', sockets);
    await delay(100);

    // The claim is trusted on the connection that made it, so the frame goes
    // out and the leg dies of its own declaration. No client is accused.
    phone.send(Buffer.alloc(64 * 1024, 1));
    for (let attempt = 0; attempt < 80 && firstClosed === null; attempt += 1) await delay(25);
    assert.ok(firstClosed !== null);
    assert.deepEqual(refusals, []);

    // The replacement leg has declared NOTHING yet. Handing it the previous
    // leg's roomy default is what killed a second connection with the very same
    // frame; an undeclared connection is held to the floor instead, so the
    // phone is answered and the leg survives.
    const second = await openDesktop({ receives: 64 * 1024 });
    phone.send(Buffer.alloc(64 * 1024, 2));
    for (let attempt = 0; attempt < 80 && refusals.length < 1; attempt += 1) await delay(25);
    await delay(200);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].bytes, 64 * 1024);
    assert.equal(refusals[0].limit, UNDECLARED_FLOOR - ROUTING_HEADER);
    assert.deepEqual(second.arrived, []);
    assert.equal(second.ws.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);

    // The floor is where every connection starts — a fresh dial, a redial and a
    // relay restart alike — so losing state can never upgrade a peer's trust.
    // Nothing is held against this device either: the next leg to declare an
    // honest number is believed on the spot.
    const third = await openDesktop({ receives: 256 * 1024, declares: 256 * 1024 });
    phone.send(Buffer.alloc(64 * 1024, 3));
    for (let attempt = 0; attempt < 80 && third.arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(third.arrived, [64 * 1024]);
    assert.equal(refusals.length, 1);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('an unrelated 1009 leaves the next leg its full declared capacity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-unrelated-1009-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    // Honest all the way through: it takes 128 KiB and says 128 KiB.
    const openDesktop = async () => {
      const ws = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
        headers: { Authorization: basicAuth(deviceId) },
        maxPayload: 128 * 1024,
      });
      sockets.push(ws);
      const arrived = [];
      ws.on('message', (raw, isBinary) => {
        if (isBinary) arrived.push(decodeRelayBinaryFrame(raw).data.length);
      });
      ws.send(JSON.stringify({
        type: 'desktop-lanes',
        media: false,
        maxPayloadBytes: 128 * 1024,
      }));
      await delay(150);
      return { ws, arrived };
    };
    const first = await openDesktop();
    const { phone, refusals } = await openPhoneLeg(relay, deviceId, 'bbbbbbbb', sockets);
    await delay(100);

    // A large, entirely successful delivery: well past the conservative floor
    // and well inside what this leg declared.
    phone.send(Buffer.alloc(100 * 1024, 1));
    for (let attempt = 0; attempt < 80 && first.arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(first.arrived, [100 * 1024]);

    // ...then this connection closes with 1009 for a reason of its own. A close
    // carries no evidence of which frame a receiver refused, so remembering a
    // historical above-floor send and charging it to the NEXT connection is an
    // accusation the relay cannot make.
    first.ws.close(1009, 'unrelated');
    await delay(250);
    const second = await openDesktop();
    phone.send(Buffer.alloc(100 * 1024, 2));
    for (let attempt = 0; attempt < 80 && second.arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(second.arrived, [100 * 1024]);
    assert.deepEqual(refusals, []);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('one phone cannot shrink the path of the phone beside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-sibling-path-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    // Takes 100 KiB, claims 128 KiB.
    const openDesktop = async () => {
      const ws = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
        headers: { Authorization: basicAuth(deviceId) },
        maxPayload: 100 * 1024,
      });
      sockets.push(ws);
      const arrived = [];
      ws.on('message', (raw, isBinary) => {
        if (isBinary) arrived.push(decodeRelayBinaryFrame(raw).data.length);
      });
      ws.send(JSON.stringify({
        type: 'desktop-lanes',
        media: false,
        maxPayloadBytes: 128 * 1024,
      }));
      await delay(150);
      return { ws, arrived };
    };
    const first = await openDesktop();
    let firstClosed = null;
    first.ws.on('close', (code) => { firstClosed = code; });
    const attacker = await openPhoneLeg(relay, deviceId, 'aa000001', sockets);
    const victim = await openPhoneLeg(relay, deviceId, 'aa000002', sockets);
    await delay(100);

    // One phone sends inside the claim and past the real receiver, and the
    // shared leg dies for it.
    attacker.phone.send(Buffer.alloc(110 * 1024, 1));
    for (let attempt = 0; attempt < 80 && firstClosed === null; attempt += 1) await delay(25);
    assert.ok(firstClosed !== null);
    assert.deepEqual(attacker.refusals, []);
    assert.deepEqual(victim.refusals, []);

    // The desktop comes back with the same declaration. A frame that fits the
    // REAL path must still cross it: distrust derived from one phone's traffic
    // and applied to every phone on the device is one client degrading another.
    const second = await openDesktop();
    victim.phone.send(Buffer.alloc(80 * 1024, 2));
    for (let attempt = 0; attempt < 80 && second.arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(second.arrived, [80 * 1024]);
    assert.deepEqual(victim.refusals, []);

    // ...and the phone that caused the close keeps its own path too: no client
    // was named, so no client was punished.
    attacker.phone.send(Buffer.alloc(60 * 1024, 3));
    for (let attempt = 0; attempt < 80 && second.arrived.length < 2; attempt += 1) await delay(25);
    assert.deepEqual(second.arrived, [80 * 1024, 60 * 1024]);
    assert.deepEqual(attacker.refusals, []);
    assert.equal(victim.phone.readyState, WebSocket.OPEN);
    assert.equal(attacker.phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a refusal names the client the router itself would have used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-duplicate-key-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 4096 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const notices = [];
    const opened = new Promise((resolve) => {
      desktop.on('message', (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        if (value.type === 'client-open') resolve(value.clientId);
        if (value.type === 'frame-too-large') notices.push(value);
      });
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    const delivered = [];
    phone.on('message', (raw) => delivered.push(String(raw)));
    const clientId = await opened;
    // Two top-level `clientId` keys in one envelope. JSON routing keeps the
    // LAST one, so a scanner that stops at the first names a client this frame
    // was never going to reach — and the desktop fails somebody else's call.
    const decoy = randomUUID();
    const hostile = `{"type":"frame","clientId":"${decoy}","clientId":"${clientId}","data":"${'y'.repeat(8192)}"}`;
    assert.equal(JSON.parse(hostile).clientId, clientId);

    desktop.send(hostile);
    for (let attempt = 0; attempt < 40 && notices.length < 1; attempt += 1) await delay(25);
    assert.equal(notices.length, 1);
    // The notice and the parser agree, byte for byte.
    assert.equal(notices[0].clientId, JSON.parse(hostile).clientId);
    assert.notEqual(notices[0].clientId, decoy);
    assert.equal(notices[0].bytes, Buffer.byteLength(hostile));
    assert.equal(notices[0].limit, 4096);

    // The same envelope, small enough to deliver, routes to that very client:
    // scanner and router are one answer, not two.
    const deliverable = `{"type":"frame","clientId":"${decoy}","clientId":"${clientId}","data":"ok"}`;
    desktop.send(deliverable);
    for (let attempt = 0; attempt < 40 && delivered.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(delivered, ['ok']);
    assert.equal(notices.length, 1);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('a nonsense configured capacity is normalised once, and published equals enforced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-clamp-bypass-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
    // A stale unit file, an unparsed env var: nonsense that must be normalised
    // where it ENTERS the relay, so no later path can read the raw value.
    uplinkCapacityBytes: Number.NaN,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    // The capabilities frame can share a read with the handshake response, so
    // the listener goes on before the socket opens.
    const desktop = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
      maxPayload: 128 * 1024,
    });
    sockets.push(desktop);
    const capabilities = [];
    const arrived = [];
    desktop.on('message', (raw, isBinary) => {
      if (isBinary) {
        arrived.push(decodeRelayBinaryFrame(raw).data.length);
        return;
      }
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'relay-capabilities') capabilities.push(value);
    });
    await new Promise((resolve, reject) => {
      desktop.once('open', resolve);
      desktop.once('error', reject);
    });
    desktop.send(JSON.stringify({
      type: 'desktop-lanes',
      media: false,
      maxPayloadBytes: 128 * 1024,
    }));
    await delay(200);
    const published = capabilities.at(-1);
    // Every published number is a real number: nonsense normalised at ingest
    // cannot reach the wire, and cannot reach the enforcement path either.
    assert.equal(published.uplinkCapacityBytes, 128 * 1024);
    assert.equal(published.uplinkBinaryCeilingBytes, 128 * 1024 - ROUTING_HEADER);
    assert.equal(Number.isFinite(published.uplinkTextCeilingBytes), true);

    const { phone, refusals } = await openPhoneLeg(relay, deviceId, 'bbbbbbbb', sockets);
    await delay(100);
    // A frame at exactly the published ceiling is carried...
    phone.send(Buffer.alloc(published.uplinkBinaryCeilingBytes, 7));
    for (let attempt = 0; attempt < 80 && arrived.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(arrived, [published.uplinkBinaryCeilingBytes]);
    assert.deepEqual(refusals, []);

    // ...and one byte more is refused at that same number, never at a limit the
    // client cannot even read.
    phone.send(Buffer.alloc(published.uplinkBinaryCeilingBytes + 1, 8));
    for (let attempt = 0; attempt < 80 && refusals.length < 1; attempt += 1) await delay(25);
    await delay(150);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].limit, published.uplinkBinaryCeilingBytes);
    assert.equal(arrived.length, 1);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('an enveloped uplink message measures the same fragmented or whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-wire-bytes-'));
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    maxFrameBytes: 1024 * 1024,
  });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
      maxPayload: 128 * 1024,
    });
    sockets.push(desktop);
    const wire = [];
    desktop.on('message', (raw, isBinary) => {
      if (isBinary) { wire.push({ form: 'binary', bytes: raw.length }); return; }
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.type === 'frame') wire.push({ form: 'json', bytes: raw.length });
    });
    await declareDesktopLanes(desktop, { maxPayloadBytes: 128 * 1024 });
    const { phone, refusals } = await openPhoneLeg(relay, deviceId, 'bbbbbbbb', sockets);
    await delay(100);

    // The admission arithmetic in one number: a 5000-byte message is 5076 bytes
    // through the JSON envelope (76 bytes of wrapper around one client id) and
    // 5042 through the binary one (a 42-byte routing header). Both ceilings are
    // derived from these bases, so the bytes the relay SENDS have to match them
    // exactly — including when the phone fragments the message on the wire.
    const payload = 'y'.repeat(5000);
    phone.send(payload);
    for (let attempt = 0; attempt < 40 && wire.length < 1; attempt += 1) await delay(25);
    assert.deepEqual(wire, [{ form: 'json', bytes: 5076 }]);

    const textHead = maskedTextFrame(payload.slice(0, 2500), { fin: false });
    const textTail = maskedTextFrame(payload.slice(2500), { opcode: 0x0, fin: true });
    phone._socket.write(Buffer.concat([
      textHead.header, textHead.masked, textTail.header, textTail.masked,
    ]));
    for (let attempt = 0; attempt < 40 && wire.length < 2; attempt += 1) await delay(25);
    assert.deepEqual(wire[1], { form: 'json', bytes: 5076 });

    phone.send(Buffer.from(payload, 'utf8'));
    for (let attempt = 0; attempt < 40 && wire.length < 3; attempt += 1) await delay(25);
    assert.deepEqual(wire[2], { form: 'binary', bytes: 5042 });

    const binaryHead = maskedTextFrame(payload.slice(0, 2500), { opcode: 0x2, fin: false });
    const binaryTail = maskedTextFrame(payload.slice(2500), { opcode: 0x0, fin: true });
    phone._socket.write(Buffer.concat([
      binaryHead.header, binaryHead.masked, binaryTail.header, binaryTail.masked,
    ]));
    for (let attempt = 0; attempt < 40 && wire.length < 4; attempt += 1) await delay(25);
    assert.deepEqual(wire[3], { form: 'binary', bytes: 5042 });
    assert.deepEqual(refusals, []);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('no padding length lets a decoy id outrank the id that routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-decoy-padding-'));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), maxFrameBytes: 4096 });
  const sockets = [];
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, '0123456789abcdef');
    const registered = relay.store.registerClient(deviceId, 'bbbbbbbb', {});
    const desktop = await openWebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: { Authorization: basicAuth(deviceId) },
    });
    sockets.push(desktop);
    const notices = [];
    const opened = new Promise((resolve) => {
      desktop.on('message', (raw) => {
        let value;
        try { value = JSON.parse(String(raw)); } catch { return; }
        if (value.type === 'client-open') resolve(value.clientId);
        if (value.type === 'frame-too-large') notices.push(value);
      });
    });
    const phone = await openWebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${registered.token}`, {
      headers: { Origin: `http://127.0.0.1:${relay.port}` },
    });
    sockets.push(phone);
    let delivered = 0;
    phone.on('message', () => { delivered += 1; });
    const clientId = await opened;
    const decoy = randomUUID();
    const nextNotice = async () => {
      const wanted = notices.length + 1;
      for (let attempt = 0; attempt < 200 && notices.length < wanted; attempt += 1) await delay(25);
      assert.equal(notices.length, wanted);
      return notices[wanted - 1];
    };

    // The reviewer's shape: a decoy id first, padding that pushes the real key
    // past any window a scan might keep, then the id the router would use.
    // Every padding length gives the same answer, because the walk answers only
    // once it has reached the end of the object — there is no window to outrun,
    // so there is no length that changes the outcome.
    for (const padding of [0, 600, 4 * 1024, 64 * 1024, 512 * 1024]) {
      const frame = `{"type":"frame","clientId":"${decoy}","pad":"${'p'.repeat(padding)}",`
        + `"clientId":"${clientId}","data":"${'y'.repeat(8192)}"}`;
      desktop.send(frame);
      const notice = await nextNotice();
      // Present ⇒ authoritative: the named id IS the parser's id.
      assert.equal(notice.clientId, JSON.parse(frame).clientId);
      assert.equal(notice.clientId, clientId);
      assert.notEqual(notice.clientId, decoy);
      assert.equal(notice.bytes, Buffer.byteLength(frame));
      assert.equal(notice.limit, 4096);
    }

    // The same holds when the authoritative key sits behind the payload itself,
    // which no bounded prefix could ever contain.
    const trailing = `{"type":"frame","data":"${'y'.repeat(256 * 1024)}","clientId":"${clientId}"}`;
    desktop.send(trailing);
    assert.equal((await nextNotice()).clientId, JSON.parse(trailing).clientId);

    // A last key the relay could never route with names nobody — never the key
    // that lost. The parser would hand this frame to no client either.
    const unroutable = `{"type":"frame","clientId":"${clientId}","clientId":42,`
      + `"data":"${'y'.repeat(8192)}"}`;
    assert.equal(JSON.parse(unroutable).clientId, 42);
    desktop.send(unroutable);
    assert.equal((await nextNotice()).clientId, undefined);

    // An escape JSON does not define makes the parser reject the WHOLE frame,
    // so it routes nowhere — and a walk that merely stepped over `\q` would
    // have answered with the valid id further along the object, failing an
    // innocent client's call for a frame nobody was ever going to receive.
    const badEscape = `{"type":"frame","pad":"\\q","clientId":"${clientId}",`
      + `"data":"${'y'.repeat(8192)}"}`;
    assert.throws(() => JSON.parse(badEscape));
    desktop.send(badEscape);
    assert.equal((await nextNotice()).clientId, undefined);

    // Same for a `\u` the parser would refuse: four hex digits or nothing.
    const shortUnicode = `{"type":"frame","pad":"\\u01","clientId":"${clientId}",`
      + `"data":"${'y'.repeat(8192)}"}`;
    assert.throws(() => JSON.parse(shortUnicode));
    desktop.send(shortUnicode);
    assert.equal((await nextNotice()).clientId, undefined);

    // A legal escape is still walked through, so this rule costs nothing that
    // the parser itself would have accepted.
    const legalEscape = `{"type":"frame","pad":"\\u0041\\n\\"","clientId":"${clientId}",`
      + `"data":"${'y'.repeat(8192)}"}`;
    assert.equal(JSON.parse(legalEscape).clientId, clientId);
    desktop.send(legalEscape);
    assert.equal((await nextNotice()).clientId, clientId);

    // And a frame that is not one whole JSON object is delivered by the router
    // to nobody, so it is attributed to nobody: unresolved evidence never
    // promotes the id that happens to be readable.
    const truncated = `{"type":"frame","clientId":"${clientId}","data":"${'y'.repeat(8192)}`;
    assert.throws(() => JSON.parse(truncated));
    desktop.send(truncated);
    assert.equal((await nextNotice()).clientId, undefined);

    // Nothing oversize reached the phone and neither leg was dropped for any of
    // it: attribution is a property of the notice, not of the connection.
    assert.equal(delivered, 0);
    assert.equal(desktop.readyState, WebSocket.OPEN);
    assert.equal(phone.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
    await relay.close();
  }
});

test('attribution costs one pass over the frame, whatever shape it is', () => {
  // Attribution reads a frame the relay has already received; what it must
  // never do is let the SHAPE of that frame buy more CPU than the bytes did.
  // A search-based walk (`indexOf` per string) is quick on one long payload and
  // quadratic on a frame made of millions of short keys — 8 MiB of them stalled
  // this single-threaded process for over a minute, which is every other
  // connection on the box waiting behind one refused frame.
  const size = 8 * 1024 * 1024;
  const clientId = randomUUID();
  const decoy = randomUUID();
  // One pass over 8 MiB is tens of milliseconds; the bound is loose enough for
  // a busy CI box and still two orders of magnitude below the stall.
  const bound = 400;
  const repeatTo = (unit, total) => unit.repeat(Math.max(1, Math.floor(total / unit.length)));
  const shapes = [
    // One enormous string value: the shape a real oversize frame has.
    ['payload-string', `{"type":"frame","clientId":"${clientId}","data":"${repeatTo('y', size)}"}`],
    // One enormous number: no quotes at all, so the walk never leaves the
    // token-skipping loop.
    ['numeric-token', `{"type":"frame","clientId":"${clientId}","n":${repeatTo('9', size)}}`],
    // Millions of short keys — the crafted shape. Each one is exactly the
    // length of the routing key, so every key takes the comparison path too.
    ['many-eight-byte-keys', `{"clientId":"${decoy}",${repeatTo('"kkkkkkkk":1,', size)}`
      + `"clientId":"${clientId}","data":"x"}`],
    // Millions of routing keys: the id-validation path, every key of it.
    ['many-client-ids', `{"type":"frame",${repeatTo(`"clientId":"${decoy}",`, size)}`
      + `"clientId":"${clientId}","data":"x"}`],
  ];
  const measure = (shape, frame) => {
    const started = performance.now();
    const named = routedClientId(frame);
    const elapsed = performance.now() - started;
    console.log(`# ${shape}: ${frame.length} bytes, ${elapsed.toFixed(1)} ms -> ${named}`);
    // Bounded work, and still the routing id: cheapness is not bought with a
    // budget that would answer with whichever id it managed to reach.
    assert.equal(named, clientId, `${shape} named the wrong client`);
    assert.notEqual(named, decoy);
    return elapsed;
  };
  const timings = new Map();
  for (const [shape, text] of shapes) {
    const frame = Buffer.from(text, 'latin1');
    assert.ok(frame.length >= size, `${shape} is not a full-size frame`);
    const elapsed = measure(shape, frame);
    timings.set(shape, elapsed);
    assert.ok(elapsed < bound, `${shape} took ${elapsed.toFixed(1)} ms (bound ${bound} ms)`);
  }

  // The same crafted shape at the LARGEST frame this relay will accept. One
  // pass costs what the frame weighs, so the answer arrives in the same
  // millisecond range scaled by size — a quadratic walk would land in minutes.
  const chunk = Buffer.from(repeatTo('"kkkkkkkk":1,', size), 'latin1');
  const head = Buffer.from(`{"clientId":"${decoy}",`, 'latin1');
  const tail = Buffer.from(`"clientId":"${clientId}","data":"x"}`, 'latin1');
  const copies = Math.ceil((MAX_WS_PAYLOAD_BYTES - head.length - tail.length) / chunk.length);
  const largest = Buffer.concat([head, ...Array.from({ length: copies }, () => chunk), tail]);
  assert.ok(largest.length >= MAX_WS_PAYLOAD_BYTES);
  const largestElapsed = measure('many-eight-byte-keys@max', largest);
  assert.ok(largestElapsed < 1500, `max-size frame took ${largestElapsed.toFixed(1)} ms`);
  // ...and the cost tracks SIZE rather than shape: this frame is ~8.5x the one
  // above, so anything near that ratio is one pass, and nothing near its square
  // could hide in it.
  const growth = largestElapsed / Math.max(1, timings.get('many-eight-byte-keys'));
  assert.ok(growth < 20, `cost grew ${growth.toFixed(1)}x for 8.5x the bytes`);
});

test('browser websocket upgrades require the relay origin', () => {
  assert.equal(browserSocketOriginAllowed({
    headers: { origin: 'https://relay.example', host: 'relay.example' },
    socket: { encrypted: true },
  }), true);
  assert.equal(browserSocketOriginAllowed({
    headers: { origin: 'http://127.0.0.1:9800', host: '127.0.0.1:9800' },
    socket: { encrypted: false },
  }), true);
  assert.equal(browserSocketOriginAllowed({
    headers: { origin: 'https://evil.example', host: 'relay.example' },
    socket: { encrypted: true },
  }), false);
  assert.equal(browserSocketOriginAllowed({
    headers: { host: 'relay.example' },
    socket: { encrypted: true },
  }), false);
});
