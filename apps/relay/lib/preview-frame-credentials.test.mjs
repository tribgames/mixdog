// The preview frame allows outside https, which includes the relay's own
// origin. These tests pin what keeps that harmless: every relay cookie is
// SameSite=Lax (never None, never Domain-wide), and a cookie never counts as
// a credential on a cross-site, non-navigation or `Origin: null` request —
// exactly what a page in the opaque-origin preview frame sends.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { serveStatic } from './relay-static-gate.mjs';
import {
  cookieCredentialAllowed,
  deviceCookieHeaders,
  PAIRING_COOKIE_NAME,
  pairingCookieHeaders,
  requestCookieToken,
} from './static-http.mjs';
import { recordingResponse } from './test-recording-response.mjs';

const TOKEN = 'a'.repeat(64);
const relayRoot = fileURLToPath(new URL('..', import.meta.url));

/** Headers of a fetch/subresource from the opaque-origin preview frame. */
const FROM_PREVIEW_FRAME = {
  origin: 'null',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

test('relay cookies are SameSite=Lax, host-only, and the pairing token is HttpOnly', () => {
  for (const encrypted of [false, true]) {
    const request = { socket: { encrypted } };
    for (const header of [pairingCookieHeaders(TOKEN, request), deviceCookieHeaders('device-1', request)]) {
      const cookie = header['Set-Cookie'];
      assert.match(cookie, /; SameSite=Lax(;|$)/);
      assert.doesNotMatch(cookie, /SameSite=None|Domain=/i);
      assert.equal(/; Secure$/.test(cookie), encrypted);
    }
    assert.match(
      pairingCookieHeaders(TOKEN, request)['Set-Cookie'],
      new RegExp(`^${PAIRING_COOKIE_NAME}=[^;]+; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax`)
    );
  }
});

test('no relay code sets a cookie except through the SameSite=Lax helper', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.m?js$/.test(entry.name) && !/\.test\.m?js$/.test(entry.name)) sources.push(path);
    }
  };
  walk(relayRoot);
  const setters = sources.filter((path) => /['"]Set-Cookie['"]\s*:\s*`/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(
    setters.map((path) => path.slice(relayRoot.length).replace(/\\/g, '/')),
    ['lib/static-http.mjs']
  );
});

test('a cookie authenticates only same-origin, browser-initiated or top-level navigation requests', () => {
  const allowed = [
    {},
    { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  ];
  for (const headers of allowed) assert.equal(cookieCredentialAllowed(headers), true, JSON.stringify(headers));
  const refused = [
    FROM_PREVIEW_FRAME,
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    // The frame navigating itself (a nested frame) to a relay URL.
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
  ];
  for (const headers of refused) assert.equal(cookieCredentialAllowed(headers), false, JSON.stringify(headers));
  const cookie = `${PAIRING_COOKIE_NAME}=${TOKEN}`;
  assert.equal(requestCookieToken({ headers: { cookie } }), TOKEN);
  assert.equal(requestCookieToken({ headers: { ...FROM_PREVIEW_FRAME, cookie } }), '');
});

test('the static gate ignores the pairing cookie on a request from the preview frame', () => {
  const store = { deviceIdForClientToken: (token) => (token === TOKEN ? 'device-1' : null), isKnown: () => false };
  const limiter = { allow: () => true };
  const request = (headers) => ({
    method: 'GET',
    url: '/',
    headers: { cookie: `${PAIRING_COOKIE_NAME}=${TOKEN}`, ...headers },
    socket: {},
  });
  const framed = recordingResponse();
  serveStatic('', store, limiter, request(FROM_PREVIEW_FRAME), framed);
  assert.equal(framed.recorded[0].status, 401);
  const app = recordingResponse();
  serveStatic(
    '',
    store,
    limiter,
    request({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }),
    app
  );
  assert.notEqual(app.recorded[0].status, 401, 'the app itself still authenticates by cookie');
});
