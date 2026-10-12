// Temporary git repositories and data dirs for the worktree suites.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

export function commitFile(cwd, rel, content, message = `edit ${rel}`) {
  writeFile(cwd, rel, content);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A repository on `main` with one commit. */
export function makeRepo({ commit = true } = {}) {
  const dir = tempDir('mixdog-wt-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Mixdog Test');
  git(dir, 'config', 'user.email', 'mixdog@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  if (commit) commitFile(dir, 'README.md', 'hello\n', 'initial');
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
