import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSignIns, normalizeSignedInSite, signedInSites } from './signed-in-sites.ts';

const cookie = (domain, name, extra = {}) => ({
  domain,
  name,
  value: `VALUE-${name}-SENTINEL`,
  path: '/',
  secure: true,
  httpOnly: false,
  session: false,
  ...extra,
});

function jar(initial) {
  let cookies = [...initial];
  const removed = [];
  return {
    removed,
    get: async () => cookies,
    remove: async (url, name, partitionKey) => {
      removed.push([url, name, partitionKey]);
      const host = new URL(url).hostname;
      cookies = cookies.filter((c) => !(c.name === name && c.domain.replace(/^\./, '') === host));
    },
  };
}

const profile = [
  cookie('.example.com', 'sid', { httpOnly: true, session: true }),
  cookie('accounts.example.com', '__Host-auth', { httpOnly: true }),
  cookie('.example.com', '_ga'),
  cookie('mail.other.org', 'session', {
    httpOnly: true,
    secure: false,
    partitionKey: { topLevelSite: 'https://x.test', hasCrossSiteAncestor: false },
  }),
  cookie('.tracker.net', 'id'),
];

test('signed-in sites are the cookie domains holding an HttpOnly cookie, subdomains folded, values never listed', () => {
  const sites = signedInSites(profile);
  assert.deepEqual(sites, [
    { site: 'example.com', cookies: 3 },
    { site: 'mail.other.org', cookies: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(sites), /SENTINEL|sid|__Host/);
  assert.equal(normalizeSignedInSite(' Example.COM '), 'example.com');
  assert.throws(() => normalizeSignedInSite('https://example.com/'), /invalid/);
  assert.throws(() => normalizeSignedInSite(''), /invalid/);
});

test('per-site sign-out clears that site only, its storage, and the sealed copy; clear all also deletes imports', async () => {
  const cookies = jar(profile);
  const calls = [];
  const signIns = createBrowserSignIns({
    cookies,
    clearOriginStorage: async (origin) => calls.push(['storage', origin]),
    clearAllStorage: async () => calls.push(['all-storage']),
    clearImportedData: async () => calls.push(['imported']),
    saveSessionCookies: async () => calls.push(['save']),
  });
  assert.equal(await signIns.signOut('example.com'), 3);
  assert.deepEqual(
    cookies.removed.map(([url, name]) => [url, name]),
    [
      ['https://example.com/', 'sid'],
      ['https://accounts.example.com/', '__Host-auth'],
      ['https://example.com/', '_ga'],
    ]
  );
  assert.deepEqual(
    (await signIns.list()).map((entry) => entry.site),
    ['mail.other.org']
  );
  assert.ok(calls.some(([kind, origin]) => kind === 'storage' && origin === 'https://accounts.example.com'));
  assert.ok(calls.some(([kind, origin]) => kind === 'storage' && origin === 'https://example.com'));
  assert.ok(!calls.some(([, origin]) => String(origin).includes('other.org')), 'other sites keep their data');
  assert.deepEqual(calls.at(-1), ['save'], 'the restart copy no longer holds the sign-in');

  // A partitioned cookie is removed from its own partition.
  await signIns.signOut('mail.other.org');
  assert.deepEqual(cookies.removed.at(-1), [
    'http://mail.other.org/',
    'session',
    { topLevelSite: 'https://x.test', hasCrossSiteAncestor: false },
  ]);

  calls.length = 0;
  await signIns.clearAll();
  assert.deepEqual(calls, [['all-storage'], ['imported'], ['save']]);
});
