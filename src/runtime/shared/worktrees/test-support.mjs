// Temporary git repositories and data dirs for the worktree suites.
import '../git-direct.test-support.mjs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const created = [];

export function tempDir(prefix = 'mixdog-wt-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  }
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[name];

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function writeFile(root, rel, content) {
  const path = join(root, ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A git hook script; outside Windows git skips a hook without the executable bit. */
export function writeHook(root, name, script) {
  const path = writeFile(root, `.git/hooks/${name}`, script);
  chmodSync(path, 0o755);
  return path;
}

export function commitFile(cwd, rel, content, message = `edit ${rel}`) {
  writeFile(cwd, rel, content);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

// Built once per process and copied per repository: the five or six git
// spawns behind one fresh repository cost ~0.8 s on win32, and the worktree
// suites make dozens. A non-bare repository holds no absolute paths, so a copy
// is the same repository at its new location.
const templates = new Map();

function repoTemplate(commit) {
  const existing = templates.get(commit);
  if (existing && existsSync(existing)) return existing;
  const dir = tempDir('mixdog-wt-template-');
  git(dir, 'init', '-q', '-b', 'main');
  // One config write instead of a `git config` process per key. Auto
  // maintenance is off, so no commit (the test's or a merge's) starts a
  // `git maintenance run` child.
  appendFileSync(
    join(dir, '.git', 'config'),
    '[user]\n\tname = Mixdog Test\n\temail = mixdog@example.com\n[core]\n\tautocrlf = false\n[maintenance]\n\tauto = false\n'
  );
  if (commit) commitFile(dir, 'README.md', 'hello\n', 'initial');
  templates.set(commit, dir);
  return dir;
}

/** A repository on `main` with one commit. */
export function makeRepo({ commit = true } = {}) {
  const dir = tempDir('mixdog-wt-repo-');
  cpSync(repoTemplate(commit), dir, { recursive: true });
  return dir;
}

/** Point the data dir at a fresh temp dir; returns it. */
export function useTempDataDir() {
  const dir = tempDir('mixdog-wt-data-');
  process.env.MIXDOG_DATA_DIR = dir;
  return dir;
}

let idCounter = 0;

/** Fresh session/runtime/transaction ids for one managed worktree. */
export function nextIds() {
  idCounter += 1;
  return { sessionId: `session-${idCounter}`, runtimeToken: `token-${idCounter}`, txId: `tx-${idCounter}` };
}

/** createManagedWorktree with fresh ids; resolves { entry, sessionId, runtimeToken, txId, ...extra }. */
export async function createTestWorktree(projectPath, extra = {}) {
  const { createManagedWorktree } = await import('./manager.mjs');
  const id = nextIds();
  const entry = await createManagedWorktree({ projectPath, nameHint: 'Fix the login page', ...id, ...extra });
  return { entry, ...id, ...extra };
}

/** The repository's branches under the default managed prefix. */
export function prefixedBranches(repo) {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/mixdog/').split('\n').filter(Boolean);
}
