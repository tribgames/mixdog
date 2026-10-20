import test from 'node:test';
import assert from 'node:assert/strict';
import { canFallbackCapacityRoute, canFallbackRoute, routeFallbackVerdict } from './model-route-fallback.mjs';
import { agentContextOverflowError } from '../agent/orchestrator/session/loop/context-overflow.mjs';
import { responseFailedError } from '../agent/orchestrator/providers/openai-ws-terminal.mjs';

test('only explicit pre-generation provider refusals permit switching', () => {
  assert.equal(canFallbackRoute({ status: 429 }), true);
  assert.equal(canFallbackRoute({ status: 503 }), true);
  for (const error of [
    { status: 400 },
    { status: 413 },
    { code: 'ECONNRESET' },
    new Error('unknown failure'),
    { status: 429, name: 'AbortError' },
    { status: 503, partialContent: 'visible' },
    { status: 503, toolCallsStarted: true },
    { status: 503, toolCallsDispatched: 1 },
    { status: 503, streamStalled: true },
  ])
    assert.equal(canFallbackRoute(error), false);
  assert.equal(canFallbackRoute({ status: 429 }, { committed: true }), false);
  assert.equal(canFallbackRoute({ status: 429 }, { signal: AbortSignal.abort() }), false);
});

const usageLimit = {
  type: 'usage_limit_reached',
  message: 'The usage limit has been reached',
  resets_at: 4_102_444_800,
};

test('a typed usage-limit refusal hops whatever its status or stream frames', () => {
  // A status-less response.failed after response.created: the shape that
  // never reached the next model.
  const failed = Object.assign(
    responseFailedError(
      { type: 'response.failed', response: { status: 'failed', error: usageLimit } },
      { label: 'ws' }
    ),
    { sawResponseCreated: true, terminalObserved: true }
  );
  assert.equal(canFallbackRoute(failed), true);
  assert.equal(canFallbackRoute({ code: 'provider_accounts_exhausted', quotaExhausted: {} }), true);
  // The same refusal after visible output or a started tool call never hops.
  assert.equal(canFallbackRoute(Object.assign(failed, { liveTextEmitted: true })), false);
  assert.equal(canFallbackRoute({ code: 'usage_limit_reached', toolCallsStarted: true }), false);
});

test('provider-, account- and model-scoped refusals hop; request-scoped ones stay', () => {
  for (const error of [
    { status: 401 },
    { status: 403 },
    { status: 402 },
    { status: 529 },
    { status: 500 },
    { code: 'server_error' },
    { status: 404, code: 'not_found_error' },
    { status: 400, code: 'model_not_found' },
    { reauthRequired: true },
    { code: 'rate_limited', retryAfterMs: 600_000 },
    { status: 429, code: 'flex_unavailable' },
  ])
    assert.equal(routeFallbackVerdict(error), 'hop', JSON.stringify(error));
  for (const error of [
    { status: 400, code: 'invalid_request_error' },
    { status: 413 },
    { status: 400, code: 'content_policy_violation' },
    { code: 'ENOTFOUND' },
    new TypeError('fetch failed'),
    { name: 'AbortError' },
  ])
    assert.equal(routeFallbackVerdict(error), 'stay', JSON.stringify(error));
  const codex = Object.assign(
    new Error(
      "OpenAI OAuth HTTP fallback 400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."
    ),
    { status: 400, code: 'invalid_request_error' }
  );
  assert.equal(routeFallbackVerdict(codex), 'hop');
  const overflow = { status: 400, code: 'context_length_exceeded' };
  assert.equal(routeFallbackVerdict(overflow), 'context');
  assert.equal(canFallbackRoute(overflow), false);
  assert.equal(canFallbackRoute(overflow, { contextGrows: true }), true);
});

test('exposure on a wrapped cause still keeps the request on its model', () => {
  const sent = Object.assign(new Error('prompt is too long'), {
    status: 400,
    code: 'context_length_exceeded',
    liveTextEmitted: true,
  });
  const wrapped = agentContextOverflowError({ stage: 'send', model: 'm' }, sent);
  assert.equal(routeFallbackVerdict(wrapped), 'stay');
  assert.equal(canFallbackRoute(wrapped, { contextGrows: true }), false);
  const clean = agentContextOverflowError(
    { stage: 'send', model: 'm' },
    Object.assign(new Error('prompt is too long'), { status: 400, code: 'context_length_exceeded' })
  );
  assert.equal(routeFallbackVerdict(clean), 'context');
});

test('native web search keeps its strict guards: only a stated capacity refusal on an unstarted stream moves', () => {
  assert.equal(canFallbackCapacityRoute({ status: 429 }), true);
  assert.equal(canFallbackCapacityRoute({ status: 503 }), true);
  assert.equal(canFallbackCapacityRoute({ code: 'provider_accounts_exhausted', quotaExhausted: {} }), true);
  for (const error of [
    { status: 429, sawResponseCreated: true },
    { status: 503, terminalObserved: true },
    { status: 401 },
    { status: 403 },
    { status: 404, code: 'model_not_found' },
    { status: 500 },
    { status: 429, partialContent: 'x' },
    { status: 429, name: 'AbortError' },
  ])
    assert.equal(canFallbackCapacityRoute(error), false, JSON.stringify(error));
  assert.equal(canFallbackCapacityRoute({ status: 429 }, { signal: AbortSignal.abort() }), false);
});
