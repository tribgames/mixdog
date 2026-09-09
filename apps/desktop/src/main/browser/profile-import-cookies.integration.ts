import assert from 'node:assert/strict';
import { session } from 'electron';
import { CookieImportError, importBrowserCookies } from './profile-import-cookies';

export async function verifyCookieImport(): Promise<void> {
  const partition = session.fromPartition(`cookie-migration-${Date.now()}`);
  const origin = 'https://accounts.example.test/';
  await partition.cookies.set({
    url: origin, domain: '.accounts.example.test', name: 'LSID', value: 'bad-duplicate',
  });
  await partition.cookies.set({
    url: origin, domain: '.example.test', name: 'LSID', value: 'parent-session',
  });
  await partition.cookies.set({
    url: 'https://unrelated.example.test/', name: 'other', value: 'untouched',
  });
  let backup: Electron.Cookie[] = [];
  const imported = await importBrowserCookies(partition, [
    { domain: 'accounts.example.test', name: 'LSID', value: 'correct-host', secure: true },
    { domain: 'accounts.example.test', name: '__Host-GAPS', value: 'host-token', secure: true },
    { domain: '.example.test', name: 'shared', value: 'domain-token', secure: true, sameSite: 'none' },
    { domain: 'accounts.example.test', name: 'expired', value: 'stale', expires: 1 },
  ], async (cookies) => {
    backup = cookies;
    assert.equal((await partition.cookies.get({ name: '__Host-GAPS' })).length, 0);
  });
  assert.equal(imported, 3);
  assert.equal(backup.some((cookie) => cookie.value === 'bad-duplicate'), true);
  const host = (await partition.cookies.get({ name: '__Host-GAPS' }))[0];
  assert.equal(host.hostOnly, true);
  assert.equal(host.domain, 'accounts.example.test');
  assert.equal(host.value, 'host-token');
  const sessions = await partition.cookies.get({ name: 'LSID' });
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((cookie) => cookie.domain === '.accounts.example.test'), false);
  assert.equal(sessions.find((cookie) => cookie.hostOnly)?.value, 'correct-host');
  assert.equal(sessions.find((cookie) => cookie.domain === '.example.test')?.value, 'parent-session');
  assert.equal((await partition.cookies.get({ url: 'https://child.accounts.example.test/' }))
    .some((cookie) => cookie.name === '__Host-GAPS'), false);
  assert.equal((await partition.cookies.get({ name: 'shared' }))[0].sameSite, 'no_restriction');
  assert.equal((await partition.cookies.get({ name: 'expired' })).length, 0);
  assert.equal((await partition.cookies.get({ name: 'other' }))[0].value, 'untouched');

  // An explicitly supplied domain cookie is not mistaken for an old duplicate.
  await importBrowserCookies(partition, [
    { domain: '.accounts.example.test', name: 'both', value: 'domain', secure: true },
    { domain: 'accounts.example.test', name: 'both', value: 'host', secure: true },
  ], async () => {});
  assert.equal((await partition.cookies.get({ name: 'both' })).length, 2);
  await importBrowserCookies(partition, [
    { domain: 'overlap.example.test', name: 'overlap', value: 'host-secure', secure: true },
    { domain: '.example.test', name: 'overlap', value: 'domain-nonsecure', secure: false },
  ], async () => {});
  const overlapping = await partition.cookies.get({ name: 'overlap' });
  assert.equal(overlapping.length, 2);
  assert.equal(overlapping.find((cookie) => cookie.hostOnly)?.secure, true);
  assert.equal(overlapping.find((cookie) => !cookie.hostOnly)?.secure, false);
  await assert.rejects(importBrowserCookies(partition, [
    { domain: 'accounts.example.test', name: '__Host-invalid', value: 'never-log-this', secure: false },
    { domain: 'accounts.example.test', name: 'after-failure', value: 'valid' },
  ], async () => {}), (error: unknown) => {
    assert.ok(error instanceof CookieImportError);
    assert.equal(error.imported, 1);
    assert.equal(error.failed, 1);
    assert.equal(error.message.includes('never-log-this'), false);
    return true;
  });
  assert.equal((await partition.cookies.get({ name: 'after-failure' }))[0].value, 'valid');
  await assert.rejects(importBrowserCookies(partition, [
    { domain: 'accounts.example.test', name: 'blocked-by-backup', value: 'valid' },
  ], async () => { throw new Error('backup unavailable'); }), /backup unavailable/);
  assert.equal((await partition.cookies.get({ name: 'blocked-by-backup' })).length, 0);

  // A partial native report cannot become a success after Electron accepts
  // its remaining entries; independent healthy cookies still import.
  await assert.rejects(importBrowserCookies(partition, [
    { domain: 'accounts.example.test', name: 'healthy-after-native-failure', value: 'valid' },
  ], async () => {}, {
    decryption: 2, domainMismatch: 1, invalidEncoding: 1, invalidPartition: 3,
  }), (error: unknown) => {
    assert.ok(error instanceof CookieImportError);
    assert.equal(error.imported, 1);
    assert.equal(error.failed, 7);
    assert.match(error.message, /2 decryption/);
    assert.match(error.message, /3 invalid partition/);
    assert.match(error.message, /Sign-in has not been verified/);
    return true;
  });
  assert.equal((await partition.cookies.get({ name: 'healthy-after-native-failure' }))[0].value, 'valid');

  const expiryPartition = session.fromPartition(`cookie-expiry-${Date.now()}`);
  await assert.rejects(importBrowserCookies(expiryPartition, [
    ...[-1, 0, 1].map((expires) => ({
      domain: 'expiry.example.test', name: `expired-${expires}`, value: 'stale', session: false, expires,
    })),
    { domain: 'expiry.example.test', name: 'invalid', value: 'stale', session: false },
    { domain: 'expiry.example.test', name: 'empty', value: '', session: true },
    { domain: 'expiry.example.test', name: 'fresh', value: 'valid', session: false, expires: Date.now() / 1000 + 3600 },
  ], async () => {}), (error: unknown) => {
    assert.ok(error instanceof CookieImportError);
    assert.equal(error.imported, 2);
    assert.equal(error.failed, 1);
    return true;
  });
  const kept = await expiryPartition.cookies.get({});
  assert.deepEqual(kept.map((cookie) => cookie.name).sort(), ['empty', 'fresh']);
  assert.equal(kept.find((cookie) => cookie.name === 'empty')?.value, '');
  assert.equal(kept.find((cookie) => cookie.name === 'fresh')?.session, false);
}
