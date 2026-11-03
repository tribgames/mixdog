/**
 * Spawn-free read of a checkout's HEAD: the repository layout (work tree root,
 * git dir, common dir) is found by walking up from a folder to its `.git`
 * (a directory, or a `gitdir:` file for linked worktrees and submodules), and
 * HEAD is the one small file in the git dir. Packed refs never matter: HEAD
 * names a branch (`ref: refs/heads/x`) or holds a commit id.
 *
 * A session's watcher holds, through the shared watched-file cache, exactly
 * the files its answer was read from: HEAD and every symbolic ref it passes
 * through for a repository, or each `.git` the layout walk looked for above a
 * folder outside any repository. Their change events alone refresh the
 * answer; nothing re-reads on a clock. A filesystem that delivers no events
 * is the watched-file cache's to handle, for that path only.
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createWatchedFileCache, fileStamp, fileStampSync } from '../watched-file-cache.mjs';
import { canonicalPath } from './paths.mjs';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const NO_HEAD = Object.freeze({ branch: null, commit: null });

/** start dir → { topLevel, gitDir, commonDir } for folders inside a checkout. */
const layouts = new Map();
/** start dir → watchers holding it as "not a repository" (kept so until a `.git` they watch changes). */
const notRepos = new Map();
/** git dir → last HEAD read, kept across a half-written HEAD. */
const lastHeads = new Map();
/** git dir → the shared watched state of a repository some watcher holds (see acquireRepo). */
const repos = new Map();

function readText(path, strict = false) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    return null;
  }
}

function isDirectory(path, strict = false) {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (strict && !['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    return false;
  }
}

function isFile(path, strict = false) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (strict && !['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    return false;
  }
}

const GIT_LAYOUT_ENTRIES = ['objects', 'refs', 'config', 'commondir', 'packed-refs', 'index'];

/** True when a `.git` directory holds any entry git itself would create. Permission errors propagate. */
function hasGitLayout(dotGit) {
  return GIT_LAYOUT_ENTRIES.some((name) => {
    try {
      statSync(resolve(dotGit, name));
      return true;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      return false;
    }
  });
}

function layoutAbove(start, strict = false) {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = resolve(dir, '.git');
    let gitDir = null;
    if (isDirectory(dotGit, strict)) {
      gitDir = dotGit;
    } else if (isFile(dotGit, strict)) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit, strict) ?? '');
      if (strict && !pointer) throw new Error(`Cannot inspect Git directory: ${dotGit}`);
      if (pointer) gitDir = resolve(dir, pointer[1]);
    }
    if (gitDir && strict && !isFile(resolve(gitDir, 'HEAD'), true)) {
      // A directory with none of git's layout is a stray folder, not a damaged repo.
      if (gitDir !== dotGit || hasGitLayout(gitDir)) throw new Error(`Cannot inspect Git HEAD: ${gitDir}`);
      gitDir = null;
    }
    if (gitDir && isFile(resolve(gitDir, 'HEAD'), strict)) {
      const common = readText(resolve(gitDir, 'commondir'), strict)?.trim();
      return {
        topLevel: canonicalPath(dir),
        gitDir,
        commonDir: canonicalPath(common ? resolve(gitDir, common) : gitDir),
      };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Every `.git` the walk from `start` looks for, nearest first. */
function dotGitsAbove(start) {
  const paths = [];
  for (let dir = start; ; dir = dirname(dir)) {
    paths.push(resolve(dir, '.git'));
    if (dirname(dir) === dir) return paths;
  }
}

/**
 * The checkout layout containing `cwd`, or null outside a repository. Strict
 * lookups always walk; the cached one walks once per folder: a watched
 * repository's layout is trusted with no fs access, and a folder a watcher
 * holds as outside any repository answers null with none.
 */
export function findGitLayout(cwd, { strict = false } = {}) {
  const start = resolve(String(cwd || '.'));
  if (strict) return layoutAbove(start, true);
  const known = layouts.get(start);
  if (known && (repos.has(known.gitDir) || isFile(resolve(known.gitDir, 'HEAD')))) return known;
  layouts.delete(start);
  if (notRepos.has(start)) return null;
  const found = layoutAbove(start);
  if (found) layouts.set(start, found);
  return found;
}

const MAX_SYMREF_DEPTH = 5;
const PER_WORKTREE_REFS = /^refs\/(?:bisect|worktree|rewritten)\//;
const SYMREF = /^ref:\s*(.+)$/;

/** Where a ref's loose file lives: per-worktree refs in the git dir, the rest in the common dir. */
function refFile(layout, name) {
  return resolve(PER_WORKTREE_REFS.test(name) ? layout.gitDir : layout.commonDir, name);
}

/**
 * Follows HEAD's symbolic refs like git does (packed-refs never holds a
 * symref, so only loose ref files are read through `read`). Returns
 * `{ name, files }`: the ref HEAD finally resolves to (the first non-symbolic
 * ref, or the first missing target: an unborn branch) and every file read
 * along the chain, or `{ name: null, files }` for a cycle or a chain over the
 * depth limit.
 */
function followHead(layout, text, read) {
  const files = [resolve(layout.gitDir, 'HEAD')];
  let name = SYMREF.exec(text)?.[1].trim();
  const seen = new Set();
  for (let depth = 0; name && depth < MAX_SYMREF_DEPTH; depth++) {
    if (seen.has(name)) return { name: null, files };
    seen.add(name);
    const file = refFile(layout, name);
    files.push(file);
    const next = SYMREF.exec(read(file)?.trim() ?? '')?.[1].trim();
    if (!next) return { name, files };
    name = next;
  }
  return { name: null, files };
}

/**
 * One read of HEAD through `read`: the resolved `head` and the symref chain
 * `files` — both null for a missing or half-written HEAD, so the caller keeps
 * its last answer.
 */
function readHead(layout, read = readText) {
  const path = resolve(layout.gitDir, 'HEAD');
  const text = read(path)?.trim();
  if (text && SYMREF.test(text)) {
    const { name, files } = followHead(layout, text, read);
    const branch = name?.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : null;
    return { head: { branch, commit: null }, files };
  }
  if (text && OBJECT_ID.test(text)) return { head: { branch: null, commit: text.toLowerCase() }, files: [path] };
  return { head: null, files: null };
}

/**
 * What `cwd`'s checkout has checked out: `{ topLevel, gitDir, repoCommonDir,
 * branch, commit }` (`branch` null when detached or when the symbolic-ref
 * chain is broken, `commit` null on a branch), or null when `cwd` is not
 * inside a git repository. A branch alias resolves to the branch it points at.
 * A repository some watcher holds is answered from its event-maintained cache
 * with no fs access; any other is read now.
 */
export function readGitHead(cwd) {
  const layout = findGitLayout(cwd);
  if (!layout) return null;
  let head = repos.get(layout.gitDir)?.head;
  if (!head) {
    head = readHead(layout).head ?? lastHeads.get(layout.gitDir) ?? NO_HEAD;
    lastHeads.set(layout.gitDir, head);
  }
  return {
    topLevel: layout.topLevel,
    gitDir: layout.gitDir,
    repoCommonDir: layout.commonDir,
    branch: head.branch,
    commit: head.commit,
  };
}

/*
 * The held files: one watched-file cache entry per path some watcher reads,
 * with the listeners told when its value changes. A value is the file's text,
 * '' for a directory (a `.git` folder) and null when missing, so a `.git`
 * appearing is a change too.
 */
const listeners = new Map();
const held = createWatchedFileCache(
  {
    load(path) {
      const stamp = fileStampSync(path);
      if (stamp === 'missing') return { value: null, stamp };
      try {
        return { value: readFileSync(path, 'utf8'), stamp };
      } catch (error) {
        if (error?.code === 'EISDIR') return { value: '', stamp };
        if (error?.code === 'ENOENT') return { value: null, stamp: 'missing' };
        throw error;
      }
    },
    async loadAsync(path) {
      const stamp = await fileStamp(path);
      if (stamp === null) throw new Error(`Cannot stat ${path}`);
      if (stamp === 'missing') return { value: null, stamp };
      try {
        return { value: await readFile(path, 'utf8'), stamp };
      } catch (error) {
        if (error?.code === 'EISDIR') return { value: '', stamp };
        if (error?.code === 'ENOENT') return { value: null, stamp: 'missing' };
        throw error;
      }
    },
  },
  {
    onChange: (path) => {
      for (const listener of [...(listeners.get(path) ?? [])]) listener();
    },
  }
);

/** A held file's text (null when missing or unreadable); warm reads touch no fs. */
function readHeld(path) {
  try {
    return held.get(path);
  } catch {
    return null;
  }
}

function hold(path, listener) {
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
    readHeld(path);
  }
  set.add(listener);
}

function unhold(path, listener) {
  const set = listeners.get(path);
  if (!set?.delete(listener) || set.size) return;
  listeners.delete(path);
  held.delete(path);
}

/** Holds exactly `paths` for `entry` (HEAD and its symref chain). */
function holdChain(entry, paths) {
  const next = new Set(paths);
  for (const path of entry.files) if (!next.has(path)) unhold(path, entry.listener);
  for (const path of next) if (!entry.files.includes(path)) hold(path, entry.listener);
  entry.files = [...next];
}

/** Drops a repository whose HEAD vanished; its subscribers re-resolve their folders. */
function dropRepo(entry) {
  entry.gone = true;
  closeRepo(entry);
  lastHeads.delete(entry.layout.gitDir);
  for (const [start, layout] of layouts) if (layout.gitDir === entry.layout.gitDir) layouts.delete(start);
  for (const subscriber of [...entry.subscribers]) subscriber();
}

function closeRepo(entry) {
  entry.closed = true;
  holdChain(entry, []);
  if (repos.get(entry.layout.gitDir) === entry) repos.delete(entry.layout.gitDir);
}

/** Re-reads HEAD after a held file changed: once per burst (a microtask), publishing only a different answer. */
function refreshRepo(entry) {
  if (entry.closed || entry.queued) return;
  entry.queued = true;
  queueMicrotask(() => {
    entry.queued = false;
    if (entry.closed) return;
    if (!isFile(resolve(entry.layout.gitDir, 'HEAD'))) {
      dropRepo(entry);
      return;
    }
    const read = readHead(entry.layout, readHeld);
    if (read.files) holdChain(entry, read.files);
    if (!read.head || isDeepStrictEqual(read.head, entry.head)) return;
    entry.head = read.head;
    lastHeads.set(entry.layout.gitDir, read.head);
    for (const subscriber of [...entry.subscribers]) subscriber();
  });
}

/** Joins (or creates, with one cold read) the shared entry of `layout`'s repository. */
function acquireRepo(layout) {
  let entry = repos.get(layout.gitDir);
  if (!entry) {
    // gone: HEAD vanished (subscribers re-resolve); closed: dropped or released — never reopened.
    entry = { layout, head: null, files: [], refs: 0, subscribers: new Set(), queued: false, gone: false, closed: false };
    entry.listener = () => refreshRepo(entry);
    const read = readHead(layout, readHeld);
    entry.head = read.head ?? lastHeads.get(layout.gitDir) ?? NO_HEAD;
    lastHeads.set(layout.gitDir, entry.head);
    repos.set(layout.gitDir, entry);
    holdChain(entry, read.files ?? [resolve(layout.gitDir, 'HEAD')]);
  }
  entry.refs++;
  return entry;
}

function releaseRepo(entry) {
  entry.refs--;
  if (entry.refs > 0 || entry.closed) return;
  closeRepo(entry);
}

/**
 * Calls `onChange` shortly after the HEAD of the checkout `getCwd()` names
 * changes (a `git switch` from any terminal), or after a repository appears
 * around a folder that had none. Call `retarget()` when the session's folder
 * may have moved: it re-resolves only when that folder differs. `dispose()`
 * releases the watch.
 */
export function createGitHeadWatcher({ getCwd, onChange, debounceMs = 40 }) {
  let target = null;
  let entry = null;
  let dotGits = [];
  let timer = null;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
    timer.unref?.();
  };
  const subscriber = () => {
    if (entry?.gone) attach(target);
    notify();
  };
  // A `.git` above a folder outside any repository changed: walk again.
  const found = () => {
    const layout = layoutAbove(target);
    if (!layout) return;
    layouts.set(target, layout);
    attach(target);
    notify();
  };
  const detach = () => {
    if (entry) {
      entry.subscribers.delete(subscriber);
      releaseRepo(entry);
      entry = null;
    }
    if (dotGits.length) {
      for (const path of dotGits) unhold(path, found);
      dotGits = [];
      const count = (notRepos.get(target) ?? 1) - 1;
      if (count > 0) notRepos.set(target, count);
      else notRepos.delete(target);
    }
  };
  function attach(start) {
    detach();
    target = start;
    const layout = findGitLayout(start);
    if (layout) {
      entry = acquireRepo(layout);
      entry.subscribers.add(subscriber);
      return;
    }
    notRepos.set(start, (notRepos.get(start) ?? 0) + 1);
    dotGits = dotGitsAbove(start);
    for (const path of dotGits) hold(path, found);
  }
  return {
    retarget() {
      const start = resolve(String(getCwd() || '.'));
      if (start === target && !entry?.gone) return;
      attach(start);
    },
    dispose() {
      clearTimeout(timer);
      detach();
      target = null;
    },
  };
}
