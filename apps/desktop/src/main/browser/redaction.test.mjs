import assert from 'node:assert/strict';
import test from 'node:test';

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { micaLibraryPath } from '../window-mica.ts';

// The rules are Rust, served by mixdog_window.node: these tests run against the built module and are skipped, not
// failed, while it is absent (cargo build --release in native/mixdog-window; they never build it).
const built = existsSync(
  micaLibraryPath({ isPackaged: false, resourcesPath: '', appPath: fileURLToPath(new URL('../../..', import.meta.url)) })
);
const skip = built ? false : 'mixdog_window.node is not built (cargo build --release in native/mixdog-window)';

const { browserUrlContainsSecret, redactBrowserText, redactBrowserKnownSecrets, redactBrowserUrl } = built
  ? await import('./redaction.ts')
  : {};

test('browser URL secret detection covers encoded token shapes without blocking ordinary keys', { skip }, () => {
  assert.equal(browserUrlContainsSecret('https://example.com/?api_key=value'), true);
  assert.equal(browserUrlContainsSecret('https://example.com/%67%68%70%5Fabcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(browserUrlContainsSecret('https://example.com/docs?key=keyboard'), false);
});

test('browser URL secret decoding stays bounded and tolerates malformed escapes', { skip }, () => {
  assert.equal(browserUrlContainsSecret('https://example.test/%2567%2568%2570%255Fabcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(
    browserUrlContainsSecret('https://example.test/%252567%252568%252570%25255Fabcdefghijklmnopqrstuvwxyz'),
    false
  );
  assert.equal(browserUrlContainsSecret('https://example.test/Bearer+abcdefghijklmnop'), true);
  assert.equal(browserUrlContainsSecret('https://example.test/%zz'), false);
  assert.equal(browserUrlContainsSecret('https://example.test/%zz/ghp_abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(browserUrlContainsSecret(''), false);
});

test('browser output redacts URL credentials and common token shapes', { skip }, () => {
  const redacted = redactBrowserText(
    'https://alice:secret@example.com/?access_token=abc123 sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz'
  );
  assert.doesNotMatch(redacted, /secret|abc123|abcdefghijklmnop|ghp_/);
  assert.match(redacted, /\[REDACTED/);
  assert.doesNotMatch(redactBrowserText('{"access_token":"opaque-value","name":"safe"}'), /opaque-value/);
  assert.doesNotMatch(redactBrowserUrl('https://example.test/callback?code=opaque-code&state=public'), /opaque-code/);
});

test('known browser credential redaction never amplifies short secrets', { skip }, () => {
  const source = 'a password can be short: a';
  const redacted = redactBrowserKnownSecrets(source, ['a', '*']);
  assert.equal(redacted.includes('a'), false);
  assert.ok(redacted.length <= source.length);
});

test('auth assignments redact the entire opaque credential and repeated redaction is stable', { skip }, () => {
  for (const value of [
    'Authorization: Bearer MIXDOG_SYNTHETIC_ONLY_0123456789',
    'authorization = Basic QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
    'token=synthetic-test-value',
    '{"password":"synthetic-test-value","name":"public"}',
    'https://example.test/?token=synthetic-test-value',
    'Authorization: [REDACTED STORED CREDENTIAL]',
  ]) {
    const once = redactBrowserText(value);
    assert.doesNotMatch(once, /MIXDOG_SYNTHETIC|QUJDREV|synthetic-test-value/);
    assert.equal(redactBrowserText(once), once);
    assert.equal(redactBrowserText(redactBrowserText(once)), once);
  }
  assert.equal(
    redactBrowserText('Authorization: Bearer MIXDOG_SYNTHETIC_ONLY_0123456789'),
    'Authorization: [REDACTED]'
  );
});
