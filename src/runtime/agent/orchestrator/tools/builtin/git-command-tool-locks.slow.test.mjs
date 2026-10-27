// The git tool's lock policy against real git (git-repo-rw-lock.mjs): reads
// take no lock, writes wait only for writes on the same worktree, and a write
// refused on a busy git lock file retries.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeGitTool } from './git-command-tool.mjs';
import { gitRepoLockKey, withGitRepoWriteLock, withGitWorktreeWriteLock } from './git-repo-rw-lock.mjs';

const rawGit = (cwd, args, env = process.env) =>
  execFileSync('git', args, { cwd, env, stdio: 'pipe', windowsHide: true }).toString();
const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
const FAILED = /^(?:error:|exit [1-9])/;
const WAIT_NOTE = /note: waited \d+\.\ds for concurrent git writes/;

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function pendingAfter(promise, ms) {
  const timeout = Symbol('pending');
  const winner = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(timeout), ms))]);
  return winner === timeout;
}

// A main checkout with one linked worktree, under a fresh temp root.
function linkedRepo(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const linked = join(root, 'linked');
  mkdirSync(repo);
  rawGit(repo, ['init', '-q', '-b', 'main']);
  rawGit(repo, ['config', 'user.name', 't']);
  rawGit(repo, ['config', 'user.email', 't@example.com']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  rawGit(repo, ['add', 'a.txt']);
  rawGit(repo, ['commit', '-q', '-m', 'init']);
  rawGit(repo, ['worktree', 'add', '-q', '-b', 'side', linked]);
  return { root, repo, linked, lockKey: gitRepoLockKey(join(repo, '.git')) };
}

// History whose `git log -S` takes seconds: every commit rewrites three 1 MiB
// files, so pickaxe inflates and scans 6 MiB per commit.
function addSlowHistory(repo, commits) {
  const parts = [];
  const pool = [];
  let mark = 0;
  for (let index = 0; index < 8; index++) {
    const data = Buffer.from(randomBytes(512 * 1024).toString('hex'));
    parts.push(Buffer.from(`blob\nmark :${++mark}\ndata ${data.length}\n`), data, Buffer.from('\n'));
    pool.push(mark);
  }
  for (let index = 0; index < commits; index++) {
    const message = `c${index}\n`;
    let text = `commit refs/heads/history\nmark :${++mark}\ncommitter T <t@example.invalid> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}`;
    for (let file = 0; file < 3; file++) text += `M 100644 :${pool[(index * 3 + file) % pool.length]} f${file}.txt\n`;
    parts.push(Buffer.from(`${text}\n`));
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: Buffer.concat(parts), stdio: 'pipe' });
}

test('git reads take no lock: they answer while a write holds the repository and another write waits', async (t) => {
  const { repo, linked, lockKey } = linkedRepo(t, 'mixdog-git-reads-');
  const hold = gate();
  const held = withGitRepoWriteLock(lockKey, () => hold.promise);
  const waitingWrite = executeGitTool({ command: 'git tag waiting' }, repo);
  const reads = [
    'git status --short',
    'git diff',
    'git log --oneline -1',
    'git rev-parse HEAD',
    'git branch --list',
    'git show --stat HEAD',
    'git worktree list',
  ];
  const answers = await Promise.all([
    ...reads.map((command) => executeGitTool({ command }, repo)),
    executeGitTool({ command: 'git status' }, linked),
  ]);
  for (const answer of answers) assert.doesNotMatch(answer, FAILED);
  assert.equal(await pendingAfter(waitingWrite, 50), true);
  hold.release();
  await held;
  assert.doesNotMatch(await waitingWrite, FAILED);
});

test('neither light reads nor a write on another worktree wait behind a long git log -S', async (t) => {
  const { repo, linked } = linkedRepo(t, 'mixdog-git-long-read-');
  addSlowHistory(repo, 80);
  const started = Date.now();
  let longDone = 0;
  const long = executeGitTool({ command: 'git log -S needle --all --oneline' }, repo).then((text) => {
    longDone = Date.now();
    return text;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const written = await executeGitTool({ command: `git -C ${quote(linked)} commit -q --allow-empty -m quick` }, repo);
  const writeDone = Date.now();
  const light = await Promise.all(
    ['git rev-parse history', 'git log --oneline -1 history', 'git status --short', 'git branch --list'].map(
      (command) => executeGitTool({ command }, repo)
    )
  );
  const lightDone = Date.now();
  assert.doesNotMatch(await long, FAILED);
  assert.doesNotMatch(written, FAILED);
  assert.match(rawGit(repo, ['log', '--format=%s', '-1', 'side']), /^quick$/m);
  for (const answer of light) assert.doesNotMatch(answer, FAILED);
  const timing = `write ${writeDone - started}ms, light ${lightDone - started}ms, long log ${longDone - started}ms`;
  assert.ok(writeDone < longDone && lightDone < longDone, timing);
});

test('git writes wait only for writes on the same worktree and report a wait over a second', async (t) => {
  const { repo, linked, lockKey } = linkedRepo(t, 'mixdog-git-writes-');
  const hold = gate();
  const held = withGitWorktreeWriteLock(lockKey, [linked], () => hold.promise);
  const free = await Promise.all([
    executeGitTool({ command: 'git tag main-tag' }, repo),
    executeGitTool({ command: 'git commit -q --allow-empty -m main' }, repo),
  ]);
  for (const answer of free) {
    assert.doesNotMatch(answer, FAILED);
    assert.doesNotMatch(answer, WAIT_NOTE);
  }
  // Queued in this order: the commit runs before the tag that points at it.
  const sameWorktree = executeGitTool({ command: 'git commit -q --allow-empty -m side' }, linked);
  assert.equal(await pendingAfter(sameWorktree, 300), true);
  const tagLinked = executeGitTool({ command: `git -C ${quote(linked)} tag side-tag` }, repo);
  assert.equal(await pendingAfter(tagLinked, 1200), true);
  assert.equal(await pendingAfter(sameWorktree, 0), true);
  hold.release();
  await held;
  const committed = await sameWorktree;
  assert.doesNotMatch(committed, FAILED);
  assert.match(committed, WAIT_NOTE);
  assert.doesNotMatch(await tagLinked, FAILED);
  assert.match(rawGit(repo, ['log', '--format=%s', '-1', 'side']), /^side$/m);
  assert.match(rawGit(repo, ['log', '--format=%s', '-1', 'side-tag']), /^side$/m);
});

test('a git write refused on a busy lock file retries with backoff instead of failing', async (t) => {
  const { repo } = linkedRepo(t, 'mixdog-git-retry-');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  const lock = join(repo, '.git', 'index.lock');
  // GIT_TRACE (inherited by the spawned git) logs every `git add` attempt, so
  // the lock is released on an observed attempt count, not a timer that a
  // loaded machine can outrun. The note appears once the retry sleeps pass 1 s
  // (100+200+400+800 ms), i.e. after four refusals; the fifth attempt starting
  // proves git was refused four times, and the lock may go.
  const trace = join(repo, '..', 'git-trace.log');
  const previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  t.after(() => {
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
  });
  const attempts = () => {
    try {
      return (readFileSync(trace, 'utf8').match(/built-in: git add b\.txt/g) || []).length;
    } catch {
      return 0;
    }
  };
  writeFileSync(lock, '');
  const adding = executeGitTool({ command: 'git add b.txt' }, repo);
  const deadline = Date.now() + 60_000;
  while (attempts() < 5) {
    if (Date.now() > deadline) {
      rmSync(lock, { force: true });
      await adding;
      assert.fail(`git add never hit the busy index.lock 4 times within 60s (saw ${attempts()} attempts)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  rmSync(lock);
  const text = await adding;
  assert.doesNotMatch(text, FAILED);
  assert.match(text, /note: waited \d+\.\ds for concurrent git writes \(git lock file busy; retried [1-5]x\)/);
  assert.match(rawGit(repo, ['ls-files']), /^b\.txt$/m);
});

test('git status runs without optional locks, so it never takes index.lock beside a write', async (t) => {
  const { repo } = linkedRepo(t, 'mixdog-git-optional-locks-');
  const index = join(repo, '.git', 'index');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(repo, 'a.txt'), later, later);
  const before = statSync(index).mtimeMs;
  for (const command of ['git status', 'git status --short']) {
    assert.doesNotMatch(await executeGitTool({ command }, repo), FAILED);
  }
  assert.equal(statSync(index).mtimeMs, before);
  // Control: git with optional locks on writes the refreshed stat data back.
  rawGit(repo, ['status'], { ...process.env, GIT_OPTIONAL_LOCKS: '1' });
  assert.notEqual(statSync(index).mtimeMs, before);
});
