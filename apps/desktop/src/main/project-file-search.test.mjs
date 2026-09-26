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
