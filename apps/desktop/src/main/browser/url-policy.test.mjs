import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAgentUrl, normalizePageUrl, normalizeRestoredPageUrl } from './url-policy.ts';

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

test('session restoration accepts an internal blank tab alongside web tabs without relaxing navigation admission', () => {
  const policy = { allowedDomains: ['gamerscroll.com'] };
  assert.deepEqual(
    ['about:blank', 'https://gamerscroll.com/rankings/'].map(url => normalizeRestoredPageUrl(url, policy)),
    ['about:blank', 'https://gamerscroll.com/rankings/'],
  );
  for (const normalize of [normalizeAgentUrl, normalizePageUrl]) {
    assert.throws(() => normalize('about:blank', policy), /only http\(s\)/);
  }
  for (const url of ['about:config', 'about:blank#fragment', 'file:///C:/secrets.txt', 'javascript:alert(1)', 'data:text/html,test']) {
    assert.throws(() => normalizeRestoredPageUrl(url, policy), /only http\(s\)/);
  }
  assert.throws(() => normalizeRestoredPageUrl('https://outside.test', policy), /domain policy/);
  assert.throws(() => normalizeRestoredPageUrl('http://192.168.1.1'), /private or internal/);
  assert.throws(() => normalizeRestoredPageUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
  assert.throws(() => normalizeRestoredPageUrl('https://user:pass@gamerscroll.com'), /embedded credentials/);
});
