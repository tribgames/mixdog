import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDeviceRoute, PUBLIC_APP_ASSETS, serveStatic, shareTargetShell } from './relay-static-gate.mjs';

test('device routes require a trailing slash before they can resolve relative assets', () => {
  assert.equal(parseDeviceRoute('/nope'), null);
  assert.deepEqual(parseDeviceRoute('/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
    deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    redirect: true,
    rest: '/index.html',
  });
  assert.deepEqual(parseDeviceRoute('/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/'), {
    deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    redirect: false,
    rest: '/index.html',
  });
  assert.deepEqual(parseDeviceRoute('/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/boot.js'), {
    deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    redirect: false,
    rest: '/boot.js',
  });
});

test('installability assets are the only pairing-gate exemptions', () => {
  assert.deepEqual(
    [...PUBLIC_APP_ASSETS],
    ['/manifest.webmanifest', '/mixdog.svg', '/mixdog-192.png', '/mixdog-512.png']
  );
});

test('a share POST that outran the worker reopens the app shell', () => {
  assert.equal(
    shareTargetShell('/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/share-target'),
    '/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/'
  );
  assert.equal(shareTargetShell('/share-target'), '/');
  assert.equal(shareTargetShell('/other'), '');
  const recorded = [];
  const response = {
    writeHead(status, headers) {
      recorded.push({ status, headers });
      return this;
    },
    end() {},
  };
  serveStatic(
    '',
    { deviceIdForClientToken: () => null, isKnown: () => false },
    { allow: () => true },
    { method: 'POST', url: '/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/share-target', headers: {}, socket: {} },
    response
  );
  assert.equal(recorded[0].status, 303);
  assert.equal(recorded[0].headers.Location, '/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/');
});

test('healthz is public and other writes still 405', () => {
  const recorded = [];
  const response = {
    writeHead(status, headers) {
      recorded.push({ status, headers });
      return this;
    },
    end(body) {
      recorded.at(-1).body = body;
    },
  };
  serveStatic('', {}, { allow: () => true }, { method: 'GET', url: '/healthz', headers: {}, socket: {} }, response);
  assert.equal(recorded[0].status, 200);
  assert.equal(recorded[0].body, '{"status":"ok"}');
  serveStatic('', {}, { allow: () => true }, { method: 'PUT', url: '/healthz', headers: {}, socket: {} }, response);
  assert.equal(recorded[1].status, 405);
});
