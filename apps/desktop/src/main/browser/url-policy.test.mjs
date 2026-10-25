import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUrlPolicyFromEnvironment } from './host-policy.ts';
import { restorablePages } from './restore-pages.ts';
import {
  assertResolvedAddressAllowed,
  MAIL_LINK_WINDOW_MS,
  normalizeAgentUrl,
  normalizePageUrl,
} from './url-policy.ts';

test('a local session allows LAN and Tailscale addresses, a remote session blocks them, metadata is always blocked', (t) => {
  const saved = process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK;
    else process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK = saved;
  });
  delete process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK;
  const local = browserUrlPolicyFromEnvironment({ remote: false });
  const remote = browserUrlPolicyFromEnvironment({ remote: true });
  for (const address of ['192.168.1.10', '100.101.102.103']) {
    assert.equal(normalizeAgentUrl(`http://${address}/`, local), `http://${address}/`);
    assert.equal(normalizePageUrl(`http://${address}/`, local), `http://${address}/`);
    assert.doesNotThrow(() => assertResolvedAddressAllowed(address, address, local));
    assert.throws(() => normalizeAgentUrl(`http://${address}/`, remote), /private or internal/);
    assert.throws(() => normalizePageUrl(`http://${address}/`, remote), /private or internal/);
    assert.throws(() => assertResolvedAddressAllowed(address, address, remote), /private or internal/);
  }
  for (const policy of [local, remote]) {
    assert.throws(() => normalizeAgentUrl('http://169.254.169.254/latest/meta-data', policy), /metadata/);
    assert.throws(() => normalizePageUrl('http://169.254.169.254/latest/meta-data', policy), /metadata/);
    assert.throws(() => assertResolvedAddressAllowed('169.254.169.254', 'metadata.test', policy), /metadata/);
  }
});

test('browser URL policy blocks credentials, metadata, and private networks but keeps loopback', () => {
  assert.equal(normalizeAgentUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeAgentUrl('http://localhost:3000/app'), 'http://localhost:3000/app');
  assert.throws(() => normalizeAgentUrl('https://user:pass@example.com'), /embedded credentials/);
  assert.throws(() => normalizeAgentUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
  assert.throws(() => normalizeAgentUrl('http://192.168.1.1'), /private or internal/);
  assert.throws(() => normalizeAgentUrl('https://example.com/collect?token=plain-secret'), /credential-like/);
  assert.throws(() => normalizeAgentUrl('https://example.com/collect/sk%2Dproj%2Dabcdefghijklmnop'), /secret tokens/);
  assert.equal(
    normalizeAgentUrl('http://localhost:3000/callback?token=local-development'),
    'http://localhost:3000/callback?token=local-development'
  );
  assert.equal(normalizeAgentUrl('http://192.168.1.1', { allowPrivateNetwork: true }), 'http://192.168.1.1/');
  assert.throws(
    () => normalizeAgentUrl('https://example.net', { allowedDomains: ['example.com', '*.trusted.test'] }),
    /domain policy/
  );
  assert.equal(
    normalizePageUrl('https://example.com/product?dib=eyJ2IjoiMSJ9.long.site.token'),
    'https://example.com/product?dib=eyJ2IjoiMSJ9.long.site.token'
  );
  assert.throws(() => normalizePageUrl('https://user:pass@example.com'), /embedded credentials/);
  assert.throws(() => normalizePageUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
  assert.throws(() => normalizePageUrl('file:///C:/Users/example/secrets.txt'), /only http\(s\)/);
});

test('a token link opens only as the runtime read it in a mail: exact, https, recent, on the sender’s domain', () => {
  const LINK =
    'https://alternativeto.net/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImRldiJ9.c2lnbmF0dXJlLXZhbHVl&callbackURL=https%3A%2F%2Falternativeto.net%2F';
  const read = (fields = {}) => ({ url: LINK, from_domain: 'alternativeto.net', read_at: Date.now(), ...fields });
  assert.equal(normalizeAgentUrl(LINK, {}, read()), LINK);
  assert.equal(normalizeAgentUrl(LINK, {}, read({ from_domain: 'mail.alternativeto.net' })), LINK, 'a mail subdomain');
  assert.throws(() => normalizeAgentUrl(LINK), /credential-like/, 'typed without a mail read');
  const lookalike = LINK.replace('alternativeto.net/', 'alternativeto.net.evil.com/');
  const punycode = LINK.replace('https://alternativeto.net/', 'https://\u0430lternativeto.net/');
  const refused = [
    ['another sender domain', LINK, read({ from_domain: 'evil.example' })],
    ['http', LINK.replace('https:', 'http:'), read({ url: LINK.replace('https:', 'http:') })],
    ['past the window', LINK, read({ read_at: Date.now() - MAIL_LINK_WINDOW_MS - 1_000 })],
    ['a URL other than the mail’s', `${LINK}&next=%2Fadmin`, read()],
    ['a suffix lookalike host', lookalike, read({ url: lookalike })],
    ['a suffix lookalike sender', LINK, read({ from_domain: 'alternativeto.net.evil.com' })],
    ['a punycode lookalike host', punycode, read({ url: punycode })],
    ['a sender that is not a domain', LINK, read({ from_domain: 'evil.example/alternativeto.net' })],
    ['no read time', LINK, read({ read_at: undefined })],
  ];
  for (const [why, url, link] of refused) {
    assert.throws(() => normalizeAgentUrl(url, {}, link), /credential-like|secret tokens/, why);
  }
  // Every other rule still holds for a mail link.
  assert.throws(
    () => normalizeAgentUrl(LINK, { allowedDomains: ['example.com'] }, read()),
    /domain policy/,
    'the domain allowlist'
  );
});

test('session restoration recreates admitted web pages only, without relaxing navigation admission', () => {
  const policy = { allowedDomains: ['gamerscroll.com'] };
  const restored = (urls, restorePolicy = policy) =>
    restorablePages(
      urls.map((url) => ({ url })),
      restorePolicy
    ).map(({ url }) => url);
  assert.deepEqual(restored(['about:blank', 'https://gamerscroll.com/rankings/']), [
    'https://gamerscroll.com/rankings/',
  ]);
  for (const normalize of [normalizeAgentUrl, normalizePageUrl]) {
    assert.throws(() => normalize('about:blank', policy), /only http\(s\)/);
  }
  assert.deepEqual(
    restored([
      'about:config',
      'about:blank#fragment',
      'file:///C:/secrets.txt',
      'javascript:alert(1)',
      'data:text/html,test',
      'https://outside.test',
      'https://user:pass@gamerscroll.com',
    ]),
    []
  );
  assert.deepEqual(restored(['http://192.168.1.1', 'http://169.254.169.254/latest/meta-data'], {}), []);
});
