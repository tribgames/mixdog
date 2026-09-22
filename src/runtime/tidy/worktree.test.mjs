import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess, which } from './process.mjs';
import { NO_GIT_REASON, listWorkingTreeChanges, splitFindingsByWorktree, worktreeNotes } from './worktree.mjs';

function git(cwd, args) {
  return runProcess('git', args, { cwd, timeoutMs: 30_000 });
}

/** A repository whose HEAD is clean, so "modified" means someone touched it. */
async function committedProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-worktree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'clean.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'dirty.js'), 'export const b = 2;\n');
  writeFileSync(join(root, 'src', 'renamed.js'), 'export const c = 3;\n');
  const commands = [
    ['init'],
    ['add', '.'],
    ['-c', 'user.email=tidy@example.invalid', '-c', 'user.name=Tidy', 'commit', '-m', 'init'],
  ];
  for (const args of commands) {
    const result = await git(root, args);
    if (result.code !== 0) return null;
  }
  return root;
}

test('the working-tree set holds modified, untracked and renamed files, never the clean ones', async (t) => {
  const root = await committedProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  writeFileSync(join(root, 'src', 'dirty.js'), 'export const b = 22;\n');
  writeFileSync(join(root, 'src', 'fresh.js'), 'export const d = 4;\n');
  assert.equal((await git(root, ['mv', 'src/renamed.js', 'src/moved.js'])).code, 0);

  const { files, error } = await listWorkingTreeChanges({ cwd: root });
  assert.equal(error, '');
  assert.deepEqual([...files].sort(), ['src/dirty.js', 'src/fresh.js', 'src/moved.js', 'src/renamed.js']);
  assert.equal(files.has('src/clean.js'), false);
});

test('a cwd below the repository root reports paths relative to that cwd', async (t) => {
  const root = await committedProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  writeFileSync(join(root, 'src', 'dirty.js'), 'export const b = 22;\n');
  writeFileSync(join(root, 'top.md'), '# top\n');

  const { files, error } = await listWorkingTreeChanges({ cwd: join(root, 'src') });
  assert.equal(error, '');
  assert.deepEqual([...files].sort(), ['dirty.js']);
});

test('a directory git cannot answer for reports the error instead of calling everything clean', async (t) => {
  if (!which('git')) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'tidy-worktree-bare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { files, error, skipped } = await listWorkingTreeChanges({ cwd: root });
  assert.equal(files, null);
  assert.equal(skipped, undefined, 'git answered badly; that is not a skipped probe');
  assert.ok(error, 'a failed git status must carry a reason');
  assert.match(worktreeNotes({ error }, 'fix')[0], /working-tree split unavailable/);
});

test('no git on PATH skips the probe silently instead of spawning and warning', async (t) => {
  const root = await committedProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  writeFileSync(join(root, 'src', 'dirty.js'), 'export const b = 22;\n');

  // A real repository with real changes: a spawn would have answered with the
  // file set, and a failed spawn would have carried a reason. Neither happened.
  const { files, error, skipped } = await listWorkingTreeChanges({ cwd: root, env: { PATH: '', Path: '' } });
  assert.equal(files, null);
  assert.equal(error, '', 'nothing was spawned, so there is no failure to report');
  assert.equal(skipped, NO_GIT_REASON);
  assert.deepEqual(worktreeNotes({ skipped }, 'fix'), [], 'a machine without git gets no standing warning');
  assert.deepEqual(worktreeNotes({ skipped }, 'check'), []);
});

test('findings split into the modified and the clean population, with counts for both', () => {
  const findings = new Map([
    ['src/dirty.js', 3],
    ['src/clean.js', 2],
    ['scripts/build.mjs', 1],
  ]);
  const split = splitFindingsByWorktree(findings, new Set(['src/dirty.js', 'src/untouched-by-findings.js']));
  assert.deepEqual(split.modified, { files: ['src/dirty.js'], findings: 3 });
  assert.deepEqual(split.clean, { files: ['scripts/build.mjs', 'src/clean.js'], findings: 3 });

  assert.match(worktreeNotes(split, 'fix')[0], /2 file\(s\)/);
  assert.match(worktreeNotes(split, 'fix')[0], /apply:true writes them too/);
  assert.match(worktreeNotes(split, 'check')[0], /would write them too/);
  const allDirty = splitFindingsByWorktree(findings, new Set(['src/dirty.js', 'src/clean.js', 'scripts/build.mjs']));
  assert.deepEqual(worktreeNotes(allDirty, 'fix'), []);
  assert.deepEqual(worktreeNotes(null, 'fix'), []);
});
