import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  rewriteFileThrough,
  writeProjectTextFileThrough,
  writeProjectTextFilesThrough,
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

/** A real handle whose methods can be intercepted: `fault` replaces a method's behaviour. */
function faultyHandle(handle, fault) {
  return new Proxy(handle, {
    get(target, prop) {
      if (fault[prop]) return (...args) => fault[prop](target, ...args);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('a failure after the current file was modified restores it with the earlier files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'alpha');
  await writeFile(join(root, 'b.txt'), 'bravo');
  const writes = [
    { relPath: 'a.txt', content: 'alpha edited', expectedContent: 'alpha' },
    { relPath: 'b.txt', content: 'bravo edited', expectedContent: 'bravo' },
  ];
  // b's bytes are already written and truncated when its sync fails (once).
  let failed = false;
  const openFile = async (absolute) => {
    const handle = await open(absolute, 'r+');
    if (!absolute.endsWith('b.txt')) return handle;
    return faultyHandle(handle, {
      datasync: async (target) => {
        if (!failed) {
          failed = true;
          throw new Error('disk fault');
        }
        await target.datasync();
      },
    });
  };
  await assert.rejects(writeProjectTextFilesThrough(root, writes, openFile), /disk fault/);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'bravo');
});

test('a single-file save that fails part-way leaves the original intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-single-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = 'a much longer original text';
  await writeFile(join(root, 'a.txt'), original);
  // The new bytes are written and the file truncated when the sync fails (once).
  let failed = false;
  const openFile = async (absolute) =>
    faultyHandle(await open(absolute, 'r+'), {
      datasync: async (target) => {
        if (!failed) {
          failed = true;
          throw new Error('disk fault');
        }
        await target.datasync();
      },
    });
  await assert.rejects(
    writeProjectTextFileThrough(root, 'a.txt', 'edited', original, undefined, openFile),
    /disk fault/
  );
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), original);

  await writeProjectTextFileThrough(root, 'a.txt', 'edited', original, undefined, openFile);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'edited');
});

test('a single-file save whose restore also fails says so', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-single-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'alpha');
  const openFile = async (absolute) =>
    faultyHandle(await open(absolute, 'r+'), {
      datasync: async () => {
        throw new Error('disk fault');
      },
    });
  await assert.rejects(
    writeProjectTextFileThrough(root, 'a.txt', 'edited', 'alpha', undefined, openFile),
    /disk fault\. The original could not be restored/
  );
});

test('a restore that fails is reported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'alpha');
  const openFile = async (absolute) =>
    faultyHandle(await open(absolute, 'r+'), {
      datasync: async () => {
        throw new Error('disk fault');
      },
    });
  await assert.rejects(
    writeProjectTextFilesThrough(root, [{ relPath: 'a.txt', content: 'edited', expectedContent: 'alpha' }], openFile),
    /Not restored: \["a\.txt"\]/
  );
});

test('a partial write is completed before the file is truncated', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-short-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'a.txt');
  await writeFile(file, 'a much longer original text');
  const handle = await open(file, 'r+');
  t.after(() => handle.close());
  const calls = [];
  const short = faultyHandle(handle, {
    write: async (target, buffer, offset, length, position) => {
      calls.push([offset, length, position]);
      return target.write(buffer, offset, Math.min(length, 3), position);
    },
  });
  await rewriteFileThrough(short, Buffer.from('replacement'));
  assert.equal(await readFile(file, 'utf8'), 'replacement');
  assert.equal(calls.length, 4);

  const stalled = faultyHandle(handle, { write: async () => ({ bytesWritten: 0 }) });
  await assert.rejects(rewriteFileThrough(stalled, Buffer.from('never')), /no progress/);
});
