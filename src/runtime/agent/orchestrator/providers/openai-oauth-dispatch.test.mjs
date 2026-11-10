import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAiOAuthDispatch } from './openai-oauth-dispatch.mjs';
import { frameTooLargeError, wsClosedError } from './openai-ws-terminal.mjs';

function shouldUseHttpFallback(error) {
  const dispatch = createOpenAiOAuthDispatch({
    provider: { _httpFallbackUntilByPoolKey: new Map() },
    opts: {},
    poolKey: 'session-1',
    httpFallbackEnabled: true,
  });
  return dispatch.shouldUseHttpFallback(error);
}

test('a server 1009 close switches to HTTP without spending the WS retry budget', () => {
  assert.equal(shouldUseHttpFallback(wsClosedError(1009, '')), true);
  assert.equal(shouldUseHttpFallback(wsClosedError(1009, 'payload too large')), true);
});

test('a server 1009 close after visible output is never replayed over HTTP', () => {
  const err = Object.assign(wsClosedError(1009, ''), { liveTextEmitted: true });
  assert.equal(shouldUseHttpFallback(err), false);
});

test('the local receive bound keeps its own WS retry path', () => {
  const err = Object.assign(frameTooLargeError('OpenAI OAuth WS', 20, 10), { wsCloseCode: 1009 });
  assert.equal(shouldUseHttpFallback(err), false);
});

test('other close codes still wait for the WS retry budget', () => {
  assert.equal(shouldUseHttpFallback(wsClosedError(1006, '')), false);
});

function httpDispatch({ sendHttp, authState = { tokens: { access_token: 'old' } }, externalSignal = null }) {
  const refreshes = [];
  const provider = {
    _httpFallbackUntilByPoolKey: new Map(),
    ensureAuth: async (args) => {
      refreshes.push(args);
      return { access_token: 'new' };
    },
  };
  const dispatch = createOpenAiOAuthDispatch({
    provider,
    opts: {},
    authState,
    poolKey: 'session-401',
    externalSignal,
    sendHttp,
    startedAt: Date.now(),
    httpFallbackEnabled: true,
  });
  return { dispatch, refreshes, authState };
}

const unauthorized = (extra = {}) => Object.assign(new Error('HTTP 401'), { httpStatus: 401, ...extra });

test('an HTTP 401 forces one token refresh and reissues the request with the new token', async () => {
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  const tokens = [];
  const { dispatch, refreshes } = httpDispatch({
    sendHttp: async ({ auth }) => {
      tokens.push(auth.access_token);
      if (auth.access_token === 'old') throw unauthorized({ initialResponseError: true });
      return { content: 'ok', toolCalls: [] };
    },
  });
  assert.equal((await dispatch.dispatchHttp('forced')).content, 'ok');
  assert.deepEqual(tokens, ['old', 'new']);
  assert.deepEqual(refreshes, [{ forceRefresh: true, reason: '401' }]);
});

test('the HTTP 401 refresh is bounded to one per send, including a WS-side refresh', async () => {
  let calls = 0;
  const { dispatch, refreshes } = httpDispatch({
    sendHttp: async () => {
      calls++;
      throw unauthorized();
    },
  });
  await assert.rejects(dispatch.dispatchHttp('forced'), (err) => err.httpStatus === 401);
  assert.equal(calls, 2, 'one reissue only');
  assert.equal(refreshes.length, 1);

  let wsCalls = 0;
  const spent = httpDispatch({
    authState: { tokens: { access_token: 'old' }, authRefreshed: true },
    sendHttp: async () => {
      wsCalls++;
      throw unauthorized();
    },
  });
  await assert.rejects(spent.dispatch.dispatchHttp('forced'));
  assert.equal(wsCalls, 1);
  assert.equal(spent.refreshes.length, 0);
});

test('an HTTP 401 after exposed output or an abort is never reissued', async () => {
  for (const extra of [{ liveTextEmitted: true }, { emittedToolCall: true }, { unsafeToRetry: true }]) {
    let calls = 0;
    const { dispatch, refreshes } = httpDispatch({
      sendHttp: async () => {
        calls++;
        throw unauthorized(extra);
      },
    });
    await assert.rejects(dispatch.dispatchHttp('forced'));
    assert.equal(calls, 1);
    assert.equal(refreshes.length, 0);
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const aborted = httpDispatch({
    externalSignal: controller.signal,
    sendHttp: async () => {
      calls++;
      throw unauthorized();
    },
  });
  await assert.rejects(aborted.dispatch.dispatchHttp('forced'));
  assert.equal(calls, 1);
});

test('a non-401 HTTP failure is not reissued by the auth recovery', async () => {
  let calls = 0;
  const { dispatch, refreshes } = httpDispatch({
    sendHttp: async () => {
      calls++;
      throw Object.assign(new Error('forbidden'), { httpStatus: 403 });
    },
  });
  await assert.rejects(dispatch.dispatchHttp('forced'));
  assert.equal(calls, 1);
  assert.equal(refreshes.length, 0);
});
