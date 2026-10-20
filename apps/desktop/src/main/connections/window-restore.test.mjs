import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SERVER_WINDOWS_FILE, createServerWindowRestore } from './window-restore.ts';

function profile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-window-restore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const restoreOf = (userDataPath) =>
  createServerWindowRestore({
    userDataPath,
    savedServers: async () => [],
    open: async () => {},
    onProgress: () => {},
  });
const stored = (dir) => JSON.parse(readFileSync(join(dir, SERVER_WINDOWS_FILE), 'utf8'));

test('a NUL-filled list reads as the defaults, is kept aside, and later changes persist', async (t) => {
  const dir = profile(t);
  writeFileSync(join(dir, SERVER_WINDOWS_FILE), Buffer.alloc(120));
  const restore = restoreOf(dir);
  assert.equal(await restore.isEnabled(), true);
  assert.equal(
    readdirSync(dir).some((name) => name.startsWith(`${SERVER_WINDOWS_FILE}.corrupt-`)),
    true
  );
  await restore.remember('box');
  assert.deepEqual(stored(dir), { version: 1, enabled: true, open: ['box'] });
  assert.equal(await restoreOf(dir).isEnabled(), true);
});

test('truncated JSON is damage too: the list starts empty and can be written', async (t) => {
  const dir = profile(t);
  writeFileSync(join(dir, SERVER_WINDOWS_FILE), '{"version":1,"enabled":false,"op');
  const restore = restoreOf(dir);
  await restore.remember('box');
  assert.deepEqual(stored(dir).open, ['box']);
});

test('a read that fails is not remembered: the next call reads again', async (t) => {
  const dir = profile(t);
  const file = join(dir, SERVER_WINDOWS_FILE);
  // A directory where the file belongs cannot be read as a file (EISDIR).
  mkdirSync(file);
  const restore = restoreOf(dir);
  await assert.rejects(restore.isEnabled());
  rmSync(file, { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, enabled: false, open: [] }));
  assert.equal(await restore.isEnabled(), false);
});
