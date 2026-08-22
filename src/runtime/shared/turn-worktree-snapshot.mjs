import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BYTES = 8 * 1024 * 1024;
const PATCH_MAX_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
// Baselines used to live in the OS temp directory, where a reboot or a disk
// cleaner could remove the only copy of a turn's revert source. Keep them with
// the rest of the runtime data (same resolution as
// session-runtime/runtime-paths.mjs; shared code cannot import that layer).
const DATA_DIR = process.env.MIXDOG_DATA_DIR
  || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
const SNAPSHOT_ROOT = join(DATA_DIR, 'turn-worktree-snapshots-v1');
// A baseline tree is unreachable by design (no commit, no ref), so collection
// is what bounds how long a review stays revertible.
const SHADOW_GC_PRUNE = '7.days.ago';
const states = new Map();

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathKey(value) {
  const text = clean(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function commandError(args, stderr, code) {
  const error = new Error(`git ${args.join(' ')} failed (${code}): ${clean(stderr) || 'no diagnostic'}`);
  error.code = code;
  return error;
}

function runGit(args, {
  cwd,
  input = '',
  timeoutMs = COMMAND_TIMEOUT_MS,
  maxBytes = COMMAND_MAX_BYTES,
  allowFailure = false,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasInput = (typeof input === 'string' || Buffer.isBuffer(input)) && input.length > 0;
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdinError = null;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      try { child.kill(); } catch {}
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    const collect = (chunks, chunk, kind) => {
      const next = Buffer.from(chunk);
      if (kind === 'stdout') stdoutBytes += next.length;
      else stderrBytes += next.length;
      if (stdoutBytes + stderrBytes > maxBytes) {
        const error = new Error(`git ${args.join(' ')} exceeded ${maxBytes} output bytes`);
        error.code = 'EMAXBUFFER';
        try { child.kill(); } catch {}
        finish(error);
        return;
      }
      chunks.push(next);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const result = {
        code: Number(code ?? 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (result.code !== 0 && !allowFailure) {
        finish(commandError(args, result.stderr, result.code));
        return;
      }
      if (stdinError && result.code === 0) {
        finish(stdinError);
        return;
      }
      finish(null, result);
    });
    if (child.stdin) {
      // A short-lived git command can close before Node flushes stdin. Keep
      // that transport race inside this promise instead of emitting an
      // unhandled EPIPE that terminates the entire release validator.
      child.stdin.on('error', (error) => { stdinError = error; });
      child.stdin.end(input);
    }
  });
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

function stateForRoot(root) {
  const key = pathKey(root);
  let state = states.get(key);
  if (state) return state;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  state = {
    root,
    gitDir: join(SNAPSHOT_ROOT, hash),
    initialized: false,
    sourceIndexPath: null,
    sourceIndexIdentity: null,
    sourceTracked: new Set(),
    lock: Promise.resolve(),
  };
  states.set(key, state);
  return state;
}

function withStateLock(state, task) {
  const next = state.lock.then(task, task);
  state.lock = next.then(() => undefined, () => undefined);
  return next;
}

function shadowArgs(state, args) {
  return [
    '-c', 'core.autocrlf=false',
    '-c', 'core.quotepath=false',
    '--git-dir', state.gitDir,
    '--work-tree', state.root,
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
  } catch {}
  const target = join(state.gitDir, 'objects', 'info', 'alternates');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${[...new Set(alternates)].join('\n')}\n`, 'utf8');
}

async function refreshSourceTracked(state, { force = false } = {}) {
  state.sourceIndexPath ??= await sourceGitPath(state.root, 'index');
  let identity = 'missing';
  if (state.sourceIndexPath) {
    try {
      const stat = await lstat(state.sourceIndexPath);
      identity = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {}
  }
  if (!force && state.sourceIndexIdentity === identity) return;
  const result = await runGit([
    '-c', 'core.quotepath=false',
    'ls-files', '--cached', '-z',
  ], {
    cwd: state.root,
    allowFailure: true,
  });
  if (result.code !== 0) return;
  state.sourceTracked = new Set(
    result.stdout.split('\0').map((value) => pathKey(value)).filter(Boolean),
  );
  state.sourceIndexIdentity = identity;
}

async function ensureState(state) {
  if (state.initialized && await exists(join(state.gitDir, 'config'))) return;
  await mkdir(SNAPSHOT_ROOT, { recursive: true });
  if (!(await exists(join(state.gitDir, 'config')))) {
    // Migrate the short-lived prototype layout (`git init <dir>` created
    // <dir>/.git) before initializing the real external index repository.
    if (await exists(join(state.gitDir, '.git', 'config'))) {
      await rm(state.gitDir, { recursive: true, force: true });
    }
    await runGit(['init', '--bare', state.gitDir], { cwd: state.root });
    // One atomic config write replaces nine serial `git config` processes on
    // Windows. The shadow repository has no refs or user-authored config.
    await writeFile(join(state.gitDir, 'config'), [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tbare = false',
      '\tautocrlf = false',
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
    ].join('\n'), 'utf8');
  }
  await Promise.all([syncSourceExclude(state), syncAlternates(state)]);
  // Seed once per process, then keep this index synchronized with the live
  // worktree. The temp repository survives process restarts, so re-seeding
  // here also removes stale untracked entries left by a prior process without
  // paying the copy/rescan cost on every review poll.
  await refreshSourceTracked(state, { force: true });
  await resetShadowIndex(state);
  state.initialized = true;
}

async function resetShadowIndex(state) {
  state.sourceIndexPath ??= await sourceGitPath(state.root, 'index');
  const sourceIndex = state.sourceIndexPath;
  const target = join(state.gitDir, 'index');
  if (sourceIndex && await exists(sourceIndex)) {
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
  const trackedPaths = tracked.stdout.split('\0').map((value) => value.trim()).filter(Boolean);
  const untrackedPaths = untracked.stdout.split('\0').map((value) => value.trim()).filter(Boolean);
  const sourceTrackedPaths = trackedPaths.filter((value) => state.sourceTracked.has(pathKey(value)));
  const shadowTrackedKeys = new Set(trackedPaths.map((value) => pathKey(value)));
  const changedUntracked = [...new Set([
    ...trackedPaths.filter((value) => !state.sourceTracked.has(pathKey(value))),
    ...untrackedPaths,
  ])];
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

async function captureTreeUnlocked(state) {
  await ensureState(state);
  const { paths, excludedUntracked } = await changedWorktreePaths(state);
  if (paths.length > 0) {
    await runGit(shadowArgs(state, [
      'add',
      '--all',
      '--sparse',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ]), {
      cwd: state.root,
      input: `${paths.join('\0')}\0`,
    });
  }
  if (excludedUntracked.length > 0) {
    // A small untracked file may already live in the persistent shadow index
    // from an earlier turn. If it later grows past the bound, remove only its
    // index entry so neither hashing nor turn-relative restore sees stale data.
    await runGit(shadowArgs(state, [
      'update-index',
      '--force-remove',
      '-z',
      '--stdin',
    ]), {
      cwd: state.root,
      input: `${excludedUntracked.join('\0')}\0`,
    });
  }
  const tree = await runGit(shadowArgs(state, ['write-tree']), { cwd: state.root });
  return clean(tree.stdout);
}

function parseNameStatus(text) {
  const out = new Map();
  const tokens = String(text || '').split('\0');
  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++] || '';
    if (!rawStatus) continue;
    const code = rawStatus[0] || 'M';
    const oldPath = tokens[index++] || '';
    if (!oldPath) continue;
    const newPath = code === 'R' || code === 'C' ? (tokens[index++] || '') : oldPath;
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

async function diffTreesUnlocked(state, baselineTree, currentTree, paths = null) {
  if (!baselineTree || !currentTree || baselineTree === currentTree) {
    return { patch: '', files: [], patchTruncated: false, currentTree };
  }
  // A scoped review restricts the range to the paths its session owns: the
  // baseline describes the whole worktree, concurrent sessions included.
  const pathspec = Array.isArray(paths) && paths.length > 0 ? paths : ['.'];
  const rangeArgs = ['--find-renames', baselineTree, currentTree, '--', ...pathspec];
  const [nameStatus, numstat] = await Promise.all([
    runGit(shadowArgs(state, ['diff', '--name-status', '-z', ...rangeArgs]), { cwd: state.root }),
    runGit(shadowArgs(state, ['diff', '--numstat', '-z', ...rangeArgs]), { cwd: state.root }),
  ]);
  let patch = '';
  let patchTruncated = false;
  try {
    const result = await runGit(shadowArgs(state, [
      'diff',
      '--no-ext-diff',
      '--unified=3',
      ...rangeArgs,
    ]), {
      cwd: state.root,
      maxBytes: PATCH_MAX_BYTES + 256 * 1024,
    });
    patch = result.stdout.length <= PATCH_MAX_BYTES ? result.stdout : result.stdout.slice(0, PATCH_MAX_BYTES);
    patchTruncated = result.stdout.length > PATCH_MAX_BYTES;
  } catch (error) {
    if (error?.code !== 'EMAXBUFFER') throw error;
    patchTruncated = true;
  }
  const statuses = parseNameStatus(nameStatus.stdout);
  const stats = parseNumstat(numstat.stdout);
  const keys = [...new Set([...statuses.keys(), ...stats.keys()])];
  const files = keys.map((key) => {
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
  }).sort((left, right) => left.path.localeCompare(right.path));
  return { patch, files, patchTruncated, currentTree };
}

// One maintenance pass per shadow repository per process, off the turn's
// critical path. `--auto` does nothing until the repository actually needs it,
// so the common case costs a process spawn and nothing else.
const maintainedShadowRepositories = new Set();

function scheduleShadowGc(state) {
  if (maintainedShadowRepositories.has(state.gitDir)) return;
  maintainedShadowRepositories.add(state.gitDir);
  const timer = setTimeout(() => {
    // Deliberately outside the state lock: collection can run for minutes and
    // git serializes itself through gc.lock, so a clash just retries later.
    void runGit(shadowArgs(state, ['gc', '--auto', `--prune=${SHADOW_GC_PRUNE}`, '--quiet']), {
      cwd: state.root,
      allowFailure: true,
      timeoutMs: 300_000,
    }).catch(() => {});
  }, 60_000);
  timer.unref?.();
}

export async function createTurnWorktreeSnapshot(worktree) {
  const root = await repositoryRoot(worktree).catch(() => null);
  if (!root) return null;
  const state = stateForRoot(root);
  return await withStateLock(state, async () => {
    const baselineTree = await captureTreeUnlocked(state);
    if (!baselineTree) return null;
    scheduleShadowGc(state);
    return {
      state,
      root,
      baselineTree,
      currentTree: baselineTree,
      patch: '',
      files: [],
      patchTruncated: false,
      scopePaths: null,
    };
  });
}

/** Re-open a recorded baseline after the runtime lost its in-memory tracker.
 *  The tree object is the durable half of a review; `paths` scopes both this
 *  diff and any later revert to what the recording session actually owns. */
export async function resumeTurnWorktreeSnapshot(worktree, baselineTree, { paths = null } = {}) {
  const tree = clean(baselineTree);
  if (!tree) return null;
  const root = await repositoryRoot(worktree).catch(() => null);
  if (!root) return null;
  const state = stateForRoot(root);
  return await withStateLock(state, async () => {
    await ensureState(state);
    // A collected or never-written baseline restores nothing. Report that as
    // "no snapshot" instead of failing every later call made against it.
    const kind = await runGit(shadowArgs(state, ['cat-file', '-t', tree]), {
      cwd: state.root,
      allowFailure: true,
    });
    if (kind.code !== 0 || clean(kind.stdout) !== 'tree') return null;
    const scopePaths = Array.isArray(paths) && paths.length > 0 ? [...new Set(paths)] : null;
    const snapshot = {
      state,
      root,
      baselineTree: tree,
      currentTree: tree,
      patch: '',
      files: [],
      patchTruncated: false,
      scopePaths,
    };
    const currentTree = await captureTreeUnlocked(state);
    Object.assign(snapshot, await diffTreesUnlocked(state, tree, currentTree, scopePaths));
    return snapshot;
  });
}

export async function refreshTurnWorktreeSnapshot(snapshot) {
  if (!snapshot?.state || !snapshot.baselineTree) return null;
  return await withStateLock(snapshot.state, async () => {
    const currentTree = await captureTreeUnlocked(snapshot.state);
    if (currentTree === snapshot.currentTree) return snapshot;
    const review = await diffTreesUnlocked(
      snapshot.state,
      snapshot.baselineTree,
      currentTree,
      snapshot.scopePaths,
    );
    Object.assign(snapshot, review);
    return snapshot;
  });
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

async function restorePathFromTree(snapshot, rel) {
  const listed = await runGit(shadowArgs(snapshot.state, [
    'ls-tree',
    '-z',
    '--name-only',
    snapshot.baselineTree,
    '--',
    rel,
  ]), { cwd: snapshot.root });
  if (listed.stdout.split('\0').some((value) => value === rel)) {
    await runGit(shadowArgs(snapshot.state, [
      'checkout',
      snapshot.baselineTree,
      '--',
      rel,
    ]), { cwd: snapshot.root });
    return;
  }
  const target = resolve(snapshot.root, rel);
  try {
    const stat = await lstat(target);
    if (stat.isDirectory()) throw new Error('turn review revert refuses to remove a directory');
    await rm(target, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function revertPathsUnlocked(snapshot, targets) {
  for (const target of targets) {
    await restorePathFromTree(snapshot, target);
  }
  const currentTree = await captureTreeUnlocked(snapshot.state);
  Object.assign(snapshot, await diffTreesUnlocked(
    snapshot.state,
    snapshot.baselineTree,
    currentTree,
    snapshot.scopePaths,
  ));
  return snapshot;
}

export async function revertTurnWorktreeFile(snapshot, value) {
  if (!snapshot?.state || !snapshot.baselineTree) throw new Error('turn worktree snapshot is unavailable');
  return await withStateLock(snapshot.state, async () => {
    const rel = safeRelativePath(snapshot.root, value);
    const entry = snapshot.files.find((file) =>
      pathKey(file.path) === pathKey(rel) || pathKey(file.oldPath) === pathKey(rel));
    const targets = [...new Set([entry?.path || rel, entry?.oldPath].filter(Boolean))]
      .map((target) => safeRelativePath(snapshot.root, target));
    return await revertPathsUnlocked(snapshot, targets);
  });
}

export async function revertTurnWorktreeSnapshot(snapshot) {
  if (!snapshot?.state || !snapshot.baselineTree) throw new Error('turn worktree snapshot is unavailable');
  return await withStateLock(snapshot.state, async () => {
    // Resolve and validate every path before the first mutation. Renames and
    // copies contribute both sides so the worktree returns to the exact
    // turn-start tree rather than leaving a destination behind.
    const targets = [...new Set(snapshot.files
      .flatMap((file) => [file.path, file.oldPath])
      .filter(Boolean))]
      .map((target) => safeRelativePath(snapshot.root, target));
    return await revertPathsUnlocked(snapshot, targets);
  });
}

/** Restore only the listed paths. This is the session-owned revert: a shared
 *  worktree cannot attribute the whole-tree diff, but the paths this session's
 *  own tools wrote are exactly attributable. */
export async function revertTurnWorktreePaths(snapshot, values) {
  if (!snapshot?.state || !snapshot.baselineTree) throw new Error('turn worktree snapshot is unavailable');
  const requested = (Array.isArray(values) ? values : []).filter(Boolean);
  if (requested.length === 0) throw new Error('turn review revert has no restorable files');
  return await withStateLock(snapshot.state, async () => {
    const targets = [...new Set(requested.map((value) => safeRelativePath(snapshot.root, value)))];
    return await revertPathsUnlocked(snapshot, targets);
  });
}

export function _resetTurnWorktreeSnapshotsForTest() {
  states.clear();
}
