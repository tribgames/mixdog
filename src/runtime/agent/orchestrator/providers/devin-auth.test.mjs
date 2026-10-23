import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  beginDevinOAuthLogin,
  describeDevinOAuthCredentials,
  exchangeDevinCode,
  forgetDevinOAuthCredentials,
  hasDevinOAuthCredentials,
  resolveDevinOAuthAccessToken,
} from './devin-auth.mjs';

const BINDINGS = Symbol.for('mixdog.providerAuthBindings');
const CALLBACK = 'http://127.0.0.1:59653/callback';
const DAY_MS = 24 * 60 * 60_000;

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function bindCredentialFile(t, name = 'devin-oauth.json') {
  const path = join(mkdtempSync(join(tmpdir(), 'devin-auth-')), name);
  const previous = globalThis[BINDINGS];
  globalThis[BINDINGS] = { ...previous, 'devin-oauth': path };
  t.after(() => {
    globalThis[BINDINGS] = previous;
  });
  return path;
}

const readStored = (path) => JSON.parse(readFileSync(path, 'utf8'));

// A token endpoint that records every request and answers with `token`.
function tokenEndpoint(token) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ token }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchFn };
}

function callback(params) {
  return fetch(`${CALLBACK}?${new URLSearchParams(params)}`);
}

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(59653, '127.0.0.1', () => probe.close(resolve));
  });
}

async function startLogin(t, options = {}) {
  const login = await beginDevinOAuthLogin({ openBrowser: false, ...options });
  t.after(async () => {
    login.cancel();
    await login.waitForCallback.catch(() => {});
  });
  return login;
}

test('the authorize URL carries PKCE S256, a uuid state, the loopback redirect and account selection', async (t) => {
  bindCredentialFile(t);
  const login = await startLogin(t);
  const url = new URL(login.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://app.devin.ai/auth/cli/continue');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(login.provider, 'devin-oauth');
  assert.equal(login.manualUrl, null);
  assert.equal(typeof login.cancel, 'function');
});

test('callback exchanges the code with the PKCE verifier and stores the JWT with its expiry', async (t) => {
  const path = bindCredentialFile(t);
  const exp = nowSeconds() + 3600;
  const token = jwt({ exp, sub: 'user-1', email: 'dev@example.com' });
  const endpoint = tokenEndpoint(token);
  const login = await startLogin(t, { fetchFn: endpoint.fetchFn });
  const state = new URL(login.url).searchParams.get('state');
  const challenge = new URL(login.url).searchParams.get('code_challenge');

  const response = await callback({ code: 'auth-code', state });
  assert.equal(response.status, 200);
  const tokens = await login.waitForCallback;

  assert.equal(endpoint.calls.length, 1);
  const [{ url, init, body }] = endpoint.calls;
  assert.equal(url, 'https://api.devin.ai/auth/cli/token');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.deepEqual(Object.keys(body).sort(), ['code', 'code_verifier']);
  assert.equal(body.code, 'auth-code');
  assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge);

  assert.equal(tokens.access_token, token);
  assert.equal(tokens.refresh_token, null);
  assert.equal(tokens.expires_at, exp * 1000);
  const stored = readStored(path);
  assert.equal(stored.access_token, token);
  assert.equal(stored.expires_at, exp * 1000);
  assert.deepEqual(stored.identity, { id: 'user-1', email: 'dev@example.com' });
  assert.equal(await resolveDevinOAuthAccessToken(), token);
  await assertPortFree();
});

test('a token without an exp claim is assumed valid for about a year', async (t) => {
  const path = bindCredentialFile(t);
  const endpoint = tokenEndpoint('opaque-login-token');
  const login = await startLogin(t, { fetchFn: endpoint.fetchFn });
  const before = Date.now();
  await callback({ code: 'c', state: new URL(login.url).searchParams.get('state') });
  await login.waitForCallback;
  const lifetime = readStored(path).expires_at - before;
  assert.ok(lifetime > 364 * DAY_MS && lifetime < 366 * DAY_MS, `lifetime ${lifetime}`);
});

test('a callback with the wrong state is refused and the login keeps waiting', async (t) => {
  const path = bindCredentialFile(t);
  const endpoint = tokenEndpoint(jwt({ exp: nowSeconds() + 3600 }));
  const login = await startLogin(t, { fetchFn: endpoint.fetchFn });
  const state = new URL(login.url).searchParams.get('state');

  assert.equal((await callback({ code: 'forged', state: 'other' })).status, 400);
  assert.equal((await callback({ code: 'forged' })).status, 400);
  assert.equal(endpoint.calls.length, 0);
  assert.equal(existsSync(path), false);

  assert.equal((await callback({ code: 'real', state })).status, 200);
  await login.waitForCallback;
  assert.equal(endpoint.calls.length, 1);
  assert.equal(endpoint.calls[0].body.code, 'real');
});

test('a callback without a code is refused and requests to other paths are 404', async (t) => {
  bindCredentialFile(t);
  const login = await startLogin(t, { fetchFn: tokenEndpoint('x').fetchFn });
  const state = new URL(login.url).searchParams.get('state');
  assert.equal((await callback({ state })).status, 400);
  assert.equal((await fetch('http://127.0.0.1:59653/other')).status, 404);
});

// Sends raw bytes (so the request line is not normalised by a client) and
// resolves with everything the server answers before it closes.
function rawRequest(text) {
  return new Promise((resolve, reject) => {
    const socket = connect(59653, '127.0.0.1', () => socket.write(text));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(received));
  });
}

test('a malformed request target is answered with 400 and never escapes the listener', async (t) => {
  bindCredentialFile(t);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const endpoint = tokenEndpoint(jwt({ exp: nowSeconds() + 3600 }));
  const login = await startLogin(t, { fetchFn: endpoint.fetchFn });

  for (const target of ['http://[', '//[', 'http://%zz[:99999']) {
    const answer = await rawRequest(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 400 /, `target ${target}`);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(endpoint.calls.length, 0);

  // The login survived and still completes from the real callback.
  assert.equal((await callback({ code: 'real', state: new URL(login.url).searchParams.get('state') })).status, 200);
  await login.waitForCallback;
});

test('an authorization error on the callback fails the login and frees the port', async (t) => {
  const path = bindCredentialFile(t);
  const endpoint = tokenEndpoint('x');
  const login = await startLogin(t, { fetchFn: endpoint.fetchFn });
  const state = new URL(login.url).searchParams.get('state');
  const outcome = login.waitForCallback.then(
    () => assert.fail('login should have failed'),
    (error) => error
  );
  assert.equal(
    (await callback({ state, error: 'access_denied', error_description: '{"token":"SECRET-TOKEN"}' })).status,
    400
  );
  const error = await outcome;
  assert.equal(error.message, '[devin-oauth] authorization failed (access_denied)');
  assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /SECRET-TOKEN/);
  assert.equal(endpoint.calls.length, 0);
  assert.equal(existsSync(path), false);
  await assertPortFree();
});

test('a rejected token exchange fails the login without storing or leaking the code', async (t) => {
  const path = bindCredentialFile(t);
  const fetchFn = async () => new Response('bad code secret-code', { status: 401 });
  const login = await startLogin(t, { fetchFn });
  const outcome = login.waitForCallback.then(
    () => assert.fail('login should have failed'),
    (error) => error
  );
  const response = await callback({ code: 'secret-code', state: new URL(login.url).searchParams.get('state') });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret-code/);
  const error = await outcome;
  assert.equal(error.status, 401);
  assert.match(error.message, /Devin token exchange failed \(401\)/);
  assert.doesNotMatch(error.message, /secret-code/);
  assert.equal(existsSync(path), false);
  await assertPortFree();
});

test('the token exchange refuses an empty response', async () => {
  const fetchFn = async () => new Response(JSON.stringify({}), { status: 200 });
  await assert.rejects(exchangeDevinCode('c', 'v', { fetchFn }), /returned no token/);
});

test('no failed token exchange ever puts a response body in the error', async () => {
  const secret = 'SECRET-TOKEN';
  const bodies = [
    [400, JSON.stringify({ token: secret })],
    [500, `upstream said ${secret}`],
    [200, `${secret} is not json`],
    [200, `{"token": ${secret}`],
    [200, JSON.stringify({ token: 42, echoed: secret })],
  ];
  for (const [status, body] of bodies) {
    const error = await exchangeDevinCode('c', 'v', { fetchFn: async () => new Response(body, { status }) }).then(
      () => assert.fail(`status ${status} should have failed`),
      (caught) => caught
    );
    const exposed = [error.message, error.stack, JSON.stringify(error), String(error.cause ?? '')].join('\n');
    assert.doesNotMatch(exposed, new RegExp(secret), `status ${status}: ${body}`);
    if (status !== 200) assert.equal(error.status, status);
  }
});

test('a login whose exchange is rejected never surfaces the response body', async (t) => {
  bindCredentialFile(t);
  const fetchFn = async () => new Response(JSON.stringify({ token: 'SECRET-TOKEN' }), { status: 400 });
  const login = await startLogin(t, { fetchFn });
  const outcome = login.waitForCallback.then(
    () => assert.fail('login should have failed'),
    (error) => error
  );
  const response = await callback({ code: 'c', state: new URL(login.url).searchParams.get('state') });
  assert.doesNotMatch(await response.text(), /SECRET-TOKEN/);
  const error = await outcome;
  assert.equal(error.message, 'Devin token exchange failed (400)');
  assert.doesNotMatch(JSON.stringify(error), /SECRET-TOKEN/);
});

test('an expired login token requires sign-in and never attempts a refresh', async (t) => {
  const path = bindCredentialFile(t);
  const exp = nowSeconds() - 60;
  writeFileSync(path, JSON.stringify({ access_token: jwt({ exp }), refresh_token: 'ignored', expires_at: exp * 1000 }));
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response('{}');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(
    resolveDevinOAuthAccessToken({ forceRefresh: true }),
    (error) => error.reauthRequired === true && /\/providers.*sign in again/.test(error.message)
  );
  assert.equal(requests, 0);
  assert.equal(hasDevinOAuthCredentials(), false);
  const state = describeDevinOAuthCredentials();
  assert.equal(state.authenticated, false);
  assert.equal(state.usable, false);
  assert.equal(state.refreshable, false);
  assert.equal(state.reauthRequired, true);
  assert.equal(state.status, 'Reauth Required');
});

test('missing credentials require sign-in and describe as Not Set', async (t) => {
  bindCredentialFile(t);
  assert.equal(hasDevinOAuthCredentials(), false);
  await assert.rejects(resolveDevinOAuthAccessToken(), (error) => error.reauthRequired === true);
  assert.deepEqual(describeDevinOAuthCredentials(), {
    authenticated: false,
    usable: false,
    refreshable: false,
    reauthRequired: false,
    status: 'Not Set',
    detail: 'Mixdog token store',
  });
});

test('a valid login token is usable, non-refreshable and reports its account', async (t) => {
  const path = bindCredentialFile(t);
  const exp = nowSeconds() + 3600;
  const token = jwt({ exp, sub: 'u-9', email: 'who@example.com' });
  writeFileSync(path, JSON.stringify({ access_token: token }));
  assert.equal(hasDevinOAuthCredentials(), true);
  assert.equal(await resolveDevinOAuthAccessToken(), token);
  assert.deepEqual(describeDevinOAuthCredentials(), {
    authenticated: true,
    usable: true,
    refreshable: false,
    reauthRequired: false,
    status: 'Access Only',
    detail: 'Mixdog token store',
    expiresAt: exp * 1000,
    email: 'who@example.com',
    identityId: 'u-9',
  });
});

test('forget removes the stored credential', async (t) => {
  const path = bindCredentialFile(t);
  writeFileSync(path, JSON.stringify({ access_token: jwt({ exp: nowSeconds() + 3600 }) }));
  assert.deepEqual(forgetDevinOAuthCredentials(), { removed: true });
  assert.equal(existsSync(path), false);
  assert.equal(hasDevinOAuthCredentials(), false);
  assert.deepEqual(forgetDevinOAuthCredentials(), { removed: false });
});

test('credentials are isolated per bound account file', async (t) => {
  const first = bindCredentialFile(t, 'first.json');
  const exp = nowSeconds() + 3600;
  const firstToken = jwt({ exp, sub: 'first' });
  writeFileSync(first, JSON.stringify({ access_token: firstToken }));
  assert.equal(await resolveDevinOAuthAccessToken(), firstToken);

  const second = bindCredentialFile(t, 'second.json');
  assert.notEqual(first, second);
  assert.equal(hasDevinOAuthCredentials(), false);
  const secondToken = jwt({ exp, sub: 'second' });
  const endpoint = tokenEndpoint(secondToken);
  const login = await startLogin(t, { fetchFn: endpoint.fetchFn });
  await callback({ code: 'c', state: new URL(login.url).searchParams.get('state') });
  await login.waitForCallback;
  assert.equal(await resolveDevinOAuthAccessToken(), secondToken);
  assert.equal(readStored(first).access_token, firstToken);

  assert.deepEqual(forgetDevinOAuthCredentials(), { removed: true });
  assert.equal(existsSync(first), true);
});

test('model proxy client mode exposes no credentials', async (t) => {
  const path = bindCredentialFile(t);
  writeFileSync(path, JSON.stringify({ access_token: jwt({ exp: nowSeconds() + 3600 }) }));
  const previous = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = previous;
  });
  assert.equal(hasDevinOAuthCredentials(), false);
  await assert.rejects(resolveDevinOAuthAccessToken(), (error) => error.reauthRequired === true);
});

test('an occupied callback port fails with a clear error and leaves nothing behind', async (t) => {
  bindCredentialFile(t);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(59653, '127.0.0.1', resolve));
  let blocked = true;
  t.after(() => {
    if (blocked) blocker.close();
  });

  await assert.rejects(beginDevinOAuthLogin({ openBrowser: false }), (error) => {
    assert.equal(error.code, 'EADDRINUSE');
    assert.match(error.message, /127\.0\.0\.1:59653 is already in use/);
    return true;
  });

  await new Promise((resolve) => blocker.close(resolve));
  blocked = false;
  const login = await startLogin(t);
  assert.match(login.url, /^https:\/\/app\.devin\.ai\//);
});

test('cancel rejects the login, stops the server and frees the port', async (t) => {
  const path = bindCredentialFile(t);
  const endpoint = tokenEndpoint(jwt({ exp: nowSeconds() + 3600 }));
  const login = await startLogin(t, { fetchFn: endpoint.fetchFn });
  const state = new URL(login.url).searchParams.get('state');
  const outcome = login.waitForCallback.then(
    () => assert.fail('login should have been cancelled'),
    (error) => error
  );
  login.cancel();
  assert.match((await outcome).message, /cancelled/);
  await assertPortFree();
  await assert.rejects(callback({ code: 'late', state }));
  assert.equal(endpoint.calls.length, 0);
  assert.equal(existsSync(path), false);
  login.cancel();
});

test('cancelling during the token exchange stores nothing', async (t) => {
  const path = bindCredentialFile(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requested;
  const exchangeStarted = new Promise((resolve) => {
    requested = resolve;
  });
  const fetchFn = async (_url, init) => {
    requested();
    await gate;
    init.signal.throwIfAborted();
    return new Response(JSON.stringify({ token: jwt({ exp: nowSeconds() + 3600 }) }), { status: 200 });
  };
  const login = await startLogin(t, { fetchFn });
  const outcome = login.waitForCallback.then(
    () => assert.fail('login should have been cancelled'),
    (error) => error
  );
  const pending = callback({ code: 'c', state: new URL(login.url).searchParams.get('state') }).catch(() => null);
  await exchangeStarted;
  login.cancel();
  release();
  assert.match((await outcome).message, /cancelled/);
  await pending;
  assert.equal(existsSync(path), false);
  await assertPortFree();
});

test('the login times out, rejects and frees the port', async (t) => {
  bindCredentialFile(t);
  const login = await startLogin(t, { timeoutMs: 40 });
  await assert.rejects(login.waitForCallback, /timed out after 40ms/);
  await assertPortFree();
});

test('overlapping starts supersede in call order and only the last login owns the port', async (t) => {
  bindCredentialFile(t);
  const token = jwt({ exp: nowSeconds() + 3600 });
  const endpoint = tokenEndpoint(token);
  const starts = [1, 2, 3].map(() => beginDevinOAuthLogin({ openBrowser: false, fetchFn: endpoint.fetchFn }));
  const logins = await Promise.all(starts);
  t.after(async () => {
    for (const login of logins) login.cancel();
    await Promise.all(logins.map((login) => login.waitForCallback.catch(() => {})));
  });

  const [first, second, last] = logins;
  for (const superseded of [first, second]) {
    await assert.rejects(superseded.waitForCallback, /cancelled/);
  }
  const states = logins.map((login) => new URL(login.url).searchParams.get('state'));
  assert.equal(new Set(states).size, 3);

  // A superseded login's state is refused; the last one completes.
  assert.equal((await callback({ code: 'stale', state: states[0] })).status, 400);
  assert.equal((await callback({ code: 'fresh', state: states[2] })).status, 200);
  assert.equal((await last.waitForCallback).access_token, token);
  assert.equal(endpoint.calls.length, 1);
  assert.equal(endpoint.calls[0].body.code, 'fresh');
  await assertPortFree();
});

test('a failed start does not block the starts queued behind it', async (t) => {
  bindCredentialFile(t);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(59653, '127.0.0.1', resolve));
  const blocked = beginDevinOAuthLogin({ openBrowser: false });
  const outcome = blocked.then(
    () => assert.fail('start should have failed'),
    (error) => error
  );
  const queued = beginDevinOAuthLogin({ openBrowser: false });
  assert.equal((await outcome).code, 'EADDRINUSE');
  await queued.then(
    () => assert.fail('queued start should also fail while the port is busy'),
    (error) => assert.equal(error.code, 'EADDRINUSE')
  );
  await new Promise((resolve) => blocker.close(resolve));
  const login = await startLogin(t);
  assert.match(login.url, /^https:\/\/app\.devin\.ai\//);
});

test('a newer login supersedes the previous one instead of failing on the busy port', async (t) => {
  bindCredentialFile(t);
  const first = await startLogin(t);
  const firstOutcome = first.waitForCallback.then(
    () => assert.fail('first login should have been superseded'),
    (error) => error
  );
  const second = await startLogin(t);
  assert.match((await firstOutcome).message, /cancelled/);
  assert.notEqual(new URL(first.url).searchParams.get('state'), new URL(second.url).searchParams.get('state'));
});
