import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { expandAbsoluteGlobs } from './lib/absolute-glob-expand.mjs';
import { buildGlobPatternGroups } from './lib/glob-static-prefix.mjs';
import {
  canonicalizeGlobSlashes,
  coerceReadFamilyPathArg,
  extractGlobBaseDirectory,
  hasGlobMagic,
  normalizeGlobArgs,
  normalizeInputPath,
  normalizeOutputPath,
  resolveAgainstCwd,
} from './path-utils.mjs';
import {
  basePathDiagnostic,
  buildNotFoundHint,
  finalizeReadFamilyEnoentTail,
  isUncOrSmbPath,
  relativeSearchResultPath,
  resolveSearchScope,
  uncRefusalMessage,
} from './search-path-diagnostics.mjs';
// Facade re-export: path-diagnostic helpers moved to search-path-diagnostics.mjs;
// keep prior importers of search-tool.mjs unchanged.
export {
  _suggestIndexedPaths,
  basePathDiagnostic,
  buildNotFoundHint,
  isUncOrSmbPath,
  relativePathPrefix,
  relativeSearchResultPath,
  resolveSearchScope,
  uncRefusalMessage,
} from './search-path-diagnostics.mjs';
import { buildGlobCacheKey, DEFAULT_IGNORE_GLOBS, rootScanIgnoreGlobs } from './search-builders.mjs';
import { runRg, runRgWindowedLines } from './native-search-runner.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import { cacheGet, cacheSet, runResultCacheInFlight, statPathsForMtime, visitPathsForMtime } from './cache-layers.mjs';
import { recordLocalSearchCacheHit } from './local-search-telemetry.mjs';
import { uniqueStrings, coerceNonNegInt, globMtimeTiePath } from './lib/search-input-helpers.mjs';
import { reportToolProgress } from './lib/tool-progress.mjs';
import { statReachable } from './fs-reachability.mjs';

// Same A/B override surface for glob (stock default 100).
function _globDefaultHeadLimit() {
  const parsed = parseInt(process.env.MIXDOG_GLOB_DEFAULT_HEAD_LIMIT ?? '', 10);
  return parsed > 0 ? parsed : 100;
}

function compareGlobMtimeEntries(a, b) {
  const dm = b.mtime - a.mtime;
  if (dm !== 0) return dm;
  return globMtimeTiePath(a).localeCompare(globMtimeTiePath(b));
}

function retainBestEntries(heap, candidate, limit, compare) {
  if (heap.length < limit) {
    heap.push(candidate);
    for (let index = heap.length - 1; index > 0; ) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[index], heap[parent]) <= 0) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
    return;
  }
  if (compare(candidate, heap[0]) >= 0) return;
  heap[0] = candidate;
  for (let index = 0; ; ) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
    if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

export function _createGlobMtimeTopK(limit) {
  const cap = Math.max(1, Math.floor(Number(limit) || 1));
  const statted = [];
  const unstatted = [];
  return {
    add(entry, index) {
      if (entry?.stat != null) {
        retainBestEntries(statted, entry, cap, compareGlobMtimeEntries);
      } else {
        retainBestEntries(unstatted, { ...entry, _walkIndex: index }, cap, (a, b) => a._walkIndex - b._walkIndex);
      }
    },
    values() {
      statted.sort(compareGlobMtimeEntries);
      unstatted.sort((a, b) => a._walkIndex - b._walkIndex);
      return [...statted, ...unstatted].slice(0, cap);
    },
  };
}

const GLOB_PATH_CAP = 10;
const GLOB_PATTERN_ARRAY_CAP = 10;
const GLOB_ACCUM_CAP = 50000;
const GLOB_STAT_DEADLINE_MS = 5000;

// The distinct normalized roots a `path` array names.
function globPathList(paths) {
  const seen = new Set();
  return paths
    .map((p) => (typeof p === 'string' ? normalizeInputPath(p) : ''))
    .filter((p) => p && !seen.has(p) && seen.add(p));
}

// Independent per-path globs run concurrently; sections are assembled in
// the original (capped) order so output stays identical.
async function runGlobPerPath(args, workDir, options, list) {
  const capped = list.slice(0, GLOB_PATH_CAP);
  const bodies = await Promise.all(
    capped.map(async (p) => {
      try {
        return await executeGlobTool({ ...args, path: p }, workDir, options);
      } catch (err) {
        return `Error: ${err?.message ? err.message : err}`;
      }
    })
  );
  const parts = capped.map((p, i) => `# glob ${p}\n${bodies[i]}`);
  if (list.length > GLOB_PATH_CAP) {
    parts.push(`[capped at ${GLOB_PATH_CAP} of ${list.length} paths]`);
    // Omitted paths mean the returned listing is not the whole
    // requested set — never cache it as complete.
    if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  return parts.join('\n\n');
}

// ripgrep `--glob` matchers use forward slashes on all platforms;
// canonicalize `\`→`/` (win32 only) so a `**\*.ts` pattern matches
// instead of being parsed as an escape sequence. A glob written as the
// path is the pattern, searched from the cwd.
function requestedGlobPatterns(args) {
  const rawPattern = args.pattern;
  let rawPatterns = [];
  if (Array.isArray(rawPattern)) rawPatterns = rawPattern.filter((p) => typeof p === 'string' && p);
  else if (rawPattern) rawPatterns = [String(rawPattern)];
  let patterns = uniqueStrings(rawPatterns.map(normalizeInputPath).map(canonicalizeGlobSlashes));
  if (patterns.length === 0 && hasGlobMagic(args.path)) {
    patterns = [canonicalizeGlobSlashes(normalizeInputPath(args.path))];
    args.path = undefined;
  }
  return patterns.length ? patterns : ['*'];
}

// Omitted patterns: mark the scoped cache incomplete and key the internal
// cache on the original count so a capped glob never collides with an
// exact N-pattern request or is served as the whole set.
function capGlobPatterns(patterns, options) {
  if (patterns.length <= GLOB_PATTERN_ARRAY_CAP) return { patterns, note: '', total: 0 };
  if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  return {
    patterns: patterns.slice(0, GLOB_PATTERN_ARRAY_CAP),
    note: `[capped at ${GLOB_PATTERN_ARRAY_CAP} of ${patterns.length} patterns]\n`,
    total: patterns.length,
  };
}

// Call-scoped stat cache: the preflight stats each root, the per-group rg
// runs re-stat the same resolved cwd, and the empty-result diagnostic stats
// it a third time. Memoized by resolved path so each root is stat'd once.
function createStatCache() {
  const cache = new Map();
  const stat = async (resolvedPath) => {
    if (cache.has(resolvedPath)) return await cache.get(resolvedPath);
    const pending = statReachable(resolvedPath).then(
      (st) => ({ st, err: null }),
      (err) => ({ st: null, err })
    );
    cache.set(resolvedPath, pending);
    const settled = await pending;
    if (cache.get(resolvedPath) === pending) cache.set(resolvedPath, settled);
    return settled;
  };
  return { cache, stat };
}

// A base path carrying glob magic (path:'src/**/cache/*') names a SET of
// directories, not a literal one — resolving it literally ENOENTs. Split
// it the way grep's path handling does: walk from the static baseDir and
// fold the magic suffix into each pattern under that root.
function globBaseEntry(basePath, workDir) {
  if (typeof basePath !== 'string' || !hasGlobMagic(basePath)) return { root: basePath, prefix: '' };
  // Literal-first (same contract as grep's path handling): a directory
  // literally named e.g. "cache{v2}" is the root, not a pattern.
  try {
    if (statSync(resolveAgainstCwd(basePath, workDir)).isDirectory()) {
      return { root: basePath, prefix: '' };
    }
  } catch {
    /* not a literal dir — treat as base+glob below */
  }
  const { baseDir, relativePattern } = extractGlobBaseDirectory(canonicalizeGlobSlashes(basePath));
  // A trailing pure-`*` segment ("cache/*") means "the children" — the
  // pattern itself supplies the leaf match, so nesting it one level
  // deeper ("*/<pat>") would skip files directly under the dir. Drop
  // that segment; `**` and mid-path magic still nest.
  const segs = relativePattern.replace(/^\//, '').split('/').filter(Boolean);
  if (segs[segs.length - 1] === '*') segs.pop();
  return { root: baseDir || '.', prefix: segs.join('/') };
}

function globUncRefusal(baseEntries, patterns, resolvedForSearchRoot) {
  for (const e of baseEntries) {
    if (isUncOrSmbPath(e.root)) return uncRefusalMessage('glob', e.root, e.root);
    const resolvedBase = resolvedForSearchRoot(e.root);
    if (isUncOrSmbPath(resolvedBase)) return uncRefusalMessage('glob', e.root, resolvedBase);
  }
  for (const p of patterns) {
    if (isAbsolute(p) && isUncOrSmbPath(p)) return uncRefusalMessage('glob', p, p);
  }
  return null;
}

function globWindow(args) {
  const headLimitCoerced = coerceNonNegInt(args.head_limit);
  if (Number.isNaN(headLimitCoerced)) {
    return {
      error: `Error: invalid limit ${JSON.stringify(args.head_limit)}; expected a non-negative integer (0 = unlimited)`,
    };
  }
  const offsetCoerced = coerceNonNegInt(args.offset);
  if (Number.isNaN(offsetCoerced)) {
    return { error: `Error: invalid offset ${JSON.stringify(args.offset)}; expected a non-negative integer` };
  }
  let headLimit = headLimitCoerced;
  if (headLimitCoerced === null) headLimit = _globDefaultHeadLimit();
  else if (headLimitCoerced === 0) headLimit = Infinity;
  return { headLimit, offset: offsetCoerced || 0 };
}

// The rg argument list for one pattern group. Explicit literal basenames
// (no glob magic in the final segment) name a concrete file: honor rg's
// later-glob-wins contract and let the lookup descend dependency-noise
// dirs, which the native walker would otherwise prune before the pattern
// could ever match. Wildcard basenames keep the noise prunes; device-name
// globs (no trailing /**) always apply.
function globGroupArgs(root, rels, { includeNoise, extraIgnoreGlobs, rgCwd }) {
  const rgArgs = ['--files', '--hidden'];
  if (includeNoise) rgArgs.push('--no-ignore');
  const explicitBasenames =
    rels.length > 0 &&
    rels.every((rel) => {
      const base = String(rel).split('/').filter(Boolean).pop() || '';
      return base !== '' && !hasGlobMagic(base);
    });
  // A pattern that NAMES a pruned directory is asking for it: only the
  // wildcard basename decided this before, so `node_modules/**/index.js`
  // was answered while `__pycache__/*.pyc` returned "(no files found)"
  // for a file sitting right there. The yield is per-directory — every
  // other prune stays on — and a negative pattern never counts as a
  // request for its own target.
  const namedDirs = new Set(
    [
      ...rels.filter((rel) => !String(rel).startsWith('!')).flatMap((rel) => String(rel).split('/')),
      ...String(root || '')
        .replace(/\\/g, '/')
        .split('/'),
    ].filter((segment) => segment && !hasGlobMagic(segment))
  );
  // Later globs win: retained safety/noise exclusions must follow the
  // requested patterns, or a broad positive glob re-admits noise files.
  for (const rel of rels) rgArgs.push('--glob', rel);
  for (const ex of DEFAULT_IGNORE_GLOBS) {
    const pruned = /^!\*\*\/([^/]+)\/\*\*$/.exec(ex);
    if (pruned && (includeNoise || explicitBasenames || namedDirs.has(pruned[1]))) continue;
    rgArgs.push('--glob', ex);
  }
  for (const ex of extraIgnoreGlobs) rgArgs.push('--glob', ex);
  // Root-anchored kernel-tree prunes trail every positive glob so
  // rg's later-glob-wins rule can never re-admit /proc//sys//dev on a
  // full-root scan.
  for (const ex of rootScanIgnoreGlobs(rgCwd)) rgArgs.push('--glob', ex);
  rgArgs.push('.');
  return rgArgs;
}

function absolutePaths(lines, rgCwd) {
  return lines.map((line) => (isAbsolute(line) ? line : resolveAgainstCwd(line, rgCwd)));
}

// One pattern group's enumeration: a windowed native pass when the page is
// bounded (newest-first or walk order), else the full rg listing.
function missingGlobRoot(scan, root, rgCwd, err) {
  const hint = buildNotFoundHint(scan.workDir, rgCwd, 'Search', err?.code);
  return {
    error: `path does not exist: ${normalizeOutputPath(rgCwd)} (${err?.code || 'ENOENT'})${finalizeReadFamilyEnoentTail(hint, root, err?.code)}`,
    paths: [],
    stdoutTruncated: false,
  };
}

// A windowed listing served by the native walker: the mtime top-K window is
// always complete, the natural-order window reports whether it ran out.
async function runWindowedGlob(scan, rgArgs, rgCwd) {
  const nativeMtime = scan.canWindowMtime;
  const served = await scan.runWindowedLines(
    rgArgs,
    { cwd: rgCwd, signal: scan.sharedSignal },
    { offset: 0, limit: scan.offset + scan.headLimit + 1, ...(nativeMtime ? { mtimeTopK: true } : {}) }
  );
  return {
    error: null,
    paths: absolutePaths(served.lines, rgCwd),
    stdoutTruncated: false,
    stdoutPartial: served.partial === true,
    windowIncomplete: nativeMtime ? false : served.complete !== true,
    cacheSafe: served.cacheSafe !== false,
    ...(nativeMtime ? { nativeMtime: true, totalSeen: served.totalSeen } : {}),
  };
}

function globGroupFailure(root, err) {
  const stderr = String(err?.stderr || err?.message || err)
    .trim()
    .split('\n')
    .slice(0, 3)
    .join('; ');
  return {
    error: `rg failed for ${normalizeOutputPath(root)}: ${stderr || 'unknown error'}`,
    paths: [],
    stdoutTruncated: false,
    stdoutPartial: false,
  };
}

async function runGlobGroup(scan, root, rels) {
  const { sharedSignal } = scan;
  const rgCwd = scan.resolvedForSearchRoot(root);
  const rgArgs = globGroupArgs(root, rels, {
    includeNoise: scan.includeNoise,
    extraIgnoreGlobs: scan.extraIgnoreGlobs,
    rgCwd,
  });
  const cwdStat = await scan.statCached(rgCwd);
  if (cwdStat.err) return missingGlobRoot(scan, root, rgCwd, cwdStat.err);
  try {
    if (scan.canWindowMtime || scan.canWindowNatural) return await runWindowedGlob(scan, rgArgs, rgCwd);
    const stdout = await runRg(rgArgs, { cwd: rgCwd, signal: sharedSignal });
    const meta = stdout && typeof stdout === 'object' ? stdout : null;
    const lines = String(stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      error: null,
      paths: absolutePaths(lines, rgCwd),
      stdoutTruncated: Boolean(meta?.truncated),
      stdoutPartial: Boolean(meta?.partial),
      cacheSafe: meta?.cacheSafe !== false,
    };
  } catch (err) {
    if (sharedSignal?.aborted) throw err;
    return globGroupFailure(root, err);
  }
}

// Folds the group runs into one file list and the integrity flags the
// listing reports; the accumulation cap stops the fold.
function mergeGlobRuns(groupRuns) {
  const merged = {
    allFiles: [],
    rgErrors: [],
    accumTruncated: false,
    rgStdoutTruncated: false,
    rgStdoutPartial: false,
    rgWindowIncomplete: false,
    rgCacheUnsafe: false,
    nativeMtimeTotal: null,
  };
  for (const run of groupRuns) {
    if (run.error) {
      merged.rgErrors.push(run.error);
      continue;
    }
    if (run.stdoutTruncated) merged.rgStdoutTruncated = true;
    if (run.stdoutPartial) merged.rgStdoutPartial = true;
    if (run.windowIncomplete) merged.rgWindowIncomplete = true;
    if (run.cacheSafe === false) merged.rgCacheUnsafe = true;
    if (run.nativeMtime) {
      merged.nativeMtimeTotal = (merged.nativeMtimeTotal ?? 0) + Math.max(0, Number(run.totalSeen) || 0);
    }
    for (const p of run.paths) {
      if (merged.allFiles.length >= GLOB_ACCUM_CAP) {
        merged.accumTruncated = true;
        break;
      }
      merged.allFiles.push(p);
      if (merged.allFiles.length >= GLOB_ACCUM_CAP) {
        merged.accumTruncated = true;
        break;
      }
    }
  }
  return merged;
}

// Newest-first by a bounded stat pass, so a hung mount cannot pin glob
// until the agent stall watchdog fires. A deadline-expired or failed stat
// degrades ORDERING only, never completeness: unsortable entries keep their
// walk order at the tail.
async function statOrderedPaths(unique, workDir) {
  const withStat = await statPathsForMtime(unique, workDir, 64, { deadlineMs: GLOB_STAT_DEADLINE_MS });
  const statted = [];
  const unstatted = [];
  for (const entry of withStat) {
    if (!entry) continue;
    if (entry.stat != null) statted.push(entry);
    else unstatted.push(entry);
  }
  statted.sort(compareGlobMtimeEntries);
  return [...statted, ...unstatted].map((entry) => entry.full || resolveAgainstCwd(entry.path, workDir));
}

async function orderGlobPaths(unique, { nativeMtimeTotal, groupCount, sortMode, headLimit, offset, workDir }) {
  if (nativeMtimeTotal !== null && groupCount === 1) return unique;
  if (nativeMtimeTotal !== null) return statOrderedPaths(unique, workDir);
  if (sortMode !== 'mtime') {
    return unique.map((entry) => (isAbsolute(entry) ? resolve(entry) : resolveAgainstCwd(entry, workDir)));
  }
  if (headLimit === Infinity) return statOrderedPaths(unique, workDir);
  // Scan and stat every match for exact global ordering, but retain
  // only the requested page plus one lookahead row. This changes
  // O(N log N) sorting and O(N) result retention to O(N log K) and
  // O(K) without narrowing the searched candidate set.
  const selector = _createGlobMtimeTopK(Math.min(unique.length, offset + headLimit + 1));
  await visitPathsForMtime(unique, workDir, 64, { deadlineMs: GLOB_STAT_DEADLINE_MS }, (entry, index) =>
    selector.add(entry, index)
  );
  return selector.values().map((entry) => entry.full || resolveAgainstCwd(entry.path, workDir));
}

function globIntegritySuffix({ accumTruncated, rgStdoutTruncated, rgStdoutPartial, rgErrors }) {
  let truncSuffix = '';
  if (accumTruncated) truncSuffix = `\n... [truncated at accumulation cap (${GLOB_ACCUM_CAP})]`;
  if (rgStdoutTruncated) truncSuffix += '\n... [truncated at rg stdout cap (20MB); results incomplete]';
  if (rgStdoutPartial) truncSuffix += '\n... [warning] rg exit 2 (partial results); listing may be incomplete';
  const errorSuffix = rgErrors.length > 0 ? `\n... [warning] ${rgErrors.join(' | ')}` : '';
  return errorSuffix + truncSuffix;
}

function globMoreSuffix({ rgWindowIncomplete, remaining, totalBeforeOffset, nextOffset }) {
  if (rgWindowIncomplete) return `\n... [more entries available — pass offset:${nextOffset} to continue]`;
  if (remaining > 0) {
    return `\n... [${remaining} more entries of ${totalBeforeOffset} total — pass offset:${nextOffset} to continue]`;
  }
  return '';
}

function globEmptyDiagnostic(scan, { totalBeforeOffset }) {
  const { patterns, basePath, baseEntries, workDir, statCache, offset } = scan;
  const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
  const baseLabel = normalizeOutputPath(basePath);
  if (totalBeforeOffset > 0 && offset >= totalBeforeOffset) {
    return `(no entries after offset=${offset}; total=${totalBeforeOffset}) pattern=${patternStr} path=${baseLabel}`;
  }
  const diagnostic = basePathDiagnostic(
    baseEntries.map((e) => e.root),
    workDir,
    statCache
  );
  return `(no files found) pattern=${patternStr} path=${baseLabel}; ${diagnostic}`;
}

// An absolute pattern that enumerated nothing may still have real matches
// the inventory walker cannot see: it does not follow symlinked
// directories, and /sys, /proc and friends are made of them. Expand those
// patterns straight off the filesystem before declaring the miss.
async function directAbsoluteMatches({ patterns, headLimit, offset }) {
  const direct = await expandAbsoluteGlobs(patterns, { limit: headLimit === Infinity ? 50 : offset + headLimit });
  const window = offset > 0 ? direct.slice(offset) : direct;
  return headLimit === Infinity ? window : window.slice(0, headLimit);
}

async function scanGlobGroups(scan) {
  const { groups, options, patterns, offset, headLimit, workDir, patternCapNote } = scan;
  const globGroups = [...groups.entries()];
  const merged = mergeGlobRuns(await Promise.all(globGroups.map(([root, rels]) => runGlobGroup(scan, root, rels))));
  const { allFiles, rgErrors } = merged;
  if (rgErrors.length > 0 && allFiles.length === 0) return `Error: ${rgErrors.join(' | ').slice(0, 500)}`;
  const unique = Array.from(new Set(allFiles));
  const orderedPaths = await orderGlobPaths(unique, {
    nativeMtimeTotal: merged.nativeMtimeTotal,
    groupCount: globGroups.length,
    sortMode: scan.sortMode,
    headLimit,
    offset,
    workDir,
  });
  const totalBeforeOffset = merged.nativeMtimeTotal ?? unique.length;
  const windowed = offset > 0 ? orderedPaths.slice(offset) : orderedPaths;
  const capped = (headLimit === Infinity ? windowed : windowed.slice(0, headLimit)).map((abs) =>
    relativeSearchResultPath(abs, workDir)
  );
  const remaining = Math.max(0, totalBeforeOffset - offset - capped.length);
  const miss = capped.length === 0 && rgErrors.length === 0;
  if (miss) {
    const shown = await directAbsoluteMatches({ patterns, headLimit, offset });
    if (shown.length > 0) return patternCapNote + shown.join('\n');
  }
  const out = patternCapNote + renderGlobPage(scan, merged, { capped, remaining, totalBeforeOffset, miss });
  settleGlobScanCache(scan, merged, out, remaining);
  reportToolProgress(options, `found ${totalBeforeOffset} files`);
  return out;
}

// The page body with its more/integrity suffixes. Empty partials are not
// proof of absence: diagnostics are preserved even when there is no path
// body, rather than silently dropping the integrity suffix.
function renderGlobPage(scan, merged, { capped, remaining, totalBeforeOffset, miss }) {
  const { offset } = scan;
  const errSuffix = globIntegritySuffix(merged);
  const moreSuffix = globMoreSuffix({
    rgWindowIncomplete: merged.rgWindowIncomplete,
    remaining,
    totalBeforeOffset,
    nextOffset: offset + capped.length,
  });
  if (capped.length > 0) return `${capped.join('\n')}${moreSuffix}${errSuffix}`;
  const emptyDiag = miss ? globEmptyDiagnostic(scan, { totalBeforeOffset }) : '';
  const emptyBody = (emptyDiag || '(no files found)').replace(
    '(no files found)',
    merged.rgStdoutPartial || merged.rgWindowIncomplete ? '(no files found yet)' : '(no files found)'
  );
  return `${emptyBody}${moreSuffix}${errSuffix}`;
}

// Scoped-cache bookkeeping for a finished scan. Pagination is not an
// incomplete computation: limit/offset are part of the cache key, and the
// native watcher invalidates the scoped page on any relevant namespace/mtime
// change. Cache exact pages even when more rows exist; only a genuinely
// partial scan must bypass reuse.
function settleGlobScanCache(scan, merged, out, remaining) {
  const { options, cacheKey } = scan;
  const { accumTruncated, rgStdoutTruncated, rgStdoutPartial, rgWindowIncomplete, rgCacheUnsafe, rgErrors } = merged;
  if (
    options?.scopedCacheOutcome &&
    (accumTruncated || rgStdoutTruncated || rgStdoutPartial || rgWindowIncomplete || remaining > 0)
  ) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  const globComputationIncomplete = accumTruncated || rgStdoutTruncated || rgStdoutPartial || rgErrors.length > 0;
  if (!globComputationIncomplete && !rgCacheUnsafe) cacheSet(cacheKey, out, { scopes: scan.scopes });
}

function globScanOptions(args) {
  const rawSort = typeof args.sort === 'string' ? args.sort.trim() : '';
  // Newest-first is the default: recently-touched files are almost always
  // the relevant ones. sort:'natural' opts back into raw walk order, which
  // keeps early windowing and skips the stat phase on huge trees.
  const sortMode = rawSort === 'natural' ? 'natural' : 'mtime';
  const includeNoise = args.include_noise === true;
  // Internal-only ignore extension (see normalizeGlobArgs). Caller (e.g.
  // ai-wrapped-dispatch broad-cwd preflight) appends basename ignore globs
  // so head_limit bounds SOURCE entries rather than artifact noise.
  const extraIgnoreGlobs = Array.isArray(args._extraIgnoreDirs)
    ? args._extraIgnoreDirs.map((name) => `!**/${name}/**`)
    : [];
  return { sortMode, includeNoise, extraIgnoreGlobs };
}

export async function executeGlobTool(args, workDir, options = {}) {
  args = normalizeGlobArgs(args);
  args.path = coerceReadFamilyPathArg(args.path, workDir);
  if (Array.isArray(args.path)) {
    const list = globPathList(args.path);
    if (list.length > 1) return runGlobPerPath(args, workDir, options, list);
    args.path = list[0] ?? '.';
  } else {
    args.path = normalizeInputPath(args.path);
  }
  const {
    patterns,
    note: patternCapNote,
    total: patternCapTotal,
  } = capGlobPatterns(requestedGlobPatterns(args), options);
  const basePath = args.path || '.';
  const { cache: statCache, stat: statCached } = createStatCache();
  const baseEntries = [globBaseEntry(basePath, workDir)];
  const resolvedSearchRoots = new Map();
  const resolvedForSearchRoot = (root) => {
    if (!resolvedSearchRoots.has(root)) resolvedSearchRoots.set(root, resolveSearchScope(root, workDir));
    return resolvedSearchRoots.get(root);
  };
  const refusal = globUncRefusal(baseEntries, patterns, resolvedForSearchRoot);
  if (refusal) return refusal;
  const window = globWindow(args);
  if (window.error) return window.error;
  const { headLimit, offset } = window;
  const { sortMode, includeNoise, extraIgnoreGlobs } = globScanOptions(args);
  const groups = await buildGlobPatternGroups({ patterns, baseEntries, resolveRoot: resolvedForSearchRoot });
  const scopes = [...groups.keys()].map((root) => resolvedForSearchRoot(root));
  const cacheKey = buildGlobCacheKey({
    patterns,
    basePath: scopes
      .map((root) => normalizeOutputPath(root))
      .sort()
      .join('\x01'),
    headLimit,
    offset,
    extraIgnore: extraIgnoreGlobs,
    sort: sortMode,
    patternCapTotal,
    includeNoise,
  });
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    recordLocalSearchCacheHit('result');
    return cached;
  }
  const scan = {
    groups,
    scopes,
    options,
    patterns,
    patternCapNote,
    basePath,
    baseEntries,
    statCache,
    statCached,
    resolvedForSearchRoot,
    runWindowedLines: options.__runRgWindowedLines || runRgWindowedLines,
    workDir,
    cacheKey,
    headLimit,
    offset,
    sortMode,
    includeNoise,
    extraIgnoreGlobs,
    canWindowNatural: sortMode === 'natural' && headLimit !== Infinity,
    canWindowMtime: sortMode === 'mtime' && headLimit !== Infinity,
  };
  return await runResultCacheInFlight(
    cacheKey,
    ({ signal: sharedSignal }) => scanGlobGroups({ ...scan, sharedSignal }),
    { signal: options?.signal || options?.abortSignal || null, scopes }
  );
}
