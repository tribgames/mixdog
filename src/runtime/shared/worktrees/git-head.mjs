/**
 * Spawn-free read of a checkout's HEAD: the repository layout (work tree root,
 * git dir, common dir) is found by walking up from a folder to its `.git`
 * (a directory, or a `gitdir:` file for linked worktrees and submodules), and
 * HEAD is the one small file in the git dir. Packed refs never matter: HEAD
 * names a branch (`ref: refs/heads/x`) or holds a commit id.
 */
import { readFileSync, statSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalPath } from './paths.mjs';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const NOT_A_REPO_TTL_MS = 1000;

/** start dir → { topLevel, gitDir, commonDir } for folders inside a checkout. */
const layouts = new Map();
/** start dir → time a walk found no repository. */
const notRepos = new Map();
/** git dir → last HEAD read, kept across a half-written HEAD. */
const lastHeads = new Map();

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function layoutAbove(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = resolve(dir, '.git');
    let gitDir = null;
    if (isDirectory(dotGit)) {
      gitDir = dotGit;
    } else if (isFile(dotGit)) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
      if (pointer) gitDir = resolve(dir, pointer[1]);
    }
    if (gitDir && isFile(resolve(gitDir, 'HEAD'))) {
      const common = readText(resolve(gitDir, 'commondir'))?.trim();
      return {
        topLevel: canonicalPath(dir),
        gitDir,
        commonDir: canonicalPath(common ? resolve(gitDir, common) : gitDir),
      };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The checkout layout containing `cwd`, or null outside a repository. */
export function findGitLayout(cwd) {
  const start = resolve(String(cwd || '.'));
  const known = layouts.get(start);
  if (known && isFile(resolve(known.gitDir, 'HEAD'))) return known;
  layouts.delete(start);
  const missedAt = notRepos.get(start);
  if (missedAt !== undefined && Date.now() - missedAt < NOT_A_REPO_TTL_MS) return null;
  const found = layoutAbove(start);
  if (!found) {
    notRepos.set(start, Date.now());
    return null;
  }
  notRepos.delete(start);
  layouts.set(start, found);
  return found;
}

const MAX_SYMREF_DEPTH = 5;
const PER_WORKTREE_REFS = /^refs\/(?:bisect|worktree|rewritten)\//;

/** Where a ref's loose file lives: per-worktree refs in the git dir, the rest in the common dir. */
function refFile(layout, name) {
  return resolve(PER_WORKTREE_REFS.test(name) ? layout.gitDir : layout.commonDir, name);
}

/**
 * Follows HEAD's symbolic refs like git does (packed-refs never holds a
 * symref, so only loose ref files are read). Returns `{ name, files }`: the
 * ref HEAD finally resolves to (the first non-symbolic ref, or the first
 * missing target: an unborn branch) and every file read along the chain, or
 * `{ name: null, files }` for a cycle or a chain over the depth limit.
 */
function followHead(layout, text) {
  const files = [resolve(layout.gitDir, 'HEAD')];
  let name = /^ref:\s*(.+)$/.exec(text)?.[1].trim();
  const seen = new Set();
  for (let depth = 0; name && depth < MAX_SYMREF_DEPTH; depth++) {
    if (seen.has(name)) return { name: null, files };
    seen.add(name);
    const file = refFile(layout, name);
    files.push(file);
    const next = /^ref:\s*(.+)$/.exec(readText(file)?.trim() ?? '')?.[1].trim();
    if (!next) return { name, files };
    name = next;
  }
  return { name: null, files };
}

/** Files whose change can change what `gitDir`'s HEAD resolves to. */
function headChainFiles(layout) {
  const text = readText(resolve(layout.gitDir, 'HEAD'))?.trim();
  return text && /^ref:/.test(text) ? followHead(layout, text).files : [resolve(layout.gitDir, 'HEAD')];
}

/**
 * What `cwd`'s checkout has checked out: `{ topLevel, gitDir, repoCommonDir,
 * branch, commit }` (`branch` null when detached or when the symbolic-ref
 * chain is broken, `commit` null on a branch), or null when `cwd` is not
 * inside a git repository. A branch alias resolves to the branch it points at.
 */
export function readGitHead(cwd) {
  const layout = findGitLayout(cwd);
  if (!layout) return null;
  const text = readText(resolve(layout.gitDir, 'HEAD'))?.trim();
  let head = lastHeads.get(layout.gitDir) ?? { branch: null, commit: null };
  if (text && /^ref:\s*(.+)$/.test(text)) {
    const { name } = followHead(layout, text);
    head = { branch: name?.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : null, commit: null };
  } else if (text && OBJECT_ID.test(text)) {
    head = { branch: null, commit: text.toLowerCase() };
  }
  lastHeads.set(layout.gitDir, head);
  return {
    topLevel: layout.topLevel,
    gitDir: layout.gitDir,
    repoCommonDir: layout.commonDir,
    branch: head.branch,
    commit: head.commit,
  };
}

/**
 * Calls `onChange` shortly after the HEAD of the checkout `getCwd()` names
 * changes (a `git switch` from any terminal). Call `retarget()` whenever the
 * folder may have changed; `dispose()` ends the watch.
 */
export function createGitHeadWatcher({ getCwd, onChange, debounceMs = 40 }) {
  let target = '';
  let watchers = [];
  let timer = null;
  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
    timer.unref?.();
  };
  const retarget = () => {
    const layout = findGitLayout(getCwd());
    // HEAD and every symbolic ref it passes through: a change anywhere in
    // that chain can change the branch.
    const files = layout ? headChainFiles(layout) : [];
    const key = files.join('\n');
    if (key === target) return;
    closeWatchers();
    target = key;
    // The directories, not the files: git replaces a ref by renaming <ref>.lock.
    const dirs = [...new Set(files.map((file) => dirname(file)))];
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          if (name && !files.includes(resolve(dir, String(name)))) return;
          retarget();
          notify();
        });
        watcher.on('error', () => {
          watcher.close();
          watchers = watchers.filter((w) => w !== watcher);
          target = '';
        });
        watchers.push(watcher);
      } catch {
        // A chain directory that does not exist (an unborn target) is not watched.
      }
    }
  };
  return {
    retarget,
    dispose() {
      clearTimeout(timer);
      closeWatchers();
      target = '';
    },
  };
}
