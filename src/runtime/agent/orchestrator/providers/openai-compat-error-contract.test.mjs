import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCompatErrorContract } from './openai-compat-error-contract.mjs';
import { consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { classifyError, typedErrorCode } from './retry-classifier.mjs';

// The OpenAI SDK's APIError shape: `error` is the body's error object and
// `code`/`type` mirror its fields.
function sdkError(status, body, headers) {
  return Object.assign(new Error(body.message || 'failed'), {
    name: 'APIError',
    status,
    error: body,
    code: body.code ?? undefined,
    type: body.type,
    headers,
  });
}

test('type-only insufficient_quota is normalized into a lowercased code', () => {
  const err = applyCompatErrorContract(
    sdkError(429, { message: 'You exceeded your current quota.', type: 'Insufficient_Quota' })
  );
  assert.equal(err.code, 'insufficient_quota');
  assert.equal(typedErrorCode(err), 'insufficient_quota');
  assert.equal(err.status, 429);
  assert.equal(classifyError(err), 'permanent');
});

test('content_policy_violation and request_too_large keep their codes', () => {
  const policy = applyCompatErrorContract(sdkError(400, { message: 'no', code: 'content_policy_violation' }));
  assert.equal(policy.code, 'content_policy_violation');
  const tooLarge = applyCompatErrorContract(sdkError(413, { message: 'big', type: 'request_too_large' }));
  assert.equal(tooLarge.code, 'request_too_large');
  assert.equal(tooLarge.status, 413);
  const both = applyCompatErrorContract(
    sdkError(400, { message: 'x', code: 'request_too_large', type: 'invalid_request_error' })
  );
  assert.equal(both.code, 'request_too_large');
});

test('a socket errno is not overwritten by a wire type', () => {
  const err = Object.assign(new Error('reset'), { code: 'ECONNRESET', error: { type: 'server_error' } });
  assert.equal(applyCompatErrorContract(err).code, 'ECONNRESET');
});

test('headers, retryAfterMs and resetAt are surfaced when the provider sends them', () => {
  const now = 1_700_000_000_000;
  const response = { headers: new Headers({ 'retry-after': '7' }) };
  const err = Object.assign(sdkError(429, { type: 'usage_limit_reached', resets_in_seconds: 90 }), { response });
  applyCompatErrorContract(err, err.error, now);
  assert.equal(err.headers, response.headers);
  assert.equal(err.retryAfterMs, 7000);
  assert.equal(err.resetAt, now + 90_000);
  const epoch = applyCompatErrorContract(sdkError(429, { type: 'usage_limit_reached', resets_at: 1_800_000_000 }));
  assert.equal(epoch.resetAt, 1_800_000_000_000);
  const bare = applyCompatErrorContract(sdkError(500, { type: 'server_error' }));
  assert.equal(bare.retryAfterMs, undefined);
  assert.equal(bare.resetAt, undefined);
});

test('an untyped error gets no synthesized status', () => {
  const err = applyCompatErrorContract(new Error('401 in the text only'));
  assert.equal(err.status, undefined);
  assert.equal(err.code, undefined);
});

test('Responses error events normalize type-only codes and status', async () => {
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'response.failed',
        response: { error: { message: 'quota', type: 'insufficient_quota', status: 429 } },
      };
    },
  };
  const err = await consumeCompatResponsesStream(stream, { label: 'gw:responses' }).then(
    () => assert.fail('expected rejection'),
    (error) => error
  );
  assert.equal(err.code, 'insufficient_quota');
  assert.equal(err.status, 429);
  assert.equal(classifyError(err), 'permanent');
});

test('the provider boundary stamps the contract on SDK errors', async () => {
  const provider = new OpenAICompatProvider('openai', { apiKey: 'k', preconnect: false });
  const failure = sdkError(429, { message: 'quota', type: 'insufficient_quota' }, { 'retry-after-ms': '1500' });
  provider._sendWithOpts = async () => {
    throw failure;
  };
  await assert.rejects(provider._doSend([], 'm', [], {}), (error) => {
    assert.equal(error, failure);
    assert.equal(error.code, 'insufficient_quota');
    assert.equal(error.retryAfterMs, 1500);
    return true;
  });
});
