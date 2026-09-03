import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  GIT_METADATA_TTL_MS,
  UNTRACKED_STAT_CONCURRENCY,
  gitCacheKey,
  mapWithConcurrency,
  untrackedStat,
} from './git-read-utils';
import {
  publicGitRemoteUrl,
  run,
  streamNulRecords,
} from './git-runner';

export type GitOperation = '' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface GitFileEntry {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
  stagedAdditions: number;
  stagedDeletions: number;
  unstagedAdditions: number;
  unstagedDeletions: number;
  additions: number;
  deletions: number;
}

export interface GitStatusResult {
  repository: boolean;
  branch: string;
  detached: boolean;
  unborn: boolean;
  upstream: boolean;
  upstreamName: string;
  remote: boolean;
  remoteUrl: string;
  ahead: number;
  behind: number;
  operation: GitOperation;
  files: GitFileEntry[];
}

export interface GitStatusOptions {
  reuseLineStats?: boolean;
  skipLineStats?: boolean;
}

function emptyStatus(): GitStatusResult {
  return {
    repository: false,
    branch: '',
    detached: false,
    unborn: false,
    upstream: false,
    upstreamName: '',
    remote: false,
    remoteUrl: '',
    ahead: 0,
    behind: 0,
    operation: '',
    files: [],
  };
}

function pathAfterFields(record: string, fieldCount: number): string {
  let offset = 0;
  for (let index = 0; index < fieldCount; index++) {
    offset = record.indexOf(' ', offset);
    if (offset < 0) return '';
    offset += 1;
  }
  return record.slice(offset);
}

function normalizeStatusLetter(value: string | undefined): string {
  return !value || value === '.' ? ' ' : value;
}

async function readNumstat(
  cwd: string,
  args: string[],
): Promise<Map<string, { additions: number; deletions: number }>> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  let renameStat: { additions: number; deletions: number; oldPathSeen: boolean } | null = null;
  try {
    await streamNulRecords(cwd, args, (field) => {
      if (renameStat) {
        if (!renameStat.oldPathSeen) {
          renameStat.oldPathSeen = true;
          return;
        }
        if (field) stats.set(field, {
          additions: renameStat.additions,
          deletions: renameStat.deletions,
        });
        renameStat = null;
        return;
      }
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field);
      if (!match) return;
      const value = {
        additions: match[1] === '-' ? 0 : Number(match[1]),
        deletions: match[2] === '-' ? 0 : Number(match[2]),
      };
      if (match[3]) stats.set(match[3], value);
      else renameStat = { ...value, oldPathSeen: false };
    });
    return stats;
  } catch {
    return new Map();
  }
}

interface CachedRemoteMetadata {
  expiresAt: number;
  names: string;
  url: string;
}

interface CachedLineStats {
  signature: string;
  files: Map<string, Pick<GitFileEntry,
    'stagedAdditions' | 'stagedDeletions' | 'unstagedAdditions' | 'unstagedDeletions'>>;
}

const remoteMetadataCache = new Map<string, CachedRemoteMetadata>();
const gitDirCache = new Map<string, string>();
const lineStatsCache = new Map<string, CachedLineStats>();

async function remoteMetadata(cwd: string): Promise<CachedRemoteMetadata> {
  const key = gitCacheKey(cwd);
  const cached = remoteMetadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const raw = await run(cwd, ['--no-optional-locks', 'remote', '-v']).catch(() => '');
  const names: string[] = [];
  const urls = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    if (!names.includes(match[1])) names.push(match[1]);
    if (!urls.has(match[1]) || line.endsWith('(fetch)')) urls.set(match[1], match[2]);
  }
  const primary = names.includes('origin') ? 'origin' : names[0] || '';
  const value = {
    expiresAt: Date.now() + GIT_METADATA_TTL_MS,
    names: names.join('\n'),
    url: publicGitRemoteUrl(primary ? urls.get(primary) || '' : ''),
  };
  remoteMetadataCache.set(key, value);
  return value;
}

async function cachedGitDir(cwd: string): Promise<string> {
  const key = gitCacheKey(cwd);
  const cached = gitDirCache.get(key);
  if (cached) return cached;
  const dotGit = join(cwd, '.git');
  let gitDir = '';
  try {
    const text = await readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/mi.exec(text);
    if (match) gitDir = resolve(cwd, match[1]);
  } catch {
    try {
      await access(dotGit);
      gitDir = dotGit;
    } catch {
      gitDir = resolve(cwd, (await run(cwd, [
        '--no-optional-locks', 'rev-parse', '--absolute-git-dir',
      ])).trim());
    }
  }
  gitDirCache.set(key, gitDir);
  return gitDir;
}

function lineStatsSignature(files: GitFileEntry[]): string {
  return files.map((file) =>
    `${file.path}\0${file.oldPath || ''}\0${file.index}\0${file.worktree}\0${file.untracked ? 1 : 0}`)
    .join('\x01');
}

function applyCachedLineStats(files: GitFileEntry[], cached: CachedLineStats): void {
  for (const file of files) {
    const stats = cached.files.get(file.path);
    if (!stats) continue;
    Object.assign(file, stats);
    file.additions = file.stagedAdditions + file.unstagedAdditions;
    file.deletions = file.stagedDeletions + file.unstagedDeletions;
  }
}

async function applyFreshLineStats(
  cwd: string,
  files: GitFileEntry[],
  stagedStats: Map<string, { additions: number; deletions: number }>,
  unstagedStats: Map<string, { additions: number; deletions: number }>,
): Promise<void> {
  const untracked = new Map(await mapWithConcurrency(
    files.filter((file) => file.untracked),
    UNTRACKED_STAT_CONCURRENCY,
    async (file) => [file.path, await untrackedStat(cwd, file.path)] as const,
  ));
  for (const file of files) {
    const staged = stagedStats.get(file.path);
    const unstaged = unstagedStats.get(file.path);
    file.stagedAdditions = staged?.additions ?? 0;
    file.stagedDeletions = staged?.deletions ?? 0;
    file.unstagedAdditions = file.untracked
      ? untracked.get(file.path) ?? 0
      : unstaged?.additions ?? 0;
    file.unstagedDeletions = unstaged?.deletions ?? 0;
    file.additions = file.stagedAdditions + file.unstagedAdditions;
    file.deletions = file.stagedDeletions + file.unstagedDeletions;
  }
}

export async function hasHead(cwd: string): Promise<boolean> {
  try {
    await run(cwd, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function currentGitOperation(cwd: string): Promise<GitOperation> {
  let gitDir = '';
  try {
    gitDir = await cachedGitDir(cwd);
  } catch {
    return '';
  }
  const exists = async (name: string): Promise<boolean> => {
    try {
      await access(join(gitDir, name));
      return true;
    } catch {
      return false;
    }
  };
  const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all([
    exists('rebase-merge'),
    exists('rebase-apply'),
    exists('MERGE_HEAD'),
    exists('CHERRY_PICK_HEAD'),
    exists('REVERT_HEAD'),
  ]);
  if (rebaseMerge || rebaseApply) return 'rebase';
  if (merge) return 'merge';
  if (cherryPick) return 'cherry-pick';
  if (revert) return 'revert';
  return '';
}

export async function gitStatus(
  cwd: string,
  options: GitStatusOptions = {},
): Promise<GitStatusResult> {
  const files: GitFileEntry[] = [];
  let branch = '';
  let oid = '';
  let upstreamName = '';
  let unborn = false;
  let ahead = 0;
  let behind = 0;
  let pendingRename: GitFileEntry | null = null;
  const statusStream = streamNulRecords(
    cwd,
    ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    (entry) => {
      if (pendingRename) {
        if (entry) pendingRename.oldPath = entry;
        files.push(pendingRename);
        pendingRename = null;
        return;
      }
      if (entry.startsWith('# branch.oid ')) {
        oid = entry.slice('# branch.oid '.length);
        unborn = oid === '(initial)';
        return;
      }
      if (entry.startsWith('# branch.head ')) {
        branch = entry.slice('# branch.head '.length);
        return;
      }
      if (entry.startsWith('# branch.upstream ')) {
        upstreamName = entry.slice('# branch.upstream '.length);
        return;
      }
      if (entry.startsWith('# branch.ab ')) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(entry);
        ahead = Number(match?.[1] || 0);
        behind = Number(match?.[2] || 0);
        return;
      }
      if (entry.startsWith('? ')) {
        const path = entry.slice(2);
        if (path) {
          files.push({
            path,
            index: '?',
            worktree: '?',
            untracked: true,
            conflicted: false,
            stagedAdditions: 0,
            stagedDeletions: 0,
            unstagedAdditions: 0,
            unstagedDeletions: 0,
            additions: 0,
            deletions: 0,
          });
        }
        return;
      }
      const kind = entry[0];
      if (kind !== '1' && kind !== '2' && kind !== 'u') return;
      const xy = entry.slice(2, 4);
      const path = pathAfterFields(entry, kind === '1' ? 8 : kind === '2' ? 9 : 10);
      if (!path) return;
      const file: GitFileEntry = {
        path,
        index: normalizeStatusLetter(xy[0]),
        worktree: normalizeStatusLetter(xy[1]),
        untracked: false,
        conflicted: kind === 'u',
        stagedAdditions: 0,
        stagedDeletions: 0,
        unstagedAdditions: 0,
        unstagedDeletions: 0,
        additions: 0,
        deletions: 0,
      };
      if (kind === '2') pendingRename = file;
      else files.push(file);
    },
  );
  const collectLineStats = options.skipLineStats !== true;
  const eagerStats = collectLineStats && options.reuseLineStats !== true;
  const stagedStatsPromise = eagerStats
    ? readNumstat(cwd, ['--no-optional-locks', 'diff', '--cached', '--numstat', '-z'])
    : null;
  const unstagedStatsPromise = eagerStats
    ? readNumstat(cwd, ['--no-optional-locks', 'diff', '--numstat', '-z'])
    : null;
  const metadataPromise = remoteMetadata(cwd);
  const operationPromise = currentGitOperation(cwd);
  try {
    await statusStream;
  } catch {
    return emptyStatus();
  }
  if (pendingRename) files.push(pendingRename);
  const [metadata, operation] = await Promise.all([metadataPromise, operationPromise]);
  if (collectLineStats) {
    const cacheKey = gitCacheKey(cwd);
    const signature = lineStatsSignature(files);
    const cachedStats = lineStatsCache.get(cacheKey);
    if (options.reuseLineStats === true && cachedStats?.signature === signature) {
      applyCachedLineStats(files, cachedStats);
    } else {
      const [stagedStats, unstagedStats] = await Promise.all([
        stagedStatsPromise
          ?? readNumstat(cwd, ['--no-optional-locks', 'diff', '--cached', '--numstat', '-z']),
        unstagedStatsPromise
          ?? readNumstat(cwd, ['--no-optional-locks', 'diff', '--numstat', '-z']),
      ]);
      await applyFreshLineStats(cwd, files, stagedStats, unstagedStats);
      lineStatsCache.set(cacheKey, {
        signature,
        files: new Map(files.map((file) => [file.path, {
          stagedAdditions: file.stagedAdditions,
          stagedDeletions: file.stagedDeletions,
          unstagedAdditions: file.unstagedAdditions,
          unstagedDeletions: file.unstagedDeletions,
        }])),
      });
    }
  }

  const detached = branch === '(detached)';
  if (detached) {
    branch = oid && oid !== '(initial)' ? `HEAD (${oid.slice(0, 8)})` : 'Detached HEAD';
  }
  return {
    repository: true,
    branch,
    detached,
    unborn,
    upstream: Boolean(upstreamName),
    upstreamName,
    remote: metadata.names.length > 0,
    remoteUrl: metadata.url,
    ahead,
    behind,
    operation,
    files,
  };
}
