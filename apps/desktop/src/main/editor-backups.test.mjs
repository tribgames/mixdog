import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deleteEditorBackup, readEditorBackup, writeEditorBackup } from './editor-backups.ts';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-editor-backup-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'source.ts');
  await writeEditorBackup(root, source, 'original draft', 'disk contents');
  const directory = join(root, 'editor-backups');
  const [name] = await fs.readdir(directory);
  return { root, source, path: join(directory, name) };
}

for (const code of ['EACCES', 'EIO']) {
  test(`reading a backup after ${code} preserves the draft and reports the failure`, async (t) => {
    const { root, source, path } = await fixture(t);
    const read = fs.readFile;
    const original = await read(path, 'utf8');
    const failure = Object.assign(new Error('backup read failed'), { code });
    t.mock.method(fs, 'readFile', async (target, ...args) => {
      if (target === path) throw failure;
      return read(target, ...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(readEditorBackup(root, source), (error) => error === failure);
    assert.equal(await read(path, 'utf8'), original);
  });
}

test('concurrent autosaves retain the last accepted complete draft', async (t) => {
  const { root, source } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  await Promise.all(['first', 'second', 'third'].map(
    (content) => writeEditorBackup(root, source, content, 'disk contents'),
  ));
  assert.equal((await readEditorBackup(root, source)).content, 'third');
});

test('deleting a backup waits for an earlier accepted write instead of reviving it', async (t) => {
  const { root, source, path } = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const rename = fs.rename;
  const remove = fs.rm;
  let released = false;
  let deletedBeforeWrite = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path) {
      entered.resolve();
      await release.promise;
    }
    return rename(from, to);
  });
  t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target === path && !released) deletedBeforeWrite = true;
    return remove(target, ...args);
  });
  syncBuiltinESMExports();
  const writing = writeEditorBackup(root, source, 'late draft', 'disk contents');
  await entered.promise;
  const deleting = deleteEditorBackup(root, source);
  try {
    await Promise.resolve();
    assert.equal(deletedBeforeWrite, false);
  } finally {
    released = true;
    release.resolve();
    await Promise.all([writing, deleting]);
  }
  assert.equal(await readEditorBackup(root, source), null);
});

test('malformed backup recovery still removes only the invalid draft', async (t) => {
  const { root, source, path } = await fixture(t);
  await fs.writeFile(path, '{incomplete');
  assert.equal(await readEditorBackup(root, source), null);
  await assert.rejects(fs.stat(path), { code: 'ENOENT' });
});
