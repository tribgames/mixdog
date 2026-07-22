// Turn-scoped worktree snapshots over a SHADOW git repository.
//
// A per-worktree bare repo lives under <data>/turn-snapshots/<hash>; `git
// --git-dir <shadow> --work-tree <project>` add/write-tree captures the whole
// worktree as a tree object WITHOUT touching the project's own git state (or
// requiring the project to be a git repo at all). Diffing the turn-start tree
// against the current tree therefore reports EVERYTHING a turn changed —
// lead edits, subagent edits, background shell jobs, even external editors —
// which transcript-parsed patches structurally cannot see.
//
// Costs: the first track() of a project hashes the worktree once (mitigated
// by reusing the project's own .git objects via alternates); every later
// track() is an index stat-scan. All entry points are best-effort and never
// throw into the turn path. MIXDOG_TURN_SNAPSHOT=0 disables the feature.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { resolvePluginData } from './plugin-paths.mjs';

const DISABLED = /^(0|false|off)$/i.test(String(process.env.MIXDOG_TURN_SNAPSHOT || ''));
const GIT_TIMEOUT_MS = 120_000;
const BEGIN_WAIT_CAP_MS = 1_500;
const MAX_PATCH_BYTES = 2_000_000;
const BASE_CACHE_MAX = 32;
const FAILURE_BACKOFF_MS = 5 * 60_000;

const _queues = new Map();        // gitdir → tail promise (serialize per repo)
const _baseBySession = new Map(); // sessionId → { worktree, tree, at }
const _failedUntil = new Map();   // gitdir → timestamp

function _worktreeKey(worktree) {
  const raw = String(worktree || '').trim();
  if (!raw) return '';
  const full = resolve(raw);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function _gitDirFor(worktreeKey) {
  const hash = createHash('sha1').update(worktreeKey).digest('hex').slice(0, 20);
  return join(resolvePluginData(), 'turn-snapshots', hash);
}

function _git(args, { cwd } = {}) {
  return new Promise((resolveExec) => {
    execFile('git', args, {
      cwd: cwd || undefined,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolveExec({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Serialize all git operations per shadow repo: concurrent index writes would
// corrupt each other, and turn-start/track/diff can overlap freely otherwise.
function _enqueue(gitdir, task) {
  const tail = (_queues.get(gitdir) || Promise.resolve()).then(task, task);
  _queues.set(gitdir, tail.catch(() => {}));
  return tail;
}

async function _ensureRepo(worktree, gitdir) {
  if (existsSync(join(gitdir, 'HEAD'))) return true;
  mkdirSync(gitdir, { recursive: true });
  const init = await _git(['init', '--bare', '--quiet', gitdir]);
  if (init.code !== 0) return false;
  // The shadow repo indexes the project via --work-tree; never let it descend
  // into the project's real .git, and keep bytes stable/gc quiet.
  await _git(['--git-dir', gitdir, 'config', 'core.bare', 'false']);
  await _git(['--git-dir', gitdir, 'config', 'core.autocrlf', 'false']);
  await _git(['--git-dir', gitdir, 'config', 'gc.auto', '0']);
  try {
    mkdirSync(join(gitdir, 'info'), { recursive: true });
    writeFileSync(join(gitdir, 'info', 'exclude'), '.git/\n');
    // First-snapshot cost: reuse the project's own git objects so unchanged
    // blobs need no re-hash/store (the opencode chromium lesson).
    const projectObjects = join(worktree, '.git', 'objects');
    if (existsSync(projectObjects)) {
      mkdirSync(join(gitdir, 'objects', 'info'), { recursive: true });
      writeFileSync(join(gitdir, 'objects', 'info', 'alternates'), `${projectObjects}\n`);
    }
  } catch { /* exclusions/alternates are optimizations, not requirements */ }
  return true;
}

// Capture the current worktree as a tree object; null on any failure.
async function _trackTree(worktree) {
  const key = _worktreeKey(worktree);
  if (!key || !existsSync(key)) return null;
  const gitdir = _gitDirFor(key);
  const failedUntil = _failedUntil.get(gitdir) || 0;
  if (Date.now() < failedUntil) return null;
  return _enqueue(gitdir, async () => {
    if (!(await _ensureRepo(key, gitdir))) {
      _failedUntil.set(gitdir, Date.now() + FAILURE_BACKOFF_MS);
      return null;
    }
    const base = ['--git-dir', gitdir, '--work-tree', key];
    const add = await _git([...base, 'add', '-A', '--', '.'], { cwd: key });
    if (add.code !== 0) {
      _failedUntil.set(gitdir, Date.now() + FAILURE_BACKOFF_MS);
      return null;
    }
    const tree = await _git([...base, 'write-tree'], { cwd: key });
    if (tree.code !== 0) return null;
    const hash = tree.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
  });
}

/** Fire-and-forget shadow-repo warmup so a project's first turn never pays
 *  the initial full snapshot inline. */
export function prewarmTurnSnapshot(worktree) {
  if (DISABLED || !worktree) return;
  void _trackTree(worktree).catch(() => {});
}

/** Capture the turn base tree for a session. Waits at most BEGIN_WAIT_CAP_MS
 *  so a cold first snapshot cannot stall the turn; a slower capture still
 *  lands through the shared promise and applies to this turn retroactively. */
export async function beginTurnSnapshot(worktree, sessionId) {
  if (DISABLED || !worktree || !sessionId) return;
  const key = _worktreeKey(worktree);
  const capture = _trackTree(worktree).then((tree) => {
    if (!tree) return;
    _baseBySession.delete(sessionId);
    _baseBySession.set(sessionId, { worktree: key, tree, at: Date.now() });
    while (_baseBySession.size > BASE_CACHE_MAX) {
      const oldest = _baseBySession.keys().next().value;
      if (oldest === undefined) break;
      _baseBySession.delete(oldest);
    }
  }).catch(() => {});
  await Promise.race([capture, new Promise((r) => { const t = setTimeout(r, BEGIN_WAIT_CAP_MS); t.unref?.(); })]);
}

/** Diff the session's turn-start tree against the CURRENT worktree state.
 *  Returns { supported, files:[{name, additions, deletions}], patch }. */
export async function getTurnReviewDiff(worktree, sessionId) {
  if (DISABLED) return { supported: false, files: [], patch: '' };
  const key = _worktreeKey(worktree);
  const base = sessionId ? _baseBySession.get(sessionId) : null;
  if (!key) return { supported: false, files: [], patch: '' };
  if (!base || base.worktree !== key) {
    return { supported: true, files: [], patch: '', reason: 'no-base' };
  }
  const head = await _trackTree(worktree);
  if (!head) return { supported: false, files: [], patch: '' };
  if (head === base.tree) return { supported: true, files: [], patch: '', baseTree: base.tree, headTree: head };
  const gitdir = _gitDirFor(key);
  const argsBase = ['--git-dir', gitdir];
  const [numstat, patch] = await Promise.all([
    _git([...argsBase, 'diff-tree', '-r', '--numstat', '-z', base.tree, head]),
    _git([...argsBase, 'diff-tree', '-r', '-p', '--no-color', base.tree, head]),
  ]);
  if (numstat.code !== 0) return { supported: false, files: [], patch: '' };
  const files = [];
  const fields = numstat.stdout.split('\0').filter(Boolean);
  for (const row of fields) {
    const match = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!match) continue;
    files.push({
      name: match[3],
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  let patchText = patch.code === 0 ? patch.stdout : '';
  if (patchText.length > MAX_PATCH_BYTES) {
    patchText = patchText.slice(0, MAX_PATCH_BYTES);
    const cut = patchText.lastIndexOf('\ndiff --git ');
    if (cut > 0) patchText = patchText.slice(0, cut + 1);
  }
  return { supported: true, files, patch: patchText, baseTree: base.tree, headTree: head };
}

export function _resetTurnSnapshotForTest() {
  _queues.clear();
  _baseBySession.clear();
  _failedUntil.clear();
}
