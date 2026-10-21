// Deleting imported data must remove every password copy (the vault, its last-good
// `.bak` and the `.corrupt-*` copies kept aside) or report why it could not.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const app={isPackaged:false},safeStorage={};export const session={},BrowserWindow={};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { BrowserProfileImportService } = await import('./profile-import.ts');

const VAULT = 'browser-password-vault.bin';
const service = (userDataDirectory) =>
  new BrowserProfileImportService({ userDataDirectory, temporaryDirectory: tmpdir() });
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-import-clear-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('clearing removes the vault, its .bak and every .corrupt-* copy, and leaves other files', async (t) => {
  const dir = tempDir(t);
  for (const name of [VAULT, `${VAULT}.bak`, `${VAULT}.corrupt-1`, `${VAULT}.corrupt-2`, 'unrelated.json']) {
    writeFileSync(join(dir, name), 'secret');
  }
  await service(dir).clearImportedData();
  assert.deepEqual(readdirSync(dir), ['unrelated.json']);
});

test('a data directory that does not exist is already clear', async (t) => {
  const dir = tempDir(t);
  await service(join(dir, 'missing')).clearImportedData();
});

test('an enumeration failure other than a missing directory rejects instead of reporting success', async (t) => {
  const dir = tempDir(t);
  // A file where the directory belongs: readdir fails with ENOTDIR, not ENOENT.
  const notADirectory = join(dir, 'file');
  writeFileSync(notADirectory, 'x');
  await assert.rejects(service(notADirectory).clearImportedData(), (error) => error.code === 'ENOTDIR');
  assert.equal(existsSync(notADirectory), true);
});
