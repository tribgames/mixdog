import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

test('a typed query finds files the scan cap left out of the index', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'deep', 'a', 'b'), { recursive: true });
  const names = Array.from({ length: 10 }, (_, index) => `note-${index}.txt`);
  for (const name of names) await writeFile(join(root, name), '');
  await writeFile(join(root, 'deep', 'a', 'b', 'target-file.txt'), '');
  const capped = { maxScannedEntries: 5, includeDirectories: true };
  for (const name of names) assert.deepEqual(await searchProjectDirectory(root, name, 10, capped), [name]);
  assert.deepEqual(await searchProjectDirectory(root, 'target-file', 10, capped), ['deep/a/b/target-file.txt']);
  assert.deepEqual(await searchProjectDirectory(root, 'b', 10, capped), ['deep/a/b/', 'deep/a/b/target-file.txt']);
});

test('a linked folder is listed but never walked: its files are listed under their real paths', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'real'));
  await writeFile(join(root, '.gitignore'), 'secret.txt\n');
  await writeFile(join(root, 'real', 'linked-note.md'), '');
  await writeFile(join(root, 'real', 'secret.txt'), '');
  await symlink(join(root, 'real'), join(root, 'shared'), 'junction');
  await symlink(root, join(root, 'real', 'back'), 'junction');
  assert.deepEqual(await searchProjectDirectory(root, 'shared', 10, { includeDirectories: true }), ['shared/']);
  // No `shared/linked-note.md`, and the ignored file does not appear through the link.
  assert.deepEqual(await searchProjectDirectory(root, 'linked-note', 10), ['real/linked-note.md']);
  assert.deepEqual(await searchProjectDirectory(root, 'secret', 10), []);
  // A link to the project itself is not listed.
  assert.deepEqual(await searchProjectDirectory(root, 'back', 10, { includeDirectories: true }), []);
});

test('a link leading outside the project is neither listed nor walked', async (t) => {
  const root = await tempRoot(t);
  const outside = await tempRoot(t);
  await writeFile(join(outside, 'private.txt'), '');
  await writeFile(join(root, 'inside.txt'), '');
  await symlink(outside, join(root, 'shared'), 'junction');
  assert.deepEqual(await searchProjectDirectory(root, 'private', 10, { includeDirectories: true }), []);
  assert.deepEqual(await searchProjectDirectory(root, 'shared', 10, { includeDirectories: true }), []);
  assert.deepEqual(await searchProjectDirectory(root, '', 10, { includeDirectories: true }), ['inside.txt']);
});

test('a link to an excluded folder does not bypass the exclusion', async (t) => {
  const root = await tempRoot(t);
  await writeFile(join(root, '.gitignore'), 'build/\n');
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, 'build'));
  await writeFile(join(root, 'node_modules', 'pkg', 'vendored.txt'), '');
  await writeFile(join(root, 'build', 'output.txt'), '');
  await symlink(join(root, 'node_modules'), join(root, 'alias'), 'junction');
  await symlink(join(root, 'build'), join(root, 'latest'), 'junction');
  for (const query of ['vendored', 'output', 'alias', 'latest']) {
    assert.deepEqual(await searchProjectDirectory(root, query, 10, { includeDirectories: true }), []);
  }
  // Ignored files are wanted: only the default exclusions still apply.
  assert.deepEqual(await searchProjectDirectory(root, 'output', 10, { includeIgnored: true }), ['build/output.txt']);
  assert.deepEqual(
    await searchProjectDirectory(root, 'latest', 10, { includeIgnored: true, includeDirectories: true }),
    ['latest/']
  );
  assert.deepEqual(await searchProjectDirectory(root, 'vendored', 10, { includeIgnored: true }), []);
});

test('an inaccessible descendant, or one whose ignore rules cannot be read, is skipped', async (t) => {
  const root = await tempRoot(t);
  for (const folder of ['locked', 'hidden-rules', 'open']) await mkdir(join(root, folder));
  for (const file of ['locked/a.txt', 'hidden-rules/b.txt', 'open/c.txt']) await writeFile(join(root, file), '');
  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const { opendir, readFile } = fsPromises;
  t.mock.method(fsPromises, 'opendir', (path, ...rest) =>
    String(path).endsWith('locked') ? Promise.reject(denied) : opendir(path, ...rest)
  );
  t.mock.method(fsPromises, 'readFile', (path, ...rest) =>
    String(path).includes('hidden-rules') ? Promise.reject(denied) : readFile(path, ...rest)
  );
  syncBuiltinESMExports();
  try {
    // `hidden-rules` is not searched with incomplete rules; `locked` cannot be opened.
    assert.deepEqual(await searchProjectDirectory(root, 'txt', 10), ['open/c.txt']);
    // The project root itself must stay readable.
    await assert.rejects(searchProjectDirectory(join(root, 'locked'), 'txt', 10), { code: 'EACCES' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

async function chainRoot(t) {
  const root = await tempRoot(t);
  const chain = join(root, ...Array.from({ length: 40 }, () => 'd'));
  await mkdir(chain, { recursive: true });
  await writeFile(join(chain, 'needle-end.txt'), '');
  return root;
}

test("a consumer's next search supersedes its previous one; other consumers and an aborted signal behave alone", async (t) => {
  const root = await chainRoot(t);
  const slow = { maxScannedEntries: 1, yieldEvery: 1, includeDirectories: true };
  const deep = `${Array(40).fill('d').join('/')}/needle-end.txt`;
  const first = searchProjectDirectory(root, 'needle', 10, { ...slow, consumer: 'window-1' });
  const other = searchProjectDirectory(root, 'needle-end', 10, { ...slow, consumer: 'window-2' });
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  // An empty query supersedes too.
  const empty = searchProjectDirectory(root, '', 10, { ...slow, consumer: 'window-1' });
  assert.deepEqual(await first, []);
  assert.deepEqual(await empty, ['d/']);
  // The other window on the same root keeps walking.
  assert.deepEqual(await other, [deep]);
  const second = searchProjectDirectory(root, 'needle-end', 10, { ...slow, consumer: 'window-1' });
  assert.deepEqual(await second, [deep]);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await searchProjectDirectory(root, 'needle', 10, { ...slow, signal: controller.signal }), []);
});

test('the answer is due at the budget even while a directory read is held, and the walk then stops', async (t) => {
  const root = await chainRoot(t);
  const { opendir } = fsPromises;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const opened = t.mock.method(fsPromises, 'opendir', async (path, ...rest) => {
    if (path === join(root, 'd')) await held;
    return opendir(path, ...rest);
  });
  syncBuiltinESMExports();
  try {
    const options = { maxScannedEntries: 1, beyondBudgetMs: 30 };
    assert.deepEqual(await searchProjectDirectory(root, 'needle', 10, options), []);
    const calls = opened.mock.callCount();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The released read starts no further work…
    assert.equal(opened.mock.callCount(), calls);
    // …and kept nothing: the next query still walks and finds the file.
    // (A generous budget: this assertion is about the walk result, not the deadline, so it
    // must not depend on 40 nested reads finishing within the 30 ms used above.)
    assert.deepEqual(await searchProjectDirectory(root, 'needle-end', 10, { ...options, beyondBudgetMs: 10_000 }), [
      `${Array(40).fill('d').join('/')}/needle-end.txt`,
    ]);
  } finally {
    release();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('a walk stopped while an ignore file is read opens no further folder', async (t) => {
  const root = await chainRoot(t);
  const { opendir, readFile } = fsPromises;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const opened = t.mock.method(fsPromises, 'opendir', (path, ...rest) => opendir(path, ...rest));
  t.mock.method(fsPromises, 'readFile', async (path, ...rest) => {
    if (path === join(root, 'd', '.gitignore')) await held;
    return readFile(path, ...rest);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(
      await searchProjectDirectory(root, 'needle', 10, { maxScannedEntries: 1, beyondBudgetMs: 30 }),
      []
    );
    const calls = opened.mock.callCount();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opened.mock.callCount(), calls);
  } finally {
    release();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("a link whose target's ignore rules cannot be read is not listed", async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'real', 'sub'), { recursive: true });
  await symlink(join(root, 'real', 'sub'), join(root, 'alias'), 'junction');
  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const { readFile } = fsPromises;
  t.mock.method(fsPromises, 'readFile', (path, ...rest) =>
    String(path).endsWith(join('real', '.gitignore')) ? Promise.reject(denied) : readFile(path, ...rest)
  );
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await searchProjectDirectory(root, 'alias', 10, { includeDirectories: true }), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('the walk past the cap has a time budget and answers with what it has', async (t) => {
  const root = await chainRoot(t);
  await writeFile(join(root, 'needle-top.txt'), '');
  assert.deepEqual(
    await searchProjectDirectory(root, 'needle', 10, { maxScannedEntries: 3, yieldEvery: 1, beyondBudgetMs: 0 }),
    ['needle-top.txt']
  );
});

test('a finished walk past the cap answers the queries that extend it without walking again', async (t) => {
  const root = await chainRoot(t);
  const opened = t.mock.method(fsPromises, 'opendir');
  syncBuiltinESMExports();
  try {
    const options = { maxScannedEntries: 1 };
    // A cached index is what carries the finished walk from one query to the next.
    const first = await searchProjectDirectory(root, 'needle', 10, options);
    assert.equal(first.length, 1);
    const walks = opened.mock.callCount();
    assert.deepEqual(await searchProjectDirectory(root, 'needle-end', 10, options), first);
    assert.equal(opened.mock.callCount(), walks);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
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
