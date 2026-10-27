// Run with `node scripts/test-direct.mjs <this file>` (uses mock.module).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { mock } from 'node:test';

const opened = [];
mock.module(new URL('../../../shared/open-url.mjs', import.meta.url).href, {
  namedExports: { openInBrowser: (url) => opened.push(url) },
});
const { createOpenAIOAuthLogin } = await import('./openai-oauth-login.mjs');

const GRANT = { authorization_code: 'auth-code', code_challenge: 'chal', code_verifier: 'verif' };

// A local stand-in for auth.openai.com: records every request and answers the
// usercode / deviceauth token / oauth token endpoints from per-test scripts.
async function fakeAuth(t, { usercode, pollStatuses = [], tokenReply } = {}) {
  const requests = [];
  const polls = [...pollStatuses];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, type: req.headers['content-type'], body: raw });
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.url === '/api/accounts/deviceauth/usercode') {
      const u = usercode ?? { status: 200, body: { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '7' } };
      return reply(u.status, u.body);
    }
    if (req.url === '/api/accounts/deviceauth/token') {
      const status = polls.length ? polls.shift() : 200;
      if (status === 'stall') return; // never answers
      return reply(status, status === 200 ? GRANT : undefined);
    }
    if (req.url === '/oauth/token') {
      return reply(200, tokenReply ?? { access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 3600 });
    }
    return reply(404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { issuer: `http://127.0.0.1:${server.address().port}`, requests };
}

function loginFor(issuer, extra = {}) {
  const saved = [];
  const login = createOpenAIOAuthLogin({
    clientId: 'client-x',
    originator: 'mixdog',
    extractAccountId: (token) => `acct-${token}`,
    identityFromTokens: (idToken, accessToken) => ({ idToken, accessToken }),
    expiryFromAccessToken: () => 1234,
    saveTokens: (tokens) => saved.push(tokens),
    issuer,
    ...extra,
  });
  return { login, saved };
}

const fastSleep = (waits) => async (ms, signal) => {
  signal?.throwIfAborted();
  waits.push(ms);
};

test('device start returns the verification url, user code and handles', async (t) => {
  const { issuer, requests } = await fakeAuth(t);
  const { login } = loginFor(issuer, { sleep: fastSleep([]) });
  const started = await login.beginOAuthLogin({ openBrowser: false });
  t.after(() => started.cancel());
  assert.equal(started.url, `${issuer}/codex/device`);
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(typeof started.waitForCallback.then, 'function');
  assert.equal(typeof started.cancel, 'function');
  assert.equal(requests[0].path, '/api/accounts/deviceauth/usercode');
  assert.match(requests[0].type, /application\/json/);
  assert.deepEqual(JSON.parse(requests[0].body), { client_id: 'client-x' });
  assert.deepEqual(opened, []);
});

test('device login polls through keep-waiting responses, exchanges with the deviceauth redirect and saves like PKCE', async (t) => {
  const { issuer, requests } = await fakeAuth(t, { pollStatuses: [403, 404, 403] });
  const waits = [];
  const { login, saved } = loginFor(issuer, { sleep: fastSleep(waits) });
  const started = await login.beginOAuthLogin({ openBrowser: false });
  const tokens = await started.waitForCallback;

  const polls = requests.filter((r) => r.path === '/api/accounts/deviceauth/token');
  assert.equal(polls.length, 4);
  assert.deepEqual(JSON.parse(polls[0].body), { device_auth_id: 'dev-1', user_code: 'ABCD-1234' });
  assert.deepEqual(waits, [7000, 7000, 7000]);

  const exchange = requests.find((r) => r.path === '/oauth/token');
  assert.match(exchange.type, /application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'auth-code');
  assert.equal(form.get('code_verifier'), 'verif');
  assert.equal(form.get('client_id'), 'client-x');
  assert.equal(form.get('redirect_uri'), `${issuer}/deviceauth/callback`);

  assert.equal(saved.length, 1);
  assert.equal(saved[0], tokens);
  assert.equal(tokens.access_token, 'at');
  assert.equal(tokens.refresh_token, 'rt');
  assert.equal(tokens.account_id, 'acct-at');
  assert.deepEqual(tokens.identity, { idToken: 'it', accessToken: 'at' });
  assert.ok(tokens.expires_at > Date.now());
});

test('device login fails on a poll status other than keep-waiting', async (t) => {
  const { issuer } = await fakeAuth(t, { pollStatuses: [403, 500] });
  const { login, saved } = loginFor(issuer, { sleep: fastSleep([]) });
  const started = await login.beginOAuthLogin({ openBrowser: false });
  await assert.rejects(started.waitForCallback, /device auth failed with status 500/);
  assert.deepEqual(saved, []);
});

test('device login times out after 15 minutes of keep-waiting', async (t) => {
  const { issuer } = await fakeAuth(t, { pollStatuses: Array(500).fill(403) });
  let clock = 0;
  const waits = [];
  const { login, saved } = loginFor(issuer, {
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  const started = await login.beginOAuthLogin({ openBrowser: false });
  await assert.rejects(started.waitForCallback, /timed out after 15 minutes/);
  assert.equal(clock, 15 * 60_000);
  assert.ok(waits.every((ms) => ms <= 7000));
  assert.deepEqual(saved, []);
});

test('a stalled poll is aborted at the deadline and the login rejects with the timeout error', async (t) => {
  const { issuer, requests } = await fakeAuth(t, { pollStatuses: ['stall'] });
  const { login, saved } = loginFor(issuer, { deviceTimeoutMs: 150 });
  const started = await login.beginOAuthLogin({ openBrowser: false });
  const startedAt = Date.now();
  await assert.rejects(started.waitForCallback, /timed out after 15 minutes/);
  assert.ok(Date.now() - startedAt < 5000);
  assert.equal(requests.filter((r) => r.path === '/api/accounts/deviceauth/token').length, 1);
  assert.deepEqual(saved, []);
});

test('cancelling a device login stops polling, settles empty and saves nothing', async (t) => {
  const { issuer, requests } = await fakeAuth(t, { pollStatuses: Array(100).fill(403) });
  const { login, saved } = loginFor(issuer); // real, abortable sleep (7s interval)
  const started = await login.beginOAuthLogin({ openBrowser: false });
  while (!requests.some((r) => r.path === '/api/accounts/deviceauth/token')) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  started.cancel();
  assert.equal(await started.waitForCallback, null);
  const count = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.length, count);
  assert.deepEqual(saved, []);
});

test('cancelling during the code exchange saves nothing', async (t) => {
  const { issuer, requests } = await fakeAuth(t);
  const { login, saved } = loginFor(issuer, { sleep: fastSleep([]) });
  const started = await login.beginOAuthLogin({ openBrowser: false });
  while (!requests.some((r) => r.path === '/oauth/token')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  started.cancel();
  assert.equal(await started.waitForCallback, null);
  assert.deepEqual(saved, []);
});

test('a usercode 404 falls back to the PKCE flow without opening a browser', async (t) => {
  const { issuer } = await fakeAuth(t, { usercode: { status: 404 } });
  const { login } = loginFor(issuer);
  opened.length = 0;
  const started = await login.beginOAuthLogin({ openBrowser: false });
  t.after(() => started.cancel());
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(started.userCode, undefined);
  assert.equal(typeof started.completeCode, 'function');
  assert.deepEqual(opened, []);
});

test('another usercode failure is an error, not a fallback', async (t) => {
  const { issuer } = await fakeAuth(t, { usercode: { status: 500 } });
  const { login } = loginFor(issuer);
  await assert.rejects(login.beginOAuthLogin({ openBrowser: false }), /device code request failed with status 500/);
});

test('the PKCE flow is unchanged when openBrowser is true: no device request, browser opened, localhost redirect', async (t) => {
  const { issuer, requests } = await fakeAuth(t, {
    tokenReply: { access_token: 'at', refresh_token: 'rt', expires_in: 60 },
  });
  const { login, saved } = loginFor(issuer);
  opened.length = 0;
  const started = await login.beginOAuthLogin({ openBrowser: true });
  t.after(() => started.cancel());
  assert.equal(started.userCode, undefined);
  assert.deepEqual(requests, []);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(opened, [started.url]);

  const state = new URL(started.url).searchParams.get('state');
  const res = await fetch(`http://localhost:1455/auth/callback?code=pkce-code&state=${state}`);
  await res.text();
  const tokens = await started.waitForCallback;
  assert.equal(tokens.access_token, 'at');
  assert.equal(saved.length, 1);
  const form = new URLSearchParams(requests.find((r) => r.path === '/oauth/token').body);
  assert.equal(form.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(form.get('code'), 'pkce-code');
  assert.ok(form.get('code_verifier'));
});
