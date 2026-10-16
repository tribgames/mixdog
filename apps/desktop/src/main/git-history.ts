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
  /** Worktree identity `${size}:${mtimeNs}:${ctimeNs}:${ino}`, or 'deleted' when the file is gone. */
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

// ── Incremental review ───────────────────────────────────────────────────
// The Changes pane and composer chip re-read the review on every burst of
// file activity. A full `git diff <ref>` per read re-scanned the worktree
// twice more than the status scan that already says which files can differ,
// and re-counted every unchanged file. One status scan names the candidates;
// only candidates whose status record or worktree identity moved are diffed
// again (pathspec-limited), the rest keep their cached row.

type ReviewRecord = { status: string; additions: number; deletions: number };

interface ReviewCache {
  /** The diff base the cached rows were counted against (ref and HEAD oid). */
  refKey: string;
  /** Tracked candidate → its key (status record + worktree identity), row (null: no diff) and read time. */
  tracked: Map<string, { key: string; record: ReviewRecord | null; checkedAt: number }>;
  /** Untracked file → the identity its line count was read at, and when. */
  untracked: Map<string, { revision: string; additions: number; checkedAt: number }>;
}

const REVIEW_CACHE_MAX = 16;
/** A cached row older than this is read again even when its identity stands,
 *  so a tool that restores every stat field cannot keep a wrong row forever. */
const REVIEW_REVALIDATE_MS = 30_000;
const reviewCaches = new Map<string, ReviewCache>();
/** `${root}\0${ref}\0${head}` → paths the two commits differ in (immutable). */
const committedPathsCache = new Map<string, string[]>();
const emptyTreeCache = new Map<string, string>();

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > REVIEW_CACHE_MAX) map.delete(map.keys().next().value as K);
}

interface ReviewStatus {
  head: string;
  /** Tracked path → its status record(s): every path whose worktree may differ from HEAD. */
  tracked: Map<string, string>;
  untracked: string[];
}

/** One `status --porcelain=v2` scan: the HEAD oid, the tracked paths that
 *  differ anywhere between HEAD, index and worktree, and the untracked files. */
async function reviewStatus(root: string): Promise<ReviewStatus | null> {
  let raw: string;
  try {
    raw = await run(root, [
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '-z',
      // Only `branch.oid` is read: no upstream ahead/behind walk.
      '--branch',
      '--no-ahead-behind',
      '--untracked-files=all',
      '--no-renames',
    ]);
  } catch {
    return null;
  }
  const result: ReviewStatus = { head: '', tracked: new Map(), untracked: [] };
  const fields = raw.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index];
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) result.head = record.slice('# branch.oid '.length);
    else if (record.startsWith('? ')) result.untracked.push(record.slice(2));
    else if (record.startsWith('1 ')) result.tracked.set(pathAfter(record, 8), record);
    else if (record.startsWith('u ')) result.tracked.set(pathAfter(record, 10), record);
    else if (record.startsWith('2 ')) {
      // A rename (only under a config --no-renames does not reach): both sides.
      const origin = fields[++index] ?? '';
      result.tracked.set(pathAfter(record, 9), record);
      if (origin) result.tracked.set(origin, record);
    }
  }
  return result;
}

function pathAfter(record: string, fieldCount: number): string {
  let offset = 0;
  for (let index = 0; index < fieldCount; index++) {
    offset = record.indexOf(' ', offset) + 1;
    if (offset <= 0) return '';
  }
  return record.slice(offset);
}

/** `git diff <ref> --raw --numstat -z` rows by path (name-status letter and counts). */
function parseRawNumstat(raw: string): Map<string, ReviewRecord> {
  const records = new Map<string, ReviewRecord>();
  const fields = raw.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.startsWith(':')) {
      const path = fields[++index];
      if (!path) continue;
      const status = field.slice(field.lastIndexOf(' ') + 1)[0] ?? 'M';
      const known = records.get(path);
      if (known) known.status = status;
      else records.set(path, { status, additions: 0, deletions: 0 });
    }
  }
  for (const [path, counts] of parseNumstat(raw)) {
    const known = records.get(path);
    if (known) Object.assign(known, counts);
  }
  return records;
}

async function cachedEmptyTree(root: string): Promise<string> {
  const key = gitCacheKey(root);
  let tree = emptyTreeCache.get(key);
  if (!tree) {
    tree = await emptyTree(root);
    boundedSet(emptyTreeCache, key, tree);
  }
  return tree;
}

/** Paths a branch review's base and HEAD differ in: committed changes a
 *  worktree status cannot name. Both are commit ids, so the answer is kept. */
async function committedPaths(root: string, ref: string, head: string): Promise<string[]> {
  const key = `${gitCacheKey(root)}\0${ref}\0${head}`;
  const cached = committedPathsCache.get(key);
  if (cached) return cached;
  const raw = await run(root, ['--no-optional-locks', 'diff', '--name-only', '-z', '--no-renames', ref, head]);
  const paths = raw.split('\0').filter(Boolean);
  boundedSet(committedPathsCache, key, paths);
  return paths;
}

/** Worktree identity: size, modify and change time (ns) and file id. Any write
 *  moves the change time (Windows ChangeTime included) even when a tool puts
 *  the modify time back, and a replacing rename moves the file id. */
const worktreeRevision = (root: string, path: string): Promise<string> =>
  stat(join(root, path), { bigint: true }).then(
    (info) => `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`,
    () => 'deleted'
  );

/** Re-read the rows of `stale` paths against `ref`; `whole` when the path list
 *  outgrew the command line and the whole diff was read instead. */
async function diffStaleRows(
  root: string,
  ref: string,
  stale: string[]
): Promise<{ records: Map<string, ReviewRecord>; whole: boolean }> {
  const args = ['-c', 'core.quotePath=false', '--no-optional-locks', '--literal-pathspecs', 'diff', ref];
  const flags = ['--raw', '--numstat', '--no-renames', '-z'];
  const argChars = stale.reduce((sum, path) => sum + path.length + 3, 0);
  // Past the command-line budget the whole diff is read instead.
  const whole = argChars > REVIEW_BATCH_ARGS_CHARS;
  const raw = await run(root, whole ? [...args, ...flags] : [...args, ...flags, '--', ...stale]).catch(() => '');
  return { records: parseRawNumstat(raw), whole };
}

export async function gitReview(cwd: string, source: GitReviewSource = 'branch'): Promise<GitReviewResult> {
  let root: string;
  try {
    root = await cachedGitRoot(cwd);
  } catch {
    return { repository: false, root: '', base: '', files: [], untrackedOmitted: 0 };
  }
  // The merge-base read runs beside the status scan; an unborn HEAD drops it.
  const [status, mergeBase] = await Promise.all([
    reviewStatus(root),
    source === 'uncommitted' ? null : resolveMergeBase(root),
  ]);
  if (!status) {
    const { base } = await resolveReviewRef(root, source);
    return { repository: true, root, base, files: [], untrackedOmitted: 0 };
  }
  const unborn = !status.head || status.head === '(initial)';
  let base = 'HEAD';
  let ref = 'HEAD';
  if (unborn) ref = await cachedEmptyTree(root);
  else if (mergeBase) ({ base, ref } = mergeBase);
  // Every path the worktree can differ from `ref` in: a status candidate, or
  // (base ≠ HEAD) a path the commits since the base touched.
  const candidates = new Map(status.tracked);
  if (!unborn && ref !== 'HEAD' && ref !== status.head) {
    for (const path of await committedPaths(root, ref, status.head).catch(() => [])) {
      if (!candidates.has(path)) candidates.set(path, '');
    }
  }
  const untrackedPaths = status.untracked.slice(0, REVIEW_UNTRACKED_LIMIT);
  const untrackedOmitted = status.untracked.length - untrackedPaths.length;
  const trackedPaths = [...candidates.keys()];
  const revisions = new Map<string, string>();
  await mapWithConcurrency([...trackedPaths, ...untrackedPaths], UNTRACKED_STAT_CONCURRENCY, async (path) => {
    if (!revisions.has(path)) revisions.set(path, await worktreeRevision(root, path));
  });
  // Cached rows hold while the base, HEAD and every edited attributes file
  // (which can turn a file binary or change its line endings) stand.
  const attributes = [...trackedPaths, ...untrackedPaths]
    .filter((path) => /(^|\/)\.gitattributes$/.test(path))
    .map((path) => `${path}\0${revisions.get(path)}`);
  const refKey = [ref, unborn ? '' : status.head, ...attributes].join('\0');
  const cacheKey = `${gitCacheKey(root)}\0${source}`;
  const previous = reviewCaches.get(cacheKey);
  const priorTracked: ReviewCache['tracked'] = previous?.refKey === refKey ? previous.tracked : new Map();
  const tracked: ReviewCache['tracked'] = new Map();
  const stale: string[] = [];
  const now = Date.now();
  const fresh = (checkedAt: number): boolean => now - checkedAt < REVIEW_REVALIDATE_MS;
  for (const path of trackedPaths) {
    const key = `${candidates.get(path)}\0${revisions.get(path)}`;
    const known = priorTracked.get(path);
    if (known?.key === key && fresh(known.checkedAt)) tracked.set(path, known);
    else {
      tracked.set(path, { key, record: null, checkedAt: now });
      stale.push(path);
    }
  }
  if (stale.length) {
    const { records, whole } = await diffStaleRows(root, ref, stale);
    for (const path of stale) {
      const entry = tracked.get(path);
      if (entry) entry.record = records.get(path) ?? null;
    }
    if (whole) {
      for (const [path, record] of records) {
        if (!tracked.has(path)) tracked.set(path, { key: '', record, checkedAt: now });
      }
    }
  }
  const files = new Map<string, GitReviewFile>();
  for (const [path, { record }] of tracked) {
    if (!record) continue;
    files.set(path, { path, ...record, untracked: false, revision: revisions.get(path) ?? '' });
  }
  const untracked: ReviewCache['untracked'] = new Map();
  await mapWithConcurrency(untrackedPaths, UNTRACKED_STAT_CONCURRENCY, async (path) => {
    const revision = revisions.get(path) ?? '';
    const known = previous?.untracked.get(path);
    // Recounting reads the file once, as a content hash would: any moved
    // identity field or an aged row is simply counted again.
    if (known?.revision === revision && fresh(known.checkedAt)) untracked.set(path, known);
    else untracked.set(path, { revision, additions: await untrackedStat(root, path), checkedAt: now });
  });
  for (const path of untrackedPaths) {
    const entry = untracked.get(path);
    files.set(path, {
      path,
      status: 'A',
      additions: entry?.additions ?? 0,
      deletions: 0,
      untracked: true,
      revision: entry?.revision ?? '',
    });
  }
  // A row read past the arg budget has no key: it is read again next time.
  for (const [path, entry] of tracked) if (!entry.key) tracked.delete(path);
  boundedSet(reviewCaches, cacheKey, { refKey, tracked, untracked });
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
  for (const [index, path] of untracked.entries()) accept(path, untrackedPatches[index] ?? '');
  return { patches, omitted };
}
