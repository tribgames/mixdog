import { opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

interface ProjectFileIndex {
  files: string[];
  builtAt: number;
}

const projectFileIndexes = new Map<string, ProjectFileIndex>();
const buildingIndexes = new Map<string, Promise<string[]>>();

export interface IgnoreRule {
  base: string;
  ignored: boolean;
  directoryOnly: boolean;
  matcher: RegExp;
}

function globExpression(pattern: string): string {
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

function fuzzyIndex(value: string, query: string): number {
  let queryIndex = 0;
  let first = -1;
  for (let index = 0; index < value.length && queryIndex < query.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue;
    if (first < 0) first = index;
    queryIndex += 1;
  }
  return queryIndex === query.length ? first : -1;
}

function matchScore(path: string, query: string): number | null {
  if (!query) return 10_000 + path.length;
  const normalized = path.toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (normalized === query) return 0;
  if (basename === query) return 1;
  if (normalized.startsWith(query)) return 10 + normalized.length - query.length;
  if (basename.startsWith(query)) return 20 + basename.length - query.length;
  const contained = normalized.indexOf(query);
  if (contained >= 0) return 100 + contained + normalized.length - query.length;
  const fuzzy = fuzzyIndex(normalized, query);
  return fuzzy < 0 ? null : 1_000 + fuzzy + normalized.length;
}

async function collectProjectFiles(
  root: string,
  options: { maxScannedEntries?: number; yieldEvery?: number } = {}
): Promise<string[]> {
  const directories: Array<{ relative: string; rules: IgnoreRule[] }> = [{ relative: '', rules: [] }];
  const files: string[] = [];
  const maxScannedEntries = Math.max(
    1,
    Math.min(MAX_SCANNED_ENTRIES, options.maxScannedEntries ?? MAX_SCANNED_ENTRIES)
  );
  const yieldEvery = Math.max(1, options.yieldEvery ?? 256);
  let scanned = 0;

  while (directories.length && scanned < maxScannedEntries) {
    const { relative, rules: parentRules } = directories.shift()!;
    let rules = parentRules;
    try {
      const nested = ignoreRules(await readFile(join(root, relative, '.gitignore'), 'utf8'), relative);
      if (nested.length) rules = [...parentRules, ...nested];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const directory = await opendir(join(root, relative));
    for await (const entry of directory) {
      if (scanned >= maxScannedEntries) break;
      scanned += 1;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!DEFAULT_PRUNED_DIRECTORIES.has(entry.name) && !ignoredPath(path, true, rules)) {
          directories.push({ relative: path, rules });
        }
      } else if (entry.isFile() && !ignoredPath(path, false, rules)) {
        files.push(path);
      }
      if (scanned % yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  return files;
}

function buildProjectIndex(root: string): Promise<string[]> {
  const inFlight = buildingIndexes.get(root);
  if (inFlight) return inFlight;
  const build = collectProjectFiles(root)
    .then(
      (files) => {
        projectFileIndexes.delete(root);
        projectFileIndexes.set(root, { files, builtAt: Date.now() });
        while (projectFileIndexes.size > INDEX_CACHE_LIMIT) {
          const oldest = projectFileIndexes.keys().next().value;
          if (oldest === undefined) break;
          projectFileIndexes.delete(oldest);
        }
        return files;
      },
      (error: unknown) => {
        // A root that can no longer be walked must not keep serving its old
        // list; the next search walks again and reports the failure.
        projectFileIndexes.delete(root);
        throw error;
      }
    )
    .finally(() => {
      if (buildingIndexes.get(root) === build) buildingIndexes.delete(root);
    });
  buildingIndexes.set(root, build);
  return build;
}

async function projectFilesFor(root: string): Promise<string[]> {
  const cached = projectFileIndexes.get(root);
  if (!cached) return buildProjectIndex(root);
  // LRU touch so hot roots survive the cache cap.
  projectFileIndexes.delete(root);
  projectFileIndexes.set(root, cached);
  if (Date.now() - cached.builtAt > INDEX_TTL_MS) void buildProjectIndex(root).catch(() => undefined);
  return cached.files;
}

export async function searchProjectDirectory(
  root: string,
  query: string,
  limit: number,
  options: { maxScannedEntries?: number; yieldEvery?: number } = {}
): Promise<string[]> {
  const normalizedQuery = query.trim().replace(/\\/g, '/').toLowerCase();
  // Explicit traversal options (tests, capped callers) bypass the cache so
  // scan-cap semantics stay exact; the interactive keystroke path shares the
  // TTL-cached index.
  const usesCache = options.maxScannedEntries === undefined && options.yieldEvery === undefined;
  const files = usesCache ? await projectFilesFor(root) : await collectProjectFiles(root, options);
  const matches: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const score = matchScore(path, normalizedQuery);
    if (score !== null) matches.push({ path, score });
  }
  return matches
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((match) => match.path);
}
