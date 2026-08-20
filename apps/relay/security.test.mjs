import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import {
  browserSocketOriginAllowed,
  CLAIM_TTL_MS,
  decodeHookResponseBody,
  DeviceStore,
  MAX_HOOK_RESPONSE_BODY_BYTES,
  MAX_PHONE_CONNECTIONS_PER_MINUTE,
  MAX_PHONE_CLIENTS_PER_DEVICE,
  phoneClientCapacityAvailable,
  RateLimiter,
  readDeviceCredentials,
  startRelay,
} from './server.mjs';
import { resolveStaticTarget, sendStaticFile } from './lib/static-http.mjs';
import {
  decodeRelayBinaryFrame,
  encodeRelayBinaryFrame,
} from './lib/relay-binary-frame.mjs';

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
  assert.match(html, /<script src="\.\/boot\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>\s*\S/);
  assert.match(boot, /mixdog\.desktop-theme-preference/);
  assert.match(boot, /mixdog-boot-error/);
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
  assert.equal(store.authenticate('aaaaaaaa', '0123456789abcdef'), true);
  store.setClientToken('aaaaaaaa', 'fedcba9876543210');
  store.save();
  const path = join(dir, 'devices.json');
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  assert.match(persisted.aaaaaaaa.secretHash, /^[0-9a-f]{64}$/);
  assert.match(persisted.aaaaaaaa.clientTokenHash, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, '{corrupt');
  assert.throws(() => new DeviceStore(dir), /failed to load device store/);
});

test('browser credentials are isolated per desktop and individually revocable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-browser-store-'));
  const store = new DeviceStore(dir);
  assert.equal(store.authenticate('aaaaaaaa', '0123456789abcdef'), true);
  store.setClientToken('aaaaaaaa', 'fedcba9876543210');
  const first = store.registerClient('aaaaaaaa', 'bbbbbbbb', {
    name: 'iPhone · Safari',
    platform: 'iPhone',
    browser: 'Safari',
  });
  const second = store.registerClient('aaaaaaaa', 'cccccccc', {
    name: 'Windows · Edge',
    platform: 'Windows',
    browser: 'Edge',
  });
  assert.equal(store.clientAccessForToken(first.token)?.clientId, 'bbbbbbbb');
  assert.equal(store.clientAccessForToken(second.token)?.clientId, 'cccccccc');
  assert.equal(
    store.listClients('aaaaaaaa', new Set(['bbbbbbbb']))
      .find((row) => row.id === 'bbbbbbbb')?.online,
    true,
  );
  assert.equal(store.revokeClient('aaaaaaaa', 'bbbbbbbb'), true);
  assert.equal(store.clientAccessForToken(first.token), null);
  assert.equal(store.clientAccessForToken(second.token)?.deviceId, 'aaaaaaaa');
  store.save();
  const restored = new DeviceStore(dir);
  assert.deepEqual(restored.listClients('aaaaaaaa', new Set()).map((row) => row.id), ['cccccccc']);
});

test('browser registration exchanges a pairing token for an individual credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-browser-http-'));
  const renderer = join(dir, 'renderer');
  mkdirSync(renderer);
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>Mixdog</title>');
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), rendererDir: renderer });
  try {
    relay.store.authenticate('aaaaaaaa', '0123456789abcdef');
    relay.store.setClientToken('aaaaaaaa', 'fedcba9876543210');
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
      deviceId: 'aaaaaaaa',
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
    relay.store.authenticate('aaaaaaaa', '0123456789abcdef');
    const origin = `http://127.0.0.1:${relay.port}`;
    // A route naming a desktop this relay never registered reveals nothing.
    assert.equal((await fetch(`${origin}/d/cccccccc/`)).status, 401);
    // Nor does the bare app shell: it is for approved browsers only.
    assert.equal((await fetch(`${origin}/`)).status, 401);
    const shell = await fetch(`${origin}/d/aaaaaaaa/`);
    assert.equal(shell.status, 200);
    // The cookie carries the route across the root asset requests that follow.
    assert.match(String(shell.headers.get('set-cookie')), /mixdog_device=aaaaaaaa/);
    const manifest = await (await fetch(`${origin}/d/aaaaaaaa/manifest.webmanifest`)).json();
    // An install captures start_url, so it is what tells the installed app
    // which desktop to ask for approval.
    assert.equal(manifest.start_url, '/d/aaaaaaaa/');
    assert.equal(manifest.scope, '/d/aaaaaaaa/');
    assert.equal(manifest.id, '/d/aaaaaaaa/');
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
    relay.store.authenticate('aaaaaaaa', '0123456789abcdef');
    desktop = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: {
        Authorization: `Basic ${Buffer.from('aaaaaaaa:0123456789abcdef').toString('base64')}`,
      },
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
        deviceId: 'aaaaaaaa',
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
    assert.equal(relay.store.deviceIdForClientToken(answer.token), 'aaaaaaaa');
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
    relay.store.authenticate('aaaaaaaa', '0123456789abcdef');
    desktop = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
      headers: {
        Authorization: `Basic ${Buffer.from('aaaaaaaa:0123456789abcdef').toString('base64')}`,
      },
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
      body: JSON.stringify({ deviceId: 'aaaaaaaa', clientId: 'bbbbbbbb', publicKey }),
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
    relay.store.authenticate('aaaaaaaa', '0123456789abcdef');
    relay.store.setClientToken('aaaaaaaa', 'fedcba9876543210');
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
    const registered = relay.store.registerClient('aaaaaaaa', 'bbbbbbbb', {});
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
    relay.store.authenticate('aaaaaaaa', '0123456789abcdef');
    const registered = relay.store.registerClient('aaaaaaaa', 'bbbbbbbb', {});
    const desktopUrl = `ws://127.0.0.1:${relay.port}/desktop`;
    const desktopOptions = {
      headers: {
        Authorization: `Basic ${Buffer.from('aaaaaaaa:0123456789abcdef').toString('base64')}`,
      },
    };
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
