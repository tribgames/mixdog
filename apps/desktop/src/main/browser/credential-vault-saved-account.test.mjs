// `fill savedAccount` (profile-import.ts useCredentialByAccount) reads the same
// sealed file as the vault. Two logins that differ only by username case must
// each be reachable by their exact name, never answered with the other's password.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const app={getPath:()=>"",isPackaged:false};export const safeStorage={isEncryptionAvailable:()=>true,decryptString:(sealed)=>Buffer.from(sealed).reverse().toString("utf8"),encryptString:(text)=>Buffer.from(text,"utf8").reverse()};export const session={};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { CredentialVault } = await import('./credential-vault.ts');
const { BrowserProfileImportService } = await import('./profile-import.ts');

const seal = (plaintext) => Buffer.from(plaintext, 'utf8').reverse();
const unseal = (sealed) => Buffer.from(sealed).reverse().toString('utf8');
const origin = 'https://case.example.com';

async function fixture(t, usernames) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-saved-account-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = new CredentialVault({ userDataDirectory: dir, seal, unseal });
  for (const username of usernames) {
    await vault.upsert({ origin, username, password: `pw-${username}`, source: 'chat' });
  }
  const service = new BrowserProfileImportService({ userDataDirectory: dir, temporaryDirectory: tmpdir() });
  return (account) => service.useCredentialByAccount(`${origin}/login`, account, async (credential) => credential);
}

test('the exact username picks its own login among case variants', async (t) => {
  const use = await fixture(t, ['Alice', 'alice']);
  assert.deepEqual(await use('Alice'), { username: 'Alice', password: 'pw-Alice' });
  assert.deepEqual(await use('alice'), { username: 'alice', password: 'pw-alice' });
  await assert.rejects(use('ALICE'), /matches several stored logins/, 'no exact name: a guess is not answered');
});

test('a lone login still answers to its username in another case', async (t) => {
  const use = await fixture(t, ['Bob']);
  assert.deepEqual(await use('bob'), { username: 'Bob', password: 'pw-Bob' });
});
