import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundTaskFailureStatusLabel, presentErrorText, retryTimeoutText } from './err-text.mjs';

function timeout(message, fields) {
  return Object.assign(new Error(message), { name: 'ProviderTimeoutError', code: 'EPROVIDERTIMEOUT', ...fields });
}

test('a first-byte timeout reads as a model still thinking, with the wait and the attempts', () => {
  const error = timeout('Antigravity first byte timed out after 285000ms', {
    timeoutPhase: 'headers',
    attempts: 2,
    waitedMs: 465_000,
    providerLabel: 'Antigravity',
  });
  const text = 'Model still thinking: no output in 465s; Antigravity sent nothing yet; attempts: 2.';
  assert.equal(presentErrorText(error, { providerLabel: 'Antigravity' }), text);
  // An error-carried label is never trusted as the provider name.
  assert.match(presentErrorText(error), /; the provider sent nothing yet; /);
  // Persisted as text, it stays the same sentence.
  assert.equal(presentErrorText(text), text);
  assert.equal(
    backgroundTaskFailureStatusLabel('failed', text, { surface: 'agent' }),
    'Timeout · Model still thinking: no output in 465s; Antigravity sent nothing yet; attempts: 2'
  );
});

test('retry timeout wording takes the provider name from the caller, not the error', () => {
  const error = timeout('x first byte timed out after 60000ms', {
    timeoutPhase: 'headers',
    providerLabel: 'INJECTED_LABEL',
  });
  assert.equal(
    retryTimeoutText(error, 'first_response_timeout', 'Antigravity'),
    'Model still thinking: no output in 1m; Antigravity sent nothing yet'
  );
  assert.ok(!retryTimeoutText(error, 'first_response_timeout').includes('INJECTED'));
});

test('retry timeout wording comes from typed stamps, other classes get none', () => {
  assert.equal(
    retryTimeoutText(timeout('provider first byte timed out after 60000ms'), 'first_response_timeout'),
    'No first response 1m'
  );
  assert.equal(
    retryTimeoutText(Object.assign(new Error('x timed out after 300000ms'), { timeoutPhase: 'idle' }), 'stalled'),
    'No progress 5m'
  );
  assert.equal(retryTimeoutText(new Error('x'), 'other'), null);
});

test('a first-chunk timeout without a named provider still reads as thinking', () => {
  const error = Object.assign(new Error('Gemini streamGenerateContent first byte timed out after 60000ms'), {
    name: 'GeminiTimeoutError',
    code: 'EGEMINITIMEOUT',
    timeoutPhase: 'first-chunk',
  });
  assert.equal(presentErrorText(error), 'Model still thinking: no output in 1m; the provider sent nothing yet.');
});

test('an idle timeout reads as no progress', () => {
  const error = Object.assign(new Error('Antigravity streamGenerateContent SSE idle timed out after 300000ms'), {
    name: 'GeminiTimeoutError',
    code: 'EGEMINITIMEOUT',
    timeoutPhase: 'idle',
  });
  assert.equal(presentErrorText(error), 'No progress 5m.');
});

test('a truncated stream reads as a dropped connection, like a socket loss', () => {
  const truncated = Object.assign(new Error('Antigravity streamGenerateContent truncated: no finishReason'), {
    code: 'TRUNCATED_STREAM',
    truncatedStream: true,
  });
  assert.equal(presentErrorText(truncated), 'Connection to the provider was lost (TRUNCATED_STREAM).');
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
  assert.equal(presentErrorText(reset), 'Connection to the provider was lost (ECONNRESET).');
});

test('the agent watchdog has its own wording, distinct from provider timeouts', () => {
  const text = presentErrorText(new Error('agent first transport stale (481000ms)'));
  assert.equal(text, 'Agent watchdog stopped the run: no model response in 481s.');
  assert.equal(
    presentErrorText(new Error('agent first semantic response stale (600000ms)')),
    'Agent watchdog stopped the run: no model response in 10m.'
  );
  assert.equal(presentErrorText(text), text);
  assert.equal(
    backgroundTaskFailureStatusLabel('failed', text, { surface: 'agent' }),
    'Timeout · Agent watchdog stopped the run: no model response in 481s'
  );
});
