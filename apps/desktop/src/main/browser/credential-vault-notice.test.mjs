import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// OS encryption comes and goes with globalThis.__encryption (see
// credential-vault-encryption-unavailable.test.mjs).
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,export const app={getPath:()=>""};export const safeStorage={' +
            'isEncryptionAvailable:()=>globalThis.__encryption!==false,' +
            'encryptString:(text)=>{if(globalThis.__encryption===false)throw new Error("Encryption is not available.");' +
            'return Buffer.from(text,"utf8").reverse()},' +
            'decryptString:(sealed)=>{if(globalThis.__decryptFails)throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");' +
            'return Buffer.from(sealed).reverse().toString("utf8")}};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { CredentialVault } = await import('./credential-vault.ts');
const { clearDesktopNotice, registerDesktopNoticeSink } = await import(
  '../../../../../src/runtime/shared/desktop-notice-host.mjs'
);

function vaultDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cred-vault-notice-'));
  t.after(() => {
    globalThis.__encryption = true;
    globalThis.__decryptFails = false;
    clearDesktopNotice('secret-storage');
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('saved logins that encryption reports available yet cannot open tell the user once', async (t) => {
  const dir = vaultDirectory(t);
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  await new CredentialVault({ userDataDirectory: dir }).upsert({
    origin: 'https://shop.example.com',
    username: 'alice',
    password: 'pw',
    source: 'manual',
  });
  assert.deepEqual(notices, []);

  globalThis.__decryptFails = true;
  await new CredentialVault({ userDataDirectory: dir }).list().catch(() => undefined);
  await new CredentialVault({ userDataDirectory: dir }).list().catch(() => undefined);
  assert.deepEqual(notices, [{ key: 'secret-storage', code: 'secret-storage-failed', params: {} }]);
});

test('saved logins that cannot be sealed or opened tell the user once', async (t) => {
  const dir = vaultDirectory(t);
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  const vault = new CredentialVault({ userDataDirectory: dir });

  globalThis.__encryption = false;
  await assert.rejects(
    vault.upsert({ origin: 'https://shop.example.com', username: 'alice', password: 'pw', source: 'manual' }),
    /Encryption is not available/
  );
  assert.equal(notices.length, 1, 'a first save that cannot be sealed');

  globalThis.__encryption = true;
  await vault.upsert({ origin: 'https://shop.example.com', username: 'alice', password: 'pw', source: 'manual' });
  globalThis.__encryption = false;
  await assert.rejects(vault.list(), /Credential encryption is unavailable/);
  await assert.rejects(vault.list(), /Credential encryption is unavailable/);
  assert.deepEqual(notices, [{ key: 'secret-storage', code: 'secret-storage-failed', params: {} }]);
});
