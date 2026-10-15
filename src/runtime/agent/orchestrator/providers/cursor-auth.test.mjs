import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exchangeCursorToken, resolveCursorOAuthAccessToken } from './cursor-auth.mjs';

const BINDINGS = Symbol.for('mixdog.providerAuthBindings');

const failing = (status, headers = {}, body = '') => async () => new Response(body, { status, headers });

// Binds the cursor-oauth credential file to a temp path holding an expired
// access token plus a refresh token.
function expiredCredentials(t, extra = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'cursor-auth-')), 'cursor-oauth.json');
  const exp = Math.floor(Date.now() / 1000) - 60;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  writeFileSync(
    path,
    JSON.stringify({ access_token: `h.${payload}.s`, refresh_token: 'refresh', expires_at: exp * 1000, ...extra })
  );
  const previous = globalThis[BINDINGS];
  globalThis[BINDINGS] = { ...previous, 'cursor-oauth': path };
  t.after(() => {
    globalThis[BINDINGS] = previous;
  });
}

test('Cursor token exchange marks a rejected refresh credential as reauthRequired with guidance', async () => {
  for (const [status, code] of [
    [401, 'unauthenticated'],
    [403, 'permission_denied'],
    [400, 'invalid_argument'],
  ]) {
    await assert.rejects(exchangeCursorToken('refresh', { fetchFn: failing(status, {}, 'bad token') }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.reauthRequired, true);
      assert.match(error.message, /bad token/);
      assert.match(error.message, /\/providers.*sign in again/);
      return true;
    });
  }
});

test('Cursor token exchange does not mark throttles or server failures as reauthRequired', async () => {
  await assert.rejects(exchangeCursorToken('refresh', { fetchFn: failing(429, { 'retry-after': '4' }) }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'resource_exhausted');
    assert.equal(error.retryAfterMs, 4_000);
    assert.equal(error.headers['retry-after'], '4');
    assert.equal(error.reauthRequired, undefined);
    return true;
  });
  for (const status of [500, 502, 503, 504]) {
    await assert.rejects(exchangeCursorToken('refresh', { fetchFn: failing(status) }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.reauthRequired, undefined);
      return true;
    });
  }
});

test('Cursor OAuth resolution surfaces reauthRequired only for a confirmed permanent refresh failure', async (t) => {
  expiredCredentials(t);
  await assert.rejects(
    resolveCursorOAuthAccessToken({ fetchFn: failing(401) }),
    (error) => error.reauthRequired === true && error.status === 401
  );
  await assert.rejects(
    resolveCursorOAuthAccessToken({ fetchFn: failing(503) }),
    (error) => error.status === 503 && error.reauthRequired === undefined
  );
  await assert.rejects(
    resolveCursorOAuthAccessToken({
      fetchFn: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      },
    }),
    (error) => error.reauthRequired === undefined
  );
});

test('Cursor OAuth without any refresh token requires sign-in', async (t) => {
  expiredCredentials(t, { refresh_token: null });
  await assert.rejects(
    resolveCursorOAuthAccessToken({}),
    (error) => error.reauthRequired === true && /\/providers.*sign in again/.test(error.message)
  );
});
