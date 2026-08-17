import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createProjectEntryIn,
  listProjectDirIn,
  projectEntryPathIn,
  readProjectTextFileIn,
} from './project-files.ts';

test('project file operations reject symlink and junction escapes', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'mixdog-project-path-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'project');
  const outside = join(fixture, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  const link = join(root, 'escape');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => projectEntryPathIn(root, 'escape/secret.txt'), /resolves outside/);
  await assert.rejects(listProjectDirIn(root, 'escape'), /resolves outside/);
  await assert.rejects(readProjectTextFileIn(root, 'escape/secret.txt'), /resolves outside/);
  await assert.rejects(
    createProjectEntryIn(root, '', 'escape/created.txt', false),
    /resolves outside/,
  );
});

test('project directory listing does not hide entries after 500', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from(
    { length: 501 },
    (_, index) => writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), ''),
  ));

  const entries = await listProjectDirIn(root, '');

  assert.equal(entries.length, 501);
  assert.equal(entries.at(-1)?.name, 'file-500.txt');
});
