import assert from 'node:assert/strict';
import { Server } from 'node:http';
import test from 'node:test';
import { createOpenAIOAuthLogin } from './openai-oauth-login.mjs';

const createLogin = (saveTokens = () => {}) =>
  createOpenAIOAuthLogin({
    clientId: 'client',
    originator: 'mixdog',
    extractAccountId: () => 'acct',
    identityFromTokens: () => null,
    expiryFromAccessToken: () => Date.now() + 60_000,
    saveTokens,
  });

// beginOAuthLogin returns before the callback server has bound its fixed
// port, so a request sent straight away can be refused. Wait for the server's
// own 'listening' event (or its bind error) before returning the login.
// A headless login tries the device flow first; these tests exercise the
// browser callback, so the usercode endpoint answers 404 (Codex's fallback).
async function beginListening(t, login) {
  const listening = Promise.withResolvers();
  const listen = Server.prototype.listen;
  const mocked = t.mock.method(Server.prototype, 'listen', function (...args) {
    this.once('listening', listening.resolve);
    this.once('error', listening.reject);
    return listen.apply(this, args);
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    String(input).includes('/deviceauth/usercode')
      ? Promise.resolve(new Response('', { status: 404 }))
      : realFetch(input, init);
  try {
    const pending = await login.beginOAuthLogin({ openBrowser: false });
    await listening.promise;
    return pending;
  } finally {
    globalThis.fetch = realFetch;
    mocked.mock.restore();
  }
}

// A login whose token endpoint answers only when the test releases the gate.
async function gatedLogin(t) {
  const saved = [];
  const pending = await beginListening(
    t,
    createLogin((tokens) => saved.push(tokens))
  );
  const state = new URL(pending.url).searchParams.get('state');
  const gate = Promise.withResolvers();
  const exchangeStarted = Promise.withResolvers();
  const tokenRequests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes('/oauth/token')) return realFetch(input, init);
    tokenRequests.push(init.body.get('code'));
    exchangeStarted.resolve();
    return tokenRequests.length === 1 ? gate.promise : new Response('invalid_grant', { status: 400 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    pending.cancel();
  });
  const grant = () =>
    gate.resolve(new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })));
  return { pending, state, saved, tokenRequests, grant, realFetch, exchangeStarted: exchangeStarted.promise };
}

test('cancelling an OpenAI login during the token exchange saves nothing', async (t) => {
  const { pending, state, saved, grant, realFetch, exchangeStarted } = await gatedLogin(t);
  const res = realFetch(`http://localhost:1455/auth/callback?code=abc&state=${state}`);
  await exchangeStarted;
  pending.cancel();
  assert.equal(await pending.waitForCallback, null);
  grant();
  assert.equal((await res).status, 500);
  assert.deepEqual(saved, []);
});

test('an OpenAI callback plus manual code run one exchange', async (t) => {
  const { pending, state, saved, tokenRequests, grant, realFetch, exchangeStarted } = await gatedLogin(t);
  const res = realFetch(`http://localhost:1455/auth/callback?code=abc&state=${state}`);
  await exchangeStarted;
  const manual = pending.completeCode(`other#${state}`);
  grant();
  assert.equal((await manual).access_token, 'at');
  assert.equal((await res).status, 200);
  assert.equal((await pending.waitForCallback).access_token, 'at');
  assert.deepEqual(tokenRequests, ['abc']);
  assert.equal(saved.length, 1);
});

test('a duplicate OpenAI code cannot settle the login before the exchange finishes', async (t) => {
  const { pending, state, saved, grant, realFetch, exchangeStarted } = await gatedLogin(t);
  let settled = false;
  pending.waitForCallback.then(
    () => (settled = true),
    () => (settled = true)
  );
  const res = realFetch(`http://localhost:1455/auth/callback?code=abc&state=${state}`);
  await exchangeStarted;
  const manual = pending.completeCode(`other#${state}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  grant();
  assert.equal((await manual).access_token, 'at');
  await res;
  assert.equal((await pending.waitForCallback).access_token, 'at');
  assert.equal(saved.length, 1);
});

async function callback(t, tokenReply, queryFor) {
  const pending = await beginListening(t, createLogin());
  const state = new URL(pending.url).searchParams.get('state');
  const settled = pending.waitForCallback.then(
    (tokens) => ({ tokens }),
    (error) => ({ error })
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    String(input).includes('/oauth/token') ? Promise.resolve(tokenReply()) : realFetch(input, init);
  try {
    const res = await fetch(`http://localhost:1455/auth/callback?${queryFor(state)}`);
    const body = await res.text();
    const outcome = await settled;
    return { res, body, outcome };
  } finally {
    globalThis.fetch = realFetch;
    pending.cancel?.();
  }
}

test('a completed OpenAI callback answers with the branded success page', async (t) => {
  const { res, body, outcome } = await callback(
    t,
    () => new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })),
    (state) => `code=abc&state=${state}`
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(body, /로그인 완료/);
  assert.match(body, /OpenAI 로그인이 완료되었습니다\./);
  assert.ok(outcome.tokens);
});

test('a failed OpenAI token exchange answers with the branded failure page', async (t) => {
  const { res, body, outcome } = await callback(
    t,
    () => new Response('nope', { status: 400 }),
    (state) => `code=abc&state=${state}`
  );
  assert.equal(res.status, 500);
  assert.match(body, /로그인 실패/);
  assert.ok(outcome.error);
});

test('a mismatched OpenAI state answers with the failure page and leaves the pending login to complete', async (t) => {
  const pending = await beginListening(t, createLogin());
  const state = new URL(pending.url).searchParams.get('state');
  let settled = false;
  pending.waitForCallback.then(
    () => (settled = true),
    () => (settled = true)
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    String(input).includes('/oauth/token')
      ? Promise.resolve(new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })))
      : realFetch(input, init);
  try {
    const wrong = await fetch('http://localhost:1455/auth/callback?code=abc&state=wrong');
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /로그인 실패/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    const valid = await fetch(`http://localhost:1455/auth/callback?code=abc&state=${state}`);
    assert.equal(valid.status, 200);
    await valid.text();
    assert.equal((await pending.waitForCallback).access_token, 'at');
  } finally {
    globalThis.fetch = realFetch;
    pending.cancel();
  }
});
