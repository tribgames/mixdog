import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HOST_DIRECTORY_LIST_LIMIT, listServerDirectories, validatedHostDirectoryPath } from './host-directories.ts';

test('server listing: home by default, absolute paths only, git roots marked, hidden folders opt-in', async () => {
  const home = await listServerDirectories('');
  assert.equal(home.path, await realpath(homedir()));
  await assert.rejects(listServerDirectories('relative/dir'), /absolute/);
  await assert.rejects(listServerDirectories(7), /string/);
  const root = await mkdtemp(join(tmpdir(), 'server-dirs-'));
  try {
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await mkdir(join(root, 'worktree'));
    await writeFile(join(root, 'worktree', '.git'), 'gitdir: ../elsewhere');
    await mkdir(join(root, 'plain'));
    await mkdir(join(root, '.cache'));
    await writeFile(join(root, 'note.txt'), 'x');
    const canonical = await realpath(root);
    const listing = await listServerDirectories(root);
    assert.equal(listing.path, canonical);
    assert.deepEqual(listing.entries, [
      { name: 'plain', git: false },
      { name: 'repo', git: true },
      { name: 'worktree', git: true },
    ]);
    assert.equal(listing.truncated, false);
    const withHidden = await listServerDirectories(root, true);
    assert.deepEqual(
      withHidden.entries.map((entry) => entry.name),
      ['.cache', 'plain', 'repo', 'worktree']
    );
    await assert.rejects(listServerDirectories(join(root, 'note.txt')), /not a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server listing caps the entry count and reports truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-dirs-cap-'));
  try {
    for (let index = 0; index < HOST_DIRECTORY_LIST_LIMIT + 5; index += 1) {
      await mkdir(join(root, `d${String(index).padStart(5, '0')}`));
    }
    const listing = await listServerDirectories(root);
    assert.equal(listing.entries.length, HOST_DIRECTORY_LIST_LIMIT);
    assert.equal(listing.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path validation: empty is home; relative, NUL, device and non-string paths are rejected', () => {
  assert.equal(validatedHostDirectoryPath(''), homedir());
  assert.equal(validatedHostDirectoryPath('   '), homedir());
  assert.throws(() => validatedHostDirectoryPath(5), /string/);
  assert.throws(() => validatedHostDirectoryPath('relative/dir'), /absolute/);
  assert.throws(() => validatedHostDirectoryPath(`${tmpdir()}\0x`), /invalid/);
  assert.throws(() => validatedHostDirectoryPath('\\\\?\\C:\\Windows'), /invalid/);
  assert.throws(() => validatedHostDirectoryPath('\\\\.\\PhysicalDrive0'), /invalid/);
  assert.throws(() => validatedHostDirectoryPath('/'.repeat(40_000)), /too long/);
  assert.equal(validatedHostDirectoryPath(tmpdir()), tmpdir());
});
