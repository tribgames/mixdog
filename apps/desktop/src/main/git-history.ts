import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DISPLAY_DIFF_ARGS,
  GIT_METADATA_TTL_MS,
  UNTRACKED_STAT_CONCURRENCY,
  gitCacheKey,
  mapWithConcurrency,
  parseNumstat,
  untrackedPatch,
  untrackedStat,
} from './git-read-utils';
import type { GitReviewSource } from './git-contract.mjs';
import { run } from './git-runner';
import { cachedGitRoot, hasHead } from './git-status';

const reviewBaseCache = new Map<string, { expiresAt: number; base: string }>();

export async function gitDiff(
  cwd: string,
  path: string,
  staged: boolean,
  worktreeOnly = false,
  untracked = false
): Promise<string> {
  const root = await cachedGitRoot(cwd);
  if (untracked) return untrackedPatch(root, path);
  let baseArgs: string[];
  if (staged) baseArgs = ['--cached'];
  else if (worktreeOnly) baseArgs = [];
  else baseArgs = [(await resolveReviewRef(root, 'uncommitted')).ref];
  return run(root, ['--no-optional-locks', 'diff', ...DISPLAY_DIFF_ARGS, ...baseArgs, '--', path]);
}

export interface GitReviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  untracked: boolean;
  /** Worktree identity `${size}:${mtimeMs}`, or 'deleted' when the file is gone. */
  revision: string;
}

interface GitReviewResult {
  repository: boolean;
  root: string;
  base: string;
  files: GitReviewFile[];
  /** Untracked files past {@link REVIEW_UNTRACKED_LIMIT}, left out of `files`. */
  untrackedOmitted: number;
}

export interface GitReviewDiffsResult {
  /** Per-file patch ('' when the file has no diff) with the requested path. A
   *  list, not an object keyed by path: `__proto__` is a legal file name. */
  patches: { path: string; patch: string }[];
  /** Requested paths with no entry in `patches`; fetch them one at a time. */
  omitted: string[];
}

const REVIEW_UNTRACKED_LIMIT = 256;
/** Total patch text one batch returns before the remaining files are omitted. */
const REVIEW_BATCH_PATCH_CHARS = 8_000_000;
/** Pathspec text one batch passes on the command line (Windows caps it near 32k). */
const REVIEW_BATCH_ARGS_CHARS = 20_000;
/** Paths git would quote in a diff header, so the header cannot be matched back. */
const UNMATCHABLE_HEADER_PATH = /["\\\u0000-\u001f]/;

async function resolveReviewBase(cwd: string): Promise<string> {
  const key = gitCacheKey(cwd);
  const cached = reviewBaseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.base;
  const remember = (base: string): string => {
    reviewBaseCache.set(key, { expiresAt: Date.now() + GIT_METADATA_TTL_MS, base });
    return base;
  };
  try {
    const head = (await run(cwd, ['--no-optional-locks', 'symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
    const short = head.replace(/^refs\/remotes\//, '');
    if (short) return remember(short);
  } catch {
    /* no origin/HEAD ref */
  }
  const candidates = [
    ['origin/main', 'refs/remotes/origin/main'],
    ['origin/master', 'refs/remotes/origin/master'],
    ['main', 'refs/heads/main'],
    ['master', 'refs/heads/master'],
  ];
  for (const [candidate, fullRef] of candidates) {
    try {
      await run(cwd, ['--no-optional-locks', 'rev-parse', '--verify', '--quiet', fullRef]);
      return remember(candidate);
    } catch {
      /* try next */
    }
  }
  return remember('HEAD');
}

/** The tree object every file is added against while HEAD is unborn. */
async function emptyTree(cwd: string): Promise<string> {
  return (await run(cwd, ['--no-optional-locks', 'hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/**
 * The ref a review source diffs the worktree against: `HEAD` for uncommitted
 * work, the merge-base sha with the default branch for the branch view, and
 * the empty tree while HEAD is unborn.
 */
async function resolveReviewRef(root: string, source: GitReviewSource): Promise<{ base: string; ref: string }> {
  if (!(await hasHead(root))) return { base: 'HEAD', ref: await emptyTree(root) };
  if (source === 'uncommitted') return { base: 'HEAD', ref: 'HEAD' };
  return resolveMergeBase(root);
}

/** `base` is the default-branch name; `ref` is its merge-base sha with HEAD. */
async function resolveMergeBase(cwd: string): Promise<{ base: string; ref: string }> {
  const base = await resolveReviewBase(cwd);
  if (base === 'HEAD') return { base, ref: 'HEAD' };
  try {
    return { base, ref: (await run(cwd, ['--no-optional-locks', 'merge-base', base, 'HEAD'])).trim() || 'HEAD' };
  } catch {
    return { base, ref: 'HEAD' };
  }
}

interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  when: string;
  author: string;
  authoredAt: string;
  pushed: boolean;
  parents: string[];
  refs: string[];
  tags: string[];
  branches: string[];
  remotes: string[];
}

function displayRef(value: string): string {
  return value
    .trim()
    .replace(/^HEAD -> /, '')
    .replace(/^tag:\s*/, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '');
}

interface DecodedRefs {
  refs: string[];
  tags: string[];
  branches: string[];
  remotes: string[];
}

function decodeRefs(decorations: string): DecodedRefs {
  const decoded: DecodedRefs = { refs: [], tags: [], branches: [], remotes: [] };
  for (const raw of String(decorations || '').split(', ')) {
    const entry = raw.trim();
    if (!entry) continue;
    const name = displayRef(entry);
    if (!name) continue;
    decoded.refs.push(name);
    const head = entry.replace(/^HEAD -> /, '');
    if (head.startsWith('tag:')) decoded.tags.push(name);
    else if (head.startsWith('refs/remotes/')) decoded.remotes.push(name);
    else if (head !== 'HEAD') decoded.branches.push(name);
  }
  return decoded;
}

export async function gitLog(cwd: string, query = '', skip = 0, limit = 40): Promise<GitLogEntry[]> {
  let raw = '';
  try {
    const safeQuery = String(query || '')
      .trim()
      .slice(0, 200);
    const safeSkip = Math.max(0, Math.floor(Number(skip) || 0));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
    raw = await run(cwd, [
      'log',
      '--all',
      '--topo-order',
      '--decorate=full',
      `--skip=${safeSkip}`,
      `-n${safeLimit}`,
      ...(safeQuery ? ['--regexp-ignore-case', `--grep=${safeQuery}`] : []),
      '--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%cr%x1f%an%x1f%aI',
    ]);
  } catch {
    return [];
  }
  let unpushed = new Set<string>();
  try {
    unpushed = new Set((await run(cwd, ['rev-list', '@{u}..HEAD'])).split(/\s+/).filter(Boolean));
  } catch {
    try {
      unpushed = new Set((await run(cwd, ['rev-list', 'HEAD'])).split(/\s+/).filter(Boolean));
    } catch {
      unpushed = new Set();
    }
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [
        hash = '',
        shortHash = '',
        parents = '',
        decorations = '',
        subject = '',
        when = '',
        author = '',
        authoredAt = '',
      ] = line.split('\u001f');
      const { refs, tags, branches, remotes } = decodeRefs(decorations);
      return {
        hash,
        shortHash,
        subject,
        when,
        author,
        authoredAt,
        pushed: !unpushed.has(hash),
        parents: parents.split(/\s+/).filter(Boolean),
        refs,
        tags,
        branches,
        remotes,
      };
    });
}

interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
}

interface GitCommitDetails {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  authoredAt: string;
  parents: string[];
  files: GitCommitFile[];
}

function parseCommitFiles(statusRaw: string, numstatRaw: string): GitCommitFile[] {
  const stats = parseNumstat(numstatRaw);
  const fields = statusRaw.split('\0');
  const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const token = fields[index++];
    if (!token) continue;
    const status = token[0] || 'M';
    let oldPath: string | undefined;
    if (status === 'R' || status === 'C') {
      oldPath = fields[index++] || undefined;
    }
    const path = fields[index++] || '';
    if (!path) continue;
    const stat = stats.get(path);
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    });
  }
  return files;
}

export async function gitShow(cwd: string, hash: string): Promise<GitCommitDetails> {
  const [metadata, statusRaw, numstatRaw] = await Promise.all([
    run(cwd, ['show', '-s', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P', hash]),
    run(cwd, ['show', '--format=', '--name-status', '-z', '--find-renames', '--first-parent', hash]),
    run(cwd, ['show', '--format=', '--numstat', '-z', '--find-renames', '--first-parent', hash]),
  ]);
  const [
    fullHash = hash,
    shortHash = hash.slice(0, 8),
    subject = '',
    author = '',
    email = '',
    authoredAt = '',
    parents = '',
  ] = metadata.trim().split('\u001f');
  return {
    hash: fullHash,
    shortHash,
    subject,
    author,
    email,
    authoredAt,
    parents: parents.split(/\s+/).filter(Boolean),
    files: parseCommitFiles(statusRaw, numstatRaw),
  };
}

export function gitShowDiff(cwd: string, hash: string, path: string): Promise<string> {
  return run(cwd, [
    'show',
    ...DISPLAY_DIFF_ARGS,
    '--format=',
    '--patch',
    '--find-renames',
    '--first-parent',
    hash,
    '--',
    path,
  ]);
}

export async function gitShowFile(cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    return await run(cwd, ['show', `${rev}:${path.replace(/\\/g, '/')}`]);
  } catch {
    return null;
  }
}

export async function gitReview(cwd: string, source: GitReviewSource = 'branch'): Promise<GitReviewResult> {
  let root: string;
  try {
    root = await cachedGitRoot(cwd);
  } catch {
    return { repository: false, root: '', base: '', files: [], untrackedOmitted: 0 };
  }
  const { base, ref } = await resolveReviewRef(root, source);
  const files = new Map<string, GitReviewFile>();
  const [nameStatus, numstat, worktreeStatus] = await Promise.all([
    run(root, ['--no-optional-locks', 'diff', ref, '--name-status', '--no-renames', '-z']).catch(() => ''),
    run(root, ['--no-optional-locks', 'diff', ref, '--numstat', '--no-renames', '-z']).catch(() => ''),
    run(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).catch(
      () => ''
    ),
  ]);
  const fields = nameStatus.split('\0').filter(Boolean);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1];
    if (!path) continue;
    files.set(path, { path, status: fields[i][0] ?? 'M', additions: 0, deletions: 0, untracked: false, revision: '' });
  }
  for (const [path, stat] of parseNumstat(numstat)) {
    const entry = files.get(path);
    if (!entry) continue;
    entry.additions = stat.additions;
    entry.deletions = stat.deletions;
  }
  const untrackedPaths: string[] = [];
  let untrackedOmitted = 0;
  for (const entry of worktreeStatus.split('\0')) {
    if (!entry.startsWith('?? ') || entry.length < 4) continue;
    if (untrackedPaths.length >= REVIEW_UNTRACKED_LIMIT) {
      untrackedOmitted += 1;
      continue;
    }
    const path = entry.slice(3);
    untrackedPaths.push(path);
    files.set(path, { path, status: 'A', additions: 0, deletions: 0, untracked: true, revision: '' });
  }
  await mapWithConcurrency(untrackedPaths, UNTRACKED_STAT_CONCURRENCY, async (path) => {
    const entry = files.get(path);
    if (entry) entry.additions = await untrackedStat(root, path);
  });
  await mapWithConcurrency([...files.values()], UNTRACKED_STAT_CONCURRENCY, async (entry) => {
    entry.revision = await stat(join(root, entry.path)).then(
      (info) => `${info.size}:${info.mtimeMs}`,
      () => 'deleted'
    );
  });
  return {
    repository: true,
    root,
    base,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    untrackedOmitted,
  };
}

export async function gitReviewDiff(
  cwd: string,
  path: string,
  untracked: boolean,
  source: GitReviewSource = 'branch'
): Promise<string> {
  const root = await cachedGitRoot(cwd);
  if (untracked) return untrackedPatch(root, path);
  const { ref } = await resolveReviewRef(root, source);
  return run(root, [
    '--no-optional-locks',
    'diff',
    ...DISPLAY_DIFF_ARGS,
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ref,
    '--',
    path,
  ]);
}

/**
 * Many `gitReviewDiff`s at once: one `git diff` over every tracked path (split
 * per file) plus file reads for the untracked ones. Paths that cannot be
 * served in bulk (header git would quote, command-line or patch budget spent,
 * output past the process buffer) come back in `omitted`.
 */
export async function gitReviewDiffs(
  cwd: string,
  files: readonly { path: string; untracked: boolean }[],
  source: GitReviewSource = 'branch'
): Promise<GitReviewDiffsResult> {
  const root = await cachedGitRoot(cwd);
  const patches: { path: string; patch: string }[] = [];
  const omitted: string[] = [];
  const tracked: string[] = [];
  const untracked: string[] = [];
  let argChars = 0;
  for (const file of new Map(files.map((entry) => [entry.path, entry])).values()) {
    if (file.untracked) {
      untracked.push(file.path);
      continue;
    }
    argChars += file.path.length + 3;
    if (UNMATCHABLE_HEADER_PATH.test(file.path) || argChars > REVIEW_BATCH_ARGS_CHARS) omitted.push(file.path);
    else tracked.push(file.path);
  }
  let budget = REVIEW_BATCH_PATCH_CHARS;
  const accept = (path: string, patch: string): void => {
    if (patch.length > budget) {
      omitted.push(path);
      return;
    }
    budget -= patch.length;
    patches.push({ path, patch });
  };
  if (tracked.length) {
    const { ref } = await resolveReviewRef(root, source);
    let output: string | null = null;
    try {
      output = await run(root, [
        '-c',
        'core.quotePath=false',
        '--no-optional-locks',
        '--literal-pathspecs',
        'diff',
        ...DISPLAY_DIFF_ARGS,
        // Headers are matched back as `a/<path> b/<path>`: pin the prefixes
        // against diff.noprefix and diff.mnemonicPrefix.
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-renames',
        ref,
        '--',
        ...tracked,
      ]);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('maxBuffer')) throw error;
      omitted.push(...tracked);
    }
    if (output !== null) {
      const byHeader = new Map(tracked.map((path) => [`diff --git a/${path} b/${path}`, path]));
      const chunks = new Map<string, string>();
      let unmatched = false;
      for (const chunk of output.split(/^(?=diff --git )/m)) {
        if (!chunk) continue;
        const path = byHeader.get(chunk.slice(0, chunk.indexOf('\n')));
        if (path !== undefined) chunks.set(path, chunk);
        else unmatched = true;
      }
      // A path with no chunk is unchanged only when every chunk git printed was
      // attributed; otherwise its patch may be among the unmatched ones.
      for (const path of tracked) {
        const chunk = chunks.get(path);
        if (chunk !== undefined) accept(path, chunk);
        else if (unmatched) omitted.push(path);
        else accept(path, '');
      }
    }
  }
  const untrackedPatches = await mapWithConcurrency(untracked, UNTRACKED_STAT_CONCURRENCY, (path) =>
    untrackedPatch(root, path)
  );
  untracked.forEach((path, index) => accept(path, untrackedPatches[index] ?? ''));
  return { patches, omitted };
}
