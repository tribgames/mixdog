import assert from 'node:assert/strict';
import { safeStorage, session } from 'electron';
import { createBrowserCookieJar, storedCookieSetDetails, type BrowserCookie } from './cookie-jar';
import { CookieImportError, importBrowserCookies } from './profile-import-cookies';

export async function verifyPartitionedCookieImport() {
  const owner = session.fromPartition(`chips-owner-${Date.now()}`);
  const other = session.fromPartition(`chips-other-${Date.now()}`);
  const jar = createBrowserCookieJar(owner);
  const otherJar = createBrowserCookieJar(other);
  const sameSite = { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false };
  const withAncestor = { ...sameSite, hasCrossSiteAncestor: true };
  const otherSite = { topLevelSite: 'https://other.test', hasCrossSiteAncestor: true };
  const domain = 'widget.example.test';
  const fixtures = [
    { value: 'ordinary' },
    { value: 'same-site', partitionKey: sameSite },
    { value: 'cross-ancestor', partitionKey: withAncestor },
    { value: 'other-top-level', partitionKey: otherSite },
  ].map((item) => ({
    ...item, domain, name: '__Host-session', path: '/', secure: true, httpOnly: true, session: true, sameSite: 'none',
  }));

  try {
    await otherJar.set({
      url: `https://${domain}/`, name: 'untouched', value: 'other-context', secure: true,
      partitionKey: sameSite,
    });
    const count = await importBrowserCookies({ cookies: jar }, [
      ...fixtures,
      ...['chrome://whats-new', 'chrome-untrusted://new-tab-page'].map((topLevelSite) => ({
        ...fixtures[1], name: 'internal-ui-state',
        partitionKey: { topLevelSite, hasCrossSiteAncestor: true },
      })),
    ], async () => {});
    assert.equal(count, 4, 'browser-internal exclusions are neither failures nor imported web cookies');
    const imported = await jar.get({});
    assert.equal(imported.length, 4);
    assert.deepEqual(imported.map((cookie) => cookie.value).sort(),
      ['ordinary', 'same-site', 'cross-ancestor', 'other-top-level'].sort());
    assert.equal((await jar.get({ partitionKey: null }))[0].value, 'ordinary');
    assert.equal((await jar.get({ partitionKey: sameSite }))[0].value, 'same-site');
    assert.equal((await jar.get({ partitionKey: withAncestor }))[0].value, 'cross-ancestor');
    assert.equal((await jar.get({ partitionKey: otherSite }))[0].value, 'other-top-level');
    assert.equal((await otherJar.get({})).length, 1, 'destination must not escape to another Session');
    assert.equal((await jar.get({ url: 'https://child.widget.example.test/' })).length, 0,
      'host-only partitioned cookies must not become domain cookies');

    // Capture and restore an actual OS-encrypted recovery snapshot.
    let sealed: Buffer | undefined;
    await importBrowserCookies({ cookies: jar }, [{
      ...fixtures[1], value: 'replacement',
    }], async (existing) => { sealed = safeStorage.encryptString(JSON.stringify(existing)); });
    assert.ok(sealed);
    assert.equal(sealed.includes(Buffer.from('same-site')), false);
    const backup = JSON.parse(safeStorage.decryptString(sealed)) as BrowserCookie[];
    assert.equal(backup.filter((cookie) => cookie.partitionKey).length, 3);
    for (const cookie of backup) await jar.set(storedCookieSetDetails(cookie));
    assert.equal((await jar.get({ partitionKey: sameSite }))[0].value, 'same-site');

    // Exact partition removal cannot erase the same name in another jar.
    await jar.remove(`https://${domain}/`, '__Host-session', sameSite);
    assert.equal((await jar.get({ partitionKey: sameSite })).length, 0);
    assert.equal((await jar.get({})).length, 3);
    assert.equal((await jar.get({ partitionKey: withAncestor }))[0].value, 'cross-ancestor');

    // An Electron-only seam must refuse partition metadata, never discard it.
    await assert.rejects(importBrowserCookies(other, [{
      ...fixtures[1], name: 'must-not-widen',
    }], async () => {}), (error: unknown) => {
      assert.ok(error instanceof CookieImportError);
      assert.equal(error.failed, 1);
      return true;
    });
    assert.equal((await otherJar.get({ name: 'must-not-widen' })).length, 0);
  } finally {
    await jar.dispose();
    await otherJar.dispose();
  }
}
