/**
 * `.worktreeinclude` (optional, at the repository root): untracked local
 * files a fresh managed worktree should start with. Non-executable format,
 * one entry per line, `#` comments:
 *
 *   copy <relpath>   copy the file or directory into the worktree
 *   link <relpath>   link it (directory junction on Windows, symlink elsewhere)
 *   <pattern>        any other line: a .gitignore-style pattern (the format
 *                    other tools' `.worktreeinclude` files use); every
 *                    untracked path it matches that the repository also
 *                    git-ignores is copied. Explicit copy/link entries win.
 *
 * No entry is ever a creation failure: a line whose path breaks the rules
 * below (or a pattern git cannot use) is skipped with `include-invalid:<line>`,
 * and an entry or match that resolves somewhere it must not (outside the
 * repository, into .git, a Unity Library or project link, through a link in
 * the worktree) is skipped with `include-skipped:<path>`. A skipped entry is
 * never copied or linked.
 *
 * Rules: relative paths only (no absolute, `..`, `.git` or `:`); the source
 * must resolve inside the repository (no escape through links); an existing
 * path in the checkout is never overwritten; a Unity `Library` directory is
 * never copied or linked. A link that cannot be made fails the creation
 * clearly — it never degrades into a (possibly huge) copy.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  cp,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isWorktreeError, worktreeError } from './contract.mjs';
import { runGit } from './git.mjs';
import { isWithin } from './paths.mjs';

const INCLUDE_FILE = '.worktreeinclude';
const MAX_DIGEST_ENTRIES = 100_000;
// Paths one set of patterns may select, and per `git check-ignore` call.
const MAX_PATTERN_MATCHES = 2_000;
const CHECK_IGNORE_BATCH = 200;
const UNITY_MARKER = join('ProjectSettings', 'ProjectVersion.txt');

function invalid(line, reason) {
  return worktreeError('WORKTREE_UNSUPPORTED_REPO', `${INCLUDE_FILE} line ${line}: ${reason}.`, {
    file: INCLUDE_FILE,
    line,
  });
}

function relKey(rel) {
  return process.platform === 'win32' ? rel.toLowerCase() : rel;
}

/** Normalized forward-slash relative path, or a thrown include error. */
export function validateIncludePath(value, line = 0) {
  const text = String(value ?? '').trim();
  if (!text) throw invalid(line, 'a path is required');
  if (text.includes('\0')) throw invalid(line, 'the path contains a NUL byte');
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text) || /^[\\/]/.test(text))
    throw invalid(line, 'absolute paths are not allowed');
  const parts = text.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (!parts.length) throw invalid(line, 'the path names the repository root');
  if (parts.includes('..')) throw invalid(line, '".." is not allowed');
  if (parts.some((part) => part.toLowerCase() === '.git')) throw invalid(line, '".git" is not allowed');
  if (parts.some((part) => part.includes(':'))) throw invalid(line, '":" is not allowed');
  return parts.join('/');
}

/**
 * Parse the include file at `repoRoot`. Missing file → []. Bare lines are
 * `{ mode: 'pattern', pattern, line }` (`pattern` null: unusable, warned); a
 * copy/link line whose path breaks the rules is `{ mode: 'invalid', line, reason }`.
 * @returns {Promise<Array<{ mode: 'copy'|'link', rel: string, line: number } | { mode: 'pattern', pattern: string|null, line: number } | { mode: 'invalid', line: number, reason: string }>>}
 */
export async function readIncludeEntries(repoRoot) {
  let text;
  try {
    text = await readFile(join(repoRoot, INCLUDE_FILE), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) return;
    const match = /^(copy|link)\s+(.+)$/.exec(line);
    if (!match) {
      // gitignore syntax: `\#` and `\!` escape, a NUL cannot be passed to git.
      entries.push({ mode: 'pattern', pattern: line.includes('\0') ? null : line, line: index + 1 });
      return;
    }
    let rel;
    try {
      rel = validateIncludePath(match[2], index + 1);
    } catch (error) {
      // Absolute, `..`, `.git`, `:`: never followed, never a failure.
      entries.push({ mode: 'invalid', line: index + 1, reason: error.message });
      return;
    }
    entries.push({ mode: /** @type {'copy'|'link'} */ (match[1]), rel, line: index + 1 });
  });
  const explicit = entries.filter((entry) => entry.mode === 'copy' || entry.mode === 'link');
  for (const entry of explicit) {
    for (const other of explicit) {
      if (entry === other) continue;
      const a = relKey(entry.rel);
      const b = relKey(other.rel);
      if (a === b || b.startsWith(`${a}/`)) {
        throw invalid(other.line, `"${other.rel}" overlaps "${entry.rel}" (line ${entry.line})`);
      }
    }
  }
  return entries;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Link the directory `source` at `dest`: a directory junction on Windows, a symlink elsewhere. */
export function linkDirectory(source, dest) {
  return symlink(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
}

async function isUnityProject(dir) {
  try {
    return (await stat(join(dir, UNITY_MARKER))).isFile();
  } catch {
    return false;
  }
}

/** True when `relParts` is, or lies inside, a Unity project's Library. */
async function insideUnityLibrary(root, relParts) {
  for (let index = 0; index < relParts.length; index++) {
    if (relParts[index].toLowerCase() !== 'library') continue;
    if (await isUnityProject(join(root, ...relParts.slice(0, index)))) return true;
  }
  return false;
}

/** Library dir of a Unity project? (used to filter directory copies) */
async function isUnityLibraryDir(path) {
  return path.split(sep).at(-1).toLowerCase() === 'library' && isUnityProject(dirname(path));
}

async function treeBytes(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  if (await isUnityLibraryDir(path)) return 0;
  let total = 0;
  for (const name of await readdir(path)) total += await treeBytes(join(path, name));
  return total;
}

/**
 * Resolve and validate every entry against the repository before anything is
 * allocated. Missing sources are skipped with a warning.
 * `envFiles` (untrackedEnvFiles) are copied like pattern matches.
 * @param {string} repoRoot
 * @param {Array<{ mode: 'copy'|'link', rel: string, line: number }>} entries
 * @param {{ envFiles?: string[] }} [options]
 */
export async function planIncludes(repoRoot, entries, { envFiles = [] } = {}) {
  const rootReal = await realpath(repoRoot);
  const items = [];
  const warnings = [];
  let copyBytes = 0;
  const explicit = entries.filter((entry) => entry.mode === 'copy' || entry.mode === 'link');
  const patterns = [];
  for (const entry of entries) {
    if (entry.mode === 'copy' || entry.mode === 'link') continue;
    if (entry.mode === 'pattern' && entry.pattern) patterns.push(entry.pattern);
    else warnings.push(`include-invalid:${entry.line}`);
  }
  const matched = patterns.length ? await ignoredPatternMatches(repoRoot, patterns, warnings) : [];
  const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const covered = (rel) => explicit.some((entry) => overlaps(relKey(rel), relKey(entry.rel)));
  const planned = [...explicit];
  // An env file a pattern match already brings (inside a matched folder) is
  // not planned twice; one the patterns explicitly exclude (`!`) is not copied.
  const kept = await withoutNegated(repoRoot, envFiles, patterns, warnings);
  const env = kept.filter((rel) => !matched.some((path) => overlaps(relKey(rel), relKey(path))));
  for (const path of [...matched, ...env]) {
    let rel;
    try {
      rel = validateIncludePath(path);
    } catch {
      warnings.push(`include-skipped:${path}`);
      continue;
    }
    if (!covered(rel)) planned.push({ mode: 'copy', rel, line: 0, pattern: true });
  }
  for (const entry of planned) {
    try {
      copyBytes += await planEntry(entry);
    } catch (error) {
      // An entry that breaks a rule is skipped (never copied or linked), never a
      // failure; an I/O failure of an explicit entry still is one.
      if (!entry.pattern && !isWorktreeError(error, 'WORKTREE_UNSUPPORTED_REPO')) throw error;
      warnings.push(`include-skipped:${entry.rel}`);
    }
  }
  return { items, copyBytes, warnings };

  async function planEntry(entry) {
    const source = join(rootReal, ...entry.rel.split('/'));
    if (!(await exists(source))) {
      warnings.push(`include-missing:${entry.rel}`);
      return 0;
    }
    const sourceReal = await realpath(source);
    if (!isWithin(rootReal, sourceReal) || sourceReal === rootReal) {
      throw invalid(entry.line, `"${entry.rel}" resolves outside the repository`);
    }
    const realParts = relative(rootReal, sourceReal).split(sep);
    if (realParts.some((part) => part.toLowerCase() === '.git')) {
      throw invalid(entry.line, `"${entry.rel}" resolves into .git`);
    }
    if ((await insideUnityLibrary(rootReal, entry.rel.split('/'))) || (await insideUnityLibrary(rootReal, realParts))) {
      throw invalid(entry.line, `"${entry.rel}" is a Unity Library folder, which is never copied or linked`);
    }
    const info = await stat(sourceReal);
    if (entry.mode === 'link' && info.isDirectory() && (await isUnityProject(sourceReal))) {
      throw invalid(entry.line, `"${entry.rel}" is a Unity project; linking it would share its Library folder`);
    }
    const bytes = entry.mode === 'copy' ? await treeBytes(sourceReal) : 0;
    items.push({ mode: entry.mode, rel: entry.rel, source: sourceReal, directory: info.isDirectory(), bytes });
    return bytes;
  }
}

/**
 * The local env files of the main checkout a new worktree starts with, with
 * nothing to configure: every untracked `.env` or `.env.*` file, git-ignored
 * or not, at the root or nested (never inside node_modules), that is a
 * regular file, not a link. All of them: the query names only env files, so
 * it has no match cap. They are copied like `.worktreeinclude` pattern
 * matches, so the same rules hold (inside the repository, never
 * overwriting); explicit include entries and `!` exclusions win. A git
 * failure means none.
 * @returns {Promise<string[]>} Forward-slash paths relative to `repoRoot`.
 */
export async function untrackedEnvFiles(repoRoot) {
  const listed = await runGit(
    repoRoot,
    [
      '-c',
      'core.quotePath=false',
      'ls-files',
      '-z',
      '--others',
      '--',
      ':(glob)**/.env',
      ':(glob)**/.env.*',
      ':(exclude,glob)**/node_modules/**',
    ],
    { allowFailure: true, readOnly: true }
  );
  if (listed.code !== 0) return [];
  const files = [];
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    try {
      if ((await lstat(join(repoRoot, ...rel.split('/')))).isFile()) files.push(rel);
    } catch {
      /* gone since the listing */
    }
  }
  return files;
}

/**
 * `paths` minus those a `!` pattern of `patterns` explicitly excludes, by
 * gitignore order: every path starts selected (directories stay open, so a
 * nested negation can apply) and git evaluates the patterns after that, so
 * the last matching pattern decides. A git failure keeps none and warns.
 */
async function withoutNegated(repoRoot, paths, patterns, warnings) {
  if (!paths.length || !patterns.some((pattern) => pattern.startsWith('!'))) return paths;
  const listed = await runGit(
    repoRoot,
    [
      '-c',
      'core.quotePath=false',
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude=*',
      '--exclude=!*/',
      ...patterns.map((pattern) => `--exclude=${pattern}`),
      '--',
      ...paths.map((rel) => `:(literal)${rel}`),
    ],
    { allowFailure: true, readOnly: true }
  );
  if (listed.code !== 0) {
    warnings.push('include-invalid:patterns');
    return [];
  }
  const selected = new Set(listed.stdout.split('\0').filter(Boolean));
  return paths.filter((rel) => selected.has(rel));
}

/**
 * Untracked paths under `repoRoot` that match `patterns` (gitignore syntax,
 * in order, so `!` negates) AND that the repository itself git-ignores;
 * a fully matched directory is one entry. Git does the matching, so the
 * semantics are exactly .gitignore's. A git failure is a warning.
 */
async function ignoredPatternMatches(repoRoot, patterns, warnings) {
  const excludes = patterns.map((pattern) => `--exclude=${pattern}`);
  // Untracked paths the patterns select; `--directory` names a directory
  // whose whole untracked content matches once instead of file by file.
  const list = async (args) => {
    const listed = await runGit(repoRoot, ['ls-files', '-z', '--others', '--ignored', ...args], {
      allowFailure: true,
      readOnly: true,
    });
    if (listed.code !== 0) throw new Error('ls-files failed');
    return listed.stdout.split('\0').filter(Boolean);
  };
  // The subset the repository itself ignores (exit 1: none of them).
  const repoIgnored = async (paths) => {
    const ignored = new Set();
    for (let index = 0; index < paths.length; index += CHECK_IGNORE_BATCH) {
      const batch = paths.slice(index, index + CHECK_IGNORE_BATCH);
      const result = await runGit(repoRoot, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...batch], {
        allowFailure: true,
        readOnly: true,
      });
      if (result.code > 1) throw new Error('check-ignore failed');
      for (const line of result.stdout.split(/\r?\n/)) if (line) ignored.add(line);
    }
    return ignored;
  };
  const selected = [];
  try {
    const candidates = await list(['--directory', '--no-empty-directory', ...excludes]);
    const ignored = await repoIgnored(candidates);
    for (const path of candidates) {
      if (ignored.has(path)) {
        selected.push(path);
        continue;
      }
      // A directory the repository does not ignore as a whole: its files one by one.
      if (!path.endsWith('/')) continue;
      const files = await list([...excludes, '--', path]);
      const inside = await repoIgnored(files);
      selected.push(...files.filter((file) => inside.has(file)));
      if (selected.length > MAX_PATTERN_MATCHES) break;
    }
  } catch {
    warnings.push('include-invalid:patterns');
    return [];
  }
  if (selected.length > MAX_PATTERN_MATCHES) {
    // A partial copy would be worse than none.
    warnings.push(`include-truncated:${selected.length}`);
    return [];
  }
  return selected.map((path) => path.replace(/[\\/]+$/, ''));
}

/** Digest type letter of an lstat result: link, directory or file. */
function digestType(info) {
  if (info.isSymbolicLink()) return 'l';
  return info.isDirectory() ? 'd' : 'f';
}

/**
 * Digest of a copied tree (relative path, type, size, mtime). Null when the
 * tree is gone or too large to fingerprint.
 */
async function treeDigest(path) {
  const hash = createHash('sha256');
  let count = 0;
  async function walk(current, rel) {
    const info = await lstat(current);
    if (++count > MAX_DIGEST_ENTRIES) throw new RangeError('too many entries');
    const type = digestType(info);
    hash.update(`${rel}\0${type}\0${type === 'f' ? info.size : 0}\0${type === 'f' ? Math.trunc(info.mtimeMs) : 0}\n`);
    if (type !== 'd') return;
    for (const name of (await readdir(current)).sort()) await walk(join(current, name), rel ? `${rel}/${name}` : name);
  }
  try {
    await walk(path, '');
  } catch {
    return null;
  }
  return hash.digest('hex');
}

/** Refuse a destination whose existing ancestors inside the worktree are links. */
async function assertPlainParents(worktreePath, dest) {
  const parts = relative(worktreePath, dirname(dest)).split(sep).filter(Boolean);
  let current = worktreePath;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw worktreeError(
        'WORKTREE_UNSUPPORTED_REPO',
        `${INCLUDE_FILE}: ${relative(worktreePath, dest)} would pass through a link.`
      );
    }
  }
}

/**
 * Make one link of the recorded `type`: 'directory' (junction on Windows,
 * symlink elsewhere), 'file' (file symlink) or 'hard' (Windows hard link).
 */
function makeLinkOfType(type, source, dest) {
  if (type === 'file') return symlink(source, dest, 'file');
  if (type === 'hard') return link(source, dest);
  return linkDirectory(source, dest);
}

/** Link `item` at `dest`; returns the link type made (see makeLinkOfType). */
async function makeLink(item, dest) {
  const failures = [];
  if (item.directory) {
    try {
      await linkDirectory(item.source, dest);
      return 'directory';
    } catch (error) {
      failures.push(error);
    }
  } else {
    try {
      await symlink(item.source, dest, 'file');
      return 'file';
    } catch (error) {
      failures.push(error);
    }
    if (process.platform === 'win32') {
      try {
        await link(item.source, dest);
        return 'hard';
      } catch (error) {
        failures.push(error);
      }
    }
  }
  throw worktreeError(
    'WORKTREE_UNSUPPORTED_REPO',
    `${INCLUDE_FILE}: could not link ${item.rel} (${failures.map((error) => error.code || error.message).join(', ')}). ` +
      'Links are never replaced by copies; use "copy" or enable symbolic links.',
    { rel: item.rel }
  );
}

/**
 * Copy/link every planned item into `worktreePath`. `record(item)` is awaited
 * with status 'pending' before each resource is made and 'created' after, so
 * a rollback knows exactly what this transaction produced.
 */
export async function applyIncludes(plan, worktreePath, record) {
  const warnings = [];
  for (const item of plan.items) {
    const dest = join(worktreePath, ...item.rel.split('/'));
    if (await exists(dest)) {
      warnings.push(`include-exists:${item.rel}`);
      continue;
    }
    try {
      await assertPlainParents(worktreePath, dest);
    } catch (error) {
      if (!isWorktreeError(error, 'WORKTREE_UNSUPPORTED_REPO')) throw error;
      // The destination would pass through a link: skipped, never written.
      warnings.push(`include-skipped:${item.rel}`);
      continue;
    }
    const ledger = { mode: item.mode, rel: item.rel, path: dest, status: 'pending', digest: null };
    // A link records its target and (once made) its type, so a removal that
    // does not go through can put the same kind of link back (restoreIncludeLinks).
    if (item.mode === 'link') ledger.source = item.source;
    await record(ledger);
    await mkdir(dirname(dest), { recursive: true });
    if (item.mode === 'link') {
      ledger.linkType = await makeLink(item, dest);
    } else if (item.directory) {
      await cp(item.source, dest, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
        filter: async (source) => !(await isUnityLibraryDir(source)),
      });
    } else {
      await copyFile(item.source, dest, fsConstants.COPYFILE_EXCL);
    }
    ledger.status = 'created';
    if (item.mode === 'copy') ledger.digest = await treeDigest(dest);
    await record(ledger);
  }
  return { warnings };
}

/**
 * Remove the links this worktree made, never traversing their targets.
 * Copies stay (they live inside the checkout, removed with it).
 * @returns {Promise<string[]>} Links that could not be removed.
 */
export async function removeIncludeLinks(items) {
  const remaining = [];
  for (const item of items || []) {
    if (item.mode !== 'link') continue;
    let info;
    try {
      info = await lstat(item.path);
    } catch {
      continue;
    }
    // A hard-linked file (Windows fallback) is a regular file; unlinking it
    // drops only this name.
    if (!info.isSymbolicLink() && !info.isFile()) continue;
    try {
      await unlink(item.path);
    } catch (error) {
      if (!['EPERM', 'EISDIR', 'EACCES'].includes(error?.code)) {
        remaining.push(item.path);
        continue;
      }
      try {
        await rmdir(item.path);
      } catch {
        remaining.push(item.path);
      }
    }
  }
  return remaining;
}

/**
 * Put back the links removeIncludeLinks took away (those that record their
 * `source`) after a removal that did not go through, each with its recorded
 * `linkType` (a record without one — dependency links, older records — is a
 * directory link). A path that exists again is left alone.
 * @returns {Promise<Array<{ path: string, error: string }>>} Links that could not be restored.
 */
export async function restoreIncludeLinks(items) {
  const failures = [];
  for (const item of items || []) {
    if (item.mode !== 'link' || !item.source || item.status !== 'created') continue;
    if (await exists(item.path)) continue;
    try {
      await makeLinkOfType(item.linkType || 'directory', item.source, item.path);
    } catch (error) {
      failures.push({ path: item.path, error: error?.code || error?.message || String(error) });
    }
  }
  return failures;
}

/** Copied include paths whose content changed since creation (or unknown). */
export async function modifiedIncludeCopies(items) {
  const modified = [];
  for (const item of items || []) {
    if (item.mode !== 'copy' || !(await exists(item.path))) continue;
    if (item.status !== 'created' || !item.digest || (await treeDigest(item.path)) !== item.digest)
      modified.push(item.rel);
  }
  return modified;
}

/** True when `path` (forward-slash, relative) is one of the include items or inside one. */
export function coveredByIncludes(items, path) {
  const target = relKey(String(path).replace(/\\/g, '/').replace(/\/$/, ''));
  return (items || []).some((item) => {
    const base = relKey(item.rel);
    return target === base || target.startsWith(`${base}/`);
  });
}
