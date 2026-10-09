import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import {
  copyProjectEntryIn,
  createProjectEntryIn,
  listProjectDirIn,
  moveProjectEntryIn,
  projectEntryPathIn,
  readProjectTextFileIn,
  renameProjectEntryIn,
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
  await assert.rejects(createProjectEntryIn(root, '', 'escape/created.txt', false), /resolves outside/);
});

test('the project-root guard holds when the caller passes an unresolved root', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'mixdog-project-root-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'project');
  await mkdir(join(root, 'dir'), { recursive: true });
  const unresolved = `${root}${sep}dir${sep}..`;
  await assert.rejects(renameProjectEntryIn(unresolved, '', 'renamed'), /Cannot rename the project root/);
  await assert.rejects(moveProjectEntryIn(unresolved, '', 'dir'), /Cannot move the project root/);
  await assert.rejects(copyProjectEntryIn(unresolved, '', 'dir'), /Cannot copy the project root/);
});

test('text over 1 MB opens read-only up to 10 MB; beyond that it falls back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'small.txt'), 'x'.repeat(1_048_576));
  await writeFile(join(root, 'mid.txt'), 'y'.repeat(1_048_577));
  await writeFile(join(root, 'edge.txt'), 'z'.repeat(10_485_760));
  await writeFile(join(root, 'huge.txt'), 'w'.repeat(10_485_761));
  await writeFile(join(root, 'mid.bin'), Buffer.alloc(2_000_000, 0));

  const small = await readProjectTextFileIn(root, 'small.txt');
  assert.equal(small.readOnly, undefined);
  assert.equal(small.content.length, 1_048_576);
  const mid = await readProjectTextFileIn(root, 'mid.txt');
  assert.equal(mid.readOnly, true);
  assert.equal(mid.tooLarge, false);
  assert.equal(mid.content.length, 1_048_577);
  const edge = await readProjectTextFileIn(root, 'edge.txt');
  assert.equal(edge.readOnly, true);
  assert.equal(edge.tooLarge, false);
  const huge = await readProjectTextFileIn(root, 'huge.txt');
  assert.equal(huge.tooLarge, true);
  assert.equal(huge.content, '');
  const binary = await readProjectTextFileIn(root, 'mid.bin');
  assert.equal(binary.binary, true);
  assert.equal(binary.readOnly, undefined);
});

test('project directory listing does not hide entries after 500', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 501 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), ''))
  );

  const entries = await listProjectDirIn(root, '');

  assert.equal(entries.length, 501);
  assert.equal(entries.at(-1)?.name, 'file-500.txt');
});
