import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError, safeErrorDetails } from './error-presentation.mjs';
import { presentErrorText } from './err-text.mjs';

const providerFailure = (index) => new Error(`Anthropic OAuth API 400: ${JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: `messages.11.content.${index}.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests` },
})}`);

test('prefixed provider JSON becomes a short actionable summary without discarding diagnostics', () => {
  const failure = providerFailure(54);
  const result = describeError(failure);
  assert.equal(result.kind, 'image-size');
  assert.equal(result.summary, 'An attached image exceeds the provider limit.');
  assert.match(result.recovery, /image dimensions or number/);
  assert.match(result.details, /content\.54/);
  assert.equal(result.fingerprint, describeError(providerFailure(62)).fingerprint);
  assert.equal(presentErrorText(failure), result.summary);
});

test('typed failures distinguish sign-in, rate, request and connection recovery', () => {
  for (const [status, kind] of [[401, 'authentication'], [429, 'rate-limit'], [400, 'request'], [413, 'payload-size'], [503, 'connection']]) {
    const result = describeError(Object.assign(new Error('upstream rejected the request'), { status }));
    assert.equal(result.kind, kind);
    assert.ok(result.recovery);
  }
  assert.equal(describeError(new Error('ordinary failure A')).fingerprint === describeError(new Error('ordinary failure B')).fingerprint, false);
});

test('both summaries and details redact credentials while retaining useful context', () => {
  const secret = 'test-password-123';
  const raw = `Failed at https://user:${secret}@example.test/path?token=abcdef&safe=1\nAuthorization: Bearer verysecret123\n{"api_key":"sk-123456789012345678901234","password":"${secret}"}\nhttps://example.test/?code=oauthcode`;
  const result = describeError(new Error(raw));
  for (const text of [result.summary, result.details, safeErrorDetails(raw), presentErrorText(new Error(raw))]) {
    assert.doesNotMatch(text, /test-password-123|verysecret123|abcdef|oauthcode|sk-1234567890/);
  }
  assert.match(result.details, /example\.test/);
  assert.match(result.details, /safe=1/);
});

test('diagnostic payloads and display summaries have bounded size', () => {
  const result = describeError(new Error(`Failure ${'x'.repeat(40_000)}`));
  assert.ok(result.summary.length <= 180);
  assert.ok(result.details.length <= 12_002);
  assert.doesNotMatch(safeErrorDetails(`{"data":"${'a'.repeat(1000)}"}`), /a{256}/);
});

test('runtime summaries retain their recovery classification after persistence', () => {
  for (const error of [providerFailure(1), Object.assign(new Error('large request'), { status: 413 })]) {
    const first = describeError(error);
    assert.equal(describeError(first.summary).kind, first.kind);
  }
});
