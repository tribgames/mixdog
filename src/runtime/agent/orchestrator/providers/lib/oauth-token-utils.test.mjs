import assert from 'node:assert/strict';
import test from 'node:test';
import { isDefinitiveOAuthFailure } from './oauth-token-utils.mjs';

test('isDefinitiveOAuthFailure accepts dead-grant signals and bare 401', () => {
  assert.equal(isDefinitiveOAuthFailure('{"error":"invalid_grant","error_description":"Refresh token expired"}', 400), true);
  assert.equal(isDefinitiveOAuthFailure('invalid_token', 400), true);
  assert.equal(isDefinitiveOAuthFailure('unauthorized_client', 400), true);
  assert.equal(isDefinitiveOAuthFailure('Refresh token revoked', 400), true);
  assert.equal(isDefinitiveOAuthFailure('', 401), true);
});

test('isDefinitiveOAuthFailure rejects transient and policy failures', () => {
  assert.equal(isDefinitiveOAuthFailure('forbidden', 403), false);
  assert.equal(isDefinitiveOAuthFailure('rate limit exceeded', 429), false);
  assert.equal(isDefinitiveOAuthFailure('Bad Gateway', 502), false);
  assert.equal(isDefinitiveOAuthFailure('upstream error', 500), false);
  for (const t of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'socket hang up', 'fetch failed', 'request timed out']) {
    assert.equal(isDefinitiveOAuthFailure(t, 0), false);
    assert.equal(isDefinitiveOAuthFailure(t, 401), false);
  }
  assert.equal(isDefinitiveOAuthFailure('', 0), false);
});
