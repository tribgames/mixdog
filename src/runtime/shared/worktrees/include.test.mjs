import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  applyIncludes,
  coveredByIncludes,
  modifiedIncludeCopies,
  planIncludes,
  readIncludeEntries,
  removeIncludeLinks,
  validateIncludePath,
} from './include.mjs';
import { cleanupTempDirs, git, makeRepo, tempDir, writeFile } from './test-support.mjs';

after(() => cleanupTempDirs());

test('include paths must be plain relative paths', () => {
  assert.equal(validateIncludePath('./a//b\\c'), 'a/b/c');
  for (const value of [
    '',
    '/abs',
    'C:\\x',
    'c:rel',
    '\\\\server\\share',
    '../up',
    'a/../b',
    '.git',
    'a/.GIT/x',
    'a:b',
  ]) {
    assert.throws(() => validateIncludePath(value, 3), { code: 'WORKTREE_UNSUPPORTED_REPO' }, value);
  }
});

test('the include file is parsed line by line; other lines are gitignore-style patterns', async () => {
  const root = tempDir();
  assert.deepEqual(await readIncludeEntries(root), []);
  writeFile(root, '.worktreeinclude', '\uFEFF# comment\n\ncopy .env\r\nlink  node_modules \n');
  assert.deepEqual(await readIncludeEntries(root), [
    { mode: 'copy', rel: '.env', line: 3 },
    { mode: 'link', rel: 'node_modules', line: 4 },
  ]);
  writeFile(root, '.worktreeinclude', 'copy a\nlink a/b\n');
  await assert.rejects(readIncludeEntries(root), /overlaps/);
  // claude-code / vscode style files: bare patterns, never a parse failure.
  writeFile(root, '.worktreeinclude', '.env*\n!.env.example\nconfig/*.local.json\nexec ./script.sh\n');
  assert.deepEqual(await readIncludeEntries(root), [
    { mode: 'pattern', pattern: '.env*', line: 1 },
    { mode: 'pattern', pattern: '!.env.example', line: 2 },
    { mode: 'pattern', pattern: 'config/*.local.json', line: 3 },
    { mode: 'pattern', pattern: 'exec ./script.sh', line: 4 },
  ]);
  // Unsafe explicit paths are kept as invalid entries (warned and skipped), never a failure.
  writeFile(root, '.worktreeinclude', 'copy /etc/passwd\nlink ../up\ncopy .git/config\ncopy .env\n');
  const entries = await readIncludeEntries(root);
  assert.deepEqual(
    entries.map((entry) => [entry.mode, entry.line]),
    [
      ['invalid', 1],
      ['invalid', 2],
      ['invalid', 3],
      ['copy', 4],
    ]
  );
  const plan = await planIncludes(root, entries);
  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.warnings, [
    'include-invalid:1',
    'include-invalid:2',
    'include-invalid:3',
    'include-missing:.env',
  ]);
});

test('patterns copy only untracked paths the repository git-ignores; explicit entries win', async () => {
  const repo = makeRepo();
  writeFile(repo, '.gitignore', '.env*\nconfig/*.local.json\nbuild/\n');
  writeFile(repo, 'notes.txt', 'tracked\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'ignore');
  writeFile(repo, '.env', 'A=1\n');
  writeFile(repo, '.env.example', 'A=\n');
  writeFile(repo, 'config/app.local.json', '{}\n');
  writeFile(repo, 'build/out.bin', 'bin');
  writeFile(repo, 'scratch.env.txt', 'untracked but not ignored\n');
  const plan = await planIncludes(repo, [
    { mode: 'pattern', pattern: '.env*', line: 1 },
    { mode: 'pattern', pattern: '!.env.example', line: 2 },
    { mode: 'pattern', pattern: 'config/*.local.json', line: 3 },
    { mode: 'pattern', pattern: 'notes.txt', line: 4 },
    { mode: 'pattern', pattern: 'build', line: 5 },
    { mode: 'pattern', pattern: null, line: 6 },
    { mode: 'link', rel: 'build', line: 7 },
  ]);
  assert.deepEqual(plan.items.map((item) => `${item.mode}:${item.rel}`).sort(), [
    'copy:.env',
    'copy:config/app.local.json',
    'link:build',
  ]);
  assert.deepEqual(plan.warnings, ['include-invalid:6']);
});

test('copies and links never overwrite, links are removed without traversal, and copy edits are detected', async () => {
  const repo = tempDir();
  const worktree = tempDir();
  writeFile(repo, 'data/file.txt', 'data\n');
  writeFile(repo, 'linked/keep.txt', 'keep\n');
  writeFile(repo, 'exists.txt', 'source\n');
  writeFile(worktree, 'exists.txt', 'tracked\n');
  const plan = await planIncludes(repo, [
    { mode: 'copy', rel: 'data', line: 1 },
    { mode: 'link', rel: 'linked', line: 2 },
    { mode: 'copy', rel: 'exists.txt', line: 3 },
  ]);
  assert.equal(plan.copyBytes, 'data\n'.length + 'source\n'.length);
  const ledger = [];
  const result = await applyIncludes(plan, worktree, (item) => {
    ledger.push({ ...item });
  });
  assert.deepEqual(result.warnings, ['include-exists:exists.txt']);
  assert.equal(readFileSync(join(worktree, 'exists.txt'), 'utf8'), 'tracked\n');
  assert.deepEqual(
    ledger.map((item) => `${item.rel}:${item.status}`),
    ['data:pending', 'data:created', 'linked:pending', 'linked:created']
  );
  const items = ledger.filter((item) => item.status === 'created');
  assert.ok(coveredByIncludes(items, 'data/file.txt'));
  assert.ok(coveredByIncludes(items, 'linked/'));
  assert.equal(coveredByIncludes(items, 'database.txt'), false);

  assert.deepEqual(await modifiedIncludeCopies(items), []);
  writeFile(worktree, 'data/file.txt', 'edited in the worktree\n');
  assert.deepEqual(await modifiedIncludeCopies(items), ['data']);

  assert.deepEqual(await removeIncludeLinks(items), []);
  assert.equal(existsSync(join(worktree, 'linked')), false);
  assert.equal(readFileSync(join(repo, 'linked', 'keep.txt'), 'utf8'), 'keep\n');
});

test('sources reached through a link outside the repository are skipped with a warning, never copied', async () => {
  const repo = tempDir();
  const outside = tempDir();
  writeFile(outside, 'secret.txt', 'secret\n');
  writeFile(repo, 'ok.txt', 'ok\n');
  symlinkSync(outside, join(repo, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await planIncludes(repo, [
    { mode: 'copy', rel: 'escape/secret.txt', line: 1 },
    { mode: 'copy', rel: 'ok.txt', line: 2 },
  ]);
  assert.deepEqual(
    plan.items.map((item) => item.rel),
    ['ok.txt']
  );
  assert.deepEqual(plan.warnings, ['include-skipped:escape/secret.txt']);
});

test('a destination that would pass through a link in the worktree is skipped, never written', async () => {
  const repo = tempDir();
  const worktree = tempDir();
  const elsewhere = tempDir();
  writeFile(repo, 'cfg/local.json', '{}\n');
  symlinkSync(elsewhere, join(worktree, 'cfg'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await planIncludes(repo, [{ mode: 'copy', rel: 'cfg/local.json', line: 1 }]);
  const result = await applyIncludes(plan, worktree, () => {});
  assert.deepEqual(result.warnings, ['include-skipped:cfg/local.json']);
  assert.equal(existsSync(join(elsewhere, 'local.json')), false);
});
