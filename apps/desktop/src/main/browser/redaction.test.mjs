import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserUrlContainsSecret,
  redactBrowserText,
  redactBrowserKnownSecrets,
  redactBrowserUrl,
} from './redaction.ts';

test('browser URL secret detection covers encoded token shapes without blocking ordinary keys', () => {
  assert.equal(browserUrlContainsSecret('https://example.com/?api_key=value'), true);
  assert.equal(
    browserUrlContainsSecret('https://example.com/%67%68%70%5Fabcdefghijklmnopqrstuvwxyz'),
    true,
  );
  assert.equal(browserUrlContainsSecret('https://example.com/docs?key=keyboard'), false);
});

test('browser output redacts URL credentials and common token shapes', () => {
  const redacted = redactBrowserText(
    'https://alice:secret@example.com/?access_token=abc123 sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz',
  );
  assert.doesNotMatch(redacted, /secret|abc123|abcdefghijklmnop|ghp_/);
  assert.match(redacted, /\[REDACTED/);
  assert.doesNotMatch(
    redactBrowserText('{"access_token":"opaque-value","name":"safe"}'),
    /opaque-value/,
  );
  assert.doesNotMatch(
    redactBrowserUrl('https://example.test/callback?code=opaque-code&state=public'),
    /opaque-code/,
  );
});

test('known browser credential redaction never amplifies short secrets', () => {
  const source = 'a password can be short: a';
  const redacted = redactBrowserKnownSecrets(source, ['a', '*']);
  assert.equal(redacted.includes('a'), false);
  assert.ok(redacted.length <= source.length);
});
