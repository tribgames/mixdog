import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

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

const { CredentialVault, VAULT_FILE_NAME } = await import('./credential-vault.ts');

const seal = (plaintext) => Buffer.from(plaintext, 'utf8').reverse();
const unseal = (sealed) => Buffer.from(sealed).reverse().toString('utf8');

function makeVault(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cred-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, VAULT_FILE_NAME);
  return {
    file,
    vault: new CredentialVault({ userDataDirectory: dir, seal, unseal, ...options }),
    write: (document) => writeFileSync(file, seal(JSON.stringify(document))),
    stored: () => JSON.parse(unseal(readFileSync(file))).credentials,
  };
}

const usable = { id: 'a'.repeat(24), url: 'https://ok.example.com', username: 'ok', password: 'ok-pw', note: '' };
const oldId = { id: 'legacy-7', url: 'https://old.example.com', username: 'old', password: 'old-pw', note: 'from v0' };
const http = { id: 'b'.repeat(24), url: 'http://plain.example.com', username: 'plain', password: 'plain-pw', note: '' };
const noPassword = { id: 'c'.repeat(24), url: 'https://nopw.example.com', username: 'nopw', password: '', note: '' };
const junk = 'not an entry';

test('entries the vault cannot use are never offered, and a save writes only the usable ones', async (t) => {
  const { vault, write, stored } = makeVault(t);
  write({ version: 1, credentials: [oldId, usable, http, noPassword, junk] });

  assert.deepEqual(
    (await vault.list()).map((login) => login.username),
    ['ok']
  );
  assert.deepEqual(await vault.accountsFor('https://old.example.com'), []);
  assert.deepEqual(await vault.accountsFor('http://plain.example.com'), []);

  assert.equal(await vault.mergeImport('csv', [{ url: 'https://csv.example.com', username: 'c', password: 'p' }]), 1);
  assert.deepEqual(stored().map((entry) => entry.username).sort(), ['c', 'ok']);
});

test('logins differing only by username case, as v1.3.5 and the current build wrote them, load and survive a save', async (t) => {
  const { vault, write, stored } = makeVault(t);
  // v1.3.5's Chrome import: id = sha256(url NUL username), no source, no metadata.
  const chromeRow = (url, username, password) => ({
    id: createHash('sha256').update(`${url}\0${username}`).digest('hex').slice(0, 24),
    url,
    username,
    password,
    note: '',
  });
  const login = 'https://case.example.com/login';
  const written = [
    chromeRow(login, 'Alice', 'pw-Alice'),
    chromeRow(login, 'alice', 'pw-alice'),
    // The current build's shape: an origin-keyed manual entry beside a paused one.
    { ...chromeRow('https://head.example.com', 'Bob', 'pw-Bob'), source: 'manual', autoSignIn: false, savedAt: 5 },
    { ...chromeRow('https://head.example.com', 'bob', 'pw-bob'), source: 'chat', savedAt: 6, lastUsedAt: 7 },
  ];
  write({ version: 1, credentials: written });

  assert.deepEqual(
    (await vault.list()).map((entry) => entry.username).sort(),
    ['Alice', 'Bob', 'alice', 'bob'],
    'every entry loads; none is merged'
  );
  assert.equal((await vault.accountsFor(login)).length, 2);

  // A save elsewhere, then an exact re-import of the first variant: the others are untouched.
  await vault.upsert({ origin: 'https://other.example.com', username: 'o', password: 'p', source: 'chat' });
  assert.equal(await vault.mergeImport('chrome', [{ url: login, username: 'Alice', password: 'pw-Alice-2' }]), 1);
  const rows = stored();
  assert.equal(rows.length, 5);
  for (const row of written) assert.ok(rows.some((entry) => entry.id === row.id), 'ids are kept');
  const password = (id) => rows.find((entry) => entry.id === id).password;
  assert.equal(password(written[0].id), 'pw-Alice-2');
  assert.equal(password(written[1].id), 'pw-alice');
  assert.equal(password(written[2].id), 'pw-Bob');
  assert.equal(password(written[3].id), 'pw-bob');
  assert.equal(rows.find((entry) => entry.id === written[2].id).autoSignIn, false, 'the pause is kept');
});

test('an unreadable vault rejects every read and write and the file is left as it was', async (t) => {
  // A read that fails outright (not a damaged document, which is kept aside).
  const { file, vault } = makeVault(t);
  mkdirSync(file);
  const before = readdirSync(dirname(file));

  const opened = /could not be opened/;
  await assert.rejects(vault.list(), opened);
  await assert.rejects(vault.accountsFor('https://ok.example.com'), opened);
  await assert.rejects(vault.preferredAccountsFor('https://ok.example.com'), opened);
  await assert.rejects(vault.upsert({ origin: 'https://n.example.com', username: 'n', password: 'p', source: 'chat' }), opened);
  await assert.rejects(vault.mergeImport('chrome', [{ url: 'https://n.example.com', username: 'n', password: 'p' }]), opened);
  await assert.rejects(vault.markUsed(usable.id), opened);
  await assert.rejects(vault.remove(usable.id), opened);
  await assert.rejects(vault.pauseOrigin('https://ok.example.com'), opened);
  assert.ok(statSync(file).isDirectory(), 'nothing was written over the vault');
  assert.deepEqual(readdirSync(dirname(file)), before);
});

test('a document that is not a vault is not an empty vault: a save rejects and keeps it', async (t) => {
  const { file, vault, write } = makeVault(t);
  write({ version: 2, logins: [usable] });
  const before = readFileSync(file);
  await assert.rejects(vault.mergeImport('csv', [{ url: 'https://n.example.com', username: 'n', password: 'p' }]), /could not be opened/);
  await assert.rejects(vault.upsert({ origin: 'https://n.example.com', username: 'n', password: 'p', source: 'chat' }), /could not be opened/);
  assert.deepEqual(readFileSync(file), before);
});

test('a vault with no file yet still starts empty and saves', async (t) => {
  const { vault, stored } = makeVault(t);
  assert.deepEqual(await vault.list(), []);
  await vault.upsert({ origin: 'https://n.example.com', username: 'n', password: 'p', source: 'chat' });
  assert.equal(stored().length, 1);
});
