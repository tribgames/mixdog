import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'anthropic-login-'));
process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = join(dir, 'credentials.json');
const { beginOAuthLogin } = await import('./anthropic-oauth-credentials.mjs');

async function callbackWithTokenReply(reply) {
  let opened = null;
  const login = await beginOAuthLogin({ openBrowserFn: async (url) => (opened = url) });
  for (let i = 0; i < 50 && !opened; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const state = new URL(String(opened)).searchParams.get('state');
  const settled = login.waitForCallback.then(
    (tokens) => ({ tokens }),
    (error) => ({ error })
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    String(input).includes('/oauth/token') ? Promise.resolve(reply()) : realFetch(input, init);
  try {
    const res = await fetch(`http://localhost:54545/callback?code=abc&state=${state}`);
    const body = await res.text();
    const outcome = await settled;
    return { res, body, outcome };
  } finally {
    globalThis.fetch = realFetch;
    login.cancel();
  }
}

test('a completed callback answers with the branded success page', async () => {
  const { res, body, outcome } = await callbackWithTokenReply(
    () => new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 })
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(body, /로그인 완료/);
  assert.match(body, /<svg/);
  assert.ok(outcome.tokens, 'the login settles with tokens');
});

test('a failed token exchange answers with the branded failure page', async () => {
  const { res, body, outcome } = await callbackWithTokenReply(() => new Response('nope', { status: 400 }));
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(body, /로그인 실패/);
  assert.ok(outcome.error);
});

async function openedLogin() {
  let opened = null;
  const login = await beginOAuthLogin({ openBrowserFn: async (url) => (opened = url) });
  for (let i = 0; i < 50 && !opened; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  return { login, state: new URL(String(opened)).searchParams.get('state') };
}

// The token endpoint answers the first exchange once released; any further
// exchange of the same code is refused, as a real server would.
function heldTokenEndpoint(accessToken) {
  const release = Promise.withResolvers();
  const endpoint = { exchanges: 0, release: release.resolve };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes('/oauth/token')) return realFetch(input, init);
    endpoint.exchanges += 1;
    if (endpoint.exchanges > 1) return new Response('{"error":"invalid_grant"}', { status: 400 });
    await release.promise;
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'rt', expires_in: 3600 }));
  };
  endpoint.restore = () => {
    globalThis.fetch = realFetch;
  };
  return endpoint;
}

const waitFor = async (check) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

test('browser and manual completion of one code share a single exchange', async () => {
  const { login, state } = await openedLogin();
  const endpoint = heldTokenEndpoint('at-shared');
  try {
    const browser = fetch(`http://localhost:54545/callback?code=abc&state=${state}`);
    await waitFor(() => endpoint.exchanges === 1);
    const manual = login.completeCode(`abc#${state}`);
    endpoint.release();
    const [res, tokens] = await Promise.all([browser, manual]);
    assert.equal(res.status, 200);
    assert.equal(tokens.accessToken, 'at-shared');
    assert.equal((await login.waitForCallback).accessToken, 'at-shared');
    assert.equal(endpoint.exchanges, 1);
  } finally {
    endpoint.restore();
    login.cancel();
  }
});

test('a cancelled login stores nothing and rejects later codes', async () => {
  const { login, state } = await openedLogin();
  const endpoint = heldTokenEndpoint('at-cancelled');
  try {
    const inFlight = login.completeCode(`abc#${state}`);
    await waitFor(() => endpoint.exchanges === 1);
    login.cancel();
    endpoint.release();
    await assert.rejects(inFlight);
    assert.equal(await login.waitForCallback, null);
    assert.equal(readFileSync(process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH, 'utf8').includes('at-cancelled'), false);
    await assert.rejects(login.completeCode(`def#${state}`));
    assert.equal(endpoint.exchanges, 1);
  } finally {
    endpoint.restore();
  }
});

test('a callback request with a bad state is rejected without ending the pending login', async () => {
  let opened = null;
  const login = await beginOAuthLogin({ openBrowserFn: async (url) => (opened = url) });
  for (let i = 0; i < 50 && !opened; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  let settled = false;
  login.waitForCallback.then(() => {
    settled = true;
  });
  try {
    assert.ok(opened, 'the login URL is opened through the injected opener');
    const base = 'http://localhost:54545/callback';
    const wrongState = await fetch(`${base}?code=abc&state=wrong`);
    assert.equal(wrongState.status, 400);
    const noCode = await fetch(`${base}?state=wrong`);
    assert.equal(noCode.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
  } finally {
    login.cancel();
  }
  assert.equal(await login.waitForCallback, null);
});
