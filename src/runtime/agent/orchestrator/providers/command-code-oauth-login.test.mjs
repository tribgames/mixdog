import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'command-code-oauth-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.COMMAND_CODE_OAUTH_CREDENTIALS_PATH = join(dir, 'command-code-oauth.json');
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

const { beginOAuthLogin, parseCallbackPayload, parsePastedInput } = await import('./command-code-oauth-login.mjs');
const { loadTokens, forgetCommandCodeOAuthCredentials, describeCommandCodeOAuthCredentials, requestCommandCodeJson } =
  await import('./command-code-oauth-tokens.mjs');
const { registerProviderAccount, removeProviderAccount } = await import('../../../shared/provider-accounts.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const STUDIO = 'https://commandcode.ai';
const credentialFile = () => JSON.parse(readFileSync(process.env.COMMAND_CODE_OAUTH_CREDENTIALS_PATH, 'utf-8'));

// whoami stand-in: known keys map to a user; anything else is rejected. Every
// request URL is recorded so tests can prove where the key went.
function fakeApi(users = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization, redirect: init?.redirect });
    const key = String(init?.headers?.Authorization || '').replace(/^Bearer /, '');
    const user = users[key];
    if (!user) return new Response('{"error":"unauthorized"}', { status: 401 });
    return new Response(JSON.stringify({ user }), { status: 200 });
  };
  return { seen, fetchImpl };
}

const pending = (promise) =>
  Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled'
    ),
    new Promise((r) => setTimeout(() => r('pending'), 50)),
  ]);

function post(login, body, headers = {}) {
  return fetch(`http://127.0.0.1:${login.port}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: STUDIO, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const stateOf = (login) => new URL(login.url).searchParams.get('state');
const callback = (state, extra = {}) => ({
  apiKey: 'cc-key-1',
  state,
  userId: 'payload-user',
  userName: 'payload-name',
  keyName: 'mixdog',
  ...extra,
});

test('parseCallbackPayload checks state and requires every field', () => {
  const ok = parseCallbackPayload(callback('s1'), 's1');
  assert.deepEqual(ok, { apiKey: 'cc-key-1', userId: 'payload-user', userName: 'payload-name', keyName: 'mixdog' });
  assert.throws(() => parseCallbackPayload(callback('other'), 's1'), /state mismatch/);
  assert.throws(() => parseCallbackPayload(callback(undefined), 's1'), /state mismatch/);
  assert.throws(() => parseCallbackPayload(callback('s1'), ''), /state mismatch/);
  for (const field of ['apiKey', 'userId', 'userName', 'keyName']) {
    assert.throws(() => parseCallbackPayload(callback('s1', { [field]: '' }), 's1'), new RegExp(`missing ${field}`));
    assert.throws(() => parseCallbackPayload(callback('s1', { [field]: 42 }), 's1'), new RegExp(`missing ${field}`));
  }
  assert.throws(() => parseCallbackPayload(callback('s1', { apiKey: 'has space' }), 's1'), /malformed API key/);
  assert.throws(() => parseCallbackPayload(['x'], 's1'), /must be an object/);
  assert.throws(() => parseCallbackPayload(null, 's1'), /must be an object/);
});

test('parsePastedInput accepts a bare key or the state-checked callback JSON', () => {
  assert.equal(parsePastedInput('  cc-raw-key \n', 's').apiKey, 'cc-raw-key');
  assert.equal(parsePastedInput(JSON.stringify(callback('s')), 's').apiKey, 'cc-key-1');
  assert.throws(() => parsePastedInput(JSON.stringify(callback('x')), 's'), /state mismatch/);
  assert.throws(() => parsePastedInput('{not json', 's'), /not valid JSON/);
  assert.throws(() => parsePastedInput('', 's'), /API key is required/);
  assert.throws(() => parsePastedInput('two words', 's'), /malformed/);
});

test('browser callback: CORS preflight, rejects bad requests, stores the whoami identity', async () => {
  forgetCommandCodeOAuthCredentials();
  const api = fakeApi({ 'cc-key-1': { id: 'whoami-user', userName: 'alice' } });
  const login = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false, fetchImpl: api.fetchImpl });
  try {
    const url = new URL(login.url);
    assert.equal(url.origin + url.pathname, `${STUDIO}/studio/auth/cli`);
    assert.equal(url.searchParams.get('callback'), `http://127.0.0.1:${login.port}/callback`);
    assert.match(stateOf(login), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(login.url.includes(`callback=${encodeURIComponent(`http://127.0.0.1:${login.port}/callback`)}`));

    const preflight = await fetch(`http://127.0.0.1:${login.port}/callback`, {
      method: 'OPTIONS',
      headers: { Origin: STUDIO, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), STUDIO);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/);

    assert.equal((await fetch(`http://127.0.0.1:${login.port}/callback`)).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${login.port}/other`, { method: 'POST' })).status, 404);
    assert.equal((await post(login, callback(stateOf(login)), { Origin: 'https://evil.example' })).status, 403);
    const mismatch = await post(login, callback('wrong-state'));
    assert.equal(mismatch.status, 400);
    assert.match((await mismatch.json()).error, /state mismatch/);
    const missing = await post(login, callback(stateOf(login), { userName: '' }));
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /missing userName/);
    assert.equal((await post(login, '{oops')).status, 400);
    assert.equal(await pending(login.waitForCallback), 'pending');
    assert.equal(loadTokens(), null);
    assert.equal(api.seen.length, 0);

    const ok = await post(login, callback(stateOf(login)));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true });
    const tokens = await login.waitForCallback;
    assert.deepEqual(tokens, { apiKey: 'cc-key-1', userId: 'whoami-user', userName: 'alice' });
    assert.deepEqual(credentialFile(), tokens);
    assert.equal(describeCommandCodeOAuthCredentials().identityId, 'whoami-user');
    assert.deepEqual(api.seen, [
      { url: 'https://api.commandcode.ai/alpha/whoami', auth: 'Bearer cc-key-1', redirect: 'error' },
    ]);
  } finally {
    login.cancel();
  }
});

test('manual paste: raw key and callback JSON complete the login; a rejected key keeps it open', async () => {
  forgetCommandCodeOAuthCredentials();
  const api = fakeApi({ 'cc-raw': { id: 'u-raw', userName: 'bob' }, 'cc-key-1': { id: 'u-json', userName: 'carol' } });
  const raw = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false, fetchImpl: api.fetchImpl });
  await assert.rejects(raw.completeCode('cc-unknown'), (err) => err.reauthRequired === true);
  assert.equal(await pending(raw.waitForCallback), 'pending');
  await assert.rejects(raw.completeCode(JSON.stringify(callback('stale'))), /state mismatch/);
  const tokens = await raw.completeCode('cc-raw');
  assert.deepEqual(tokens, { apiKey: 'cc-raw', userId: 'u-raw', userName: 'bob' });
  assert.equal(await raw.waitForCallback, tokens);
  await assert.rejects(raw.completeCode('cc-raw'), /no longer active/);

  const json = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false, fetchImpl: api.fetchImpl });
  const viaJson = await json.completeCode(JSON.stringify(callback(stateOf(json))));
  assert.equal(viaJson.userId, 'u-json');
  assert.equal(loadTokens().apiKey, 'cc-key-1');
  assert.ok(api.seen.every((row) => new URL(row.url).host === 'api.commandcode.ai'));
});

test('the local CLI login is imported only on the first sign-in', async () => {
  forgetCommandCodeOAuthCredentials();
  const home = join(dir, 'home', '.commandcode');
  mkdirSync(home, { recursive: true });
  const localAuthPath = join(home, 'auth.json');
  writeFileSync(localAuthPath, JSON.stringify({ apiKey: 'cc-local', userId: 'local-user' }));
  const api = fakeApi({ 'cc-local': { id: 'local-whoami', userName: 'dana' } });
  const base = { openBrowser: false, port: 0, fetchImpl: api.fetchImpl, localAuthPath };

  // Nothing connected: the CLI login is adopted without a browser.
  const first = await beginOAuthLogin(base);
  assert.equal(first.imported, true);
  assert.equal(first.url, '');
  assert.deepEqual(await first.waitForCallback, { apiKey: 'cc-local', userId: 'local-whoami', userName: 'dana' });
  assert.equal(loadTokens().apiKey, 'cc-local');

  // A connected default account (reconnect / add-account): the browser flow runs.
  const again = await beginOAuthLogin(base);
  try {
    assert.equal(again.imported, undefined);
    assert.match(again.url, /\/studio\/auth\/cli\?/);
  } finally {
    again.cancel();
  }

  // A roster entry alone also rules the import out.
  forgetCommandCodeOAuthCredentials();
  const id = '00000000-0000-4000-8000-000000000001';
  await registerProviderAccount('command-code-oauth', id);
  const added = await beginOAuthLogin(base);
  try {
    assert.notEqual(added.imported, true);
  } finally {
    added.cancel();
    await removeProviderAccount('command-code-oauth', id);
  }

  // A rejected or incomplete CLI login falls through to the browser.
  writeFileSync(localAuthPath, JSON.stringify({ apiKey: 'cc-revoked', userId: 'x' }));
  const revoked = await beginOAuthLogin(base);
  try {
    assert.notEqual(revoked.imported, true);
    assert.equal(loadTokens(), null);
  } finally {
    revoked.cancel();
  }
  writeFileSync(localAuthPath, JSON.stringify({ apiKey: 'cc-local' }));
  const incomplete = await beginOAuthLogin(base);
  incomplete.cancel();
  assert.notEqual(incomplete.imported, true);
  assert.ok(api.seen.every((row) => new URL(row.url).host === 'api.commandcode.ai'));
});

test('the key is never sent to a host other than api.commandcode.ai', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response('{}');
  };
  for (const url of [
    'https://evil.example/alpha/whoami',
    'http://api.commandcode.ai/alpha/whoami',
    'https://api.commandcode.ai.evil.example/alpha/whoami',
    'https://commandcode.ai/alpha/whoami',
    'https://api.commandcode.ai:8443/alpha/whoami',
  ]) {
    await assert.rejects(requestCommandCodeJson(url, 'cc-secret', { fetchImpl }), /refusing to send the API key/);
  }
  assert.equal(called, false);
});

test('the fixed callback port falls back to a free port when taken', async () => {
  const { createServer } = await import('node:http');
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = blocker.address().port;
  try {
    const login = await beginOAuthLogin({ openBrowser: false, port: taken, importLocal: false });
    try {
      assert.notEqual(login.port, taken);
      assert.equal(new URL(new URL(login.url).searchParams.get('callback')).port, String(login.port));
    } finally {
      login.cancel();
    }
  } finally {
    blocker.close();
  }
});

// Raw HTTP over a socket: request targets fetch would normalize, and requests
// left incomplete on purpose.
async function rawRequest(port, text) {
  const { connect } = await import('node:net');
  const socket = connect(port, '127.0.0.1');
  const closed = new Promise((resolve) => socket.on('close', resolve));
  let response = '';
  socket.on('data', (chunk) => {
    response += chunk;
  });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(text);
  return { socket, closed, response: () => response };
}

const closedWithin = (closed, ms = 2000) =>
  Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), ms))]);

test('an unparsable request target is answered 400 and the login keeps running', async () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  const login = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false });
  try {
    const raw = await rawRequest(login.port, 'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.equal(await closedWithin(raw.closed), 'closed');
    assert.match(raw.response(), /^HTTP\/1\.1 400 /);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(rejections, []);
    assert.equal(await pending(login.waitForCallback), 'pending');
  } finally {
    process.off('unhandledRejection', onRejection);
    login.cancel();
  }
});

test('cancel and timeout drop a stalled partial callback; success closes the connection after replying', async () => {
  const partial = `POST /callback HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${STUDIO}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"apiKey":`;

  const cancelled = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false });
  const stalled = await rawRequest(cancelled.port, partial);
  await new Promise((r) => setTimeout(r, 20));
  cancelled.cancel();
  assert.equal(await closedWithin(stalled.closed), 'closed');

  const slow = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false, timeoutMs: 100 });
  const stalledSlow = await rawRequest(slow.port, partial);
  await assert.rejects(slow.waitForCallback, /login timed out/);
  assert.equal(await closedWithin(stalledSlow.closed), 'closed');

  forgetCommandCodeOAuthCredentials();
  const api = fakeApi({ 'cc-key-1': { id: 'u-ok', userName: 'erin' } });
  const login = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false, fetchImpl: api.fetchImpl });
  const body = JSON.stringify(callback(stateOf(login)));
  // keep-alive on purpose: the server, not the client, must close it.
  const ok = await rawRequest(
    login.port,
    `POST /callback HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${STUDIO}\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
  assert.equal((await login.waitForCallback).userId, 'u-ok');
  assert.equal(await closedWithin(ok.closed), 'closed');
  assert.match(ok.response(), /^HTTP\/1\.1 200 /);
  assert.match(ok.response(), /"success":true/);
});

test('cancel resolves null and an unanswered login times out', async () => {
  const cancelled = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false });
  cancelled.cancel();
  assert.equal(await cancelled.waitForCallback, null);
  const slow = await beginOAuthLogin({ openBrowser: false, port: 0, importLocal: false, timeoutMs: 25 });
  await assert.rejects(slow.waitForCallback, /login timed out after/);
});
