import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PATCH_EDIT_MAX_BYTES } from './bounded-file-read.mjs';
import { cleanString as clean } from './clean.mjs';
import { runGitOffThread } from './git-runner.mjs';
import { resolvePluginData } from './plugin-paths.mjs';
import {
  createReviewPatchBudget,
  PATCH_TOO_LARGE,
  patchOmittedFile,
  REVIEW_FILE_PATCH_MAX_BYTES,
  REVIEW_PATCH_MAX_BYTES,
  reviewDiffTooLarge,
} from './review-diff.mjs';
import { splitPatchSections } from './turn-changes.mjs';

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BYTES = 8 * 1024 * 1024;
// Room for git's diagnostics beside a patch read up to its byte cap.
const PATCH_OUTPUT_SLACK_BYTES = 64 * 1024;
// Paths per patch read once the whole range overflowed (bounded command line).
const PATCH_BATCH_FILES = 32;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
// Largest tool-supplied baseline kept for `hash-object`: the apply_patch edit
// limit. (2–64 MiB explicit untracked edits keep their exact revert.)
const MAX_TOOL_BASELINE_BYTES = PATCH_EDIT_MAX_BYTES;
// Baselines live with the runtime data, not the OS temp directory, where a
// reboot or a disk cleaner could remove the only copy of a turn's revert source.
// Resolved per call: the pristine-execution boundary retargets MIXDOG_DATA_DIR.
function snapshotRoot() {
  return join(resolvePluginData(), 'turn-worktree-snapshots-v1');
}
// A baseline tree is unreachable by design (no commit, no ref), so collection
// is what bounds how long a review stays revertible.
const SHADOW_GC_PRUNE = '7.days.ago';
// A review poll with no change signal since the last capture reuses it for
// this long, so the review bar's timer polls stop re-running git. Writes no
// signal reports (an external editor, a command the shell classifies
// read-only) still show within this gap.
const MIN_RECAPTURE_GAP_MS = 15_000;
const states = new Map();

function pathKey(value) {
  const text = clean(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/** `resolve` plus symlinks of the nearest existing ancestor: git reports the
 *  worktree root canonically (macOS /var -> /private/var), callers may not. */
export function canonicalPath(value, dirs = null) {
  const full = resolve(value);
  if (dirs) {
    // Same result as the walk below without repeating it per file: the parent
    // directory is canonicalized once per call; the final component only
    // matters when it is itself a link (or its state is unknown).
    const parent = dirname(full);
    if (parent !== full) {
      let canonicalParent = dirs.get(parent);
      if (canonicalParent === undefined) {
        canonicalParent = canonicalPath(parent);
        dirs.set(parent, canonicalParent);
      }
      try {
        if (!lstatSync(full).isSymbolicLink()) return join(canonicalParent, basename(full));
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return join(canonicalParent, basename(full));
      }
    }
  }
  let head = full;
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return full;
    head = parent;
  }
  return join(realpathSync(head), relative(head, full));
}

/** Non-empty entries of a NUL-separated git output list. */
function splitNulList(text) {
  return String(text ?? '')
    .split('\0')
    .map((value) => value.trim())
    .filter(Boolean);
}

function commandError(args, stderr, code) {
  const error = new Error(`git ${args.join(' ')} failed (${code}): ${clean(stderr) || 'no diagnostic'}`);
  error.code = code;
  return error;
}

// Every git child is spawned from the shared git-runner worker thread: a turn
// runs several git commands, and process creation is a synchronous native
// call that would otherwise stall the event loop each time.
async function runGit(
  args,
  {
    cwd,
    input = '',
    timeoutMs = COMMAND_TIMEOUT_MS,
    maxBytes = COMMAND_MAX_BYTES,
    allowFailure = false,
    stdoutEncoding = 'utf8',
  } = {}
) {
  const result = await runGitOffThread(args, { cwd, input, timeoutMs, maxBytes, stdoutEncoding });
  if (result.code !== 0 && !allowFailure) throw commandError(args, result.stderr, result.code);
  return result;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function repositoryRoot(worktree) {
  const cwd = resolve(clean(worktree) || process.cwd());
  const result = await runGit(['rev-parse', '--show-toplevel'], { cwd, allowFailure: true });
  if (result.code !== 0) return null;
  const root = clean(result.stdout);
  return root ? resolve(root) : null;
}

function shadowDirForKey(key) {
  return join(snapshotRoot(), createHash('sha256').update(key).digest('hex').slice(0, 24));
}

function stateForRoot(root) {
  const key = pathKey(root);
  let state = states.get(key);
  const gitDir = shadowDirForKey(key);
  if (state && state.gitDir === gitDir) return state;
  state = {
    root,
    gitDir,
    initialized: false,
    sourceIndexPath: null,
    sourceIndexIdentity: null,
    sourceTracked: new Set(),
    lineEndingArgs: [],
    lock: Promise.resolve(),
    // Bumped by every reported write under `root`; a capture records the
    // value it started from.
    changeStamp: 0,
    // Set by forgetTurnWorktreeRoot(): the shadow repository must never be
    // recreated for this state. A later snapshot of the same path gets a new one.
    forgotten: false,
    gcTimer: null,
    gcRun: null,
  };
  states.set(key, state);
  return state;
}

/** Report written paths (or `null`: anything may have changed). The next
 *  review poll of an affected worktree captures instead of reusing. */
export function noteTurnWorktreeChange(paths = null) {
  if (states.size === 0) return;
  const list = Array.isArray(paths) ? paths.filter((value) => clean(value)) : [];
  const dirs = new Map();
  const keys = list.map((value) => pathKey(canonicalPath(value, dirs)));
  for (const state of states.values()) {
    const root = pathKey(state.root);
    if (keys.length === 0 || keys.some((key) => key === root || key.startsWith(`${root}/`))) {
      state.changeStamp += 1;
    }
  }
}

// A lock hold (queue wait plus work) at least this long is logged, so a slow
// review bar can be told apart as waiting behind other captures or slow git.
const SLOW_LOCK_LOG_MS = 1_000;

function withStateLock(state, task, op = 'task') {
  const queuedAt = Date.now();
  const queuedBehind = state.lockDepth || 0;
  state.lockDepth = queuedBehind + 1;
  let startedAt = 0;
  const timed = async () => {
    startedAt = Date.now();
    return await task();
  };
  const next = state.lock.then(timed, timed).finally(() => {
    state.lockDepth -= 1;
    const finishedAt = Date.now();
    const waitMs = (startedAt || finishedAt) - queuedAt;
    if (finishedAt - queuedAt >= SLOW_LOCK_LOG_MS) {
      console.info(
        `[turn-snapshot-lock] op=${op} waitMs=${waitMs} workMs=${finishedAt - (startedAt || finishedAt)} ` +
          `queuedBehind=${queuedBehind} root=${state.root}`
      );
    }
  });
  state.lock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// The shadow index starts as a copy of the source index, so it must hash the
// worktree with the source repository's own line-ending conversion. Forcing
// `core.autocrlf=false` hashed a CRLF checkout of an LF index as raw CRLF:
// every stat-touched file then diffed as fully rewritten.
async function sourceLineEndingArgs(root) {
  const result = await runGit(['config', '--get-regexp', '^core\\.(autocrlf|eol)$'], {
    cwd: root,
    allowFailure: true,
  });
  const values = new Map();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = /^(core\.(?:autocrlf|eol))\s+(\S+)/i.exec(line.trim());
    if (match) values.set(match[1].toLowerCase(), match[2]);
  }
  return [...values].flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

// A forgotten root's shadow repository is gone for good. Every git command and
// every file write on it goes through shadowArgs/ensureState, so refusing there
// keeps a snapshot object that outlived forgetTurnWorktreeRoot() from
// recreating the directory.
function assertStateLive(state) {
  if (!state.forgotten) return;
  const error = new Error(`turn worktree snapshot for ${state.root} was removed`);
  error.code = 'TURN_WORKTREE_SNAPSHOT_REMOVED';
  throw error;
}

function shadowArgs(state, args) {
  assertStateLive(state);
  return [
    ...state.lineEndingArgs,
    // A conversion warning must never fail the snapshot `add`.
    '-c',
    'core.safecrlf=false',
    '-c',
    'core.quotepath=false',
    '--git-dir',
    state.gitDir,
    '--work-tree',
    state.root,
    ...args,
  ];
}

async function sourceGitPath(root, suffix) {
  const result = await runGit(['rev-parse', '--path-format=absolute', '--git-path', suffix], {
    cwd: root,
    allowFailure: true,
  });
  const value = clean(result.stdout);
  return result.code === 0 && value ? resolve(root, value) : null;
}

async function syncSourceExclude(state) {
  const source = await sourceGitPath(state.root, 'info/exclude');
  if (!source || !(await exists(source))) return;
  const target = join(state.gitDir, 'info', 'exclude');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target).catch(() => {});
}

async function syncAlternates(state) {
  const result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: state.root,
    allowFailure: true,
  });
  const commonDir = clean(result.stdout);
  if (result.code !== 0 || !commonDir) return;
  const sourceObjects = join(resolve(state.root, commonDir), 'objects');
  if (!(await exists(sourceObjects))) return;
  const alternates = [sourceObjects];
  try {
    const chained = (await readFile(join(sourceObjects, 'info', 'alternates'), 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const item of chained) {
      if (await exists(item)) alternates.push(item);
    }
  } catch {
    // A missing or unreadable alternates file just means there is no chain to follow.
  }
  const target = join(state.gitDir, 'objects', 'info', 'alternates');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${[...new Set(alternates)].join('\n')}\n`, 'utf8');
}

async function sourceIndexIdentity(state) {
  state.sourceIndexPath ??= await sourceGitPath(state.root, 'index');
  if (!state.sourceIndexPath) return 'missing';
  try {
    const stat = await lstat(state.sourceIndexPath);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return 'missing';
  }
}

async function refreshSourceTracked(state, { force = false } = {}) {
  const identity = await sourceIndexIdentity(state);
  if (!force && state.sourceIndexIdentity === identity) return;
  const result = await runGit(['-c', 'core.quotepath=false', 'ls-files', '--cached', '-z'], {
    cwd: state.root,
    allowFailure: true,
  });
  if (result.code !== 0) return;
  state.sourceTracked = new Set(splitNulList(result.stdout).map(pathKey));
  state.sourceIndexIdentity = identity;
}

async function ensureState(state) {
  assertStateLive(state);
  if (state.initialized && (await exists(join(state.gitDir, 'config')))) return;
  await mkdir(dirname(state.gitDir), { recursive: true });
  if (!(await exists(join(state.gitDir, 'config')))) {
    // Migrate the short-lived prototype layout (`git init <dir>` created
    // <dir>/.git) before initializing the real external index repository.
    if (await exists(join(state.gitDir, '.git', 'config'))) {
      await rm(state.gitDir, { recursive: true, force: true });
    }
    await runGit(['init', '--bare', state.gitDir], { cwd: state.root });
    // One atomic config write replaces nine serial `git config` processes on
    // Windows. The shadow repository has no refs or user-authored config.
    await writeFile(
      join(state.gitDir, 'config'),
      [
        '[core]',
        '\trepositoryformatversion = 0',
        '\tbare = false',
        '\tlongpaths = true',
        '\tsymlinks = true',
        '\tfsmonitor = false',
        '\tuntrackedCache = true',
        '[feature]',
        '\tmanyFiles = true',
        '[index]',
        '\tversion = 4',
        '\tthreads = true',
        '',
      ].join('\n'),
      'utf8'
    );
  }
  const [lineEndingArgs] = await Promise.all([
    sourceLineEndingArgs(state.root),
    syncSourceExclude(state),
    syncAlternates(state),
  ]);
  state.lineEndingArgs = lineEndingArgs;
  // Seed once per process, then keep this index synchronized with the live
  // worktree. The shadow repository survives process restarts, so re-seeding
  // here also removes stale untracked entries left by a prior process without
  // paying the copy/rescan cost on every review poll.
  await refreshSourceTracked(state, { force: true });
  await resetShadowIndex(state);
  state.initialized = true;
}

async function resetShadowIndex(state) {
  state.lastCapture = null;
  state.sourceIndexPath ??= await sourceGitPath(state.root, 'index');
  const sourceIndex = state.sourceIndexPath;
  const target = join(state.gitDir, 'index');
  if (sourceIndex && (await exists(sourceIndex))) {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await copyFile(sourceIndex, temporary);
    await rm(target, { force: true }).catch(() => {});
    await rename(temporary, target);
    return;
  }
  await rm(target, { force: true }).catch(() => {});
  await runGit(shadowArgs(state, ['read-tree', '--empty']), { cwd: state.root });
}

async function changedWorktreePaths(state) {
  await refreshSourceTracked(state);
  const [tracked, untracked] = await Promise.all([
    runGit(shadowArgs(state, ['diff-files', '--name-only', '-z', '--', '.']), {
      cwd: state.root,
    }),
    runGit(shadowArgs(state, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']), {
      cwd: state.root,
    }),
  ]);
  const trackedPaths = splitNulList(tracked.stdout);
  const untrackedPaths = splitNulList(untracked.stdout);
  const sourceTrackedPaths = trackedPaths.filter((value) => state.sourceTracked.has(pathKey(value)));
  const shadowTrackedKeys = new Set(trackedPaths.map((value) => pathKey(value)));
  const changedUntracked = [
    ...new Set([...trackedPaths.filter((value) => !state.sourceTracked.has(pathKey(value))), ...untrackedPaths]),
  ];
  // Snapshot bound: never hash a newly-created multi-MB
  // build artifact just to power a review bar. Existing tracked files remain
  // exact; only large untracked blobs are omitted.
  const allowedUntracked = [];
  const excludedUntracked = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(16, changedUntracked.length) }, async () => {
    while (cursor < changedUntracked.length) {
      const index = cursor++;
      const rel = changedUntracked[index];
      try {
        const stat = await lstat(resolve(state.root, rel));
        if (!stat.isFile() || Number(stat.size) <= MAX_UNTRACKED_FILE_BYTES) {
          allowedUntracked.push(rel);
        } else {
          excludedUntracked.push(rel);
        }
      } catch {
        // A previously indexed untracked path was deleted. Include that
        // deletion so the shadow index cannot retain a stale blob.
        if (shadowTrackedKeys.has(pathKey(rel))) allowedUntracked.push(rel);
      }
    }
  });
  await Promise.all(workers);
  return {
    paths: [...new Set([...sourceTrackedPaths, ...allowedUntracked])],
    excludedUntracked,
  };
}

/** The capture sequence a caller observes before queueing on the lock. */
function captureSequence(state) {
  return state.captureSeq || 0;
}

/** `after` (a captureSequence() read before queueing): a capture of this root
 *  that began after that point, with no reported write since and covering
 *  every explicit path, already is a capture that began after the call. Many
 *  sessions of one repository queue reads together; they share that capture
 *  instead of each re-scanning the worktree in turn. */
async function captureTreeUnlocked(state, toolPaths = [], { after = -1 } = {}) {
  await ensureState(state);
  const explicit = new Set(toolPaths);
  const last = state.lastCapture;
  if (
    after >= 0 &&
    last &&
    last.seq > after &&
    last.stamp === state.changeStamp &&
    [...explicit].every((rel) => last.explicit.has(rel))
  ) {
    return last.tree;
  }
  state.captureSeq = captureSequence(state) + 1;
  const capture = { seq: state.captureSeq, stamp: state.changeStamp, explicit, tree: '' };
  state.lastCapture = null;
  const { paths, excludedUntracked } = await changedWorktreePaths(state);
  for (const rel of explicit) {
    try {
      const stat = await lstat(resolve(state.root, rel));
      if (stat.isFile() || stat.isSymbolicLink()) paths.push(rel);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (paths.length > 0) {
    await runGit(
      shadowArgs(state, ['add', '--force', '--all', '--sparse', '--pathspec-from-file=-', '--pathspec-file-nul']),
      {
        cwd: state.root,
        input: `${[...new Set(paths)].join('\0')}\0`,
      }
    );
  }
  const excluded = excludedUntracked.filter((rel) => !explicit.has(rel));
  if (excluded.length > 0) {
    // A small untracked file may already live in the persistent shadow index
    // from an earlier turn. If it later grows past the bound, remove only its
    // index entry so neither hashing nor turn-relative restore sees stale data.
    await runGit(shadowArgs(state, ['update-index', '--force-remove', '-z', '--stdin']), {
      cwd: state.root,
      input: `${excluded.join('\0')}\0`,
    });
  }
  const tree = await runGit(shadowArgs(state, ['write-tree']), { cwd: state.root });
  capture.tree = clean(tree.stdout);
  state.lastCapture = capture;
  return capture.tree;
}

/** Only explicit tool targets bypass ignore/size filters. Their first-before
 * bytes fill holes in the shadow baseline, not the user's repository index. */
export function recordTurnWorktreeFileChange(snapshot, fullPath, before) {
  if (!snapshot) return;
  const rel = relative(snapshot.root, canonicalPath(fullPath)).replace(/\\/g, '/');
  if (!rel || isAbsolute(rel) || rel.split('/').includes('..')) return;
  snapshot.state.changeStamp += 1;
  if (snapshot.toolPaths.has(rel)) return;
  snapshot.toolPaths.add(rel);
  // Before-bytes that were never captured (an omitted marker) or exceed the
  // tool-baseline bound are neither kept nor hashed: only their size stays,
  // so materializeToolBaselines can record an omitted (unrestorable) baseline
  // instead of shipping a file-sized buffer to git.
  if (before !== null && !(Buffer.isBuffer(before) && before.length <= MAX_TOOL_BASELINE_BYTES)) {
    const size = Buffer.isBuffer(before) ? before.length : Number(before?.size) || 0;
    snapshot.pendingBaselines.set(rel, { omitted: true, size });
    return;
  }
  snapshot.pendingBaselines.set(rel, before);
}

const isOmittedBaseline = (content) => content !== null && content !== undefined && !Buffer.isBuffer(content);

/** Review rows and patch sections for omitted baselines inside the review scope. */
function withOmittedBaselines(snapshot, review) {
  const scope = snapshot.scopePaths ? new Set(snapshot.scopePaths.map(pathKey)) : null;
  const omitted = [...snapshot.baselineFiles.values()].filter(
    (entry) => entry.omitted === true && (!scope || scope.has(pathKey(entry.path)))
  );
  if (omitted.length === 0) return review;
  const keys = new Set(omitted.map((entry) => pathKey(entry.path)));
  const files = (review.files || []).filter((file) => !keys.has(pathKey(file.path)));
  let patch = review.patch || '';
  for (const entry of omitted) {
    const present = existsSync(resolve(snapshot.root, entry.path));
    const size = Number(entry.size) || 0;
    files.push({
      path: entry.path,
      oldPath: null,
      status: present ? 'M' : 'D',
      additions: null,
      deletions: null,
      binary: true,
      omitted: true,
      size,
    });
    const newHeader = present ? `b/${entry.path}` : '/dev/null';
    patch +=
      `diff --git a/${entry.path} b/${entry.path}\n` +
      (present ? '' : 'deleted file mode 100644\n') +
      `binary/large file ${present ? 'changed' : 'deleted'} (${size} bytes; content not captured)\n` +
      `Binary files a/${entry.path} and ${newHeader} differ\n`;
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { ...review, files, patch, diffTooLarge: reviewDiffTooLarge(files, patch) };
}

async function applyBaselineFilesUnlocked(state, tree, allEntries) {
  // Omitted baselines change no tree: they are carried as metadata only.
  const files = allEntries
    .filter((entry) => entry?.omitted === true)
    .map((entry) => ({
      path: safeRelativePath(state.root, entry.path),
      oid: null,
      omitted: true,
      size: Number(entry.size) || 0,
    }));
  const entries = allEntries.filter((entry) => entry?.omitted !== true);
  if (entries.length === 0) return { tree, files };
  const saved = clean((await runGit(shadowArgs(state, ['write-tree']), { cwd: state.root })).stdout);
  try {
    await runGit(shadowArgs(state, ['read-tree', tree]), { cwd: state.root });
    for (const entry of entries) {
      const path = safeRelativePath(state.root, entry.path);
      let oid = entry.oid || null;
      if (entry.content !== undefined && entry.content !== null) {
        oid = clean(
          (
            await runGit(shadowArgs(state, ['hash-object', '-w', '--stdin', '--path', path]), {
              cwd: state.root,
              input: entry.content,
            })
          ).stdout
        );
      }
      if (oid) {
        await runGit(shadowArgs(state, ['update-index', '--add', '--cacheinfo', '100644', oid, path]), {
          cwd: state.root,
        });
      } else {
        await runGit(shadowArgs(state, ['update-index', '--force-remove', '--', path]), { cwd: state.root });
      }
      files.push({ path, oid });
    }
    return {
      tree: clean((await runGit(shadowArgs(state, ['write-tree']), { cwd: state.root })).stdout),
      files,
    };
  } finally {
    await runGit(shadowArgs(state, ['read-tree', saved]), { cwd: state.root });
  }
}

async function materializeToolBaselines(snapshot) {
  const pending = [...snapshot.pendingBaselines];
  if (pending.length === 0) return;
  const { state } = snapshot;
  const paths = pending.map(([path]) => path);
  const listed = await runGit(
    shadowArgs(state, ['ls-tree', '-r', '-z', '--name-only', snapshot.baselineTree, '--', ...paths]),
    {
      cwd: state.root,
    }
  );
  const present = new Set(splitNulList(listed.stdout).map(pathKey));
  const ignoredResult = await runGit(['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: state.root,
    input: `${paths.join('\0')}\0`,
    allowFailure: true,
  });
  if (ignoredResult.code > 1) throw commandError(['check-ignore'], ignoredResult.stderr, ignoredResult.code);
  const ignored = new Set(splitNulList(ignoredResult.stdout).map(pathKey));
  const missing = pending
    .filter(
      ([path, content]) =>
        !present.has(pathKey(path)) &&
        (content === null ||
          isOmittedBaseline(content) ||
          (!state.sourceTracked.has(pathKey(path)) &&
            (ignored.has(pathKey(path)) || content.length > MAX_UNTRACKED_FILE_BYTES)))
    )
    // A path whose exact baseline is already in the tree keeps it; one that is
    // not and whose bytes were never captured is recorded as omitted.
    .map(([path, content]) =>
      isOmittedBaseline(content) ? { path, omitted: true, size: content.size } : { path, content }
    );
  const applied = await applyBaselineFilesUnlocked(state, snapshot.baselineTree, missing);
  snapshot.baselineTree = applied.tree;
  for (const entry of applied.files) snapshot.baselineFiles.set(pathKey(entry.path), entry);
  for (const [path] of pending) snapshot.pendingBaselines.delete(path);
  // A changed baseline can change the diff even when the current tree did not.
  snapshot.currentTree = '';
}

function parseNameStatus(text) {
  const out = new Map();
  const tokens = String(text || '').split('\0');
  for (let index = 0; index < tokens.length; ) {
    const rawStatus = tokens[index++] || '';
    if (!rawStatus) continue;
    const code = rawStatus[0] || 'M';
    const oldPath = tokens[index++] || '';
    if (!oldPath) continue;
    const newPath = code === 'R' || code === 'C' ? tokens[index++] || '' : oldPath;
    if (!newPath) continue;
    out.set(pathKey(newPath), {
      path: newPath.replace(/\\/g, '/'),
      oldPath: code === 'R' || code === 'C' ? oldPath.replace(/\\/g, '/') : null,
      status: code,
    });
  }
  return out;
}

function parseNumstat(text) {
  const out = new Map();
  const source = String(text || '');
  let cursor = 0;
  while (cursor < source.length) {
    const firstTab = source.indexOf('\t', cursor);
    const secondTab = firstTab < 0 ? -1 : source.indexOf('\t', firstTab + 1);
    const pathEnd = secondTab < 0 ? -1 : source.indexOf('\0', secondTab + 1);
    if (firstTab < 0 || secondTab < 0 || pathEnd < 0) break;
    const addedRaw = source.slice(cursor, firstTab);
    const deletedRaw = source.slice(firstTab + 1, secondTab);
    let path = source.slice(secondTab + 1, pathEnd);
    let oldPath = null;
    cursor = pathEnd + 1;
    if (!path) {
      const oldEnd = source.indexOf('\0', cursor);
      const newEnd = oldEnd < 0 ? -1 : source.indexOf('\0', oldEnd + 1);
      if (oldEnd < 0 || newEnd < 0) break;
      oldPath = source.slice(cursor, oldEnd);
      path = source.slice(oldEnd + 1, newEnd);
      cursor = newEnd + 1;
    }
    if (!path) continue;
    out.set(pathKey(path), {
      path: path.replace(/\\/g, '/'),
      oldPath: oldPath ? oldPath.replace(/\\/g, '/') : null,
      additions: addedRaw === '-' ? null : Number(addedRaw) || 0,
      deletions: deletedRaw === '-' ? null : Number(deletedRaw) || 0,
      binary: addedRaw === '-' || deletedRaw === '-',
    });
  }
  return out;
}

const literalPathspec = (path) => `:(literal)${path}`;

/** The `diff --git` sections of one patch read, keyed by path; null once its
 *  output passed `maxBytes`. */
async function patchSectionsByPath(state, baselineTree, currentTree, pathspec, maxBytes) {
  let result;
  try {
    result = await runGit(
      shadowArgs(state, [
        'diff',
        '--no-ext-diff',
        '--unified=3',
        '--find-renames',
        baselineTree,
        currentTree,
        '--',
        ...pathspec,
      ]),
      { cwd: state.root, maxBytes: maxBytes + PATCH_OUTPUT_SLACK_BYTES }
    );
  } catch (error) {
    if (error?.code === 'EMAXBUFFER') return null;
    throw error;
  }
  const sections = new Map();
  for (const section of splitPatchSections(Buffer.from(result.stdout, 'utf8'))) {
    const path = section.newPath ?? section.oldPath;
    if (path) sections.set(pathKey(path), section.patch);
  }
  return sections;
}

/** After the whole range overflowed: patches read in path batches, the
 *  smallest changes first, until the reply's total is spent. A batch that
 *  overflows is halved; a single file that does is too large. */
async function batchedPatchSections(state, baselineTree, currentTree, files, sections) {
  const lines = (file) => (Number(file.additions) || 0) + (Number(file.deletions) || 0);
  let remaining = REVIEW_PATCH_MAX_BYTES;
  const read = async (batch) => {
    if (batch.length === 0 || remaining <= 0) return;
    const pathspec = batch.flatMap((file) => [file.path, file.oldPath].filter(Boolean).map(literalPathspec));
    const found = await patchSectionsByPath(state, baselineTree, currentTree, pathspec, remaining);
    if (!found) {
      if (batch.length === 1) return;
      const half = Math.ceil(batch.length / 2);
      await read(batch.slice(0, half));
      await read(batch.slice(half));
      return;
    }
    for (const [key, section] of found) {
      sections.set(key, section);
      if (section.length <= REVIEW_FILE_PATCH_MAX_BYTES) remaining -= section.length;
    }
  };
  // Every changed line costs at least its marker and newline: a file whose
  // counts alone pass the per-file cap is never read.
  const queue = files
    .filter((file) => 2 * lines(file) <= REVIEW_FILE_PATCH_MAX_BYTES)
    .sort((left, right) => lines(left) - lines(right));
  for (let index = 0; index < queue.length && remaining > 0; index += PATCH_BATCH_FILES) {
    await read(queue.slice(index, index + PATCH_BATCH_FILES));
  }
}

/** Every file's patch within the reply caps. A file past the per-file cap or
 *  the remaining total is listed without one (`patchOmitted`, too large). */
async function boundedTreePatch(state, baselineTree, currentTree, pathspec, files) {
  let sections = await patchSectionsByPath(state, baselineTree, currentTree, pathspec, COMMAND_MAX_BYTES);
  // Read whole, every file has its section; read in batches, a file without
  // one was too large or past the total.
  const whole = Boolean(sections);
  if (!sections) {
    sections = new Map();
    await batchedPatchSections(state, baselineTree, currentTree, files, sections);
  }
  const budget = createReviewPatchBudget();
  const kept = [];
  const bounded = files.map((file) => {
    const section = sections.get(pathKey(file.path));
    if (!section && whole) return file;
    if (section && budget.admit(section.length)) {
      kept.push(section);
      return file;
    }
    return patchOmittedFile(file);
  });
  return { patch: Buffer.concat(kept).toString('utf8'), files: bounded };
}

async function diffTreesUnlocked(state, baselineTree, currentTree, paths = null) {
  if (!baselineTree || !currentTree || baselineTree === currentTree) {
    return { patch: '', files: [], patchTruncated: false, diffTooLarge: false, currentTree };
  }
  // A scoped review restricts the range to the paths its session owns: the
  // baseline describes the whole worktree, concurrent sessions included.
  const pathspec = Array.isArray(paths) && paths.length > 0 ? paths : ['.'];
  const rangeArgs = ['--find-renames', baselineTree, currentTree, '--', ...pathspec];
  const [nameStatus, numstat] = await Promise.all([
    runGit(shadowArgs(state, ['diff', '--name-status', '-z', ...rangeArgs]), { cwd: state.root }),
    runGit(shadowArgs(state, ['diff', '--numstat', '-z', ...rangeArgs]), { cwd: state.root }),
  ]);
  const statuses = parseNameStatus(nameStatus.stdout);
  const stats = parseNumstat(numstat.stdout);
  const keys = [...new Set([...statuses.keys(), ...stats.keys()])];
  const files = keys
    .map((key) => {
      const status = statuses.get(key) || {};
      const stat = stats.get(key) || {};
      return {
        path: status.path || stat.path || key,
        oldPath: status.oldPath || stat.oldPath || null,
        status: status.status || 'M',
        additions: stat.additions ?? null,
        deletions: stat.deletions ?? null,
        binary: stat.binary === true,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const bounded = await boundedTreePatch(state, baselineTree, currentTree, pathspec, files);
  return {
    patch: bounded.patch,
    files: bounded.files,
    patchTruncated: false,
    diffTooLarge: reviewDiffTooLarge(bounded.files, bounded.patch),
    currentTree,
  };
}

/** One file's patch between two trees (a rename read with its old path), up
 *  to `maxBytes`; past it, the file is too large. */
async function filePatchUnlocked(state, baselineTree, currentTree, path, oldPath, maxBytes) {
  if (!baselineTree || !currentTree || baselineTree === currentTree) return { patch: '' };
  const pathspec = [path, oldPath].filter(Boolean).map(literalPathspec);
  const sections = await patchSectionsByPath(state, baselineTree, currentTree, pathspec, maxBytes);
  const section = sections?.get(pathKey(path)) ?? (oldPath ? sections?.get(pathKey(oldPath)) : undefined);
  if (!sections || (section && section.length > maxBytes)) {
    return { patch: '', patchOmitted: true, reason: PATCH_TOO_LARGE };
  }
  return { patch: section ? section.toString('utf8') : '' };
}

// One maintenance pass per shadow repository per process, off the turn's
// critical path. `--auto` does nothing until the repository actually needs it,
// so the common case costs a process spawn and nothing else.
const maintainedShadowRepositories = new Set();

function scheduleShadowGc(state) {
  if (state.forgotten || maintainedShadowRepositories.has(state.gitDir)) return;
  maintainedShadowRepositories.add(state.gitDir);
  const timer = setTimeout(() => {
    state.gcTimer = null;
    // Deliberately outside the state lock: collection can run for minutes and
    // git serializes itself through gc.lock, so a clash just retries later.
    // forgetTurnWorktreeRoot() waits for `gcRun` before deleting the repository.
    state.gcRun = Promise.resolve()
      .then(() =>
        runGit(shadowArgs(state, ['gc', '--auto', `--prune=${SHADOW_GC_PRUNE}`, '--quiet']), {
          cwd: state.root,
          allowFailure: true,
          timeoutMs: 300_000,
        })
      )
      .catch(() => {});
  }, 60_000);
  timer.unref?.();
  state.gcTimer = timer;
}

async function removeShadowDir(gitDir, removed, kept) {
  if (!(await exists(gitDir))) return;
  await rm(gitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  ((await exists(gitDir)) ? kept : removed).push(gitDir);
}

/** Drop every trace of one worktree root: serialize behind its pending capture
 *  work, remove its shadow repository and in-memory state, and refuse any write
 *  a snapshot object that still holds the old state attempts afterwards.
 *  Only the exact root is touched. Returns `{ removed, kept }` shadow paths;
 *  `kept` lists a shadow repository that could not be deleted. */
export async function forgetTurnWorktreeRoot(root) {
  const text = clean(root);
  const removed = [];
  const kept = [];
  if (!text) return { removed, kept };
  const keys = new Set([pathKey(resolve(text)), pathKey(canonicalPath(text))]);
  const gitDirs = new Set([...keys].map(shadowDirForKey));
  for (const [key, state] of [...states]) {
    if (!keys.has(key) && !keys.has(pathKey(state.root))) continue;
    gitDirs.add(state.gitDir);
    await withStateLock(state, async () => {
      state.forgotten = true;
      if (states.get(key) === state) states.delete(key);
      if (state.gcTimer) clearTimeout(state.gcTimer);
      state.gcTimer = null;
      await state.gcRun;
      maintainedShadowRepositories.delete(state.gitDir);
    });
  }
  for (const gitDir of gitDirs) await removeShadowDir(gitDir, removed, kept);
  return { removed, kept };
}

export async function createTurnWorktreeSnapshot(worktree) {
  const root = await repositoryRoot(worktree).catch(() => null);
  if (!root) return null;
  const state = stateForRoot(root);
  return await withStateLock(state, async () => {
    const mark = await captureMark(state);
    const baselineTree = await captureTreeUnlocked(state);
    if (!baselineTree) return null;
    scheduleShadowGc(state);
    return {
      state,
      root,
      baselineTree,
      currentTree: baselineTree,
      captured: mark,
      refreshing: null,
      refreshSeq: 0,
      patch: '',
      files: [],
      patchTruncated: false,
      scopePaths: null,
      toolPaths: new Set(),
      pendingBaselines: new Map(),
      baselineFiles: new Map(),
    };
  });
}

/** Re-open a recorded baseline after the runtime lost its in-memory tracker.
 *  The tree object is the durable half of a review; `paths` scopes both this
 *  diff and any later revert to what the recording session actually owns. */
export async function resumeTurnWorktreeSnapshot(worktree, baselineTree, { paths = null, baselineFiles = [] } = {}) {
  const tree = clean(baselineTree);
  if (!tree) return null;
  const root = await repositoryRoot(worktree).catch(() => null);
  if (!root) return null;
  const state = stateForRoot(root);
  const after = captureSequence(state);
  return await withStateLock(
    state,
    async () => {
      if (!(await recordedTreeUnlocked(state, tree))) return null;
      const scopePaths = Array.isArray(paths) && paths.length > 0 ? [...new Set(paths)] : null;
      const applied = await applyBaselineFilesUnlocked(state, tree, baselineFiles || []);
      const snapshot = {
        state,
        root,
        baselineTree: applied.tree,
        currentTree: tree,
        patch: '',
        files: [],
        patchTruncated: false,
        scopePaths,
        toolPaths: new Set(scopePaths || []),
        pendingBaselines: new Map(),
        baselineFiles: new Map(applied.files.map((entry) => [pathKey(entry.path), entry])),
      };
      const currentTree = await captureTreeUnlocked(state, snapshot.toolPaths, { after });
      Object.assign(
        snapshot,
        withOmittedBaselines(snapshot, await diffTreesUnlocked(state, snapshot.baselineTree, currentTree, scopePaths))
      );
      return snapshot;
    },
    'resume'
  );
}

/** A collected or never-written baseline restores nothing: false reports it
 *  as "no snapshot" instead of failing every later call made against it. */
async function recordedTreeUnlocked(state, tree) {
  await ensureState(state);
  const kind = await runGit(shadowArgs(state, ['cat-file', '-t', tree]), {
    cwd: state.root,
    allowFailure: true,
  });
  return kind.code === 0 && clean(kind.stdout) === 'tree';
}

/** One file's patch of a recorded baseline against the worktree now, up to
 *  `maxBytes`. `paths` is the recording session's scope, every target checked
 *  on its own: a file outside it answers with no patch, a rename source
 *  outside it is left out of the diff. Null when the baseline is gone. */
export async function resumeTurnWorktreeFilePatch(
  worktree,
  baselineTree,
  { paths = null, baselineFiles = [], path, oldPath = '', maxBytes } = {}
) {
  const tree = clean(baselineTree);
  if (!tree) return null;
  const root = await repositoryRoot(worktree).catch(() => null);
  if (!root) return null;
  const state = stateForRoot(root);
  const scope = Array.isArray(paths) && paths.length > 0 ? new Set(paths.map(pathKey)) : null;
  const allowed = (rel) => !scope || scope.has(pathKey(rel));
  const target = safeRelativePath(root, path);
  if (!allowed(target)) return { patch: '' };
  const source = clean(oldPath) ? safeRelativePath(root, oldPath) : '';
  // Only authorized paths reach the diff.
  const targets = source && allowed(source) && pathKey(source) !== pathKey(target) ? [target, source] : [target];
  const keys = new Set(targets.map(pathKey));
  const after = captureSequence(state);
  return await withStateLock(
    state,
    async () => {
      if (!(await recordedTreeUnlocked(state, tree))) return null;
      // Only this file's recorded first states change its side of the tree.
      const applied = await applyBaselineFilesUnlocked(
        state,
        tree,
        (baselineFiles || []).filter((entry) => keys.has(pathKey(safeRelativePath(root, entry?.path))))
      );
      const currentTree = await captureTreeUnlocked(state, targets, { after });
      return await filePatchUnlocked(state, applied.tree, currentTree, targets[0], targets[1] || '', maxBytes);
    },
    'file-patch'
  );
}

/** What a capture starting now has seen: the change stamp, the source index
 *  identity (commits, checkouts, staging) and the time. */
async function captureMark(state) {
  return { stamp: state.changeStamp, index: await sourceIndexIdentity(state), at: Date.now() };
}

/** Could the worktree differ from the snapshot's last capture? */
async function captureNeeded(snapshot) {
  const mark = snapshot.captured;
  if (!mark || snapshot.pendingBaselines.size > 0) return true;
  if (mark.stamp !== snapshot.state.changeStamp) return true;
  if (Date.now() - mark.at >= MIN_RECAPTURE_GAP_MS) return true;
  return (await sourceIndexIdentity(snapshot.state)) !== mark.index;
}

function startRefresh(snapshot) {
  const flight = { seq: (snapshot.refreshSeq || 0) + 1, promise: null };
  snapshot.refreshSeq = flight.seq;
  snapshot.refreshing = flight;
  const after = captureSequence(snapshot.state);
  flight.promise = withStateLock(
    snapshot.state,
    async () => {
      const mark = await captureMark(snapshot.state);
      await materializeToolBaselines(snapshot);
      const currentTree = await captureTreeUnlocked(snapshot.state, snapshot.toolPaths, { after });
      if (currentTree !== snapshot.currentTree) {
        const review = await diffTreesUnlocked(snapshot.state, snapshot.baselineTree, currentTree, snapshot.scopePaths);
        Object.assign(snapshot, withOmittedBaselines(snapshot, review));
      }
      snapshot.captured = mark;
      return snapshot;
    },
    'refresh'
  ).finally(() => {
    if (snapshot.refreshing === flight) snapshot.refreshing = null;
  });
  return flight.promise;
}

/** Bring the snapshot up to date with the worktree. Single-flight: a call
 *  made while a capture runs waits for it, then captures again only if a
 *  change was reported after that capture began. Without a reported change,
 *  an index change or MIN_RECAPTURE_GAP_MS elapsed, the last capture stands.
 *  `force` always answers with a capture that began after this call. */
export async function refreshTurnWorktreeSnapshot(snapshot, { force = false } = {}) {
  if (!snapshot?.state || !snapshot.baselineTree) return null;
  const calledAtSeq = snapshot.refreshSeq || 0;
  for (;;) {
    const flight = snapshot.refreshing;
    if (flight) {
      await flight.promise;
      if (flight.seq > calledAtSeq) return snapshot;
      continue;
    }
    if (!force && !(await captureNeeded(snapshot))) return snapshot;
    if (snapshot.refreshing) continue;
    return await startRefresh(snapshot);
  }
}

function safeRelativePath(root, value) {
  const requested = clean(value);
  if (!requested) throw new TypeError('turn review file path is required');
  const fullPath = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, fullPath);
  if (!rel || rel === '.' || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
    throw new Error('turn review file path is outside the worktree');
  }
  return rel.replace(/\\/g, '/');
}

export function _resetTurnWorktreeSnapshotsForTest() {
  states.clear();
}
