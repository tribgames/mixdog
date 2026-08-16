import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DesktopWorkspaceTextFileResult,
  DesktopWorkspaceTextMatch,
  DesktopWorkspaceTextReplaceResult,
  DesktopWorkspaceTextSearchOptions,
  DesktopWorkspaceTextSearchResult,
} from '../shared/contract';
import {
  decodeProjectText,
  projectEntryPathIn,
  writeProjectTextFilesIn,
} from './project-files';
import { ignoreRules, ignoredPath, type IgnoreRule } from './project-file-search';

const SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.mixdog', 'node_modules', '.venv', 'venv',
  'dist', 'build', 'out', 'coverage', 'target', '__pycache__',
]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2_097_152;
const MAX_REPLACE_FILES = 100;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

interface WorkspaceWrite {
  relPath: string;
  content: string;
  expectedContent: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function globExpression(pattern: string): RegExp {
  const normalized = normalizePath(pattern.trim());
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(normalized.includes('/') ? `^${source}$` : `(?:^|/)${source}$`, 'i');
}

function globList(value = ''): RegExp[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map(globExpression);
}

function acceptsPath(path: string, include: RegExp[], exclude: RegExp[]): boolean {
  if (exclude.some((pattern) => pattern.test(path))) return false;
  return include.length === 0 || include.some((pattern) => pattern.test(path));
}

async function workspaceFiles(root: string, options: DesktopWorkspaceTextSearchOptions): Promise<string[]> {
  const include = globList(options.include);
  const exclude = globList(options.exclude);
  const files: string[] = [];
  // Breadth-first walk with nested .gitignore and ripgrep-style pruning.
  // Rules accumulate down the tree so a child
  // directory inherits every ancestor's patterns; ignored directories are
  // pruned before descent, keeping build-output trees out of the scan/read
  // budget entirely instead of only out of the results.
  const queue: Array<{ relative: string; depth: number; rules: IgnoreRule[] }> = [
    { relative: '', depth: 0, rules: [] },
  ];
  while (queue.length && files.length < MAX_FILES) {
    const { relative: relDir, depth, rules: parentRules } = queue.shift()!;
    let rules = parentRules;
    try {
      const nested = ignoreRules(await readFile(join(root, relDir, '.gitignore'), 'utf8'), relDir);
      if (nested.length) rules = [...parentRules, ...nested];
    } catch { /* no .gitignore here — inherit ancestor rules */ }
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < 24
          && !SKIPPED_DIRECTORIES.has(entry.name)
          && !ignoredPath(relPath, true, rules)) {
          queue.push({ relative: relPath, depth: depth + 1, rules });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (ignoredPath(relPath, false, rules)) continue;
      if (acceptsPath(relPath, include, exclude)) files.push(relPath);
    }
  }
  return files;
}

function searchRegex(options: DesktopWorkspaceTextSearchOptions): RegExp {
  const source = options.regex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, `gu${options.matchCase ? '' : 'i'}`);
  } catch (error) {
    throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isWholeWord(content: string, start: number, end: number): boolean {
  const before = start > 0 ? content[start - 1] : '';
  const after = end < content.length ? content[end] : '';
  return (!before || !WORD_CHARACTER.test(before)) && (!after || !WORD_CHARACTER.test(after));
}

function lineMatches(
  line: string,
  lineNumber: number,
  options: DesktopWorkspaceTextSearchOptions,
  remaining: number,
): DesktopWorkspaceTextMatch[] {
  const regex = searchRegex(options);
  const matches: DesktopWorkspaceTextMatch[] = [];
  let match: RegExpExecArray | null;
  while (matches.length < remaining && (match = regex.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (!options.wholeWord || isWholeWord(line, start, end)) {
      matches.push({
        line: lineNumber,
        column: start + 1,
        endColumn: Math.max(start + 1, end + 1),
        preview: line.slice(0, 1_000),
        matchText: match[0],
      });
    }
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return matches;
}

async function readSearchableFile(root: string, relPath: string): Promise<string | null> {
  const absolute = projectEntryPathIn(root, relPath);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return null;
  const decoded = decodeProjectText(await readFile(absolute));
  return decoded.binary ? null : decoded.content;
}

export async function searchWorkspaceTextIn(
  root: string,
  options: DesktopWorkspaceTextSearchOptions,
): Promise<DesktopWorkspaceTextSearchResult> {
  const maximum = Math.min(5_000, Math.max(1, options.maxResults ?? 2_000));
  const files = await workspaceFiles(root, options);
  const results: DesktopWorkspaceTextFileResult[] = [];
  let matchCount = 0;
  // Batched read concurrency: sequential await-per-file left the search
  // latency dominated by disk round-trips on large repos. Reads fan out in
  // small batches while matching stays in file order, so results and the
  // result cap remain deterministic (at most one batch of extra reads).
  const READ_BATCH = 8;
  for (let start = 0; start < files.length && matchCount < maximum; start += READ_BATCH) {
    const batch = files.slice(start, start + READ_BATCH);
    const contents = await Promise.all(batch.map((relPath) => readSearchableFile(root, relPath)));
    for (let offset = 0; offset < batch.length && matchCount < maximum; offset += 1) {
      const content = contents[offset];
      if (content === null) continue;
      const matches: DesktopWorkspaceTextMatch[] = [];
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matchCount < maximum; index += 1) {
        const found = lineMatches(lines[index], index + 1, options, maximum - matchCount);
        matches.push(...found);
        matchCount += found.length;
      }
      if (matches.length) results.push({ relPath: batch[offset], matches });
    }
  }
  return { files: results, matchCount, limitHit: matchCount >= maximum };
}

function replacementText(template: string, match: RegExpExecArray, input: string): string {
  return template.replace(/\$(\$|&|`|'|\d{1,2})/g, (token, key: string) => {
    if (key === '$') return '$';
    if (key === '&') return match[0];
    if (key === '`') return input.slice(0, match.index);
    if (key === "'") return input.slice(match.index + match[0].length);
    const index = Number(key);
    return Number.isInteger(index) && index > 0 && index < match.length
      ? String(match[index] ?? '')
      : token;
  });
}

function replaceContent(
  content: string,
  options: DesktopWorkspaceTextSearchOptions,
  replacement: string,
): { content: string; replacements: number } {
  const regex = searchRegex(options);
  const parts: string[] = [];
  let cursor = 0;
  let replacements = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const end = match.index + match[0].length;
    if (!options.wholeWord || isWholeWord(content, match.index, end)) {
      parts.push(content.slice(cursor, match.index));
      parts.push(options.regex ? replacementText(replacement, match, content) : replacement);
      cursor = end;
      replacements += 1;
    }
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (!replacements) return { content, replacements: 0 };
  parts.push(content.slice(cursor));
  return { content: parts.join(''), replacements };
}

export async function replaceWorkspaceTextIn(
  root: string,
  options: DesktopWorkspaceTextSearchOptions,
  replacement: string,
  relPaths: readonly string[] | undefined,
  beforeWrite?: (write: WorkspaceWrite) => Promise<void>,
): Promise<DesktopWorkspaceTextReplaceResult> {
  const search = await searchWorkspaceTextIn(root, options);
  if (search.limitHit) throw new Error('Search result limit reached. Narrow the search before replacing.');
  const requested = relPaths?.length ? new Set(relPaths.map(normalizePath)) : null;
  const matchedPaths = search.files
    .map((entry) => entry.relPath)
    .filter((path) => !requested || requested.has(path));
  const writes: WorkspaceWrite[] = [];
  let replacements = 0;
  for (const relPath of matchedPaths) {
    const expectedContent = await readSearchableFile(root, relPath);
    if (expectedContent === null) continue;
    const next = replaceContent(expectedContent, options, replacement);
    if (!next.replacements || next.content === expectedContent) continue;
    writes.push({ relPath, content: next.content, expectedContent });
    replacements += next.replacements;
  }
  if (writes.length > MAX_REPLACE_FILES) {
    throw new Error(`Replace affects ${writes.length} files. Narrow the search to ${MAX_REPLACE_FILES} files or fewer.`);
  }
  if (!writes.length) return { filesChanged: 0, replacements: 0, paths: [] };
  if (beforeWrite) await Promise.all(writes.map(beforeWrite));
  await writeProjectTextFilesIn(root, writes);
  return { filesChanged: writes.length, replacements, paths: writes.map((write) => write.relPath) };
}
