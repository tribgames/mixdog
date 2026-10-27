import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityError } from './antigravity-transport.mjs';

const verify = (details) =>
  antigravityError(
    { status: 403, headers: new Headers() },
    JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'verify your account', details } }),
    'https://x'
  );
const info = (metadata) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason: 'VALIDATION_REQUIRED',
  metadata,
});
const help = (...urls) => ({
  '@type': 'type.googleapis.com/google.rpc.Help',
  links: urls.map((url) => ({ description: 'Verify', url })),
});

test('verification URL prefers google.rpc.Help.links', () => {
  const err = verify([
    info({ validation_url: 'https://accounts.google.com/url', validation_link: 'https://accounts.google.com/link' }),
    help('https://accounts.google.com/help'),
  ]);
  assert.equal(err.validationUrl, 'https://accounts.google.com/help');
  assert.match(err.message, /accounts\.google\.com\/help/);
  assert.equal(err.code, 'validation_required');
});

test('verification URL falls back to metadata.validation_url then validation_link', () => {
  assert.equal(
    verify([
      info({ validation_url: 'https://accounts.google.com/url', validation_link: 'https://accounts.google.com/link' }),
    ]).validationUrl,
    'https://accounts.google.com/url'
  );
  assert.equal(
    verify([info({ validation_link: 'https://accounts.google.com/link' })]).validationUrl,
    'https://accounts.google.com/link'
  );
});
