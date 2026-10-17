import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundTaskFailureStatusLabel, presentErrorText, retryReasonText } from './err-text.mjs';

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
  assert.equal(presentErrorText(error), text);
  // Persisted as text, it stays the same sentence.
  assert.equal(presentErrorText(text), text);
  assert.equal(
    backgroundTaskFailureStatusLabel('failed', text, { surface: 'agent' }),
    'Timeout · Model still thinking: no output in 465s; Antigravity sent nothing yet; attempts: 2'
  );
  assert.equal(
    retryReasonText(
      timeout('Antigravity first byte timed out after 180000ms', {
        timeoutPhase: 'headers',
        attempts: 1,
        waitedMs: 180_000,
        providerLabel: 'Antigravity',
      })
    ),
    'Model still thinking: no output in 3m; Antigravity sent nothing yet; attempts: 1'
  );
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
