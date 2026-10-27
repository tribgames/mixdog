import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach, mock } from 'node:test';

// The login writes to the Grok credential file: keep it, and the data dir, in a
// scratch folder so a bare `node --test` never touches the signed-in account.
const dir = mkdtempSync(join(tmpdir(), 'mixdog-grok-login-'));
const credentialsPath = join(dir, 'grok-oauth.json');
process.env.MIXDOG_DATA_DIR = dir;
process.env.GROK_OAUTH_CREDENTIALS_PATH = credentialsPath;

// Credential writes would spawn icacls on Windows; no browser may ever open.
mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});
const opened = [];
mock.module(new URL('../../../shared/open-url.mjs', import.meta.url).href, {
  namedExports: { openInBrowser: (url) => opened.push(url) },
});
const { beginOAuthLogin } = await import('./grok-oauth-login.mjs');

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const readStored = () => JSON.parse(readFileSync(credentialsPath, 'utf8'));

// A fake xAI issuer: discovery, the device authorization endpoint and the token endpoint.
const xai = { device: [], token: [], deviceReply: null, tokenReply: null, base: '' };
let server;
let realFetch;

const reply = (status, body) => ({ status, body });
const deviceGrant = (extra = {}) =>
  reply(200, {
    device_code: 'device-code-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://accounts.x.ai/device',
    verification_uri_complete: 'https://accounts.x.ai/device?user_code=ABCD-1234',
    expires_in: 900,
    interval: 5,
    ...extra,
  });
const pending = () => reply(400, { error: 'authorization_pending' });
const grant = () =>
  reply(200, {
    access_token: jwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: 'refresh-1',
    expires_in: 3600,
    id_token: jwt({ sub: 'user-1', email: 'user@example.com' }),
  });
const scripted =
  (...replies) =>
  () =>
    replies.shift() ?? pending();

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const entry = {
        form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))),
        headers: req.headers,
      };
      let answer = reply(404, {});
      if (req.url === '/.well-known/openid-configuration') {
        answer = reply(200, {
          authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
          token_endpoint: TOKEN_ENDPOINT,
        });
      } else if (req.method === 'POST' && req.url === '/oauth2/device/code') {
        xai.device.push(entry);
        answer = xai.deviceReply;
      } else if (req.method === 'POST' && req.url === '/oauth2/token') {
        xai.token.push(entry);
        answer = await xai.tokenReply(xai.token.length);
      }
      // A dropped reply closes the connection with no HTTP response at all.
      if (answer.drop) return req.socket.destroy();
      res.writeHead(answer.status, { 'Content-Type': answer.contentType || 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  xai.base = `http://127.0.0.1:${server.address().port}`;
  // The issuer's https addresses are served by the fake; the system proxy
  // dispatcher the login passes along must not carry the request elsewhere.
  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const { dispatcher: _dispatcher, ...rest } = init;
    return realFetch(String(input).replace('https://auth.x.ai', xai.base), rest);
  };
});

after(() => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  xai.device.length = 0;
  xai.token.length = 0;
  xai.deviceReply = deviceGrant();
  xai.tokenReply = scripted();
  opened.length = 0;
  rmSync(credentialsPath, { force: true });
});

const instantSleep =
  (log = []) =>
  async (ms) => {
    log.push(ms);
  };

const pollInFlight = async () => {
  for (let i = 0; i < 200 && xai.token.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(xai.token.length, 1, 'a poll is in flight');
};

test('a headless start returns the device-code shape and no completeCode', async () => {
  // The first poll is held open, so the login is still pending while the shape is read.
  xai.tokenReply = () => new Promise(() => {});
  const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep() });
  try {
    assert.deepEqual(Object.keys(login).sort(), [
      'cancel',
      'manualUrl',
      'provider',
      'url',
      'userCode',
      'waitForCallback',
    ]);
    assert.equal(login.provider, 'grok-oauth');
    assert.equal(login.url, 'https://accounts.x.ai/device?user_code=ABCD-1234');
    assert.equal(login.manualUrl, null);
    assert.equal(login.userCode, 'ABCD-1234');
    assert.equal(typeof login.cancel, 'function');
    assert.equal(xai.device.length, 1);
    assert.equal(xai.device[0].form.client_id, CLIENT_ID);
    assert.equal(xai.device[0].form.scope, SCOPE);
    assert.equal(xai.device[0].headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(opened, [], 'a headless start never opens a browser');
    await pollInFlight();
  } finally {
    login.cancel();
  }
});

test('the device login completes by polling the token endpoint and stores the account', async () => {
  xai.tokenReply = scripted(pending(), reply(400, { error: 'slow_down' }), grant());
  const sleeps = [];
  const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep(sleeps) });
  const tokens = await login.waitForCallback;
  assert.equal(tokens.refresh_token, 'refresh-1');
  assert.equal(tokens.token_endpoint, TOKEN_ENDPOINT);
  assert.equal(tokens.email, 'user@example.com');
  assert.equal(tokens.user_id, 'user-1');
  assert.ok(tokens.expires_at > Date.now() + 3_500_000);
  // The first poll waits the issued interval; slow_down widens it by five seconds.
  assert.deepEqual(sleeps, [5000, 5000, 10_000]);
  assert.equal(xai.token.length, 3);
  for (const { form } of xai.token) {
    assert.deepEqual(form, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-code-1',
      client_id: CLIENT_ID,
    });
  }
  const stored = readStored();
  assert.equal(stored.access_token, tokens.access_token);
  assert.equal(stored.refresh_token, 'refresh-1');
  assert.equal(stored.token_endpoint, TOKEN_ENDPOINT);
  assert.equal(stored.email, 'user@example.com');
});

test('without verification_uri_complete the plain address is shown, and an omitted interval defaults to 5 s', async () => {
  // An omitted field and an explicit null both mean "absent", as for the vendor's Option fields.
  for (const absent of [undefined, null]) {
    xai.deviceReply = deviceGrant({ verification_uri_complete: absent, interval: absent });
    xai.tokenReply = scripted(grant());
    const sleeps = [];
    const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep(sleeps) });
    assert.equal(login.url, 'https://accounts.x.ai/device');
    assert.equal(login.userCode, 'ABCD-1234');
    await login.waitForCallback;
    assert.deepEqual(sleeps, [5000]);
  }
});

test('the poll interval is the issued integer, clamped to at least one second', async () => {
  for (const [interval, expected] of [
    [12, 12_000],
    [1, 1000],
    [0, 1000],
    [-3, 1000],
  ]) {
    xai.deviceReply = deviceGrant({ interval });
    xai.tokenReply = scripted(grant());
    const sleeps = [];
    const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep(sleeps) });
    await login.waitForCallback;
    assert.deepEqual(sleeps, [expected], `interval ${interval}`);
  }
});

test('numeric strings, fractions and a missing expires_in are malformed device responses', async () => {
  for (const [extra, field] of [
    [{ interval: '7' }, 'interval'],
    [{ interval: 7.5 }, 'interval'],
    [{ expires_in: '900' }, 'expires_in'],
    [{ expires_in: 900.5 }, 'expires_in'],
    [{ expires_in: undefined }, 'expires_in'],
  ]) {
    xai.deviceReply = deviceGrant(extra);
    await assert.rejects(
      beginOAuthLogin({ openBrowser: false, sleep: instantSleep() }),
      new RegExp(`${field} must be an integer`)
    );
  }
  assert.equal(xai.token.length, 0);
});

test('each verification address is validated on its own and an invalid one never yields to the other', async () => {
  const valid = {
    verification_uri: 'https://accounts.x.ai/device',
    verification_uri_complete: 'https://accounts.x.ai/device?user_code=ABCD-1234',
  };
  for (const [extra, message] of [
    [{ verification_uri_complete: 'http://evil.example/device' }, /unsupported verification URI scheme/],
    [{ verification_uri_complete: 'javascript:alert(1)' }, /unsupported verification URI scheme/],
    [{ verification_uri_complete: 'not a url' }, /invalid verification URI/],
    [{ verification_uri_complete: 'https://accounts.x.ai/\u001b[31m' }, /invalid verification URI/],
    [{ verification_uri_complete: 'https://accounts.x.ai/a\u007fb' }, /invalid verification URI/],
    [{ verification_uri_complete: 42 }, /verification_uri_complete must be a string/],
    [{ verification_uri: 'ftp://accounts.x.ai/device' }, /unsupported verification URI scheme/],
    [{ verification_uri: 'http://accounts.x.ai/device' }, /unsupported verification URI scheme/],
    [{ verification_uri: 'https://accounts.x.ai/\u001b[31m' }, /invalid verification URI/],
    [{ verification_uri: undefined }, /verification_uri must be a string/],
    [{ verification_uri: null }, /verification_uri must be a string/],
  ]) {
    xai.deviceReply = deviceGrant({ ...valid, ...extra });
    await assert.rejects(
      beginOAuthLogin({ openBrowser: false, sleep: instantSleep() }),
      message,
      JSON.stringify(extra)
    );
  }
  assert.equal(xai.token.length, 0);
});

test('http is accepted for loopback verification addresses only, and the complete address wins', async () => {
  for (const [uri, complete] of [
    ['http://localhost:8080/device', undefined],
    ['http://127.0.0.1:8080/device', 'http://127.0.0.1:8080/device?user_code=ABCD-1234'],
    ['https://accounts.x.ai/device', 'http://localhost/device?user_code=ABCD-1234'],
  ]) {
    xai.deviceReply = deviceGrant({ verification_uri: uri, verification_uri_complete: complete });
    xai.tokenReply = scripted(grant());
    const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep() });
    assert.equal(login.url, complete ?? uri);
    await login.waitForCallback;
  }
});

test('a denied or expired device code rejects and stores nothing', async () => {
  for (const [error, message] of [
    ['access_denied', /denied/],
    ['expired_token', /expired/],
  ]) {
    xai.tokenReply = scripted(reply(400, { error }));
    const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep() });
    await assert.rejects(login.waitForCallback, message);
    assert.equal(existsSync(credentialsPath), false);
  }
});

test('a transport or server failure while polling rejects at once, as in the Grok CLI', async () => {
  for (const [failure, message] of [
    [reply(503, 'upstream unavailable'), /device token 503: upstream unavailable/],
    [{ status: 502, body: '<html>bad gateway</html>', contentType: 'text/html' }, /device token 502: <html>/],
    [reply(500, { error: 'server_error' }), /device token 500: server_error/],
    [{ drop: true }, /device token request failed/],
  ]) {
    xai.token.length = 0;
    // A success follows the failure; it must never be reached to mask it.
    xai.tokenReply = scripted(failure, grant());
    const sleeps = [];
    const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep(sleeps) });
    await assert.rejects(login.waitForCallback, message);
    assert.equal(xai.token.length, 1, 'the poll is not retried');
    assert.deepEqual(sleeps, [5000]);
    assert.equal(existsSync(credentialsPath), false);
  }
});

test('polling stops with an expiry error once the device code deadline passes', async () => {
  xai.deviceReply = deviceGrant({ expires_in: 30 });
  xai.tokenReply = () => pending();
  let clock = 0;
  const login = await beginOAuthLogin({
    openBrowser: false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  await assert.rejects(login.waitForCallback, /device code expired/);
  // The issuer's expiry is floored to ten minutes (the Grok CLI's own rule): 120 polls, 5 s apart.
  assert.equal(xai.token.length, 120);
  assert.equal(existsSync(credentialsPath), false);
});

test('an invalid device response is rejected before anything is shown', async () => {
  for (const extra of [{ user_code: 'AB\u001b[31mCD' }, { user_code: '' }, { device_code: '' }]) {
    xai.deviceReply = deviceGrant(extra);
    await assert.rejects(beginOAuthLogin({ openBrowser: false, sleep: instantSleep() }), /invalid required fields/);
  }
  xai.deviceReply = reply(403, { error: 'access_denied' });
  await assert.rejects(beginOAuthLogin({ openBrowser: false, sleep: instantSleep() }), /device authorization 403/);
  assert.equal(xai.token.length, 0);
});

test('cancelling settles quietly, stops polling and stores nothing', async () => {
  const gate = Promise.withResolvers();
  xai.tokenReply = async () => {
    await gate.promise;
    return grant();
  };
  const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep() });
  await pollInFlight();
  login.cancel();
  assert.equal(await login.waitForCallback, null);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(xai.token.length, 1, 'no further poll after cancel');
  assert.equal(existsSync(credentialsPath), false);
});

test('an issuer without a device flow falls back to the loopback login with a pasted redirect', async () => {
  xai.deviceReply = reply(404, {});
  xai.tokenReply = scripted(grant());
  const login = await beginOAuthLogin({ openBrowser: false, sleep: instantSleep() });
  try {
    assert.equal(login.userCode, undefined);
    assert.equal(typeof login.completeCode, 'function');
    const url = new URL(login.url);
    assert.equal(url.origin + url.pathname, 'https://auth.x.ai/oauth2/authorize');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:56121/callback');
    assert.deepEqual(opened, [], 'a headless start never opens a browser');
    const state = url.searchParams.get('state');
    const tokens = await login.completeCode(`http://127.0.0.1:56121/callback?code=pasted&state=${state}`);
    assert.equal(tokens.refresh_token, 'refresh-1');
    assert.equal(xai.token[0].form.code, 'pasted');
    assert.equal(xai.token[0].form.grant_type, 'authorization_code');
    assert.equal(await login.waitForCallback, tokens);
    assert.equal(readStored().refresh_token, 'refresh-1');
  } finally {
    login.cancel();
  }
});

test('the browser login is unchanged: authorize URL, loopback callback, browser opened, no device request', async () => {
  xai.tokenReply = scripted(grant());
  const login = await beginOAuthLogin();
  try {
    assert.equal(xai.device.length, 0);
    assert.equal(login.userCode, undefined);
    assert.equal(typeof login.completeCode, 'function');
    const url = new URL(login.url);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:56121/callback');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    for (let i = 0; i < 200 && opened.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(opened, [login.url]);
    const state = url.searchParams.get('state');
    const res = await fetch(`http://127.0.0.1:56121/callback?code=from-browser&state=${state}`);
    assert.equal(res.status, 200);
    const tokens = await login.waitForCallback;
    assert.equal(tokens.refresh_token, 'refresh-1');
    assert.equal(xai.token[0].form.code, 'from-browser');
    assert.equal(xai.token[0].form.redirect_uri, 'http://127.0.0.1:56121/callback');
  } finally {
    login.cancel();
  }
});
