import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAgentUrl, normalizePageUrl } from './url-policy.ts';

test('browser URL policy blocks credentials, metadata, and private networks but keeps loopback', () => {
  assert.equal(normalizeAgentUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeAgentUrl('http://localhost:3000/app'), 'http://localhost:3000/app');
  assert.throws(() => normalizeAgentUrl('https://user:pass@example.com'), /embedded credentials/);
  assert.throws(() => normalizeAgentUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
  assert.throws(() => normalizeAgentUrl('http://192.168.1.1'), /private or internal/);
  assert.throws(
    () => normalizeAgentUrl('https://example.com/collect?token=plain-secret'),
    /credential-like/,
  );
  assert.throws(
    () => normalizeAgentUrl('https://example.com/collect/sk%2Dproj%2Dabcdefghijklmnop'),
    /secret tokens/,
  );
  assert.equal(
    normalizeAgentUrl('http://localhost:3000/callback?token=local-development'),
    'http://localhost:3000/callback?token=local-development',
  );
  assert.equal(
    normalizeAgentUrl('http://192.168.1.1', { allowPrivateNetwork: true }),
    'http://192.168.1.1/',
  );
  assert.throws(
    () => normalizeAgentUrl('https://example.net', { allowedDomains: ['example.com', '*.trusted.test'] }),
    /domain policy/,
  );
  assert.equal(
    normalizePageUrl('https://example.com/product?dib=eyJ2IjoiMSJ9.long.site.token'),
    'https://example.com/product?dib=eyJ2IjoiMSJ9.long.site.token',
  );
  assert.throws(() => normalizePageUrl('https://user:pass@example.com'), /embedded credentials/);
  assert.throws(() => normalizePageUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
  assert.throws(() => normalizePageUrl('file:///C:/Users/example/secrets.txt'), /only http\(s\)/);
});
