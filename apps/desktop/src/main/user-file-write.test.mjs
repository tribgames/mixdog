import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeUserFile } from './user-file-write.ts';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-user-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('replaces a file whole, creates a missing one and leaves no temp file', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'a.txt');
  await writeUserFile(file, 'first');
  await writeUserFile(file, Buffer.from([0x62, 0x00, 0x63]));
  assert.deepEqual([...(await readFile(file))], [0x62, 0x00, 0x63]);
  assert.deepEqual(await readdir(dir), ['a.txt']);
});

test('an existing file keeps its permissions', { skip: process.platform === 'win32' && 'POSIX modes' }, async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'run.sh');
  await writeFile(file, 'old');
  await chmod(file, 0o755);
  await writeUserFile(file, 'new');
  assert.equal((await stat(file)).mode & 0o777, 0o755);
});

test('writing through a symlink replaces its target and keeps the link', async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, 'target.txt');
  const link = join(dir, 'link.txt');
  await writeFile(target, 'old');
  try {
    await symlink(target, link);
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('symlinks need privileges on this machine');
    throw error;
  }
  await writeUserFile(link, 'new');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), 'new');
});

test('an existing file is rewritten in place: same identity, hard-link aliases see the new content', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'a.txt');
  const alias = join(dir, 'alias.txt');
  await writeFile(file, 'a much longer old content');
  await link(file, alias);
  const before = await stat(file);
  await writeUserFile(file, 'new');
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 2);
  assert.equal(await readFile(alias, 'utf8'), 'new');
  assert.equal(await readFile(file, 'utf8'), 'new');
});

test('an existing file keeps its mode under a restrictive umask', {
  skip: process.platform === 'win32' && 'POSIX modes',
}, async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'run.sh');
  await writeFile(file, 'old');
  await chmod(file, 0o755);
  const previous = process.umask(0o277);
  try {
    await writeUserFile(file, 'new');
  } finally {
    process.umask(previous);
  }
  assert.equal((await stat(file)).mode & 0o777, 0o755);
  assert.equal(await readFile(file, 'utf8'), 'new');
});
