import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyErrorContract,
  formatRetryTimestamp,
  httpResponseError,
  usageLimitMessage,
  waitForRetryDeadline,
} from './openai-error-contract.mjs';
import { _classifyHandshakeError, _classifyMidstreamError } from './openai-ws-send-attempts/policy.mjs';

const FUTURE = new Date(2031, 2, 5, 15, 4).getTime();
const NOW_SAME_DAY = new Date(2031, 2, 5, 9, 0).getTime();

test('retry timestamp: time only today, dated otherwise (local-time format)', () => {
  assert.equal(formatRetryTimestamp(FUTURE, NOW_SAME_DAY), '3:04 PM');
  assert.equal(formatRetryTimestamp(FUTURE, FUTURE - 3 * 86_400_000), 'Mar 5th, 2031 3:04 PM');
});

test('usage-limit copy follows plan / promo / workspace rules', () => {
  const at = { resetsAtMs: FUTURE, now: NOW_SAME_DAY };
  assert.match(
    usageLimitMessage({ planType: 'plus', ...at }),
    /Upgrade to Pro .*purchase more credits or try again at 3:04 PM\.$/u
  );
  assert.match(usageLimitMessage({ planType: 'team', ...at }), /send a request to your admin or try again at/u);
  assert.match(
    usageLimitMessage({ planType: 'free', ...at }),
    /Upgrade to Plus to continue using Codex .*,\s*or try again at/u
  );
  assert.match(usageLimitMessage({ planType: 'prolite', ...at }), /Visit https:\/\/chatgpt\.com\/settings\/usage/u);
  assert.equal(
    usageLimitMessage({ planType: 'enterprise', resetsAtMs: FUTURE, now: NOW_SAME_DAY }),
    'You’ve hit your usage limit. Try again at 3:04 PM.'
  );
  assert.equal(usageLimitMessage({}), 'You’ve hit your usage limit. Try again later.');
  assert.match(
    usageLimitMessage({ promo: 'Get 2x', planType: 'plus', ...at }),
    /^You’ve hit your usage limit\. Get 2x, or try again at/u
  );
  assert.equal(
    usageLimitMessage({ reachedType: 'workspace_owner_credits_depleted' }),
    'Your workspace is out of credits. Add credits to continue.'
  );
  assert.match(
    usageLimitMessage({ reachedType: 'workspace_member_usage_limit_reached' }),
    /spend cap set by the owner/u
  );
  assert.match(
    usageLimitMessage({ limitName: 'GPT-5 Spark', planType: 'plus' }),
    /usage limit for GPT-5 Spark\. Switch to another model now, or try again later\./u
  );
  assert.match(usageLimitMessage({ limitName: 'codex', planType: 'free' }), /Upgrade to Plus/u);
});

test('HTTP usage_limit_reached carries the mapped copy, promo header and workspace type', async () => {
  const body = JSON.stringify({
    error: { type: 'usage_limit_reached', message: 'raw server text', plan_type: 'plus', resets_at: 1893456000 },
  });
  const err = httpResponseError({
    label: 'OpenAI OAuth HTTP fallback',
    status: 429,
    headers: new Headers({ 'x-codex-rate-limit-reached-type': 'workspace_owner_usage_limit_reached' }),
    text: body,
  });
  assert.equal(err.code, 'usage_limit_reached');
  assert.match(err.message, /^OpenAI OAuth HTTP fallback 429: You hit your spend cap set in your workspace/u);
  assert.equal(err.providerError.message, 'raw server text');
  assert.doesNotMatch(err.message, /raw server text/u);
  const promo = httpResponseError({
    label: 'L',
    status: 429,
    headers: { 'X-Codex-Promo-Message': 'Try Pro' },
    text: body,
  });
  assert.match(promo.userMessage, /^You’ve hit your usage limit\. Try Pro, or try again at /u);
});

test('usage_not_included, quota codes and overload map to typed copy; empty ws codes fall back', () => {
  const mk = (error, status) => applyErrorContract(new Error(`x: ${error.message || ''}`), { status, error });
  assert.equal(
    mk({ type: 'usage_not_included', message: 'm' }, 429).userMessage,
    'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.'
  );
  for (const code of [
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ]) {
    assert.equal(
      mk({ code, message: 'm' }, 429).userMessage,
      'Quota exceeded. Check your plan and billing details.',
      code
    );
  }
  assert.equal(
    mk({ code: 'server_is_overloaded', message: 'm' }, 503).userMessage,
    'Selected model is at capacity. Please try a different model.'
  );
  assert.match(
    mk({ code: 'websocket_connection_limit_reached' }, undefined).userMessage,
    /connection limit reached \(60 minutes\)/u
  );
  assert.equal(
    mk({ code: 'previous_response_not_found' }, undefined).userMessage,
    'Previous response was not found. Retrying the full request.'
  );
  assert.equal(
    mk({ code: 'previous_response_not_found', message: 'own text' }, undefined).userMessage,
    undefined,
    'server text wins when present'
  );
});

test('transport fallback waits out the captured retry deadline, abortably', async () => {
  const err = applyErrorContract(new Error('x'), { status: 503, headers: { 'retry-after': '30' } });
  const waits = [];
  await waitForRetryDeadline(err, null, async (ms) => waits.push(ms));
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 29_000 && waits[0] <= 30_000);
  err.retryAfterAt = Date.now() - 1;
  await waitForRetryDeadline(err, null, async (ms) => waits.push(ms));
  assert.equal(waits.length, 1, 'an elapsed deadline waits nothing');
  const controller = new AbortController();
  const pending = waitForRetryDeadline(
    applyErrorContract(new Error('x'), { status: 503, headers: { 'retry-after': '3600' } }),
    controller.signal,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())
  );
  setTimeout(() => controller.abort(new Error('stop')), 10);
  await assert.rejects(pending, /stop|aborted/u);
});

test('WS handshake policy: overload / untyped 429 retry only with server advice', () => {
  const err = (fields) => Object.assign(new Error('x'), fields);
  assert.equal(_classifyHandshakeError(err({ httpStatus: 429, status: 429 })), null);
  assert.equal(_classifyHandshakeError(err({ httpStatus: 503, status: 503, code: 'server_is_overloaded' })), null);
  assert.notEqual(_classifyHandshakeError(err({ httpStatus: 429, status: 429, retryAfterMs: 1000 })), null);
});

test('WS mid-stream policy: overload / untyped 429 retry only with server advice', () => {
  const state = { sawResponseCreated: true, attemptIndex: 0 };
  const err = (fields) => Object.assign(new Error('x'), fields);
  assert.equal(
    _classifyMidstreamError(err({ httpStatus: 503, status: 503, code: 'server_is_overloaded' }), state),
    null
  );
  assert.equal(_classifyMidstreamError(err({ httpStatus: 429, status: 429 }), state), null);
  // Advice present: the gate no longer denies (the classifier may still decide by its own rules).
  const advised = err({ httpStatus: 503, status: 503, code: 'server_is_overloaded', retryAfterMs: 1000 });
  assert.notEqual(_classifyMidstreamError(advised, state), null);
});

test('the handshake wrapper forwards explicit gate overrides', () => {
  const overloaded = Object.assign(new Error('x'), { httpStatus: 503, status: 503, code: 'server_is_overloaded' });
  assert.equal(_classifyHandshakeError(overloaded), null);
  assert.notEqual(_classifyHandshakeError(overloaded, { overloadRetryRequiresAdvice: false }), null);
});
