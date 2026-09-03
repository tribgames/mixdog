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
import { run } from './git-runner';

const reviewBaseCache = new Map<string, { expiresAt: number; base: string }>();

export function gitDiff(
  cwd: string,
  path: string,
  staged: boolean,
  worktreeOnly = false,
  untracked = false,
): Promise<string> {
  if (untracked) return untrackedPatch(cwd, path);
  return run(cwd, [
    '--no-optional-locks',
    'diff',
    ...DISPLAY_DIFF_ARGS,
    ...(staged ? ['--cached'] : worktreeOnly ? [] : ['HEAD']),
    '--',
    path,
  ]);
}

export interface GitReviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  untracked: boolean;
  uncommitted: boolean;
}

export interface GitReviewResult {
  base: string;
  files: GitReviewFile[];
}

async function resolveReviewBase(cwd: string): Promise<string> {
  const key = gitCacheKey(cwd);
  const cached = reviewBaseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.base;
  const remember = (base: string): string => {
    reviewBaseCache.set(key, { expiresAt: Date.now() + GIT_METADATA_TTL_MS, base });
    return base;
  };
  try {
    const head = (await run(cwd, [
      '--no-optional-locks', 'symbolic-ref', 'refs/remotes/origin/HEAD',
    ])).trim();
    const short = head.replace(/^refs\/remotes\//, '');
    if (short) return remember(short);
  } catch { /* no origin/HEAD ref */ }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await run(cwd, [
        '--no-optional-locks', 'rev-parse', '--verify', '--quiet', candidate,
      ]);
      return remember(candidate);
    } catch { /* try next */ }
  }
  return remember('HEAD');
}

async function resolveMergeBase(cwd: string): Promise<{ base: string; ref: string }> {
  const base = await resolveReviewBase(cwd);
  return { base, ref: base === 'HEAD' ? 'HEAD' : `${base}...HEAD` };
}

export interface GitLogEntry {
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
  return value.trim()
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

export async function gitLog(
  cwd: string,
  query = '',
  skip = 0,
  limit = 40,
): Promise<GitLogEntry[]> {
  let raw = '';
  try {
    const safeQuery = String(query || '').trim().slice(0, 200);
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
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash = '', shortHash = '', parents = '', decorations = '', subject = '',
      when = '', author = '', authoredAt = ''] =
      line.split('\u001f');
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

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitCommitDetails {
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
  for (let index = 0; index < fields.length;) {
    const token = fields[index++];
    if (!token) continue;
    const status = token[0] || 'M';
    let oldPath: string | undefined;
    let path = '';
    if (status === 'R' || status === 'C') {
      oldPath = fields[index++] || undefined;
      path = fields[index++] || '';
    } else {
      path = fields[index++] || '';
    }
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
  const [fullHash = hash, shortHash = hash.slice(0, 8), subject = '', author = '', email = '',
    authoredAt = '', parents = ''] = metadata.trim().split('\u001f');
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

export async function gitReview(cwd: string): Promise<GitReviewResult> {
  const { base, ref } = await resolveMergeBase(cwd);
  const files = new Map<string, GitReviewFile>();
  const [nameStatus, numstat, worktreeStatus] = await Promise.all([
    run(cwd, [
      '--no-optional-locks', 'diff', ref, '--name-status', '--no-renames', '-z',
    ]).catch(() => ''),
    run(cwd, [
      '--no-optional-locks', 'diff', ref, '--numstat', '--no-renames', '-z',
    ]).catch(() => ''),
    run(cwd, [
      '--no-optional-locks', 'status', '--porcelain=v1', '-z',
      '--untracked-files=all', '--no-renames',
    ]).catch(() => ''),
  ]);
  try {
    const fields = nameStatus.split('\0').filter(Boolean);
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const path = fields[i + 1];
      if (!path) continue;
      files.set(path, {
        path,
        status: fields[i][0] ?? 'M',
        additions: 0,
        deletions: 0,
        untracked: false,
        uncommitted: false,
      });
    }
    for (const field of numstat.split('\0').filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field);
      const entry = match && match[3] ? files.get(match[3]) : undefined;
      if (!match || !entry) continue;
      entry.additions = match[1] === '-' ? 0 : Number(match[1]);
      entry.deletions = match[2] === '-' ? 0 : Number(match[2]);
    }
  } catch { /* empty repository (no HEAD yet) */ }
  const untrackedPaths: string[] = [];
  try {
    for (const entry of worktreeStatus.split('\0')) {
      if (entry.length < 4) continue;
      const path = entry.slice(3);
      if (!path) continue;
      const untracked = entry[0] === '?' && entry[1] === '?';
      if (untracked) untrackedPaths.push(path);
      const existing = files.get(path);
      if (existing) {
        existing.uncommitted = true;
        existing.untracked = untracked;
        continue;
      }
      files.set(path, {
        path,
        status: untracked ? 'A' : 'M',
        additions: 0,
        deletions: 0,
        untracked,
        uncommitted: true,
      });
    }
  } catch { /* not a repository */ }
  await mapWithConcurrency(untrackedPaths, UNTRACKED_STAT_CONCURRENCY, async (path) => {
    const entry = files.get(path);
    if (entry?.untracked) entry.additions = await untrackedStat(cwd, path);
  });
  return { base, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function gitReviewDiff(cwd: string, path: string, untracked: boolean): Promise<string> {
  if (untracked) return untrackedPatch(cwd, path);
  const { ref } = await resolveMergeBase(cwd);
  return run(cwd, ['--no-optional-locks', 'diff', ...DISPLAY_DIFF_ARGS, ref, '--', path]);
}
