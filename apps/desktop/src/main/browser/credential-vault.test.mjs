import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// No OS keychain in the unit lane: a reversible stand-in seals the file, and
// every vault call runs through the real sealed-file format.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const app={getPath:()=>""};export const safeStorage={isEncryptionAvailable:()=>true};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const {
  CredentialVault,
  maskedCredentialLabel,
  secureOrigin,
} = await import('./credential-vault.ts');
const { VAULT_FILE_NAME } = await import('./credential-vault.ts');

const seal = (plaintext) => Buffer.from(plaintext, 'utf8').reverse();
const unseal = (sealed) => Buffer.from(sealed).reverse().toString('utf8');

function makeVault(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cred-vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, vault: new CredentialVault({ userDataDirectory: dir, seal, unseal }) };
}

test('upsert then list shows the login without its secrets, and accountsFor is masked', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({
    origin: 'https://dart.fss.or.kr',
    username: 'data-team',
    password: 'S3NT1NEL-pw',
    source: 'chat',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  const list = await vault.list();
  assert.deepEqual(list, [
    {
      id: list[0].id,
      origin: 'https://dart.fss.or.kr',
      username: 'data-team',
      hasPassword: true,
      hasTotp: true,
      source: 'chat',
      note: '',
      autoSignIn: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(list), /S3NT1NEL|GEZDGNBV/);
  const accounts = await vault.accountsFor('https://dart.fss.or.kr');
  assert.deepEqual(accounts, [{ id: list[0].id, label: maskedCredentialLabel('data-team') }]);
  assert.doesNotMatch(JSON.stringify(accounts), /S3NT1NEL|GEZDGNBV/);
  assert.deepEqual(await vault.accountsFor('http://dart.fss.or.kr'), [], 'plain HTTP is never offered');
});

test('upsert replaces the same origin+username in place and keeps the note', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({ origin: 'https://github.com', username: 'tempest', password: 'first', source: 'chrome' });
  const [before] = await vault.list();
  await vault.update(before.id, { note: 'team account' });
  await vault.upsert({ origin: 'https://github.com', username: 'TEMPEST', password: 'second', source: 'manual' });
  const list = await vault.list();
  assert.equal(list.length, 1, 'the username match is case-insensitive');
  assert.equal(list[0].source, 'manual');
  assert.equal(list[0].note, 'team account', 'the note survives a re-save');
});

test('import merges and never wipes: an unrelated login survives, a match is replaced', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({ origin: 'https://notion.so', username: 'me@example.com', password: 'kept', source: 'chat' });
  await vault.update((await vault.list())[0].id, { note: 'chat note' });
  const stored = await vault.mergeImport('chrome', [
    { url: 'https://notion.so/', username: 'me@example.com', password: 'fromchrome' },
    { url: 'https://naver.com/login', username: 'tempest', password: 'newpw' },
  ]);
  assert.equal(stored, 2);
  const list = await vault.list();
  assert.equal(list.length, 2, 'nothing was dropped');
  const notion = list.find((entry) => entry.origin === 'https://notion.so');
  assert.equal(notion.note, 'chat note', 'the merge keeps everything but the password');
  assert.equal(notion.source, 'chrome');
  assert.ok(list.some((entry) => entry.origin === 'https://naver.com' && entry.source === 'chrome'));
});

test('update: a blank password keeps the saved one, a blank key removes it, a rename moves the id', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({
    origin: 'https://example.com',
    username: 'alice',
    password: 'keepme',
    source: 'manual',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  const [entry] = await vault.list();
  await vault.update(entry.id, { password: '', totpSecret: '', username: 'alice2', note: 'renamed' });
  const [after] = await vault.list();
  assert.notEqual(after.id, entry.id, 'the id follows the username');
  assert.equal(after.username, 'alice2');
  assert.equal(after.note, 'renamed');
  assert.equal(after.hasTotp, false, 'a blank key removes it');
  assert.equal(after.hasPassword, true, 'a blank password kept the saved one');
  // The kept password is still usable for sign-in.
  assert.equal((await vault.accountsFor('https://example.com')).length, 1);
});

test('delete removes a login and sign-out pauses auto sign-in while keeping the password', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({ origin: 'https://a.test', username: 'u', password: 'p', source: 'manual' });
  await vault.upsert({ origin: 'https://b.test', username: 'u', password: 'p', source: 'manual' });
  // Sign-out of a.test (a bare host is accepted too).
  await vault.pauseOrigin('a.test');
  assert.deepEqual(await vault.accountsFor('https://a.test'), [], 'auto sign-in stops for that origin');
  const paused = (await vault.list()).find((entry) => entry.origin === 'https://a.test');
  assert.equal(paused.autoSignIn, false);
  assert.equal(paused.hasPassword, true, 'the password is kept');
  // A fresh save re-enables auto sign-in.
  await vault.upsert({ origin: 'https://a.test', username: 'u', password: 'p2', source: 'manual' });
  assert.equal((await vault.accountsFor('https://a.test')).length, 1);

  const bId = (await vault.list()).find((entry) => entry.origin === 'https://b.test').id;
  assert.equal(await vault.remove(bId), true);
  assert.equal(await vault.remove(bId), false, 'a second delete is a no-op');
  assert.equal((await vault.accountsFor('https://b.test')).length, 0);
});

test('a note-only edit keeps the sign-out pause; re-saving the credential re-enables it', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({ origin: 'https://paused.test', username: 'u', password: 'p', source: 'manual' });
  await vault.pauseOrigin('paused.test');
  assert.equal((await vault.accountsFor('https://paused.test')).length, 0);
  // A metadata-only edit must not undo the sign-out.
  const [entry] = await vault.list();
  await vault.update(entry.id, { note: 'still signed out' });
  assert.equal((await vault.accountsFor('https://paused.test')).length, 0, 'a note edit stays paused');
  assert.equal((await vault.list())[0].autoSignIn, false);
  // A whitespace-only password is not a real re-save: the pause stays.
  await vault.update(entry.id, { password: '   ' });
  assert.equal((await vault.accountsFor('https://paused.test')).length, 0, 'a whitespace password stays paused');
  assert.equal((await vault.list())[0].autoSignIn, false);
  // Re-entering a real password is an explicit re-save and re-enables, kept verbatim.
  await vault.update(entry.id, { password: '  p2  ' });
  assert.equal((await vault.accountsFor('https://paused.test')).length, 1, 'a credential re-save re-enables');
  // An explicit upsert (from a chat/CSV/manual save) also re-enables.
  await vault.pauseOrigin('paused.test');
  await vault.upsert({ origin: 'https://paused.test', username: 'u', password: 'p3', source: 'chat' });
  assert.equal((await vault.accountsFor('https://paused.test')).length, 1, 'an upsert re-enables');
});

test('concurrent transactions across instances never lose a write', async (t) => {
  const { dir } = makeVault(t);
  // Two instances on the same file: the importer builds its own, so the lock
  // must be shared by resolved path, not per instance.
  const a = new CredentialVault({ userDataDirectory: dir, seal, unseal });
  const b = new CredentialVault({ userDataDirectory: dir, seal, unseal });
  const writes = [];
  for (let i = 0; i < 20; i += 1) {
    const vault = i % 2 ? a : b;
    writes.push(vault.upsert({ origin: `https://site${i}.test`, username: 'u', password: `p${i}`, source: 'manual' }));
  }
  await Promise.all(writes);
  const list = await a.list();
  assert.equal(list.length, 20, 'every concurrent upsert survived');
  // A concurrent delete of an existing login is not resurrected by racing saves.
  await Promise.all([
    b.remove(list[0].id),
    a.upsert({ origin: 'https://site99.test', username: 'u', password: 'p', source: 'manual' }),
  ]);
  const after = await a.list();
  assert.equal(after.length, 20);
  assert.ok(!after.some((entry) => entry.id === list[0].id), 'the delete stuck');
  assert.ok(after.some((entry) => entry.origin === 'https://site99.test'), 'the concurrent add stuck');
});

test('an existing vault written in the old format still opens', async (t) => {
  const { dir, vault } = makeVault(t);
  const legacy = {
    version: 1,
    credentials: [
      {
        id: 'a'.repeat(24),
        url: 'https://legacy.example.com/',
        username: 'owner',
        password: 'legacy-pw',
        note: 'from an old import',
      },
    ],
  };
  writeFileSync(join(dir, VAULT_FILE_NAME), seal(JSON.stringify(legacy)));
  const [entry] = await vault.list();
  assert.equal(entry.origin, 'https://legacy.example.com');
  assert.equal(entry.source, 'chrome', 'a login with no source reads as a Chrome import');
  assert.equal(entry.autoSignIn, true);
  assert.equal(entry.hasPassword, true);
  assert.equal(secureOrigin(legacy.credentials[0].url), 'https://legacy.example.com');
});

test('auto sign-in ranks accounts: the identifier prefilled on the page, then the last used, then the latest saved', async (t) => {
  const { vault } = makeVault(t);
  const origin = 'https://shop.example.com';
  // A fake clock gives each save its own timestamp, so "latest saved" is unambiguous.
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  for (const username of ['first@example.com', 'second@example.com', 'third@example.com']) {
    await vault.upsert({ origin, username, password: `pw-${username}`, source: 'chat' });
    t.mock.timers.tick(3);
  }
  const labels = async (prefilled) => (await vault.preferredAccountsFor(origin, prefilled)).map((entry) => entry.label);
  const ids = Object.fromEntries((await vault.list()).map((login) => [login.username, login.id]));
  // None used, nothing prefilled: the most recently saved.
  assert.deepEqual(await labels(), [
    maskedCredentialLabel('third@example.com'),
    maskedCredentialLabel('second@example.com'),
    maskedCredentialLabel('first@example.com'),
  ]);
  // Last used wins over the latest saved.
  await vault.markUsed(ids['first@example.com']);
  assert.equal((await vault.preferredAccountsFor(origin))[0].id, ids['first@example.com']);
  // A prefilled identifier wins over both: exact, case-insensitive for an email.
  assert.equal((await vault.preferredAccountsFor(origin, 'SECOND@example.com'))[0].id, ids['second@example.com']);
  assert.equal((await vault.preferredAccountsFor(origin, 'second@example'))[0].id, ids['first@example.com'], 'not a prefix match');
  // Only metadata is stored for it, never a secret; a paused origin offers nothing.
  assert.deepEqual((await vault.list())[0], { ...(await vault.list())[0], hasPassword: true });
  await vault.pauseOrigin(origin);
  assert.deepEqual(await vault.preferredAccountsFor(origin), []);
});

test('a stored authenticator key makes the current code on the host, for its own origin only', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({
    origin: 'https://shop.example.com',
    username: 'me@example.com',
    password: 'pw-1',
    source: 'chat',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  await vault.upsert({ origin: 'https://shop.example.com', username: 'nokey@example.com', password: 'pw-2', source: 'chat' });
  const ids = Object.fromEntries((await vault.list()).map((login) => [login.username, login.id]));
  // RFC 6238 test vector (SHA1, 20-byte key "12345678901234567890"), T = 59 s: 94287082 → 6 digits 287082.
  assert.equal(await vault.totpCodeFor(ids['me@example.com'], 'https://shop.example.com', 59_000), '287082');
  assert.equal(await vault.totpCodeFor(ids['nokey@example.com'], 'https://shop.example.com'), '', 'no key');
  assert.equal(await vault.totpCodeFor(ids['me@example.com'], 'https://evil.example'), '', 'another origin');
  assert.equal(await vault.totpCodeFor('f'.repeat(24), 'https://shop.example.com'), '');
});
