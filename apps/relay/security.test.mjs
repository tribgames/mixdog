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

import {
  browserSocketOriginAllowed,
  decodeHookResponseBody,
  DeviceStore,
  MAX_HOOK_RESPONSE_BODY_BYTES,
  MAX_PHONE_CONNECTIONS_PER_MINUTE,
  MAX_PHONE_CLIENTS_PER_DEVICE,
  phoneClientCapacityAvailable,
  RateLimiter,
  readDeviceCredentials,
} from './server.mjs';
import { resolveStaticTarget, sendStaticFile } from './lib/static-http.mjs';

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
