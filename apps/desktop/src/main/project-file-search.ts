import { opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_PRUNED_DIRECTORIES = new Set(['.git', 'node_modules']);
const MAX_SCANNED_ENTRIES = 100_000;

interface IgnoreRule {
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

function ignoreRules(source: string, base: string): IgnoreRule[] {
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
    return [{
      base,
      ignored,
      directoryOnly,
      matcher: new RegExp(anchored || pattern.includes('/')
        ? `^${expression}(?:/.*)?$`
        : `(?:^|/)${expression}(?:/.*)?$`),
    }];
  });
}

function ignoredPath(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const candidate = rule.base
      ? (path.startsWith(`${rule.base}/`) ? path.slice(rule.base.length + 1) : null)
      : path;
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

export async function searchProjectDirectory(
  root: string,
  query: string,
  limit: number,
  options: { maxScannedEntries?: number; yieldEvery?: number } = {},
): Promise<string[]> {
  const directories: Array<{ relative: string; rules: IgnoreRule[] }> = [{ relative: '', rules: [] }];
  const matches: Array<{ path: string; score: number }> = [];
  const normalizedQuery = query.trim().replace(/\\/g, '/').toLowerCase();
  const maxScannedEntries = Math.max(
    1,
    Math.min(MAX_SCANNED_ENTRIES, options.maxScannedEntries ?? MAX_SCANNED_ENTRIES),
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
        const score = matchScore(path, normalizedQuery);
        if (score !== null) matches.push({ path, score });
      }
      if (scanned % yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  return matches
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((match) => match.path);
}
