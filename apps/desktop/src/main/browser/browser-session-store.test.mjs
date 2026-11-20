import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cookieSetDetails, createBrowserSessionStore, serializeSessionCookies } from './browser-session-store.ts';

const sessionCookie = (overrides = {}) => ({
  name: 'sid',
  value: 'secret-session',
  domain: '.example.test',
  path: '/',
  secure: true,
  httpOnly: true,
  hostOnly: false,
  session: true,
  sameSite: 'lax',
  ...overrides,
});

test('only session cookies are kept and a stored cookie is recreated without an expiry', () => {
  const records = serializeSessionCookies([
    sessionCookie(),
    sessionCookie({ name: 'persistent', session: false, expirationDate: 9_999_999_999 }),
    sessionCookie({ name: '', session: true }),
  ]);
  assert.deepEqual(
    records.map((record) => record.name),
    ['sid']
  );
  const details = cookieSetDetails(records[0]);
  assert.equal(details.url, 'https://example.test/');
  assert.equal(details.domain, '.example.test');
  assert.equal(details.expirationDate, undefined);
  assert.equal(cookieSetDetails({ ...records[0], hostOnly: true }).domain, undefined);
  assert.equal(cookieSetDetails({ ...records[0], domain: 'bad domain' }), null);
});

test('a save issued before restore finishes waits and never wipes the stored sign-ins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-session-store-'));
  try {
    const jar = [sessionCookie()];
    const codec = {
      encrypt: async (text) => Buffer.from(text, 'utf8').reverse(),
      decrypt: async (data) => Buffer.from(data).reverse().toString('utf8'),
    };
    const seed = createBrowserSessionStore({
      cookies: { get: async () => jar, set: async () => {} },
      directory,
      ...codec,
    });
    assert.equal(await seed.save(), 1);

    let releaseSet;
    const gate = new Promise((resolve) => {
      releaseSet = resolve;
    });
    const restored = [];
    const emptyJar = [];
    const store = createBrowserSessionStore({
      cookies: {
        get: async () => emptyJar,
        set: async (details) => {
          await gate;
          restored.push(details);
          emptyJar.push(sessionCookie());
        },
      },
      directory,
      ...codec,
    });
    const restoring = store.restore();
    const saving = store.save();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await readFile(store.file)).length > 0, true, 'file survives while restore is pending');
    releaseSet();
    assert.equal(await restoring, 1);
    assert.equal(await saving, 1);
    assert.equal(restored.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('site logout preserves unrelated sessions when the old snapshot cannot be replaced', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-session-logout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jar = [sessionCookie(), sessionCookie({ domain: '.other.test' })];
  let canEncrypt = true;
  const writes = [];
  const host = {
    directory,
    cookies: { get: async () => jar, set: async (details) => writes.push(details) },
    encrypt: async (text) => (canEncrypt ? Buffer.from(text).reverse() : null),
    decrypt: async (data) => Buffer.from(data).reverse().toString(),
  };
  const store = createBrowserSessionStore(host);
  assert.equal(await store.save(), 2);
  await store.withSnapshotInvalidated(async () => {
    assert.equal(await createBrowserSessionStore(host).restore(), 1);
    assert.deepEqual(
      writes.splice(0).map((cookie) => cookie.domain),
      ['.other.test']
    );
    jar.shift();
    canEncrypt = false;
  }, 'example.test');
  assert.equal(await createBrowserSessionStore(host).restore(), 1);
  assert.deepEqual(
    writes.splice(0).map((cookie) => cookie.domain),
    ['.other.test']
  );
  canEncrypt = true;
  jar.push(sessionCookie({ value: 'fixture-new-session' }));
  assert.equal(await store.save(), 2);
  assert.equal(await createBrowserSessionStore(host).restore(), 2);
  assert.deepEqual(
    writes.map((cookie) => cookie.domain),
    ['.other.test', '.example.test']
  );
});

test('a fresh sign-in saves while the startup snapshot remains unreadable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-session-deferred-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jar = [sessionCookie({ path: '/old' }), sessionCookie({ domain: '.other.test' })];
  const restored = [];
  let canReadOld = false;
  const host = {
    directory,
    cookies: { get: async () => jar, set: async (details) => restored.push(details) },
    encrypt: async (text) => Buffer.from(`new:${Buffer.from(text).toString('base64')}`),
    decrypt: async (bytes) => {
      const [key, encoded] = bytes.toString().split(':');
      return key === 'old' && !canReadOld ? null : Buffer.from(encoded, 'base64').toString();
    },
  };
  const seed = createBrowserSessionStore({
    ...host,
    encrypt: async (text) => Buffer.from(`old:${Buffer.from(text).toString('base64')}`),
  });
  assert.equal(await seed.save(), 2);
  jar.length = 0;

  const store = createBrowserSessionStore(host);
  assert.equal(await store.restore(), 0);
  await store.withSnapshotInvalidated(async () => {}, 'example.test');
  jar.push(sessionCookie({ value: 'fresh-session' }));
  assert.equal(await store.save(), 1);
  assert.equal(await createBrowserSessionStore(host).restore(), 1);
  assert.deepEqual(
    restored.splice(0).map(({ value }) => value),
    ['fresh-session']
  );

  canReadOld = true;
  assert.equal(await createBrowserSessionStore(host).restore(), 2);
  assert.deepEqual(
    restored.map(({ domain, path, value }) => [domain, path, value]),
    [
      ['.other.test', '/', 'secret-session'],
      ['.example.test', '/', 'fresh-session'],
    ]
  );
});

test('autosave after a partial restore cannot promote an older cookie over a newer unreadable one', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-session-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let jar = [
    sessionCookie({ value: 'old' }),
    sessionCookie({ domain: '.signed-out.test', value: 'old-sign-in' }),
    sessionCookie({ domain: '.changed.test', value: 'before' }),
    sessionCookie({ domain: '.removed.test' }),
  ];
  let readable = new Set(['A']);
  const open = (key) =>
    createBrowserSessionStore({
      directory,
      cookies: {
        get: async () => jar,
        set: async ({ domain, path, value }) => {
          jar.push(sessionCookie({ domain, path, value }));
        },
      },
      encrypt: async (text) => Buffer.from(`${key}:${text}`),
      decrypt: async (sealed) => {
        const text = sealed.toString();
        return readable.has(text.slice(0, 1)) ? text.slice(2) : null;
      },
    });
  assert.equal(await open('A').save(), 4);
  readable = new Set(['B']);
  jar = [];
  const newer = open('B');
  assert.equal(await newer.restore(), 0);
  jar = [sessionCookie({ value: 'new' }), sessionCookie({ domain: '.signed-out.test', value: 'new-sign-in' })];
  assert.equal(await newer.save(), 2);

  readable = new Set(['A', 'C']);
  jar = [];
  const partial = open('C');
  assert.equal(await partial.restore(), 4);
  assert.equal(jar.find(({ domain }) => domain === '.example.test').value, 'old');
  await partial.save();
  await partial.withSnapshotInvalidated(async () => {
    jar = jar.filter(({ domain }) => domain !== '.signed-out.test' && domain !== '.removed.test');
    jar.find(({ domain }) => domain === '.changed.test').value = 'after';
  }, 'signed-out.test');
  await partial.save();

  readable.add('B');
  jar = [];
  assert.equal(await open('C').restore(), 2);
  assert.deepEqual(Object.fromEntries(jar.map(({ domain, value }) => [domain, value])), {
    '.example.test': 'new',
    '.changed.test': 'after',
  });
});

test('the store round-trips session cookies through the sealed file and discards stale files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-session-store-'));
  try {
    const set = [];
    let now = 1_000_000;
    const jar = [sessionCookie(), sessionCookie({ name: 'theme', value: 'dark', session: false })];
    const store = createBrowserSessionStore({
      cookies: {
        get: async () => jar,
        set: async (details) => {
          set.push(details);
        },
      },
      directory,
      encrypt: async (text) => Buffer.from(text, 'utf8').reverse(),
      decrypt: async (data) => Buffer.from(data).reverse().toString('utf8'),
      now: () => now,
    });
    assert.equal(await store.save(), 1);
    const sealed = await readFile(store.file);
    assert.doesNotMatch(sealed.toString('utf8'), /secret-session/, 'the file is not plain text');
    assert.equal(await store.restore(), 1);
    assert.equal(set.length, 1);
    assert.equal(set[0].name, 'sid');
    assert.equal(set[0].value, 'secret-session');

    now += 15 * 24 * 60 * 60 * 1_000;
    assert.equal(await store.restore(), 0, 'a two-week-old snapshot is not trusted');
    await assert.rejects(readFile(store.file), /ENOENT/);

    await writeFile(store.file, 'garbage');
    assert.equal(await store.restore(), 0);
    await assert.rejects(readFile(store.file), /ENOENT/);

    jar.length = 0;
    assert.equal(await store.save(), 0);
    await assert.rejects(readFile(store.file), /ENOENT/, 'no session cookies means no file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a NUL-filled snapshot restores nothing, and the next save replaces it without leaving a temp file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-session-store-'));
  try {
    const store = createBrowserSessionStore({
      cookies: { get: async () => [sessionCookie()], set: async () => {} },
      directory,
      encrypt: async (text) => Buffer.from(text, 'utf8').reverse(),
      decrypt: async (data) => Buffer.from(data).reverse().toString('utf8'),
    });
    await writeFile(store.file, Buffer.alloc(128));
    assert.equal(await store.restore(), 0);
    assert.equal(await store.save(), 1);
    assert.equal(await store.restore(), 1);
    assert.deepEqual(await readdir(directory), ['session-cookies.bin']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
