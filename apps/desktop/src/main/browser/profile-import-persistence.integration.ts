import assert from 'node:assert/strict';
import { join } from 'node:path';
import { app, session } from 'electron';
import { importBrowserCookies } from './profile-import-cookies';
import { createBrowserSessionStore } from './browser-session-store';
import { createBrowserCookieJar } from './cookie-jar';

const directory = process.env.MIXDOG_COOKIE_PERSISTENCE_TEST_ROOT;
const phase = process.env.MIXDOG_COOKIE_PERSISTENCE_TEST_PHASE;
if (!directory || !['write', 'read'].includes(phase || '')) {
  throw new Error('The persistence fixture requires an isolated directory and an explicit phase.');
}
app.setPath('userData', directory);

async function run() {
  await app.whenReady();
  const partition = session.fromPartition('persist:cookie-import-restart-fixture');
  const jar = createBrowserCookieJar(partition);
  const partitionA = { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false };
  const partitionB = { topLevelSite: 'https://example.test', hasCrossSiteAncestor: true };
  const store = createBrowserSessionStore({
    directory: join(directory!, 'browser-state'),
    cookies: {
      supportsPartitions: true,
      get: async () => (await jar.get({}))
        // Restore correctness must not depend on which domain Chromium lists first.
        .sort((left, right) => Number(right.secure) - Number(left.secure)),
      set: jar.set,
    },
  });
  if (phase === 'write') {
    await importBrowserCookies({ cookies: jar }, [
      { name: 'overlap', domain: 'secure.example.test', value: 'host-session', secure: true, session: true },
      { name: 'overlap', domain: '.example.test', value: 'parent-session', secure: false, session: true },
      { name: '__Host-session', domain: 'accounts.example.test', value: 'host-only-session', secure: true, session: true },
      {
        name: '__Host-persistent', domain: 'accounts.example.test', value: 'persistent-token',
        secure: true, httpOnly: true, sameSite: 'lax', session: false, expires: Date.now() / 1000 + 3600,
      },
      {
        name: '__Host-session', domain: 'accounts.example.test', value: 'partition-a-session',
        secure: true, httpOnly: true, sameSite: 'none', session: true, partitionKey: partitionA,
      },
      {
        name: '__Host-session', domain: 'accounts.example.test', value: 'partition-b-session',
        secure: true, httpOnly: true, sameSite: 'none', session: true, partitionKey: partitionB,
      },
      {
        name: '__Host-persistent', domain: 'accounts.example.test', value: 'partition-persistent',
        secure: true, httpOnly: true, sameSite: 'none', session: false,
        expires: Date.now() / 1000 + 3600, partitionKey: partitionB,
      },
    ], async () => {});
    assert.equal(await store.save(), 5);
    await jar.flushStore();
  } else {
    assert.equal(await store.restore(), 5, 'every saved session cookie must restore');
    const cookies = await jar.get({});
    assert.equal(cookies.length, 7);
    const host = cookies.find((cookie) => cookie.name === '__Host-session' && !cookie.partitionKey);
    assert.equal(host?.value, 'host-only-session');
    assert.equal(host?.hostOnly, true);
    assert.equal(host?.session, true);
    const persistent = cookies.find((cookie) => cookie.name === '__Host-persistent' && !cookie.partitionKey);
    assert.equal(persistent?.value, 'persistent-token');
    assert.equal(persistent?.session, false);
    assert.equal(persistent?.httpOnly, true);
    assert.equal(persistent?.sameSite, 'lax');
    const overlap = cookies.filter((cookie) => cookie.name === 'overlap');
    assert.equal(overlap.length, 2);
    assert.equal(overlap.find((cookie) => cookie.hostOnly)?.value, 'host-session');
    assert.equal(overlap.find((cookie) => !cookie.hostOnly)?.value, 'parent-session');
    const child = await jar.get({ url: 'https://child.accounts.example.test/' });
    assert.equal(child.some((cookie) => cookie.name.startsWith('__Host-')), false);
    assert.equal((await jar.get({ name: '__Host-session', partitionKey: partitionA }))[0].value,
      'partition-a-session');
    assert.equal((await jar.get({ name: '__Host-session', partitionKey: partitionB }))[0].value,
      'partition-b-session');
    assert.equal((await jar.get({ name: '__Host-persistent', partitionKey: partitionB }))[0].value,
      'partition-persistent');
  }
  await jar.dispose();
  process.stdout.write(`Cookie persistence ${phase} phase passed.\n`);
}

void run().then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
