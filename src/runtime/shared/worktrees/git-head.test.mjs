import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createGitHeadWatcher, findGitLayout, readGitHead } from './git-head.mjs';

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

test('strict lookup skips an empty .git above the work and finds the parent repo', (t) => {
  const root = sandbox(t);
  const outer = repo(root, 'outer', 'ref: refs/heads/main\n');
  mkdirSync(join(outer, 'home', '.git'), { recursive: true });
  mkdirSync(join(outer, 'home', 'work'), { recursive: true });
  assert.equal(findGitLayout(join(outer, 'home', 'work'), { strict: true }).topLevel, outer);
  const bare = join(root, 'plain', 'work');
  mkdirSync(join(root, 'plain', '.git'), { recursive: true });
  mkdirSync(bare, { recursive: true });
  assert.equal(findGitLayout(bare, { strict: true }), null);
});

test('strict lookup treats an empty .git in the cwd as no repository', (t) => {
  const cwd = join(sandbox(t), 'proj');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  assert.equal(findGitLayout(cwd, { strict: true }), null);
});

test('strict lookup still rejects a non-empty .git without HEAD', (t) => {
  const cwd = join(sandbox(t), 'proj');
  mkdirSync(join(cwd, '.git', 'objects'), { recursive: true });
  assert.throws(() => findGitLayout(cwd, { strict: true }), /Cannot inspect Git HEAD/);
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

/** Replaces fs.watch with handles that never fire; returns the opened handles. */
function fakeWatch(t) {
  const opened = [];
  t.mock.method(fs, 'watch', (dir, _options, listener) => {
    const handle = new EventEmitter();
    handle.dir = dir;
    handle.fire = (name) => listener('rename', name);
    handle.closed = false;
    handle.close = () => {
      handle.closed = true;
    };
    opened.push(handle);
    return handle;
  });
  syncBuiltinESMExports();
  // Restored here, not by the runner's later reset, so the module's live binding follows.
  t.after(() => stopSpy(t));
  return opened;
}

/** Counts sync fs calls made from now on. */
function spySyncFs(t) {
  const calls = [];
  for (const name of ['readFileSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync', 'readdirSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      calls.push(name);
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  return calls;
}

function stopSpy(t) {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}

const live = (dir, handles) => handles.filter((h) => !h.closed && h.dir.startsWith(dir));

test('N sessions in one repository share one watcher set', (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/main\n');
  writeRef(top, 'refs/heads/main', `${SHA}\n`);
  mkdirSync(join(top, 'src'));
  const opened = fakeWatch(t);
  const sessions = Array.from({ length: 5 }, (_, i) =>
    createGitHeadWatcher({ getCwd: () => (i % 2 ? join(top, 'src') : top), onChange: () => {} })
  );
  t.after(() => sessions.forEach((s) => s.dispose()));
  sessions.forEach((s) => s.retarget());
  // HEAD's directory and the branch ref's directory, each with the watch on
  // its parent, once for all five.
  assert.equal(opened.length, 4);
  sessions.forEach((s) => s.retarget());
  assert.equal(opened.length, 4, 'retarget with an unchanged folder re-watches nothing');
});

test('steady-state HEAD reads of a watched repository touch no sync fs', (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/main\n');
  fakeWatch(t);
  const watcher = createGitHeadWatcher({ getCwd: () => top, onChange: () => {} });
  t.after(() => watcher.dispose());
  watcher.retarget();
  assert.equal(readGitHead(top).branch, 'main');
  const calls = spySyncFs(t);
  for (let i = 0; i < 10; i++) {
    assert.equal(readGitHead(top).branch, 'main');
    assert.equal(findGitLayout(top).topLevel, top);
    watcher.retarget();
  }
  stopSpy(t);
  assert.deepEqual(calls, []);
});

test('a HEAD change is served from the cache until its watch event, then published', async (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/main\n');
  const opened = fakeWatch(t);
  let changes = 0;
  const watcher = createGitHeadWatcher({ getCwd: () => top, onChange: () => changes++, debounceMs: 10 });
  t.after(() => watcher.dispose());
  watcher.retarget();
  writeFileSync(join(top, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readGitHead(top).branch, 'main', 'no event, no re-read');
  assert.equal(changes, 0);
  live(join(top, '.git'), opened)[0].fire('HEAD');
  await settle(() => changes > 0);
  assert.equal(readGitHead(top).branch, 'feature');
});

test('a non-repository folder that becomes one is attached on the `.git` event', async (t) => {
  const cwd = join(sandbox(t), 'plain');
  mkdirSync(cwd);
  const opened = fakeWatch(t);
  let changes = 0;
  const watcher = createGitHeadWatcher({ getCwd: () => cwd, onChange: () => changes++, debounceMs: 10 });
  t.after(() => watcher.dispose());
  watcher.retarget();
  assert.equal(readGitHead(cwd), null);
  repo(dirname(cwd), 'plain', 'ref: refs/heads/main\n');
  opened.find((handle) => handle.dir === cwd && !handle.closed).fire('.git');
  await settle(() => changes > 0);
  assert.equal(readGitHead(cwd).branch, 'main');
  assert.equal(
    opened.filter((handle) => !handle.closed && handle.dir === cwd).length,
    1,
    'the folder watch for `.git` is released once attached; only the parent watch of `.git` remains'
  );
});

test('a session moving to another repository releases its reference', (t) => {
  const root = sandbox(t);
  const one = repo(root, 'one', 'ref: refs/heads/main\n');
  const two = repo(root, 'two', 'ref: refs/heads/main\n');
  const opened = fakeWatch(t);
  let cwdA = one;
  const a = createGitHeadWatcher({ getCwd: () => cwdA, onChange: () => {} });
  const b = createGitHeadWatcher({ getCwd: () => one, onChange: () => {} });
  t.after(() => {
    a.dispose();
    b.dispose();
  });
  a.retarget();
  b.retarget();
  const watchedOne = live(one, opened).length;
  assert.ok(watchedOne > 0);
  cwdA = two;
  a.retarget();
  assert.equal(live(one, opened).length, watchedOne, 'the other session still holds repository one');
  assert.ok(live(two, opened).length > 0);
  b.dispose();
  assert.equal(live(one, opened).length, 0);
  assert.equal(opened.filter((h) => h.dir.startsWith(one)).length, watchedOne, 'repository one was watched once');
  // Unwatched again: a read goes back to the file.
  writeFileSync(join(one, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
  assert.equal(readGitHead(one).branch, 'dev');
});

/** Yields to the event loop (real I/O, timers) until `done()` holds. */
async function settle(done) {
  const deadline = performance.now() + 3000;
  while (!done()) {
    assert.ok(performance.now() < deadline, 'condition never held');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('disposing during a blocked event check opens no watch handles', async (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/main\n');
  const opened = fakeWatch(t);
  const watcher = createGitHeadWatcher({ getCwd: () => top, onChange: () => {} });
  t.after(() => watcher.dispose());
  watcher.retarget();
  const gate = Promise.withResolvers();
  let reads = 0;
  const stat = fs.promises.stat;
  t.mock.method(fs.promises, 'stat', async (...args) => {
    reads++;
    await gate.promise;
    return stat(...args);
  });
  syncBuiltinESMExports();
  live(top, opened)[0].fire('HEAD');
  await settle(() => reads > 0);
  watcher.dispose();
  assert.equal(live(top, opened).length, 0);
  gate.resolve();
  for (let i = 0; i < 20; i++) await fs.promises.stat(tmpdir());
  assert.equal(live(top, opened).length, 0, 'the refresh result of a released repository opens nothing');
});

/** Starts a real watch on `top`, waits for the watch to settle, applies `change`, awaits the publish. */
async function published(t, top, change) {
  const seen = [Promise.withResolvers(), Promise.withResolvers()];
  const sessions = seen.map((s) =>
    createGitHeadWatcher({ getCwd: () => top, onChange: () => s.resolve(), debounceMs: 10 })
  );
  t.after(() => sessions.forEach((s) => s.dispose()));
  sessions.forEach((s) => s.retarget());
  // macOS delivers no event for a write made the instant a watch starts.
  await new Promise((resolve) => setTimeout(resolve, 150));
  change();
  const startedAt = performance.now();
  await Promise.race([
    Promise.all(seen.map((s) => s.promise)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('not published')), 900)),
  ]);
  return performance.now() - startedAt;
}

test('git switch, detached HEAD, symref change and atomic HEAD replace are published', async (t) => {
  const top = repo(sandbox(t), 'proj', 'ref: refs/heads/main\n');
  writeRef(top, 'refs/heads/alias', 'ref: refs/heads/main\n');
  const head = join(top, '.git', 'HEAD');
  await published(t, top, () => {
    writeFileSync(`${head}.lock`, 'ref: refs/heads/feature\n');
    renameSync(`${head}.lock`, head);
  });
  assert.equal(readGitHead(top).branch, 'feature');
  await published(t, top, () => writeFileSync(head, `${SHA}\n`));
  assert.deepEqual([readGitHead(top).branch, readGitHead(top).commit], [null, SHA]);
  await published(t, top, () => writeFileSync(head, 'ref: refs/heads/alias\n'));
  assert.equal(readGitHead(top).branch, 'main');
  await published(t, top, () => writeRef(top, 'refs/heads/alias', 'ref: refs/heads/other\n'));
  assert.equal(readGitHead(top).branch, 'other');
  await published(t, top, () => {
    writeFileSync(join(top, '.git', 'HEAD.tmp'), 'ref: refs/heads/swapped\n');
    renameSync(join(top, '.git', 'HEAD.tmp'), head);
  });
  assert.equal(readGitHead(top).branch, 'swapped');
});
