import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upstreamError, usageLimitFromResponse } from './upstream-error.mjs';

test('HTML error pages are not echoed into the message', () => {
  const error = upstreamError('ChatGPT image', 502, '<html><body>gateway</body></html>');
  assert.equal(error.message, 'ChatGPT image failed (502)');
});

test('only 429 usage-limit bodies count as usage limits', () => {
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 10 } });
  assert.deepEqual(usageLimitFromResponse(429, body, new Headers()), { limitId: '', resetsAt: 10 });
  assert.equal(usageLimitFromResponse(400, body, new Headers()), null);
  assert.equal(
    usageLimitFromResponse(429, JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), new Headers()),
    null
  );
  assert.deepEqual(
    usageLimitFromResponse(
      429,
      '',
      new Headers({ 'x-codex-rate-limit-reached-type': 'workspace_member_usage_limit_reached' })
    ),
    { limitId: '', resetsAt: null }
  );
});
