import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cookieSetDetails,
  createBrowserSessionStore,
  serializeSessionCookies,
} from './browser-session-store.ts';

const sessionCookie = (overrides = {}) => ({
  name: 'sid', value: 'secret-session', domain: '.example.test', path: '/', secure: true,
  httpOnly: true, hostOnly: false, session: true, sameSite: 'lax', ...overrides,
});

test('only session cookies are kept and a stored cookie is recreated without an expiry', () => {
  const records = serializeSessionCookies([
    sessionCookie(),
    sessionCookie({ name: 'persistent', session: false, expirationDate: 9_999_999_999 }),
    sessionCookie({ name: '', session: true }),
  ]);
  assert.deepEqual(records.map((record) => record.name), ['sid']);
  const details = cookieSetDetails(records[0]);
  assert.equal(details.url, 'https://example.test/');
  assert.equal(details.domain, '.example.test');
  assert.equal(details.expirationDate, undefined);
  assert.equal(cookieSetDetails({ ...records[0], hostOnly: true }).domain, undefined);
  assert.equal(cookieSetDetails({ ...records[0], domain: 'bad domain' }), null);
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
        set: async (details) => { set.push(details); },
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