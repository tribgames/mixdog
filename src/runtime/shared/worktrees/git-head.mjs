/**
 * Spawn-free read of a checkout's HEAD: the repository layout (work tree root,
 * git dir, common dir) is found by walking up from a folder to its `.git`
 * (a directory, or a `gitdir:` file for linked worktrees and submodules), and
 * HEAD is the one small file in the git dir. Packed refs never matter: HEAD
 * names a branch (`ref: refs/heads/x`) or holds a commit id.
 */
import { readFileSync, statSync, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalPath } from './paths.mjs';

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
/** Safety net for missed watch events: one shared async stat of each watched HEAD, and non-repo re-checks. */
const SAFETY_POLL_MS = 1000;
/** Minimum age of a "not a repository" answer before a read starts an async re-check. */
const NOT_A_REPO_RECHECK_MS = 1000;
const NO_HEAD = Object.freeze({ branch: null, commit: null });

/** start dir → { topLevel, gitDir, commonDir } for folders inside a checkout. */
const layouts = new Map();
/** start dir → { checkedAt, pending } for a walk that found no repository. */
const notRepos = new Map();
/** git dir → last HEAD read, kept across a half-written HEAD. */
const lastHeads = new Map();
/** git dir → the shared watched state of a repository some watcher holds (see acquireRepo). */
const repos = new Map();
/** Watchers whose folder is outside any repository: the safety poll re-checks them. */
const unrepoWatchers = new Set();

/*
 * The filesystem walks are generators yielding `['read'|'stat', path]`, so one
 * definition runs synchronously (cold fill, strict lookups) or on the libuv
 * threadpool (watch-driven refreshes, re-checks).
 */
function runSync(steps) {
  let step = steps.next();
  while (!step.done) {
    const [op, path] = step.value;
    let value;
    let failed = false;
    try {
      value = op === 'read' ? readFileSync(path, 'utf8') : statSync(path);
    } catch (error) {
      failed = true;
      value = error;
    }
    step = failed ? steps.throw(value) : steps.next(value);
  }
  return step.value;
}

async function runAsync(steps) {
  let step = steps.next();
  while (!step.done) {
    const [op, path] = step.value;
    let value;
    let failed = false;
    try {
      value = await (op === 'read' ? readFile(path, 'utf8') : stat(path));
    } catch (error) {
      failed = true;
      value = error;
    }
    step = failed ? steps.throw(value) : steps.next(value);
  }
  return step.value;
}

function* readText(path, strict = false) {
  try {
    return yield ['read', path];
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    return null;
  }
}

function* isDirectory(path, strict = false) {
  try {
    return (yield ['stat', path]).isDirectory();
  } catch (error) {
    if (strict && !['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    return false;
  }
}

function* isFile(path, strict = false) {
  try {
    return (yield ['stat', path]).isFile();
  } catch (error) {
    if (strict && !['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    return false;
  }
}

const GIT_LAYOUT_ENTRIES = ['objects', 'refs', 'config', 'commondir', 'packed-refs', 'index'];

/** True when a `.git` directory holds any entry git itself would create. Permission errors propagate. */
function* hasGitLayout(dotGit) {
  for (const name of GIT_LAYOUT_ENTRIES) {
    try {
      yield ['stat', resolve(dotGit, name)];
      return true;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
  }
  return false;
}

function* layoutAbove(start, strict = false) {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = resolve(dir, '.git');
    let gitDir = null;
    if (yield* isDirectory(dotGit, strict)) {
      gitDir = dotGit;
    } else if (yield* isFile(dotGit, strict)) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((yield* readText(dotGit, strict)) ?? '');
      if (strict && !pointer) throw new Error(`Cannot inspect Git directory: ${dotGit}`);
      if (pointer) gitDir = resolve(dir, pointer[1]);
    }
    if (gitDir && strict && !(yield* isFile(resolve(gitDir, 'HEAD'), true))) {
      // A directory with none of git's layout is a stray folder, not a damaged repo.
      if (gitDir !== dotGit || (yield* hasGitLayout(gitDir))) throw new Error(`Cannot inspect Git HEAD: ${gitDir}`);
      gitDir = null;
    }
    if (gitDir && (yield* isFile(resolve(gitDir, 'HEAD'), strict))) {
      const common = (yield* readText(resolve(gitDir, 'commondir'), strict))?.trim();
      return {
        topLevel: canonicalPath(dir),
        gitDir,
        commonDir: canonicalPath(common ? resolve(gitDir, common) : gitDir),
      };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** A watched repository's HEAD stands for its layout: the watch and safety poll drop it when HEAD goes. */
function watchedRepo(gitDir) {
  const entry = repos.get(gitDir);
  return entry && !entry.closed ? entry : null;
}

/**
 * Re-walks a folder that held no repository, on the threadpool. Resolves the
 * layout once one appears there, else null. `minAgeMs` throttles re-checks.
 */
function recheckNotRepo(start, minAgeMs = NOT_A_REPO_RECHECK_MS) {
  const miss = notRepos.get(start);
  if (!miss) return Promise.resolve(layouts.get(start) ?? null);
  if (miss.pending) return miss.pending;
  if (Date.now() - miss.checkedAt < minAgeMs) return Promise.resolve(null);
  miss.pending = runAsync(layoutAbove(start))
    .catch(() => null)
    .then((found) => {
      miss.pending = null;
      miss.checkedAt = Date.now();
      if (!found || notRepos.get(start) !== miss) return null;
      notRepos.delete(start);
      layouts.set(start, found);
      return found;
    });
  return miss.pending;
}

/**
 * The checkout layout containing `cwd`, or null outside a repository. Strict
 * lookups always walk; the cached one walks once per folder: a watched
 * repository's layout is trusted with no fs access, and a folder outside any
 * repository answers null while it is re-checked asynchronously.
 */
export function findGitLayout(cwd, { strict = false } = {}) {
  const start = resolve(String(cwd || '.'));
  if (strict) {
    return runSync(layoutAbove(start, true));
  }
  const known = layouts.get(start);
  if (known && (watchedRepo(known.gitDir) || runSync(isFile(resolve(known.gitDir, 'HEAD'))))) return known;
  layouts.delete(start);
  if (notRepos.has(start)) {
    void recheckNotRepo(start);
    return null;
  }
  const found = runSync(layoutAbove(start));
  if (!found) {
    notRepos.set(start, { checkedAt: Date.now(), pending: null });
    return null;
  }
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
function* followHead(layout, text) {
  const files = [resolve(layout.gitDir, 'HEAD')];
  let name = /^ref:\s*(.+)$/.exec(text)?.[1].trim();
  const seen = new Set();
  for (let depth = 0; name && depth < MAX_SYMREF_DEPTH; depth++) {
    if (seen.has(name)) return { name: null, files };
    seen.add(name);
    const file = refFile(layout, name);
    files.push(file);
    const next = /^ref:\s*(.+)$/.exec((yield* readText(file))?.trim() ?? '')?.[1].trim();
    if (!next) return { name, files };
    name = next;
  }
  return { name: null, files };
}

/**
 * The stat fingerprint of every file in a resolved chain (a missing file
 * reads as `-`): any change to HEAD or a symref it passes through changes it.
 * A published commit lives in HEAD itself (detached), so the final ref's
 * commit and packed-refs never matter.
 */
function* chainSignature(files) {
  const parts = [];
  for (const file of files) {
    try {
      const stats = yield ['stat', file];
      parts.push(`${file}=${stats.ino}:${stats.size}:${stats.mtimeMs}`);
    } catch {
      parts.push(`${file}=-`);
    }
  }
  return parts.join('\n');
}

/**
 * One read of HEAD: `{ gone }` when HEAD no longer exists, else the resolved
 * `head` and the symref chain `files` — both null for a half-written HEAD, so
 * the caller keeps its last answer.
 */
function* readHead(layout) {
  const path = resolve(layout.gitDir, 'HEAD');
  try {
    yield ['stat', path];
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return { gone: true };
  }
  const text = (yield* readText(path))?.trim();
  if (text && /^ref:\s*(.+)$/.test(text)) {
    const { name, files } = yield* followHead(layout, text);
    const branch = name?.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : null;
    return { gone: false, head: { branch, commit: null }, files };
  }
  if (text && OBJECT_ID.test(text)) {
    return { gone: false, head: { branch: null, commit: text.toLowerCase() }, files: [path] };
  }
  return { gone: false, head: null, files: null };
}

/**
 * What `cwd`'s checkout has checked out: `{ topLevel, gitDir, repoCommonDir,
 * branch, commit }` (`branch` null when detached or when the symbolic-ref
 * chain is broken, `commit` null on a branch), or null when `cwd` is not
 * inside a git repository. A branch alias resolves to the branch it points at.
 * A repository some watcher holds is answered from its watch-maintained cache
 * with no fs access; any other is read now.
 */
export function readGitHead(cwd) {
  const layout = findGitLayout(cwd);
  if (!layout) return null;
  let head = watchedRepo(layout.gitDir) ? lastHeads.get(layout.gitDir) : null;
  if (!head) {
    head = runSync(readHead(layout)).head ?? lastHeads.get(layout.gitDir) ?? NO_HEAD;
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
 * The process-wide registry: one entry per git dir any watcher holds, shared
 * by every session in that checkout — its layout, the cached HEAD (lastHeads),
 * the symref chain files, one fs.watch set, a ref count and the subscribers
 * told when the resolved HEAD changes or the repository goes away.
 */
let safetyPoll = null;

function syncSafetyPoll() {
  const needed = repos.size > 0 || unrepoWatchers.size > 0;
  if (needed && !safetyPoll) {
    safetyPoll = setInterval(pollOnce, SAFETY_POLL_MS);
    safetyPoll.unref?.();
  } else if (!needed && safetyPoll) {
    clearInterval(safetyPoll);
    safetyPoll = null;
  }
}

/**
 * Async stats of every file in each watched chain — HEAD and each symref it
 * passes through, so a missed event or a failed or missing directory watch
 * is still caught — refreshing on any difference; one async walk per
 * non-repo folder. The poll owns `signature`: a change landing during a
 * refresh differs on the next tick.
 */
function pollOnce() {
  for (const entry of repos.values()) {
    if (entry.refreshing || entry.polling) continue;
    entry.polling = true;
    void runAsync(chainSignature(entry.files)).then((signature) => {
      entry.polling = false;
      if (signature === entry.signature) return;
      entry.signature = signature;
      void refreshRepo(entry);
    });
  }
  const starts = new Set([...unrepoWatchers].map((watcher) => watcher.target()));
  for (const start of starts) {
    void recheckNotRepo(start, 0).then((found) => {
      if (!found) return;
      for (const watcher of [...unrepoWatchers]) if (watcher.target() === start) watcher.found();
    });
  }
}

function closeChainWatch(entry) {
  for (const watcher of entry.watchers) watcher.close();
  entry.watchers = [];
  entry.watchKey = '';
}

/**
 * Watches the directories of HEAD and every symbolic ref it passes through
 * (a change anywhere in that chain can change the branch). Directories, not
 * files: git replaces HEAD and refs by renaming `<name>.lock` over them.
 */
function watchChain(entry, files) {
  const key = files.join('\n');
  if (entry.closed || key === entry.watchKey) return;
  closeChainWatch(entry);
  entry.watchKey = key;
  entry.files = files;
  for (const dir of new Set(files.map((file) => dirname(file)))) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (name && !entry.files.includes(resolve(dir, String(name)))) return;
        void refreshRepo(entry);
      });
      watcher.on('error', () => {
        watcher.close();
        entry.watchers = entry.watchers.filter((w) => w !== watcher);
        entry.watchKey = '';
        void refreshRepo(entry);
      });
      entry.watchers.push(watcher);
    } catch {
      // A chain directory that does not exist (an unborn target) is not watched.
    }
  }
}

/** Drops a repository whose HEAD vanished; its subscribers re-resolve their folders. */
function dropRepo(entry) {
  entry.gone = true;
  entry.closed = true;
  closeChainWatch(entry);
  if (repos.get(entry.layout.gitDir) === entry) repos.delete(entry.layout.gitDir);
  lastHeads.delete(entry.layout.gitDir);
  for (const [start, layout] of layouts) if (layout.gitDir === entry.layout.gitDir) layouts.delete(start);
  syncSafetyPoll();
}

function applyRead(entry, read) {
  if (read.gone) {
    dropRepo(entry);
    return true;
  }
  if (read.files) watchChain(entry, read.files);
  if (!read.head || isDeepStrictEqual(read.head, lastHeads.get(entry.layout.gitDir))) return false;
  lastHeads.set(entry.layout.gitDir, read.head);
  return true;
}

/** Async re-read of HEAD; one in flight per repository, re-run once when asked again meanwhile. */
function refreshRepo(entry) {
  if (entry.closed) return Promise.resolve();
  if (entry.refreshing) {
    entry.dirty = true;
    return entry.refreshing;
  }
  entry.refreshing = (async () => {
    let changed = false;
    do {
      entry.dirty = false;
      const read = await runAsync(readHead(entry.layout));
      // Released or dropped while the read was in flight: its result opens and publishes nothing.
      if (entry.closed) return;
      changed = applyRead(entry, read) || changed;
    } while (entry.dirty && !entry.closed);
    if (changed) for (const subscriber of [...entry.subscribers]) subscriber();
  })().finally(() => {
    entry.refreshing = null;
  });
  return entry.refreshing;
}

/** Joins (or creates, with one sync cold read) the shared entry of `layout`'s repository. */
function acquireRepo(layout) {
  let entry = watchedRepo(layout.gitDir);
  if (!entry) {
    entry = {
      layout,
      files: [],
      watchers: [],
      watchKey: '',
      refs: 0,
      subscribers: new Set(),
      signature: null,
      polling: false,
      refreshing: null,
      dirty: false,
      // HEAD vanished (subscribers re-resolve); closed: dropped or released — never reopened.
      gone: false,
      closed: false,
    };
    const read = runSync(readHead(layout));
    lastHeads.set(layout.gitDir, read.head ?? lastHeads.get(layout.gitDir) ?? NO_HEAD);
    const files = read.files ?? [resolve(layout.gitDir, 'HEAD')];
    entry.signature = runSync(chainSignature(files));
    repos.set(layout.gitDir, entry);
    watchChain(entry, files);
    syncSafetyPoll();
  }
  entry.refs++;
  return entry;
}

function releaseRepo(entry) {
  entry.refs--;
  if (entry.refs > 0 || entry.closed) return;
  entry.closed = true;
  closeChainWatch(entry);
  repos.delete(entry.layout.gitDir);
  syncSafetyPoll();
}

/**
 * Calls `onChange` shortly after the HEAD of the checkout `getCwd()` names
 * changes (a `git switch` from any terminal). Call `retarget()` when the
 * session's folder may have moved: it re-resolves only when that folder
 * differs. `dispose()` releases the watch.
 */
export function createGitHeadWatcher({ getCwd, onChange, debounceMs = 40 }) {
  let target = null;
  let entry = null;
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
  const handle = {
    target: () => target,
    found: () => {
      attach(target);
      notify();
    },
  };
  const detach = () => {
    if (entry) {
      entry.subscribers.delete(subscriber);
      releaseRepo(entry);
      entry = null;
    }
    unrepoWatchers.delete(handle);
  };
  function attach(start) {
    detach();
    target = start;
    const layout = findGitLayout(start);
    if (layout) {
      entry = acquireRepo(layout);
      entry.subscribers.add(subscriber);
    } else {
      unrepoWatchers.add(handle);
    }
    syncSafetyPoll();
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
      syncSafetyPoll();
    },
  };
}
