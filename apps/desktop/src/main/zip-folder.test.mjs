import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { appendFile, mkdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FolderMovedError,
  FolderTooLargeError,
  listFolderFiles,
  scanFolder,
  zipFolder,
  zipFolderTestHooks,
  zipListedFiles,
} from './zip-folder.ts';

import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';
const limits = { maxBytes: 1024, maxFiles: 10 };

async function folder(t) {
  const root = await realpath(makeTempDirSync('zip'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'a.txt'), 'alpha');
  await writeFile(join(root, 'sub', 'b.txt'), 'beta');
  return root;
}

/** A junction (a symlink off Windows); false when the OS refuses. */
async function link(target, path) {
  try {
    await symlink(target, path, 'junction');
    return true;
  } catch {
    return false;
  }
}

const entryCount = (zip) => zip.readUInt16LE(zip.length - 22 + 10);

test('a folder zips every regular file', async (t) => {
  const root = await folder(t);
  const { archive: zip, ignored } = await zipFolder(root, limits);
  assert.equal(ignored, 0);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(entryCount(zip), 2);
  assert.equal(zip.includes(Buffer.from('sub/b.txt')), true);
});

test('a file that grows after the walk cannot push the archive past the cap', async (t) => {
  const root = await folder(t);
  const files = await listFolderFiles(root, limits);
  await appendFile(join(root, 'a.txt'), Buffer.alloc(2048, 1));
  await assert.rejects(zipListedFiles(files, limits.maxBytes), FolderTooLargeError);
});

test('a directory swapped for a junction between lstat and the walk contributes nothing', async (t) => {
  const root = await folder(t);
  const elsewhere = await folder(t);
  await writeFile(join(elsewhere, 'sub', 'secret.txt'), 'outside');
  zipFolderTestHooks.beforeDescend = async (directory) => {
    await rm(directory, { recursive: true });
    if (!(await link(join(elsewhere, 'sub'), directory))) throw new Error('no-links');
  };
  t.after(() => {
    zipFolderTestHooks.beforeDescend = undefined;
  });
  const files = await listFolderFiles(root, limits).catch((error) => error);
  if (files instanceof Error && files.message === 'no-links') return t.skip('links are unavailable');
  assert.deepEqual(
    files.map((file) => file.rel),
    ['a.txt']
  );
});

test('a directory swapped for a junction after the walk cannot be read through', async (t) => {
  const root = await folder(t);
  const elsewhere = await folder(t);
  const files = await listFolderFiles(root, limits);
  // The very same files, moved out and linked back in: identity still matches.
  await rename(join(root, 'sub'), join(elsewhere, 'moved'));
  if (!(await link(join(elsewhere, 'moved'), join(root, 'sub')))) return t.skip('links are unavailable');
  const zip = await zipListedFiles(files, limits.maxBytes);
  assert.equal(entryCount(zip), 1);
  assert.equal(zip.includes(Buffer.from('sub/b.txt')), false);
});

test('a root that is itself reached through a junction is refused', async (t) => {
  const root = await folder(t);
  const elsewhere = await folder(t);
  if (!(await link(root, join(elsewhere, 'door')))) return t.skip('links are unavailable');
  await assert.rejects(listFolderFiles(join(elsewhere, 'door'), limits), FolderMovedError);
});

/** A file symlink; false when the OS refuses (Windows without the privilege). */
async function fileLink(target, path) {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch {
    return false;
  }
}

test('links are judged by their real location: targets inside are packed under the link name', async (t) => {
  const root = await folder(t);
  const elsewhere = await folder(t);
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'id_rsa'), 'key');
  // A folder link inside the zipped folder, one out of it, one to a
  // secret-bearing folder and one back to the root.
  if (!(await link(join(root, 'sub'), join(root, 'sub-link')))) return t.skip('links are unavailable');
  await link(join(elsewhere, 'sub'), join(root, 'escape'));
  await link(join(root, '.ssh'), join(root, 'keys'));
  await link(root, join(root, 'sub', 'loop'));
  const files = await listFolderFiles(root, limits);
  const names = files.map((file) => file.rel);
  // Before the fix every link was dropped: sub-link/b.txt was missing. Before
  // PC parity `.ssh` and the link to it were left out as secrets.
  assert.deepEqual(names, ['.ssh/id_rsa', 'a.txt', 'keys/id_rsa', 'sub/b.txt', 'sub-link/b.txt']);
  assert.equal(files.find((file) => file.rel === 'sub-link/b.txt').absolute, join(root, 'sub', 'b.txt'));
  const zip = await zipListedFiles(files, limits.maxBytes);
  assert.equal(entryCount(zip), 5);
  assert.equal(zip.includes(Buffer.from('sub-link/b.txt')), true);
});

test('a file link is packed only when its target is inside the folder', async (t) => {
  const root = await folder(t);
  const elsewhere = await folder(t);
  await writeFile(join(root, '.env'), 'TOKEN=1');
  if (!(await fileLink(join(root, 'a.txt'), join(root, 'alias.txt')))) return t.skip('file links are unavailable');
  await fileLink(join(elsewhere, 'a.txt'), join(root, 'outside.txt'));
  await fileLink(join(root, '.env'), join(root, 'public.txt'));
  const files = await listFolderFiles(root, limits);
  // Before PC parity `.env` and the link to it were left out as secrets.
  assert.deepEqual(
    files.map((file) => file.rel),
    ['.env', 'a.txt', 'alias.txt', 'public.txt', 'sub/b.txt']
  );
  const zip = await zipListedFiles(files, limits.maxBytes);
  assert.equal(entryCount(zip), 5);
});

test('outside a git work tree a .git folder is packed like any other', async (t) => {
  const root = await folder(t);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), '[remote "origin"]');
  // Before PC parity it was left out through the secret deny list.
  assert.deepEqual(
    (await listFolderFiles(root, limits)).map((file) => file.rel),
    ['.git/config', 'a.txt', 'sub/b.txt']
  );
});

const big = { maxBytes: 1024 * 1024, maxFiles: 100 };
const names = (files) => files.map((file) => file.rel);

/** A git work tree: tracked and untracked sources, ignored dependencies, logs
 *  and an ignored build folder, plus an untracked secret. */
async function repository(t) {
  const root = await realpath(makeTempDirSync('zip-git'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n*.log\n');
  for (const dir of ['src', 'node_modules/pkg', 'dist/inner']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'src', 'tracked.ts'), 'tracked');
  execFileSync('git', ['add', 'src/tracked.ts'], { cwd: root });
  await writeFile(join(root, 'src', 'untracked.ts'), 'untracked');
  await writeFile(join(root, 'src', 'debug.log'), 'log');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'dep');
  await writeFile(join(root, 'dist', 'bundle.js'), 'bundle');
  await writeFile(join(root, 'dist', 'inner', 'map.js'), 'map');
  await writeFile(join(root, '.env'), 'TOKEN=1');
  return root;
}

test('in a git work tree ignored paths are left out, untracked files stay, and the counts are reported', async (t) => {
  const root = await repository(t);
  const scan = await scanFolder(root, big);
  // The untracked secret stays like any untracked file; git's own store is
  // left out by git's verdict.
  assert.deepEqual(names(scan.files), ['.env', '.gitignore', 'src/tracked.ts', 'src/untracked.ts']);
  // node_modules/pkg/index.js, dist/bundle.js, dist/inner/map.js, src/debug.log
  assert.equal(scan.ignored, 4);
});

test('a subfolder of a git work tree is judged by the same rules', async (t) => {
  const root = await repository(t);
  const scan = await scanFolder(join(root, 'src'), big);
  assert.deepEqual(names(scan.files), ['tracked.ts', 'untracked.ts']);
  assert.equal(scan.ignored, 1);
});

test('a selected folder that is itself ignored is filtered, not zipped whole', async (t) => {
  const root = await repository(t);
  const scan = await scanFolder(join(root, 'dist'), big);
  assert.deepEqual(names(scan.files), []);
  assert.equal(scan.ignored, 2);
});

test('a nested repository is filtered by its own .gitignore', async (t) => {
  const root = await repository(t);
  const nested = join(root, 'nested');
  await mkdir(join(nested, 'cache'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: nested });
  await writeFile(join(nested, '.gitignore'), 'cache/\n');
  await writeFile(join(nested, 'keep.txt'), 'keep');
  await writeFile(join(nested, 'cache', 'junk.txt'), 'junk');
  const scan = await scanFolder(root, big);
  assert.deepEqual(names(scan.files), [
    '.env',
    '.gitignore',
    'nested/.gitignore',
    'nested/keep.txt',
    'src/tracked.ts',
    'src/untracked.ts',
  ]);
  assert.equal(scan.ignored, 5);
});

test('a linked folder pointing into an ignored area contributes none of its ignored files', async (t) => {
  const root = await repository(t);
  if (!(await link(join(root, 'dist'), join(root, 'dist-link')))) return t.skip('links are unavailable');
  const scan = await scanFolder(root, big);
  assert.deepEqual(names(scan.files), ['.env', '.gitignore', 'src/tracked.ts', 'src/untracked.ts']);
});

test('outside git the well-known generated folders are left out by name', async (t) => {
  const root = await folder(t);
  for (const dir of ['node_modules/pkg', '.venv', 'src/__pycache__', 'target']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, 'node_modules', 'pkg', 'a.js'), 'a');
  await writeFile(join(root, 'node_modules', 'b.js'), 'b');
  await writeFile(join(root, '.venv', 'pyvenv.cfg'), 'c');
  await writeFile(join(root, 'src', '__pycache__', 'x.pyc'), 'd');
  await writeFile(join(root, 'target', 'out'), 'e');
  await writeFile(join(root, 'sub', 'build'), 'a file named like a generated folder stays');
  const scan = await scanFolder(root, big);
  assert.deepEqual(names(scan.files), ['a.txt', 'sub/b.txt', 'sub/build']);
  assert.equal(scan.ignored, 5);
});

test('outside git a selected generated folder is zipped whole', async (t) => {
  const root = await folder(t);
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'node_modules'), { recursive: true });
  await writeFile(join(dist, 'app.js'), 'app');
  await writeFile(join(dist, 'node_modules', 'dep.js'), 'dep');
  const scan = await scanFolder(dist, big);
  assert.deepEqual(names(scan.files), ['app.js', 'node_modules/dep.js']);
  assert.equal(scan.ignored, 0);
});

test('the caps count what is left after the exclusions, and the refusal carries the counts', async (t) => {
  const root = await repository(t);
  // Ignored files do not count toward the caps: 4 files remain.
  assert.equal((await scanFolder(root, { maxBytes: 1024, maxFiles: 4 })).files.length, 4);
  const refused = await scanFolder(root, { maxBytes: 1024, maxFiles: 3 }).catch((error) => error);
  assert.ok(refused instanceof FolderTooLargeError);
  // .env (7 bytes), .gitignore (26), tracked.ts (7) and untracked.ts (9).
  assert.deepEqual({ files: refused.files, bytes: refused.bytes }, { files: 4, bytes: 49 });
});

test('a file replaced after the walk is left out', async (t) => {
  const root = await folder(t);
  const files = await listFolderFiles(root, limits);
  await unlink(join(root, 'a.txt'));
  await writeFile(join(root, 'sub', 'tmp.txt'), 'x');
  await writeFile(join(root, 'a.txt'), 'replaced');
  const zip = await zipListedFiles(files, limits.maxBytes);
  assert.equal(entryCount(zip), 1);
  assert.equal(zip.includes(Buffer.from('replaced')), false);
});
