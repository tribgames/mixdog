import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative as relativePath, sep } from 'node:path';
import { compareFileMatches, matchFile, normalizeFileQuery, type FileMatch } from '../shared/file-match';

const DEFAULT_PRUNED_DIRECTORIES = new Set(['.git', 'node_modules']);
const MAX_SCANNED_ENTRIES = 100_000;
// Cached file lists per project root so a keystroke burst scores an in-memory
// index instead of re-walking the tree per keystroke (file-picker
// behavior). Invalidation is TTL-based ON PURPOSE: a recursive fs.watch on the
// project root silently flips the process exit code to 1 on Windows when the
// watched root itself is deleted (no 'error' event, verified empirically), so
// a TTL is the reliable cross-platform staleness bound. A stale index is
// still served while it rebuilds in the background (stale-while-revalidate),
// so only a root's first search waits for a walk; the next search after the
// rebuild sees current files.
const INDEX_CACHE_LIMIT = 16;
const INDEX_TTL_MS = 60_000;

// A typed query that has to walk past the scan cap gives up after this long
// and answers with what the index and the partial walk found.
const BEYOND_BUDGET_MS = 400;

const projectFileIndexes = new Map<string, ProjectIndex>();
// The search in flight per consumer; the consumer's next search supersedes it.
const consumerSearches = new Map<string, AbortController>();
const buildingIndexes = new Map<string, Promise<ProjectIndex>>();

export interface IgnoreRule {
  base: string;
  ignored: boolean;
  directoryOnly: boolean;
  matcher: RegExp;
}

/** Regular-expression source for a glob: `**` crosses folders, `*` and `?`
 *  stay inside one path segment, everything else is literal. */
export function globExpression(pattern: string): string {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return expression;
}

export function ignoreRules(source: string, base: string): IgnoreRule[] {
  return source.split(/\r?\n/).flatMap((line): IgnoreRule[] => {
    let pattern = line.trim();
    if (!pattern || pattern.startsWith('#')) return [];
    const ignored = !pattern.startsWith('!');
    if (!ignored) pattern = pattern.slice(1);
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);
    if (!pattern) return [];
    const expression = globExpression(pattern);
    return [
      {
        base,
        ignored,
        directoryOnly,
        matcher: new RegExp(
          anchored || pattern.includes('/') ? `^${expression}(?:/.*)?$` : `(?:^|/)${expression}(?:/.*)?$`
        ),
      },
    ];
  });
}

export function ignoredPath(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    let candidate: string | null = path;
    if (rule.base) candidate = path.startsWith(`${rule.base}/`) ? path.slice(rule.base.length + 1) : null;
    if (candidate !== null && (!rule.directoryOnly || directory) && rule.matcher.test(candidate)) {
      ignored = rule.ignored;
    }
  }
  return ignored;
}

export interface ProjectFileSearchOptions {
  maxScannedEntries?: number;
  yieldEvery?: number;
  /** Also list gitignored files (still pruning `.git` and `node_modules`):
   *  chat links name build outputs and deliverables the picker leaves out. */
  includeIgnored?: boolean;
  /** Also list folders, as `path/` (the composer @-mention palette). */
  includeDirectories?: boolean;
  /** Stops the walk past the scan cap; the answer is then partial. */
  signal?: AbortSignal;
  /** Who is asking (a window): each new search of a consumer supersedes its
   *  previous one, which stops walking and answers with what it has. Other
   *  consumers of the same root are unaffected. */
  consumer?: string;
  /** Time the walk past the scan cap may take (default 400 ms). */
  beyondBudgetMs?: number;
}

interface PendingDirectory {
  relative: string;
  rules: IgnoreRule[];
}

/** A walked project: its listed paths, and the folders the scan cap left
 *  unvisited (empty when the whole tree was walked). */
interface ProjectIndex {
  files: string[];
  pending: PendingDirectory[];
  builtAt: number;
  /** Every path beyond the index containing `needle`, from a walk that
   *  finished: any query containing `needle` is answered from it. */
  beyond?: { needle: string; matches: string[] };
}

/** A link is listed only when its canonical target lies inside the project
 *  (and is not the project itself) and is not excluded as its own path would
 *  be: the default exclusions and, unless ignored files are wanted, the
 *  `.gitignore` rules. A linked folder is listed but never walked: its
 *  contents are already listed under their real paths. */
async function linkAllowed(
  root: string,
  rootReal: string,
  path: string,
  directory: boolean,
  includeIgnored: boolean,
  shouldStop?: () => boolean
): Promise<boolean> {
  try {
    const target = await realpath(join(root, path));
    if (shouldStop?.()) return false;
    const inside = relativePath(rootReal, target);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
    const segments = inside.split(sep);
    if (segments.some((segment) => DEFAULT_PRUNED_DIRECTORIES.has(segment))) return false;
    if (includeIgnored) return true;
    const rules: IgnoreRule[] = [];
    for (let depth = 0; depth < segments.length; depth += 1) {
      const base = segments.slice(0, depth).join('/');
      // Missing rules are none; unreadable ones reject the link (no fail-open).
      const source = await readFile(join(rootReal, base, '.gitignore'), 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      if (shouldStop?.()) return false;
      rules.push(...ignoreRules(source, base));
      const prefix = segments.slice(0, depth + 1).join('/');
      if (ignoredPath(prefix, depth < segments.length - 1 || directory, rules)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Breadth-first walk of `directories`, reporting each listed path to `add`.
 *  Stops after `maxScannedEntries` entries and returns the folders left over
 *  (the interrupted one first, so it is rescanned whole). */
async function walkDirectories(
  root: string,
  directories: PendingDirectory[],
  add: (path: string) => void,
  options: ProjectFileSearchOptions & { maxScannedEntries: number; shouldStop?: () => boolean }
): Promise<PendingDirectory[]> {
  const { maxScannedEntries, shouldStop } = options;
  const yieldEvery = Math.max(1, options.yieldEvery ?? 256);
  const rootReal = await realpath(root);
  let scanned = 0;

  while (directories.length && scanned < maxScannedEntries && !shouldStop?.()) {
    const current = directories.shift()!;
    const { relative, rules: parentRules } = current;
    let rules = parentRules;
    let incompleteRules = false;
    if (!options.includeIgnored) {
      try {
        const nested = ignoreRules(await readFile(join(root, relative, '.gitignore'), 'utf8'), relative);
        if (nested.length) rules = [...parentRules, ...nested];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Only the project root must be readable; a descendant whose rules
          // cannot be read is skipped rather than searched without them.
          if (!relative) throw error;
          incompleteRules = true;
        }
      }
    }
    if (incompleteRules) continue;
    // A stop while the rules were read issues no further filesystem work.
    if (shouldStop?.()) {
      directories.unshift(current);
      break;
    }

    const children = new Set<PendingDirectory>();
    const directory = await opendir(join(root, relative)).catch((error: unknown) => {
      if (!relative) throw error;
      return null;
    });
    if (!directory) continue;
    if (shouldStop?.()) {
      await directory.close().catch(() => undefined);
      directories.unshift(current);
      break;
    }
    for await (const entry of directory) {
      if (scanned >= maxScannedEntries || shouldStop?.()) {
        // The folder is rescanned whole later, which queues its children again.
        directories.splice(0, directories.length, current, ...directories.filter((next) => !children.has(next)));
        break;
      }
      scanned += 1;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      let linkedDirectory = false;
      if (entry.isSymbolicLink()) {
        // Links and Windows junctions list as what they point at; a broken
        // link, or one leading out of the project, is neither.
        const target = await stat(join(root, path)).catch(() => null);
        isDirectory = Boolean(target?.isDirectory());
        isFile = Boolean(target?.isFile());
        if (
          (isDirectory || isFile) &&
          (shouldStop?.() ||
            !(await linkAllowed(root, rootReal, path, isDirectory, Boolean(options.includeIgnored), shouldStop)))
        ) {
          isDirectory = false;
          isFile = false;
        }
        linkedDirectory = isDirectory;
      }
      if (isDirectory) {
        if (!DEFAULT_PRUNED_DIRECTORIES.has(entry.name) && !ignoredPath(path, true, rules)) {
          // Folders share the index, marked by a trailing slash.
          add(`${path}/`);
          if (!linkedDirectory) {
            const child = { relative: path, rules };
            children.add(child);
            directories.push(child);
          }
        }
      } else if (isFile && !ignoredPath(path, false, rules)) {
        add(path);
      }
      if (scanned % yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  return directories;
}

async function collectProjectFiles(root: string, options: ProjectFileSearchOptions = {}): Promise<ProjectIndex> {
  const files: string[] = [];
  const pending = await walkDirectories(root, [{ relative: '', rules: [] }], (path) => files.push(path), {
    ...options,
    maxScannedEntries: Math.max(1, Math.min(MAX_SCANNED_ENTRIES, options.maxScannedEntries ?? MAX_SCANNED_ENTRIES)),
  });
  return { files, pending, builtAt: Date.now() };
}

/** The cap keeps the cached index small, not the search narrow: a typed query
 *  also walks the folders the cap left over, keeping only what matches. */
async function collectMatchesBeyondIndex(
  root: string,
  index: ProjectIndex,
  query: string,
  options: ProjectFileSearchOptions,
  signal: AbortSignal
): Promise<string[]> {
  const needle = normalizeFileQuery(query);
  // Every match of a query contains each shorter query it contains, so a
  // finished walk answers the keystrokes that extend it without walking again.
  if (index.beyond && needle.includes(index.beyond.needle)) {
    return index.beyond.matches.filter((path) => matchFile(path, query));
  }
  // The answer is due at the budget or on abort even if the walk is still
  // waiting on the disk; the walk then starts no further work and keeps nothing.
  let stopped = false;
  const shouldStop = () => stopped || signal.aborted;
  const found: string[] = [];
  const walk = walkDirectories(
    root,
    [...index.pending],
    (path) => {
      if (!shouldStop() && matchFile(path, query)) found.push(path);
    },
    { ...options, maxScannedEntries: Number.POSITIVE_INFINITY, shouldStop }
  ).then((left) => {
    if (!left.length && !shouldStop() && found.length <= MAX_SCANNED_ENTRIES) {
      index.beyond = { needle, matches: found };
    }
  });
  walk.catch(() => undefined);
  let due!: () => void;
  const dueAt = new Promise<void>((resolve) => {
    due = resolve;
  });
  const timer = setTimeout(() => {
    stopped = true;
    due();
  }, options.beyondBudgetMs ?? BEYOND_BUDGET_MS);
  if (signal.aborted) due();
  else signal.addEventListener('abort', due, { once: true });
  try {
    await Promise.race([walk, dueAt]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', due);
  }
  return found.slice();
}

// The gitignore-blind list is a separate index of the same root.
function indexKey(root: string, includeIgnored: boolean, maxScannedEntries?: number): string {
  return `${root}${includeIgnored ? '\0ignored' : ''}${maxScannedEntries === undefined ? '' : `\0cap${maxScannedEntries}`}`;
}

function buildProjectIndex(root: string, includeIgnored: boolean, maxScannedEntries?: number): Promise<ProjectIndex> {
  const key = indexKey(root, includeIgnored, maxScannedEntries);
  const inFlight = buildingIndexes.get(key);
  if (inFlight) return inFlight;
  const build = collectProjectFiles(root, { includeIgnored, maxScannedEntries })
    .then(
      (index) => {
        projectFileIndexes.delete(key);
        projectFileIndexes.set(key, index);
        while (projectFileIndexes.size > INDEX_CACHE_LIMIT) {
          const oldest = projectFileIndexes.keys().next().value;
          if (oldest === undefined) break;
          projectFileIndexes.delete(oldest);
        }
        return index;
      },
      (error: unknown) => {
        // A root that can no longer be walked must not keep serving its old
        // list; the next search walks again and reports the failure.
        projectFileIndexes.delete(key);
        throw error;
      }
    )
    .finally(() => {
      if (buildingIndexes.get(key) === build) buildingIndexes.delete(key);
    });
  buildingIndexes.set(key, build);
  return build;
}

async function projectIndexFor(
  root: string,
  includeIgnored: boolean,
  maxScannedEntries?: number
): Promise<ProjectIndex> {
  const key = indexKey(root, includeIgnored, maxScannedEntries);
  const cached = projectFileIndexes.get(key);
  if (!cached) return buildProjectIndex(root, includeIgnored, maxScannedEntries);
  // LRU touch so hot roots survive the cache cap.
  projectFileIndexes.delete(key);
  projectFileIndexes.set(key, cached);
  if (Date.now() - cached.builtAt > INDEX_TTL_MS)
    void buildProjectIndex(root, includeIgnored, maxScannedEntries).catch(() => undefined);
  return cached;
}

export async function searchProjectDirectory(
  root: string,
  query: string,
  limit: number,
  options: ProjectFileSearchOptions = {}
): Promise<string[]> {
  const request = new AbortController();
  if (options.signal?.aborted) request.abort();
  else options.signal?.addEventListener('abort', () => request.abort(), { once: true });
  if (options.consumer !== undefined) {
    consumerSearches.get(options.consumer)?.abort();
    consumerSearches.set(options.consumer, request);
  }
  try {
    return await searchWithin(root, query, limit, options, request.signal);
  } finally {
    if (options.consumer !== undefined && consumerSearches.get(options.consumer) === request) {
      consumerSearches.delete(options.consumer);
    }
  }
}

async function searchWithin(
  root: string,
  query: string,
  limit: number,
  options: ProjectFileSearchOptions,
  signal: AbortSignal
): Promise<string[]> {
  // An empty query lists only the root's own entries, folders first, then by
  // name; any other query ranks by the shared file-match score.
  const rootOnly = !normalizeFileQuery(query);
  // An explicit yield interval (tests) bypasses the cache; the interactive
  // keystroke path shares the TTL-cached index (one per scan cap).
  const index =
    options.yieldEvery === undefined
      ? await projectIndexFor(root, Boolean(options.includeIgnored), options.maxScannedEntries)
      : await collectProjectFiles(root, options);
  let files = index.files;
  if (!rootOnly && index.pending.length) {
    // The interrupted folder is rescanned whole, so drop what the index has.
    const indexed = new Set(files);
    const beyond = await collectMatchesBeyondIndex(root, index, query, options, signal);
    files = [...files, ...beyond.filter((path) => !indexed.has(path))];
  }
  const matches: Array<{ path: string; match: FileMatch; name: string; directory: boolean }> = [];
  for (const path of files) {
    const directory = path.endsWith('/');
    if (directory && !options.includeDirectories) continue;
    const entry = directory ? path.slice(0, -1) : path;
    if (rootOnly && entry.includes('/')) continue;
    const match = matchFile(path, query);
    if (match) matches.push({ path, match, name: entry.slice(entry.lastIndexOf('/') + 1), directory });
  }
  return matches
    .sort(
      rootOnly
        ? (left, right) =>
            Number(right.directory) - Number(left.directory) ||
            left.name.localeCompare(right.name) ||
            left.path.localeCompare(right.path)
        : compareFileMatches
    )
    .slice(0, limit)
    .map((match) => match.path);
}
