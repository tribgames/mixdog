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
