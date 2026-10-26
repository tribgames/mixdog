import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const { CredentialVault, maskedCredentialLabel, secureOrigin } = await import('./credential-vault.ts');
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

/** The vault file as stored: what the next version, or the importer, reads. */
const stored = (dir) => JSON.parse(unseal(readFileSync(join(dir, VAULT_FILE_NAME)))).credentials;
const passwordsByUsername = (rows) => Object.fromEntries(rows.map((row) => [row.username, row.password]));

test('stored credentials are kept verbatim: a long password survives load and a metadata-only save', async (t) => {
  const { dir, vault } = makeVault(t);
  const password = `p${'x'.repeat(5000)}é `;
  await vault.upsert({ origin: 'https://long.example', username: 'u'.repeat(5000), password, source: 'manual' });
  const [login] = await vault.list();
  await vault.markUsed(login.id);
  await vault.update(login.id, { note: 'n'.repeat(5000) });
  const [row] = stored(dir);
  assert.equal(row.password, password);
  assert.equal(row.username.length, 5000);
  assert.equal(row.note.length, 5000);
  assert.ok(row.lastUsedAt > 0);
});

test('a vault a merge can produce is never refused for its size', async (t) => {
  const { dir, vault } = makeVault(t);
  const credentials = Array.from({ length: 100_001 }, (_, index) => {
    const url = `https://s${index}.example`;
    return {
      id: createHash('sha256').update(`${url}\0u`).digest('hex').slice(0, 24),
      url,
      username: 'u',
      password: 'pw',
      note: '',
      source: 'csv',
    };
  });
  writeFileSync(join(dir, VAULT_FILE_NAME), seal(JSON.stringify({ version: 1, credentials })));
  assert.equal((await vault.list()).length, 100_001);
  await vault.upsert({ origin: 'https://more.example', username: 'u', password: 'pw', source: 'manual' });
  assert.equal(stored(dir).length, 100_002);
  assert.equal((await vault.list()).length, 100_002);
});

test('upsert replaces the same origin+username in place and keeps the note', async (t) => {
  const { vault } = makeVault(t);
  await vault.upsert({ origin: 'https://github.com', username: 'tempest', password: 'first', source: 'chrome' });
  const [before] = await vault.list();
  await vault.update(before.id, { note: 'team account' });
  await vault.upsert({ origin: 'https://github.com', username: 'tempest', password: 'second', source: 'manual' });
  const list = await vault.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'manual');
  assert.equal(list[0].note, 'team account', 'the note survives a re-save');
});

test('usernames that differ only by case are separate logins: save, import and a reload keep both', async (t) => {
  const { dir, vault } = makeVault(t);
  const origin = 'https://case.example.com';
  await vault.upsert({ origin, username: 'Alice', password: 'pw-Alice', source: 'chat' });
  await vault.upsert({ origin, username: 'alice', password: 'pw-alice', source: 'chat' });
  assert.deepEqual(passwordsByUsername(stored(dir)), { Alice: 'pw-Alice', alice: 'pw-alice' });
  // Saving one again replaces only that one.
  await vault.upsert({ origin, username: 'alice', password: 'pw-alice-2', source: 'manual' });
  assert.deepEqual(passwordsByUsername(stored(dir)), { Alice: 'pw-Alice', alice: 'pw-alice-2' });

  // An import: a third variant is added, an exact match replaces, and two new variants in one batch both land.
  assert.equal(
    await vault.mergeImport('csv', [
      { url: `${origin}/login`, username: 'ALICE', password: 'pw-ALICE' },
      { url: `${origin}/login`, username: 'Alice', password: 'pw-Alice-2', note: 'imported' },
      { url: 'https://batch.example.com/login', username: 'Bob', password: 'pw-Bob' },
      { url: 'https://batch.example.com/login', username: 'bob', password: 'pw-bob' },
    ]),
    4
  );
  assert.deepEqual(passwordsByUsername(stored(dir).filter((row) => row.url.startsWith(origin))), {
    Alice: 'pw-Alice-2',
    alice: 'pw-alice-2',
    ALICE: 'pw-ALICE',
  });
  assert.deepEqual(passwordsByUsername(stored(dir).filter((row) => row.url === 'https://batch.example.com/login')), {
    Bob: 'pw-Bob',
    bob: 'pw-bob',
  });

  // A fresh instance on the same file (a restart) reads all of them as distinct logins.
  const reopened = new CredentialVault({ userDataDirectory: dir, seal, unseal });
  const list = await reopened.list();
  assert.equal(list.length, 5);
  assert.equal(new Set(list.map((login) => login.id)).size, 5, 'each has its own id');
  assert.equal((await reopened.accountsFor(origin)).length, 3);
  assert.equal((await reopened.accountsFor('https://batch.example.com')).length, 2);
  assert.equal(list.find((login) => login.username === 'Alice').note, 'imported');
});

test('a prefilled identifier ranks the exact username before a case variant of an email', async (t) => {
  const { vault } = makeVault(t);
  const origin = 'https://mail.example.com';
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  for (const username of ['Pat@Example.com', 'pat@example.com']) {
    await vault.upsert({ origin, username, password: `pw-${username}`, source: 'chat' });
    t.mock.timers.tick(3);
  }
  const ids = Object.fromEntries((await vault.list()).map((login) => [login.username, login.id]));
  const first = async (prefilled) => (await vault.preferredAccountsFor(origin, prefilled))[0].id;
  assert.equal(await first('Pat@Example.com'), ids['Pat@Example.com'], 'exact, though saved earlier');
  assert.equal(await first('pat@example.com'), ids['pat@example.com']);
  // Neither is exactly the identifier: the page does not say which, so both are marked, never picked by recency.
  const guess = await vault.preferredAccountsFor(origin, 'PAT@example.com');
  assert.deepEqual(
    guess.map(({ id, ambiguous }) => [id, ambiguous]),
    [
      [ids['pat@example.com'], true],
      [ids['Pat@Example.com'], true],
    ]
  );
  assert.equal(guess[0].label, maskedCredentialLabel('pat@example.com'));
  // An exact match, a lone case variant and no identifier at all are never ambiguous.
  for (const prefilled of ['Pat@Example.com', 'pat@example.com', '']) {
    assert.ok(
      (await vault.preferredAccountsFor(origin, prefilled)).every((account) => account.ambiguous === undefined),
      prefilled
    );
  }
  await vault.upsert({ origin, username: 'other@example.com', password: 'pw-other', source: 'chat' });
  assert.deepEqual(
    (await vault.preferredAccountsFor(origin, 'OTHER@example.com')).map(({ ambiguous }) => ambiguous),
    [undefined, undefined, undefined],
    'one case variant is the identifier'
  );
  const mixed = await vault.preferredAccountsFor(origin, 'PAT@example.com');
  assert.deepEqual(
    mixed.map(({ ambiguous }) => ambiguous),
    [true, true, undefined],
    'only the tied variants are marked'
  );
});

test('a case variant saved again is a login of its own, with the same password or another; nothing is overwritten', async (t) => {
  const { dir, vault } = makeVault(t);
  const origin = 'https://other.example.com';
  await vault.upsert({
    origin,
    username: 'Pat@example.com',
    password: 'pw-1',
    source: 'chat',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  const [first] = await vault.list();
  await vault.update(first.id, { note: 'the first account' });
  await vault.upsert({ origin, username: 'pat@example.com', password: 'pw-2', source: 'chat' });
  // A shared password does not make one account: the case-only save is a third login.
  await vault.upsert({ origin, username: 'PAT@example.com', password: 'pw-1', source: 'chat' });
  const rows = stored(dir);
  assert.deepEqual(
    rows.map((row) => [row.username, row.password]),
    [
      ['Pat@example.com', 'pw-1'],
      ['pat@example.com', 'pw-2'],
      ['PAT@example.com', 'pw-1'],
    ]
  );
  assert.equal(rows[0].note, 'the first account', 'the first account keeps its note');
  assert.equal(rows[0].totpSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'and its authenticator key');
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  // Each is re-saved only by its own exact username.
  await vault.upsert({ origin, username: 'pat@example.com', password: 'pw-3', source: 'manual' });
  assert.deepEqual(
    stored(dir).map((row) => [row.username, row.password]),
    [
      ['Pat@example.com', 'pw-1'],
      ['pat@example.com', 'pw-3'],
      ['PAT@example.com', 'pw-1'],
    ]
  );
});

test('case variants of a prefilled identifier are ambiguous for any identifier, not only an email', async (t) => {
  const { vault } = makeVault(t);
  const origin = 'https://plain.example.com';
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  // 'zed' is saved last, so recency alone would put it first.
  for (const username of ['Pat', 'pat', 'zed']) {
    await vault.upsert({ origin, username, password: `pw-${username}`, source: 'chat' });
    t.mock.timers.tick(3);
  }
  await vault.upsert({ origin: 'https://lone.example.com', username: 'pat', password: 'pw-lone', source: 'chat' });
  const ids = Object.fromEntries(
    (await vault.list()).filter((login) => login.origin === origin).map((login) => [login.username, login.id])
  );
  const rank = async (site, prefilled) =>
    (await vault.preferredAccountsFor(site, prefilled)).map(({ id, ambiguous }) => [id, ambiguous]);

  assert.deepEqual(
    await rank(origin, 'PAT'),
    [
      [ids.pat, true],
      [ids.Pat, true],
      [ids.zed, undefined],
    ],
    'the case variants come first and are marked, though zed was saved last'
  );
  assert.deepEqual(
    (await rank(origin, 'pAt')).map(([, ambiguous]) => ambiguous),
    [true, true, undefined],
    'any casing of it'
  );
  // An exact username is the identifier: no mark, and it is first.
  assert.deepEqual((await rank(origin, 'Pat'))[0], [ids.Pat, undefined]);
  assert.ok((await rank(origin, 'Pat')).every(([, ambiguous]) => ambiguous === undefined));
  assert.deepEqual((await rank(origin, 'pat'))[0], [ids.pat, undefined]);
  // No identifier, or one that matches nothing, marks nothing.
  for (const prefilled of ['', 'nobody']) {
    assert.ok(
      (await rank(origin, prefilled)).every(([, ambiguous]) => ambiguous === undefined),
      prefilled
    );
  }
  // One variant alone is no ambiguity, and ranks as it always did (not as a match).
  const lone = await vault.preferredAccountsFor('https://lone.example.com', 'PAT');
  assert.equal(lone.length, 1);
  assert.equal(lone[0].ambiguous, undefined);
});

test('re-saving an imported login with a note saves password and note together under its own id', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cred-vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let writes = 0;
  let failing = false;
  const countingSeal = (plaintext) => {
    if (failing) throw new Error('keychain unavailable');
    writes += 1;
    return seal(plaintext);
  };
  const vault = new CredentialVault({ userDataDirectory: dir, seal: countingSeal, unseal });
  // A Chrome row is keyed by its sign-in URL, not by the origin.
  await vault.mergeImport('chrome', [
    { url: 'https://example.com/login', username: 'alice', password: 'old', note: 'from chrome' },
  ]);
  const [imported] = await vault.list();

  writes = 0;
  await vault.saveManual({ origin: 'https://example.com', username: 'alice', password: 'new', note: 'work' });
  assert.equal(writes, 1, 'one write carries both');
  const [after] = await vault.list();
  assert.equal(after.id, imported.id, 'the imported entry keeps its id');
  assert.equal(after.note, 'work');
  assert.equal(after.source, 'manual');
  assert.equal(stored(dir).length, 1);
  assert.equal(stored(dir)[0].password, 'new');

  // Without a note, the saved one stays.
  await vault.saveManual({ origin: 'https://example.com', username: 'alice', password: 'newer' });
  assert.equal((await vault.list())[0].note, 'work');
  assert.equal(stored(dir)[0].password, 'newer');

  // A new login with a note is one write too.
  writes = 0;
  await vault.saveManual({ origin: 'https://fresh.example.com', username: 'n', password: 'p', note: 'hello' });
  assert.equal(writes, 1);
  assert.equal((await vault.list()).find((login) => login.origin === 'https://fresh.example.com').note, 'hello');

  // A save that cannot be written changes neither the password nor the note.
  failing = true;
  await assert.rejects(
    vault.saveManual({ origin: 'https://example.com', username: 'alice', password: 'lost', note: 'lost' }),
    /keychain unavailable/
  );
  failing = false;
  assert.equal(stored(dir).find((row) => row.url === 'https://example.com/login').password, 'newer');
  assert.equal((await vault.list()).find((login) => login.id === imported.id).note, 'work');
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
  assert.ok(
    after.some((entry) => entry.origin === 'https://site99.test'),
    'the concurrent add stuck'
  );
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
  assert.equal(
    (await vault.preferredAccountsFor(origin, 'second@example'))[0].id,
    ids['first@example.com'],
    'not a prefix match'
  );
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
  await vault.upsert({
    origin: 'https://shop.example.com',
    username: 'nokey@example.com',
    password: 'pw-2',
    source: 'chat',
  });
  const ids = Object.fromEntries((await vault.list()).map((login) => [login.username, login.id]));
  // RFC 6238 test vector (SHA1, 20-byte key "12345678901234567890"), T = 59 s: 94287082 → 6 digits 287082.
  assert.equal(await vault.totpCodeFor(ids['me@example.com'], 'https://shop.example.com', 59_000), '287082');
  assert.equal(await vault.totpCodeFor(ids['nokey@example.com'], 'https://shop.example.com'), '', 'no key');
  assert.equal(await vault.totpCodeFor(ids['me@example.com'], 'https://evil.example'), '', 'another origin');
  assert.equal(await vault.totpCodeFor('f'.repeat(24), 'https://shop.example.com'), '');
});
