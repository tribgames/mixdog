import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createGitHeadWatcher, readGitHead } from './git-head.mjs';

const SHA = 'a'.repeat(40);

function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-git-head-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function repo(root, name, head) {
  const top = join(root, name);
  mkdirSync(join(top, '.git'), { recursive: true });
  writeFileSync(join(top, '.git', 'HEAD'), head);
  return top;
}

test('a normal checkout names its branch and common dir', (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/feat/x\n');
  mkdirSync(join(top, 'src', 'deep'), { recursive: true });
  const head = readGitHead(join(top, 'src', 'deep'));
  assert.equal(head.branch, 'feat/x');
  assert.equal(head.commit, null);
  assert.equal(head.topLevel, top);
  assert.equal(head.repoCommonDir, join(top, '.git'));
});

test('a detached HEAD has the commit and no branch; packed refs are irrelevant', (t) => {
  const top = repo(sandbox(t), 'proj', `${SHA}\n`);
  const head = readGitHead(top);
  assert.deepEqual([head.branch, head.commit], [null, SHA]);
});

test('a linked worktree reads its own HEAD and the main repository as common dir', (t) => {
  const root = sandbox(t);
  const main = repo(root, 'main', 'ref: refs/heads/main\n');
  const gitDir = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/side\n');
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  const linked = join(root, 'linked');
  mkdirSync(linked);
  writeFileSync(join(linked, '.git'), `gitdir: ${gitDir}\n`);
  const head = readGitHead(linked);
  assert.equal(head.branch, 'side');
  assert.equal(head.repoCommonDir, join(main, '.git'));
  assert.equal(readGitHead(main).branch, 'main');
});

function writeRef(top, name, text) {
  const file = join(top, '.git', ...name.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test('a symbolic-ref chain resolves to the final branch, not the alias', (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/alias\n');
  writeRef(top, 'refs/heads/alias', 'ref: refs/heads/main\n');
  writeRef(top, 'refs/heads/main', `${SHA}\n`);
  assert.equal(readGitHead(top).branch, 'main');
});

test('a symbolic-ref chain in a linked worktree reads branch refs from the common dir', (t) => {
  const root = sandbox(t);
  const main = repo(root, 'main', 'ref: refs/heads/main\n');
  writeRef(main, 'refs/heads/alias', 'ref: refs/heads/real\n');
  const gitDir = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/alias\n');
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  const linked = join(root, 'linked');
  mkdirSync(linked);
  writeFileSync(join(linked, '.git'), `gitdir: ${gitDir}\n`);
  assert.equal(readGitHead(linked).branch, 'real');
});

test('a symbolic-ref cycle or an over-deep chain has no branch', (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/a\n');
  writeRef(top, 'refs/heads/a', 'ref: refs/heads/b\n');
  writeRef(top, 'refs/heads/b', 'ref: refs/heads/a\n');
  assert.equal(readGitHead(top).branch, null);
  for (let i = 0; i < 10; i++) writeRef(top, `refs/heads/a${i}`, `ref: refs/heads/a${i + 1}\n`);
  writeFileSync(join(top, '.git', 'HEAD'), 'ref: refs/heads/a0\n');
  assert.equal(readGitHead(top).branch, null);
});

test('a symbolic-ref chain ending at a missing target names that unborn branch', (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/alias\n');
  writeRef(top, 'refs/heads/alias', 'ref: refs/heads/unborn\n');
  assert.equal(readGitHead(top).branch, 'unborn');
});

test('the watcher notices a change inside the symbolic-ref chain', async (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/alias\n');
  writeRef(top, 'refs/heads/alias', 'ref: refs/heads/main\n');
  let changes = 0;
  let wake = null;
  const watcher = createGitHeadWatcher({
    getCwd: () => top,
    onChange: () => {
      changes++;
      wake?.();
    },
    debounceMs: 10,
  });
  t.after(() => watcher.dispose());
  watcher.retarget();
  const changed = new Promise((resolve, reject) => {
    wake = resolve;
    setTimeout(() => reject(new Error('no event')), 2000);
  });
  // macOS delivers no event for a write made the instant a watch starts.
  await new Promise((resolve) => setTimeout(resolve, 150));
  writeRef(top, 'refs/heads/alias', 'ref: refs/heads/other\n');
  await changed;
  assert.equal(changes > 0, true);
  assert.equal(readGitHead(top).branch, 'other');
});

test('a folder outside any repository reads null', (t) => {
  assert.equal(readGitHead(sandbox(t)), null);
});

test('a switch is read at once and a half-written HEAD keeps the last answer', (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/main\n');
  assert.equal(readGitHead(top).branch, 'main');
  writeFileSync(join(top, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  assert.equal(readGitHead(top).branch, 'other');
  writeFileSync(join(top, '.git', 'HEAD'), '');
  assert.equal(readGitHead(top).branch, 'other');
});

test('the watcher reports an external HEAD change shortly after it happens', async (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/main\n');
  const changed = Promise.withResolvers();
  const watcher = createGitHeadWatcher({ getCwd: () => top, onChange: () => changed.resolve(), debounceMs: 10 });
  t.after(() => watcher.dispose());
  watcher.retarget();
  await new Promise((resolve) => setTimeout(resolve, 150));
  writeFileSync(join(top, '.git', 'HEAD.lock'), 'ref: refs/heads/next\n');
  writeFileSync(join(top, '.git', 'HEAD'), 'ref: refs/heads/next\n');
  await Promise.race([
    changed.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no event')), 2000)),
  ]);
  assert.equal(readGitHead(top).branch, 'next');
});
