import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readVaultFile, writeVaultFile } from './credential-vault-file.ts';

// A stand-in for the OS keychain: byte reversal, and an error on anything that
// is not a reversed document (as safeStorage fails on bytes it never sealed).
const seal = (document) => Buffer.from(JSON.stringify(document), 'utf8').reverse();
const unseal = (sealed) => {
  const text = Buffer.from(sealed).reverse().toString('utf8');
  if (text.includes('\0')) throw new Error('cannot decrypt');
  return text;
};

async function vaultDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'browser-password-vault.bin');
}

test('a missing vault reads as none and a written one round-trips', async (t) => {
  const file = await vaultDir(t);
  assert.equal(await readVaultFile(file, unseal), null);
  await writeVaultFile(file, seal({ version: 1, credentials: [{ id: 'a' }] }), unseal);
  assert.deepEqual(await readVaultFile(file, unseal), { version: 1, credentials: [{ id: 'a' }] });
});

test('a damaged vault is kept aside and the last good copy is restored', async (t) => {
  const file = await vaultDir(t);
  await writeVaultFile(file, seal({ version: 1, credentials: [{ id: 'old' }] }), unseal);
  await writeVaultFile(file, seal({ version: 1, credentials: [{ id: 'new' }] }), unseal);
  await writeFile(file, Buffer.alloc(64));
  assert.deepEqual(await readVaultFile(file, unseal), { version: 1, credentials: [{ id: 'old' }] });
  const names = await readdir(join(file, '..'));
  const aside = names.filter((name) => name.includes('.corrupt-'));
  assert.equal(aside.length, 1);
  assert.deepEqual([...(await readFile(join(file, '..', aside[0])))], new Array(64).fill(0));
  assert.deepEqual(await readVaultFile(file, unseal), { version: 1, credentials: [{ id: 'old' }] });
});

test('a damaged vault with no good copy reads as none and a damaged file never becomes the backup', async (t) => {
  const file = await vaultDir(t);
  await writeFile(file, Buffer.from('not sealed by this keychain'));
  assert.equal(await readVaultFile(file, unseal), null);
  assert.equal((await readdir(join(file, '..'))).filter((name) => name.includes('.corrupt-')).length, 1);

  await writeFile(file, Buffer.alloc(8));
  await writeVaultFile(file, seal({ version: 1, credentials: [] }), unseal);
  assert.equal((await readdir(join(file, '..'))).includes('browser-password-vault.bin.bak'), false);
  assert.deepEqual(await readVaultFile(file, unseal), { version: 1, credentials: [] });
});
