import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDeviceRoute, PUBLIC_APP_ASSETS, serveStatic, shareTargetShell } from './relay-static-gate.mjs';
import { recordingResponse } from './test-recording-response.mjs';

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
  assert.equal(shareTargetShell('/share-target?source=share#ignored'), '/');
  assert.equal(shareTargetShell('/%73hare-target'), '/');
  assert.equal(shareTargetShell('/d/aaaaaaaa/share-target'), '/d/aaaaaaaa/');
  assert.equal(shareTargetShell('/share-target%'), '');
  assert.equal(shareTargetShell('http://['), '');
  assert.equal(shareTargetShell(undefined), '');
  const response = recordingResponse();
  const { recorded } = response;
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

test('preview frame is public, sandboxed, cookie-free and frame-able only by self', () => {
  const response = recordingResponse();
  const { recorded } = response;
  serveStatic('', {}, { allow: () => true }, { method: 'GET', url: '/preview-frame', headers: {}, socket: {} }, response);
  const { status, headers, body } = recorded[0];
  assert.equal(status, 200);
  const csp = headers['Content-Security-Policy'];
  assert.match(csp, /(^|; )sandbox allow-scripts(;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(headers['Set-Cookie'], undefined);
  assert.equal(headers['X-Frame-Options'], undefined);
  assert.equal(headers['Cache-Control'], 'public, max-age=300');
  assert.match(headers['Content-Type'], /^text\/html/);
  assert.match(body, /event\.source !== window\.parent/);
  assert.match(body, /mixdog-preview-document/);
});

test('healthz is public and other writes still 405', () => {
  const response = recordingResponse();
  const { recorded } = response;
  serveStatic('', {}, { allow: () => true }, { method: 'GET', url: '/healthz', headers: {}, socket: {} }, response);
  assert.equal(recorded[0].status, 200);
  assert.equal(recorded[0].body, '{"status":"ok"}');
  serveStatic('', {}, { allow: () => true }, { method: 'PUT', url: '/healthz', headers: {}, socket: {} }, response);
  assert.equal(recorded[1].status, 405);
});
