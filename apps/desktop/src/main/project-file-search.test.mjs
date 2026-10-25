import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchProjectDirectory } from './project-file-search.ts';

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-file-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function eventually(check) {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

test('a stale index is served at once while it rebuilds in the background', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const root = await tempRoot(t);
  await writeFile(join(root, 'first.ts'), '');
  assert.deepEqual(await searchProjectDirectory(root, '.ts', 10), ['first.ts']);
  await writeFile(join(root, 'second.ts'), '');
  // Within the TTL the cached list answers.
  assert.deepEqual(await searchProjectDirectory(root, '.ts', 10), ['first.ts']);
  t.mock.timers.tick(61_000);
  // Stale: the caller gets the old list rather than waiting for a walk…
  assert.deepEqual(await searchProjectDirectory(root, '.ts', 10), ['first.ts']);
  // …and a later search sees the rebuilt one.
  await eventually(async () => (await searchProjectDirectory(root, '.ts', 10)).includes('second.ts'));
  assert.deepEqual(await searchProjectDirectory(root, '.ts', 10), ['first.ts', 'second.ts']);
});

test('a root that disappears stops serving its stale index', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const parent = await tempRoot(t);
  const root = join(parent, 'project');
  await mkdir(root);
  await writeFile(join(root, 'gone.ts'), '');
  assert.deepEqual(await searchProjectDirectory(root, 'gone', 10), ['gone.ts']);
  await rm(root, { recursive: true, force: true });
  t.mock.timers.tick(61_000);
  assert.deepEqual(await searchProjectDirectory(root, 'gone', 10), ['gone.ts']);
  const failure = await eventually(() =>
    searchProjectDirectory(root, 'gone', 10).then(
      () => null,
      (error) => error
    )
  );
  assert.equal(failure.code, 'ENOENT');
});

test('sixteen Project roots stay indexed together', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const parent = await tempRoot(t);
  const roots = [];
  for (let index = 0; index < 16; index += 1) {
    const root = join(parent, `project-${index}`);
    await mkdir(root);
    await writeFile(join(root, 'index.ts'), '');
    roots.push(root);
  }
  for (const root of roots) assert.deepEqual(await searchProjectDirectory(root, 'index', 10), ['index.ts']);
  await writeFile(join(roots[0], 'index-new.ts'), '');
  // The first root was not evicted by the other fifteen: no re-walk yet.
  assert.deepEqual(await searchProjectDirectory(roots[0], 'index', 10), ['index.ts']);
});

test('folders are listed as path/ only when asked for', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'src', 'views'), { recursive: true });
  await writeFile(join(root, 'src', 'views', 'list.py'), '');
  assert.deepEqual(await searchProjectDirectory(root, 'views', 10), ['src/views/list.py']);
  assert.deepEqual(await searchProjectDirectory(root, 'views', 10, { includeDirectories: true }), [
    'src/views/',
    'src/views/list.py',
  ]);
});

test('an empty query lists the root entries, folders first, then by name', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'apps'));
  await writeFile(join(root, 'README.md'), '');
  await writeFile(join(root, 'a.ts'), '');
  await writeFile(join(root, 'src', 'deep', 'b.ts'), '');
  assert.deepEqual(await searchProjectDirectory(root, '', 10, { includeDirectories: true }), [
    'apps/',
    'src/',
    'a.ts',
    'README.md',
  ]);
});

test('matches of one tier list fewer path segments first, then shorter paths, then by name', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'src', 'views'), { recursive: true });
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'z'));
  await writeFile(join(root, 'z', 'apple-review.md'), '');
  await writeFile(join(root, 'a', 'longer-review.md'), '');
  await writeFile(join(root, 'a', 'zebra-review.md'), '');
  await writeFile(join(root, 'view.md'), '');
  assert.deepEqual(await searchProjectDirectory(root, 'view', 10, { includeDirectories: true }), [
    'view.md',
    'src/views/',
    'a/zebra-review.md',
    'z/apple-review.md',
    'a/longer-review.md',
  ]);
});

test('a name match outranks a deeper folder match: comp lists Composer.tsx before benchmark folders', async (t) => {
  const root = await tempRoot(t);
  const folders = ['apps/ui', 'src/a/b/compact', 'bench/r/s/compile-compcert__abc', 'hooks', 'lib/xcomp', 'tools'];
  for (const folder of folders) await mkdir(join(root, folder), { recursive: true });
  for (const file of [
    'apps/ui/Composer.tsx',
    'hooks/use-composer.ts',
    'tools/uncompressed.txt',
    'bench/r/s/compile-compcert__abc/log.txt',
    'lib/xcomp/readme.md',
  ]) {
    await writeFile(join(root, file), '');
  }
  assert.deepEqual(await searchProjectDirectory(root, 'comp', 10, { includeDirectories: true }), [
    // name starts with the query, shallow paths first
    'apps/ui/Composer.tsx',
    'src/a/b/compact/',
    'bench/r/s/compile-compcert__abc/',
    // the query starts a word of the name
    'hooks/use-composer.ts',
    // the name contains it
    'lib/xcomp/',
    'tools/uncompressed.txt',
    // a folder of the path starts with it
    'bench/r/s/compile-compcert__abc/log.txt',
    // the path contains it
    'lib/xcomp/readme.md',
  ]);
});

test('letters scattered through the path do not match', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'p', 'a', 'l', 'e', 't', 't', 'e'), { recursive: true });
  await mkdir(join(root, 'ui'));
  await writeFile(join(root, 'p', 'a', 'l', 'e', 't', 't', 'e', 'x.txt'), '');
  await writeFile(join(root, 'ui', 'palette.tsx'), '');
  assert.deepEqual(await searchProjectDirectory(root, 'palette', 10, { includeDirectories: true }), ['ui/palette.tsx']);
});

test('folders get no priority: they rank by the same score as files', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'sub', 'target'), { recursive: true });
  await writeFile(join(root, 'target.txt'), '');
  assert.deepEqual(await searchProjectDirectory(root, 'target', 10, { includeDirectories: true }), [
    'target.txt',
    'sub/target/',
  ]);
});

test('ties go to the shorter path, then to name order; a camelCase hump beats a mid-word hit', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'z'));
  for (const file of ['abcdef.ts', 'abd.ts', 'abc.ts', 'z/abc.ts', 'src/decomposer.ts', 'src/MainComposer.tsx']) {
    await writeFile(join(root, file), '');
  }
  assert.deepEqual(await searchProjectDirectory(root, 'ab', 10), ['abc.ts', 'abd.ts', 'abcdef.ts', 'z/abc.ts']);
  assert.deepEqual(await searchProjectDirectory(root, 'composer', 10), ['src/MainComposer.tsx', 'src/decomposer.ts']);
});

test('a bare file name still lists its exact-basename files first and drops scattered hits', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
  for (const file of ['xapp.ts', 'apple.tsx', 'src/app.ts', 'a/b/c/app.ts']) await writeFile(join(root, file), '');
  assert.deepEqual(await searchProjectDirectory(root, 'app.ts', 50, { includeIgnored: true }), [
    'src/app.ts',
    'a/b/c/app.ts',
    'xapp.ts',
  ]);
});

test('gitignored files are found only when asked for, never inside node_modules', async (t) => {
  const root = await tempRoot(t);
  await writeFile(join(root, '.gitignore'), '/deliverables/\n');
  await mkdir(join(root, 'deliverables', 'brand'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'deliverables', 'brand', 'report.docx'), '');
  await writeFile(join(root, 'node_modules', 'pkg', 'report.docx'), '');
  assert.deepEqual(await searchProjectDirectory(root, 'report.docx', 10), []);
  assert.deepEqual(await searchProjectDirectory(root, 'report.docx', 10, { includeIgnored: true }), [
    'deliverables/brand/report.docx',
  ]);
});
