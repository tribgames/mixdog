import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectEntryPathIn } from './project-entry-path.ts';

test('a deleted file in a deleted folder is still inside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pe-root-'));
  try {
    assert.equal(projectEntryPathIn(root, 'src/old/a.ts'), join(root, 'src', 'old', 'a.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dangling link is judged by where it points', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pe-link-'));
  try {
    const repo = join(base, 'repo');
    const outside = join(base, 'outside');
    const inside = join(repo, 'inside');
    await mkdir(repo);
    await mkdir(outside);
    await mkdir(inside);
    await symlink(outside, join(repo, 'out'), 'junction');
    await symlink(inside, join(repo, 'in'), 'junction');
    await rm(outside, { recursive: true });
    await rm(inside, { recursive: true });
    assert.throws(() => projectEntryPathIn(repo, 'out/x.txt'), /outside the project/);
    assert.doesNotThrow(() => projectEntryPathIn(repo, 'in/x.txt'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a project at a filesystem root admits its files', () => {
  const root = process.platform === 'win32' ? process.cwd().slice(0, 3) : '/';
  const inside = join(root, 'definitely-missing-dir', 'a.ts');
  assert.equal(projectEntryPathIn(root, 'definitely-missing-dir/a.ts'), inside);
});
