import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import test from 'node:test';

import { comparablePath, projectEntryPathIn } from './project-entry-path.ts';
import { withTempDir } from '../../../../scripts/lib/scoped-temp.mjs';

const withRoot = (run) =>
  withTempDir('entry-path', async (base) => {
    const root = join(base, 'root');
    await fs.mkdir(join(root, 'sub'), { recursive: true });
    await run(root, base);
  });

test('resolves existing and missing entries under the root', async () => {
  await withRoot((root) => {
    assert.equal(projectEntryPathIn(root, 'sub'), resolve(root, 'sub'));
    assert.equal(projectEntryPathIn(root, 'sub/new/file.txt'), resolve(root, 'sub', 'new', 'file.txt'));
    assert.equal(projectEntryPathIn(root, ''), resolve(root));
    assert.equal(projectEntryPathIn(root, 'sub\\a.txt'), resolve(root, 'sub', 'a.txt'));
  });
});

test('refuses lexical traversal out of the root', async () => {
  await withRoot((root) => {
    assert.throws(() => projectEntryPathIn(root, '../outside'), /outside the project/);
    assert.throws(() => projectEntryPathIn(root, 'sub/../../outside'), /outside the project/);
  });
});

test('refuses a symlinked directory that resolves outside the root', async (t) => {
  await withRoot(async (root, base) => {
    const outside = join(base, 'outside');
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, join(root, 'link'), 'junction');
    } catch {
      t.skip('symlink not permitted');
      return;
    }
    assert.throws(() => projectEntryPathIn(root, 'link/file.txt'), /resolves outside the project/);
  });
});

test('comparablePath folds case only on Windows', () => {
  assert.equal(comparablePath('A/B'), process.platform === 'win32' ? 'a/b' : 'A/B');
});

test('a drive or filesystem root accepts entries under it', () => {
  const root = parse(resolve(tmpdir())).root;
  const entry = 'mixdog-entry-path-missing/file.txt';
  assert.equal(projectEntryPathIn(root, entry), resolve(root, entry));
});
