import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

// The OS keychain comes and goes (globalThis.__encryption): a keyring-less Linux
// reports no encryption, and a later boot may have one. A reversible stand-in seals.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,export const app={getPath:()=>""};export const safeStorage={' +
            'isEncryptionAvailable:()=>globalThis.__encryption!==false,' +
            'encryptString:(text)=>Buffer.from(text,"utf8").reverse(),' +
            'decryptString:(sealed)=>Buffer.from(sealed).reverse().toString("utf8")};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { CredentialVault, VAULT_FILE_NAME } = await import('./credential-vault.ts');

const SHOP = 'https://shop.example.com';
const BANK = 'https://bank.example.com';

/** A vault of two logins, sealed while encryption was available. */
async function seededVault(t) {
  globalThis.__encryption = true;
  t.after(() => {
    globalThis.__encryption = true;
  });
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cred-vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = new CredentialVault({ userDataDirectory: dir });
  await vault.upsert({ origin: SHOP, username: 'alice', password: 'S3NT1NEL-shop', source: 'manual' });
  await vault.upsert({ origin: BANK, username: 'bob', password: 'S3NT1NEL-bank', source: 'manual' });
  return { dir, vault, file: join(dir, VAULT_FILE_NAME), record: `${join(dir, VAULT_FILE_NAME)}.pending-pauses.json` };
}

test('a pause made while OS encryption is unavailable is recorded without secrets and enforced once it is back', async (t) => {
  const { dir, vault, file, record } = await seededVault(t);
  const sealedBefore = readFileSync(file);

  globalThis.__encryption = false;
  await vault.pauseOrigin(SHOP);
  await vault.pauseOrigin('shop.example.com');
  await vault.pauseOrigin(BANK);

  assert.deepEqual(readFileSync(file), sealedBefore, 'the sealed vault is not touched while it cannot be opened');
  const recorded = readFileSync(record, 'utf8');
  assert.deepEqual(JSON.parse(recorded).origins, [SHOP, BANK], 'one entry per origin, however it was spelled');
  assert.doesNotMatch(recorded, /S3NT1NEL|alice|bob/, 'the record holds origins only');

  // Still unavailable: no read path hands out an account, so nothing is eligible.
  const unavailable = new CredentialVault({ userDataDirectory: dir });
  const refusal = /^Error: Credential encryption is unavailable\.$/;
  await assert.rejects(unavailable.accountsFor(SHOP), refusal);
  await assert.rejects(unavailable.preferredAccountsFor(SHOP), refusal);
  await assert.rejects(unavailable.list(), refusal);
  assert.ok(readFileSync(record), 'the record is still there');

  // A later boot with a keychain: a new instance folds the pauses in and clears the record.
  globalThis.__encryption = true;
  const reopened = new CredentialVault({ userDataDirectory: dir });
  assert.deepEqual(await reopened.accountsFor(SHOP), []);
  assert.deepEqual(await reopened.preferredAccountsFor(BANK), []);
  assert.deepEqual(
    (await reopened.list()).map(({ origin, autoSignIn }) => [origin, autoSignIn]),
    [
      [BANK, false],
      [SHOP, false],
    ]
  );
  assert.equal(existsSync(record), false, 'the record is cleared once it is sealed into the vault');
  assert.deepEqual(
    await new CredentialVault({ userDataDirectory: dir }).accountsFor(SHOP),
    [],
    'the pause is now in the sealed vault'
  );
});

test('a malformed pending record blocks every account read, and is left as it is', async (t) => {
  const { dir, file, record } = await seededVault(t);
  const sealed = readFileSync(file);
  const expectedFiles = [...readdirSync(dir), basename(record)].sort();
  for (const bad of ['', '\0\0\0', 'not json', '{"origins":', '{}', '{"origins":"https://shop.example.com"}', '{"origins":[1]}', 'null']) {
    writeFileSync(record, bad);
    const vault = new CredentialVault({ userDataDirectory: dir });
    const refusal = /^Error: The stored browser credential vault could not be opened\.$/;
    await assert.rejects(vault.accountsFor(SHOP), refusal, JSON.stringify(bad));
    await assert.rejects(vault.preferredAccountsFor(BANK), refusal);
    await assert.rejects(vault.list(), refusal);
    assert.equal(readFileSync(record, 'utf8'), bad, 'the record is not rewritten or dropped');
    assert.deepEqual(readFileSync(file), sealed, 'the vault is not rewritten');
    assert.deepEqual(readdirSync(dir).sort(), expectedFiles, 'nothing is moved aside or added');
  }
});

test('a pause on top of a malformed record keeps that record, and sign-out does not fail', async (t) => {
  const { dir, vault, file, record } = await seededVault(t);
  const damaged = '{"version":1,"origins":["https://shop.example.com"';
  writeFileSync(record, damaged);
  const expectedFiles = readdirSync(dir).sort();

  globalThis.__encryption = false;
  await vault.pauseOrigin(BANK);

  assert.equal(readFileSync(record, 'utf8'), damaged, 'the damaged copy, with its earlier pauses, is kept as it was');
  assert.deepEqual(readdirSync(dir).sort(), expectedFiles, 'nothing is moved aside or added');
  globalThis.__encryption = true;
  await assert.rejects(new CredentialVault({ userDataDirectory: dir }).accountsFor(BANK), /could not be opened/);

  // Resolved by the user (the record removed): the vault opens again.
  rmSync(record);
  assert.equal((await new CredentialVault({ userDataDirectory: dir }).accountsFor(BANK)).length, 1);
  assert.ok(readFileSync(file));
});

test('without a pending record the vault reads as before and is not rewritten', async (t) => {
  const { dir, file, record } = await seededVault(t);
  const sealed = readFileSync(file);
  const vault = new CredentialVault({ userDataDirectory: dir });
  assert.equal((await vault.accountsFor(SHOP)).length, 1);
  assert.equal((await vault.preferredAccountsFor(BANK)).length, 1);
  assert.equal((await vault.list()).length, 2);
  assert.equal(existsSync(record), false);
  assert.deepEqual(readFileSync(file), sealed);
});

test('only the signed-out origin is paused; a pause with no vault is not recorded', async (t) => {
  const { dir, vault, record } = await seededVault(t);
  globalThis.__encryption = false;
  await vault.pauseOrigin(SHOP);
  globalThis.__encryption = true;

  const reopened = new CredentialVault({ userDataDirectory: dir });
  assert.equal((await reopened.accountsFor(BANK)).length, 1, 'another site stays eligible');
  assert.deepEqual(await reopened.accountsFor(SHOP), []);
  assert.equal(existsSync(record), false);

  const empty = mkdtempSync(join(tmpdir(), 'mixdog-cred-vault-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  globalThis.__encryption = false;
  await new CredentialVault({ userDataDirectory: empty }).pauseOrigin(SHOP);
  assert.deepEqual(readdirSync(empty), [], 'nothing to pause, nothing written');
});
