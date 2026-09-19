// find / find_files tools: fuzzy path lookup and glob-style file search over
// the workspace.
import { basename, relative } from 'node:path';
import {
  coerceReadFamilyPathArg,
  extractGlobBaseDirectory,
  hasGlobMagic,
  normalizeInputPath,
  normalizeOutputPath,
  resolveAgainstCwd,
} from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { buildListCacheKey, DEFAULT_IGNORE_GLOBS, rootScanIgnoreGlobs } from './search-builders.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import { cacheGet, cacheSet, statPathsForMtime } from './cache-layers.mjs';
import { formatListSize, formatMtime } from './list-formatting.mjs';
import { compileSimpleGlob } from './glob-walk.mjs';
import { capLineOrientedToolOutput, LOCATOR_OUTPUT_MAX_BYTES } from './tool-output-limit.mjs';
import { runRg } from './native-search-runner.mjs';
import { tryServeFuzzySearch } from './native-search-client.mjs';
import {
  recordLocalSearchBackend,
  recordLocalSearchCacheHit,
  recordNativeSearchTiming,
} from './local-search-telemetry.mjs';
import { listGuardPath, normalizeListHeadLimit } from './lib/list-helpers.mjs';
import { reportToolProgress } from './lib/tool-progress.mjs';
import { displayRelPath, statWalkRoot, toolErrorText } from './list-tool-shared.mjs';

const RELATIVE_WINDOW_MS = { m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 };
const FIND_ABSOLUTE_CAP = 50_000;

function positiveTimeoutEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
// Prefer a complete answer within the normal search budget. Do not enforce a
// short response slice that makes ordinary discovery depend on another call.
const FIND_FUZZY_TIMEOUT_MS = positiveTimeoutEnv('MIXDOG_FIND_FUZZY_TIMEOUT_MS', 17_500);
// Same contract for name/glob find: bound the walk and the metadata pass, then
// SAY the result is partial. The old 20s walk plus a 5s stat deadline silently
// dropped every path whose stat missed the deadline, so a slow scope reported
// fewer matches than it actually found.
const FIND_FILES_TIMEOUT_MS = positiveTimeoutEnv('MIXDOG_FIND_FILES_TIMEOUT_MS', 2_000);
const FIND_STAT_DEADLINE_MS = positiveTimeoutEnv('MIXDOG_FIND_STAT_DEADLINE_MS', 1_000);

function _findDefaultHeadLimit(fallback) {
  const parsed = parseInt(process.env.MIXDOG_FIND_DEFAULT_HEAD_LIMIT ?? '', 10);
  return parsed > 0 ? parsed : fallback;
}

function _findOutputBudgetBytes(options = {}) {
  const requested = Number(options?.__findOutputBudgetBytes);
  const explicit = Number(options?.toolOutputMaxBytes);
  return Math.max(
    1,
    Math.min(
      LOCATOR_OUTPUT_MAX_BYTES,
      Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : LOCATOR_OUTPUT_MAX_BYTES,
      Number.isFinite(explicit) && explicit > 0 ? Math.trunc(explicit) : LOCATOR_OUTPUT_MAX_BYTES
    )
  );
}

// Fuzzy filename search has one canonical implementation: the Rust search
// server's resident inventory. A server failure is surfaced instead of
// launching a second filesystem walk with different semantics.
//
// A pruned tree cannot report what it never enumerated. Dependency and cache
// directories are skipped by default, so a file that exists only inside one
// came back as "(no fuzzy match for X)", which reads as proven absence and
// ends the search. A clean miss earns one noise-including pass; the default
// answer still lists no dependency path, but names the flag that would.
// Partial or timed-out passes say "no fuzzy match YET" and already tell the
// caller to narrow, so they never pay for the second walk.
export async function executeFuzzyFindTool(args, workDir, options = {}) {
  // A complete miss answers the requested scope. Do not start a second,
  // broader walk merely to offer an optional dependency-tree hint.
  return runFuzzyFindPass(args, workDir, options);
}

function fuzzyFindRequest(args, workDir) {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'Error: find requires query.' };
  const inputPath = normalizeInputPath(args.path) || '.';
  const guard = listGuardPath(inputPath);
  if (guard) return { error: guard };
  const fullPath = resolveAgainstCwd(inputPath, workDir);
  const guardFull = listGuardPath(fullPath);
  if (guardFull) return { error: guardFull };
  return {
    query,
    fullPath,
    // Fuzzy find defaults to searching dot-directories (hidden:true) so
    // machine-wide discovery reaches paths like ~/.mixdog/data/…; callers
    // opt out with hidden:false. .git and other noise dirs are still pruned
    // via DEFAULT_IGNORE_GLOBS (unless include_noise).
    hidden: args.hidden !== false,
    includeNoise: Boolean(args.include_noise),
    // head_limit:0 means "no cap" per list semantics; default is intentionally
    // compact so ambiguous discovery does not dump a huge candidate list.
    headLimit: normalizeListHeadLimit(args.head_limit, _findDefaultHeadLimit(25)),
    depth: args.depth != null ? Math.max(parseInt(args.depth, 10) || 1, 1) : null,
  };
}

function fuzzyFindCacheKey({ query, fullPath, hidden, includeNoise, headLimit, depth }) {
  return buildListCacheKey({
    mode: 'fuzzy_find',
    inputPath: normalizeOutputPath(fullPath),
    depth: depth ?? '',
    hidden,
    sort: 'score',
    typeFilter: 'file',
    headLimit,
    offset: '',
    namePattern: query,
    includeNoise,
  });
}

// Space-separated fragments AND-match one path. The native matcher handles
// every token independently and sums exact per-token scores.
function nativeFuzzyQuery({ query, fullPath, hidden, includeNoise, headLimit, depth }) {
  return {
    query,
    cwd: fullPath,
    limit: headLimit > 0 ? headLimit + 1 : 1_000,
    hidden,
    includeNoise,
    maxDepth: depth,
    exclude: [
      ...(includeNoise ? [] : DEFAULT_IGNORE_GLOBS),
      // Kernel-virtual trees are pruned even under include_noise:
      // they are never dependency noise, and walking them starves
      // the fuzzy inventory budget on a full-root scan.
      ...rootScanIgnoreGlobs(fullPath),
    ],
  };
}

// Asks the native inventory. `complete` and `partial` carry the served
// result, `error` the tool-error text. A timeout is an empty partial pass:
// native fuzzy and broad enumeration use the same complete inventory, and
// retrying the broad pass after a fuzzy timeout repeated the same expensive
// walk — one Find call became two consecutive timeouts that killed the
// shared search server. An empty timeout is an error, not evidence of an
// absent match.
async function serveNativeFuzzy(request, options) {
  const nativeFuzzyImpl =
    typeof options?.__tryServeFuzzySearch === 'function' ? options.__tryServeFuzzySearch : tryServeFuzzySearch;
  const startedAt = performance.now();
  const record = (outcome) => recordLocalSearchBackend('native_fuzzy', performance.now() - startedAt, outcome);
  try {
    const served = await nativeFuzzyImpl(nativeFuzzyQuery(request), {
      cwd: request.fullPath,
      timeout: FIND_FUZZY_TIMEOUT_MS,
      signal: options.signal,
    });
    if (served?.complete) {
      recordNativeSearchTiming(served);
      record('hit');
      return { complete: served };
    }
    if (served?.partial) {
      recordNativeSearchTiming(served);
      record('partial');
      return { partial: served };
    }
    record('miss');
    return { error: 'Error: native fuzzy search returned an invalid response.' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error?.code === 'NATIVE_SEARCH_TIMEOUT') {
      record('partial');
      return { partial: { matches: [], partial: true, timeout: true, scanErrors: 0, walkErrorDetails: [] } };
    }
    record('error');
    return { error: toolErrorText(error) };
  }
}

function completeFuzzyResult(served, { query, headLimit }) {
  const hasMore = served.hasMore || (headLimit > 0 && served.matches.length > headLimit);
  const matches = headLimit > 0 && hasMore ? served.matches.slice(0, headLimit) : served.matches;
  const lines = matches.length === 0 ? [`(no fuzzy match for "${query}")`] : [...matches];
  if (matches.length > 0 && hasMore) lines.push(`... (top ${headLimit || 1_000}; additional matches omitted)`);
  return { result: lines.join('\n'), count: matches.length };
}

function enumerationDetails(served) {
  return served.walkErrorDetails?.length ? `: ${served.walkErrorDetails.join('; ')}` : '';
}

function partialFuzzyWarning(served) {
  if (!(served.scanErrors > 0)) return '... [search timed out; partial results shown]';
  return `... [warning] ${served.scanErrors} path(s) could not be enumerated; partial results shown${enumerationDetails(served)}`;
}

function incompleteFuzzyError(served, query) {
  const scanErrorNote =
    served.scanErrors > 0 ? `; ${served.scanErrors} path(s) could not be enumerated${enumerationDetails(served)}` : '';
  return [
    `Error: fuzzy search ${served.timeout ? 'timed out' : 'did not complete'} before returning any matches for "${query}".`,
    `... [native inventory was incomplete${scanErrorNote}; absence of matches is not established]`,
  ].join('\n');
}

async function runFuzzyFindPass(args, workDir, options = {}) {
  const request = fuzzyFindRequest(args, workDir);
  if (request.error) return request.error;
  const { query, fullPath, headLimit } = request;
  const cacheKey = fuzzyFindCacheKey(request);
  const capFindResult = (value) =>
    capLineOrientedToolOutput(
      value,
      _findOutputBudgetBytes(options),
      () => `... [find result budget reached for query=${JSON.stringify(query)}; narrow path/limit]`
    );
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    recordLocalSearchCacheHit('result');
    return capFindResult(cached);
  }
  const outcome = await serveNativeFuzzy(request, options);
  if (outcome.error) return capFindResult(outcome.error);
  if (outcome.complete) {
    const { result, count } = completeFuzzyResult(outcome.complete, request);
    if (outcome.complete.cacheSafe !== false) cacheSet(cacheKey, result, { scopes: [fullPath] });
    reportToolProgress(options, `${count} candidates`);
    return capFindResult(result);
  }
  if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  const matches = outcome.partial.matches.slice(0, headLimit);
  if (matches.length > 0) return capFindResult([...matches, partialFuzzyWarning(outcome.partial)].join('\n'));
  return capFindResult(incompleteFuzzyError(outcome.partial, query));
}

// Parse `rg --files` stdout into a normalized relative-path list: strip a
// trailing CR, drop empties, strip a leading `./`, forward-slash.
function parseRgFileList(stdout) {
  return String(stdout)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0)
    .map((line) => normalizeOutputPath(line.replace(/^\.[/\\]/, '')));
}

function parseModifiedTime(value) {
  if (typeof value !== 'string') return null;
  const relativeWindow = value.match(/^(\d+)([hdm])$/);
  if (relativeWindow) return Date.now() - parseInt(relativeWindow[1], 10) * RELATIVE_WINDOW_MS[relativeWindow[2]];
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function invalidWindowError(field, value) {
  return `Error: invalid ${field} ${JSON.stringify(value)}; expected an ISO date/time or a relative window like 90m / 12h / 7d`;
}

// The find request as the walk sees it: the root, the name pattern (a glob
// in `path` becomes the pattern), the filters and the page.
function findFilesRequest(args, workDir) {
  args.path = coerceReadFamilyPathArg(args.path, workDir);
  args.path = normalizeInputPath(args.path);
  let inputPath = args.path || '.';
  let namePattern = typeof args.name === 'string' ? args.name : null;
  if (!namePattern && hasGlobMagic(inputPath)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(inputPath);
    inputPath = baseDir || '.';
    namePattern = relativePattern.replace(/^\/+/, '');
  }
  if (namePattern) namePattern = normalizeInputPath(namePattern).replace(/^\/+/, '');
  const guard = listGuardPath(inputPath);
  if (guard) return { error: guard };
  const fullPath = resolveAgainstCwd(inputPath, workDir);
  const guardFull = listGuardPath(fullPath);
  if (guardFull) return { error: guardFull };
  const after = parseModifiedTime(args.modified_after);
  const before = parseModifiedTime(args.modified_before);
  // An unparseable date must FAIL, not silently disable the filter — a
  // caller who passed a filter believes the listing is filtered.
  if (args.modified_after && after === null) return { error: invalidWindowError('modified_after', args.modified_after) };
  if (args.modified_before && before === null) {
    return { error: invalidWindowError('modified_before', args.modified_before) };
  }
  return {
    inputPath,
    fullPath,
    namePattern,
    typeFilter: ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any',
    sortMode: ['name', 'size', 'mtime'].includes(args.sort) ? args.sort : 'mtime',
    minSize: typeof args.min_size === 'number' && args.min_size > 0 ? args.min_size : null,
    maxSize: typeof args.max_size === 'number' && args.max_size >= 0 ? args.max_size : null,
    headLimit: normalizeListHeadLimit(args.head_limit, 100),
    offset: typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0,
    includeNoise: Boolean(args.include_noise),
    hidden: Boolean(args.hidden),
    // Clamp depth to >=1 when caller passes it; null means unbounded (legacy
    // find-mode behavior). Forwarded to the rg inventory's --max-depth.
    depth: args.depth != null ? Math.max(parseInt(args.depth, 10) || 1, 1) : null,
    after,
    before,
    modifiedAfter: args.modified_after || '',
    modifiedBefore: args.modified_before || '',
  };
}

function findCacheKey(request) {
  return buildListCacheKey({
    mode: 'find',
    inputPath: normalizeOutputPath(request.fullPath),
    depth: request.depth ?? '',
    hidden: request.hidden,
    sort: request.sortMode,
    typeFilter: request.typeFilter,
    headLimit: request.headLimit,
    offset: request.offset,
    namePattern: request.namePattern,
    minSize: request.minSize,
    maxSize: request.maxSize,
    modifiedAfter: request.modifiedAfter,
    modifiedBefore: request.modifiedBefore,
    includeNoise: request.includeNoise,
  });
}

// `name` is documented as a SUBSTRING filter (use glob mode for patterns).
// Compile it as a glob ONLY when it actually contains glob metacharacters;
// otherwise match by case-insensitive contains. The bug was that EVERY name
// was glob-compiled, so a plain fragment like ".mjs" anchored-matched nothing.
function findNameMatcher({ namePattern, fullPath }) {
  if (!namePattern) return { matches: () => true, isGlob: false };
  const isGlob = /[*?[\]{}]/.test(namePattern);
  const hasPath = /[\\/]/.test(namePattern);
  let nameRegex = null;
  let rootOptionalRegex = null;
  if (isGlob) {
    try {
      // compileSimpleGlob throws (R16 DoS caps: >256 brace variants /
      // oversized pattern/regex body) — convert to a tool-error string.
      nameRegex = compileSimpleGlob(namePattern);
      rootOptionalRegex = namePattern.startsWith('**/') ? compileSimpleGlob(namePattern.slice(3)) : null;
    } catch (error) {
      return { error: toolErrorText(error) };
    }
  }
  const nameLower = namePattern.toLowerCase();
  const matches = (entName, entPath) => {
    const subject = hasPath ? normalizeOutputPath(relative(fullPath, entPath)) : entName;
    if (isGlob) return nameRegex.test(subject) || Boolean(rootOptionalRegex?.test(subject));
    return subject.toLowerCase().includes(nameLower);
  };
  return { matches, isGlob };
}

function findInventoryArgs({ hidden, depth, includeNoise, fullPath, namePattern }, nameIsGlob) {
  const inventoryArgs = ['--files', '--directories', '--no-ignore'];
  if (hidden) inventoryArgs.push('--hidden');
  if (depth != null) inventoryArgs.push('--max-depth', String(depth));
  if (!includeNoise) {
    for (const ex of DEFAULT_IGNORE_GLOBS) inventoryArgs.push('--glob', ex);
  }
  for (const ex of rootScanIgnoreGlobs(fullPath)) inventoryArgs.push('--glob', ex);
  if (namePattern) inventoryArgs.push('--iglob', nameIsGlob ? namePattern : `*${namePattern}*`);
  inventoryArgs.push('.');
  return inventoryArgs;
}

// runRg returns a plain string ONLY for a complete, cache-safe sweep; a
// timed-out / truncated / non-cache-safe one comes back as a String object
// carrying {partial,timeout,truncated,cacheSafe}. Discarding that metadata
// cached a half-finished walk as authoritative, so one slow enumeration
// became a persistent false negative.
async function enumerateFindInventory(request, nameIsGlob, options) {
  const { fullPath } = request;
  try {
    const inventory = await runRg(findInventoryArgs(request, nameIsGlob), {
      cwd: fullPath,
      signal: options.signal,
      timeout: FIND_FILES_TIMEOUT_MS,
    });
    const meta = inventory && typeof inventory === 'object' ? inventory : null;
    return {
      relPaths: parseRgFileList(String(inventory)),
      walkIncomplete: Boolean(meta && (meta.partial === true || meta.truncated === true || meta.cacheSafe === false)),
      walkTimedOut: meta?.timeout === true,
    };
  } catch (error) {
    const message = normalizeErrorMessage(error instanceof Error ? error.message : String(error));
    // The walk cap is the answer here, not a mystery failure: say which
    // scope blew it, and how to widen the cap when the scope is intended.
    if (/timed out/i.test(message)) {
      return {
        error: `Error: file enumeration under ${normalizeOutputPath(fullPath)} exceeded the ${FIND_FILES_TIMEOUT_MS}ms walk cap; narrow the scope (path/name/depth), or raise MIXDOG_FIND_FILES_TIMEOUT_MS when the whole tree is required.`,
      };
    }
    return { error: `Error: ${message}` };
  }
}

function statFilteredMatch({ stat, full: entPath, mtimeMs }, { effectiveTypeFilter, minSize, maxSize, after, before }) {
  if (effectiveTypeFilter === 'file' && !stat.isFile()) return null;
  if (effectiveTypeFilter === 'dir' && !stat.isDirectory()) return null;
  if (stat.isFile()) {
    if (minSize !== null && stat.size < minSize) return null;
    if (maxSize !== null && stat.size > maxSize) return null;
  }
  if (after !== null && mtimeMs < after) return null;
  if (before !== null && mtimeMs > before) return null;
  return { path: entPath, type: stat.isDirectory() ? 'dir' : 'file', size: stat.size, mtimeMs };
}

// Name-filters the inventory, stats the candidates under the metadata
// deadline and applies the size/type/date filters. A missed stat used to
// drop the path outright, so a time-bounded metadata pass silently reported
// fewer matches than the walk found. For a find the PATH is the answer; only
// an active size/type/date filter may legitimately exclude one whose
// metadata is unknown.
async function collectFindMatches(request, relPaths, nameMatches, workDir) {
  const { fullPath, typeFilter, minSize, maxSize, after, before } = request;
  const candidates = [];
  let truncatedByCap = false;
  for (const rel of relPaths) {
    if (!rel) continue;
    const candidate = resolveAgainstCwd(normalizeInputPath(rel), fullPath);
    if (!nameMatches(basename(candidate), candidate)) continue;
    candidates.push(candidate);
    if (candidates.length >= FIND_ABSOLUTE_CAP) {
      truncatedByCap = true;
      break;
    }
  }
  const sizeFiltered = minSize !== null || maxSize !== null;
  const effectiveTypeFilter = sizeFiltered && typeFilter === 'any' ? 'file' : typeFilter;
  const filters = { effectiveTypeFilter, minSize, maxSize, after, before };
  const filtersNeedStat = effectiveTypeFilter !== 'any' || sizeFiltered || after !== null || before !== null;
  const withStat = await statPathsForMtime(candidates, workDir, 64, { deadlineMs: FIND_STAT_DEADLINE_MS });
  const matches = [];
  let unstatted = 0;
  for (let index = 0; index < withStat.length; index++) {
    const item = withStat[index];
    let match;
    if (item?.stat) {
      match = statFilteredMatch(item, filters);
    } else {
      unstatted++;
      if (filtersNeedStat) continue;
      match = { path: candidates[index], type: 'file', size: 0, mtimeMs: 0, unknownMeta: true };
    }
    if (!match) continue;
    matches.push(match);
    if (matches.length >= FIND_ABSOLUTE_CAP) {
      truncatedByCap = true;
      break;
    }
  }
  return { matches, unstatted, truncatedByCap, filtersNeedStat };
}

function findComparator(sortMode) {
  if (sortMode === 'name') return (a, b) => normalizeOutputPath(a.path).localeCompare(normalizeOutputPath(b.path));
  if (sortMode === 'size') return (a, b) => b.size - a.size;
  return (a, b) => b.mtimeMs - a.mtimeMs;
}

function findResultLine(match, fullPath) {
  if (match.unknownMeta) return `${displayRelPath(match.path, fullPath)}\t-\t-`;
  return `${displayRelPath(match.path, fullPath)}\t${formatListSize(match.type, match.size)}\t${formatMtime(match.mtimeMs)}`;
}

function renderFindResult(request, { matches, unstatted, truncatedByCap, filtersNeedStat, walkIncomplete, walkTimedOut }) {
  const { fullPath, sortMode, offset, headLimit } = request;
  matches.sort(findComparator(sortMode));
  const windowed = offset > 0 ? matches.slice(offset) : matches;
  const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
  const paged = windowed.length > sliced.length;
  const lines = sliced.map((match) => findResultLine(match, fullPath));
  if (paged) {
    lines.push(
      `... [entries ${offset + 1}-${offset + sliced.length} of ${matches.length}; pass offset:${offset + sliced.length} to continue]`
    );
  }
  if (truncatedByCap) {
    lines.push(
      `... walk truncated at ${FIND_ABSOLUTE_CAP} matches; narrow the scope (path/name/modified_after) for accurate global sort`
    );
  }
  if (walkIncomplete) {
    lines.push(
      `... walk INCOMPLETE (${walkTimedOut ? 'file enumeration timed out' : 'file enumeration returned partial results'}); matches are missing — narrow the scope (path/name/depth) and re-run`
    );
  }
  if (unstatted) {
    lines.push(
      `... ${unstatted} path(s) had no metadata within ${FIND_STAT_DEADLINE_MS}ms; ` +
        (filtersNeedStat ? 'excluded because a size/type/date filter is active' : 'listed with "-" for size/date')
    );
  }
  return { text: lines.join('\n') || '(no matches)', paged };
}

export async function executeFindFilesTool(args, workDir, options = {}) {
  const request = findFilesRequest(args, workDir);
  if (request.error) return request.error;
  const cacheKey = findCacheKey(request);
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;
  const matcher = findNameMatcher(request);
  if (matcher.error) return matcher.error;
  const root = await statWalkRoot(request.fullPath, workDir, request.inputPath);
  if (root.error) return root.error;
  if (!root.stat.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(request.fullPath)}`;
  const inventory = await enumerateFindInventory(request, matcher.isGlob, options);
  if (inventory.error) return inventory.error;
  const collected = await collectFindMatches(request, inventory.relPaths, matcher.matches, workDir);
  const { text, paged } = renderFindResult(request, { ...collected, ...inventory });
  const incomplete = collected.truncatedByCap || inventory.walkIncomplete || collected.unstatted > 0;
  if (options?.scopedCacheOutcome && (incomplete || paged)) markScopedCacheIncomplete(options.scopedCacheOutcome);
  // A bounded page is still an exact result because offset/limit are keyed
  // and watcher invalidation covers the scope. Only the absolute safety cap
  // or a known-incomplete walk makes the computation incomplete.
  if (!incomplete) cacheSet(cacheKey, text, { scopes: [request.fullPath] });
  return text;
}
