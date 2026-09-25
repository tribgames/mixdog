import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  coerceReadFamilyPathArg,
  GREP_AUTO_CONTEXT_LINES,
  normalizeGrepArgs,
  normalizeOutputPath,
  trueCasePath,
} from './path-utils.mjs';
import { _suggestIndexedPaths, buildNotFoundHint, finalizeReadFamilyEnoentTail } from './search-path-diagnostics.mjs';
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
import { buildGrepCacheKey, buildGrepRgArgs } from './search-builders.mjs';
import { runRg, runRgWindowedLines } from './native-search-runner.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import { cacheGet, cacheSet, runResultCacheInFlight, statPathsForMtime } from './cache-layers.mjs';
import { recordLocalSearchCacheHit } from './local-search-telemetry.mjs';
import { parseGrepCountLine } from './lib/search-input-helpers.mjs';
import { statReachable } from './fs-reachability.mjs';
// Fan-out / chunk-merge / rescue sub-flows; each receives `executeGrepTool`
// as a parameter to avoid an import cycle.
import { runGrepPathFanout } from './lib/grep-path-fanout.mjs';
import { runGrepPatternFanout } from './lib/grep-pattern-fanout.mjs';
import { runGrepChunkMerge } from './lib/grep-chunk-merge.mjs';
import { MAX_RESCUE_BYTES as GREP_RESCUE_MAX_BYTES, runGrepSingleFileRescue } from './lib/grep-single-file-rescue.mjs';

// Grep output rendering (context-block windowing, fan-out dedupe, notices)
// lives in lib/grep-output.mjs.
import {
  formatGrepContextOutput,
  formatGrepOutput,
  grepNoMatchesBody,
  grepPartialWarning,
} from './lib/grep-output.mjs';
import { reportToolProgress } from './lib/tool-progress.mjs';
import {
  expandGrepAnchorContextOutput,
  _grepContextCharBudget,
  _grepDefaultHeadLimit,
} from './lib/grep-context-expander.mjs';
import { resolveGrepRequest } from './lib/grep-request.mjs';

// One explicit FILE is scanned directly by the native server — there is no tree
// to walk — so a long deadline on a file scope can only ever be spent QUEUED
// behind another request's walk. A scope rooted in a virtual filesystem
// (/proc, /sys) is exactly that walk, and it starved the searches behind it:
// a six-line /proc/self/status failed after 17.7s while a plain read of the
// same file answered in 7ms. Bound the file case to a fraction of the turn and
// let the JS rescue below answer it instead of spending the turn waiting.
const SINGLE_FILE_SEARCH_DEADLINE_MS = 2_500;
// Above this many patterns one rg run is split into chunks and merged.
const GREP_MULTILINE_PATTERN_CAP = 5;
const GREP_ARRAY_PATTERN_CAP = 20;
// Implicit (uncoerced) unlimited content searches stop at this many lines.
const GREP_CONTENT_HARD_CAP = 300;
const GREP_CONTEXT_LINE_HARD_CAP = 4000;

export async function executeGrepTool(args, workDir, executeChildBuiltinTool, readStateScope = null, options = {}) {
  args = normalizeGrepArgs(args);
  args.path = coerceReadFamilyPathArg(args.path);
  const call = {
    args,
    workDir,
    executeChildBuiltinTool,
    readStateScope,
    options,
    callContextCharBudget: _grepContextCharBudget(options),
    executeGrepTool,
  };
  // Batch multiple string paths concurrently. Recursive calls pass a single
  // string path, so recursion bottoms out after one level. Results retain
  // input order even though every path starts immediately.
  if (Array.isArray(args.path)) {
    const list = dedupedPathList(args.path);
    // Multi-root fan-out (combined single-spawn or legacy bounded
    // recursion) lives in lib/grep-path-fanout.mjs.
    if (list.length > 1) return await runGrepPathFanout({ ...call, list, defaultHeadLimit: _grepDefaultHeadLimit() });
    args.path = list[0];
  }
  const resolved = await resolveGrepRequest(args, workDir, options);
  if (resolved.delegate) return executeChildBuiltinTool('glob', resolved.delegate, workDir);
  if (resolved.result !== undefined) return resolved.result;
  const request = { ...resolved.request, ...call };
  const { patterns, outputMode, multilineMode } = request;

  // Part 1: pattern[] fan-out. Two or more patterns in a content search run
  // as INDEPENDENT greps (mirroring the path[] batching above): each pattern
  // keeps its own full head_limit budget and its own truncation notice, and
  // identical path:line match lines are de-duplicated across patterns. The
  // single-pattern path and the non-content modes (files_with_matches/count)
  // keep the combined single-rg behavior. `_grepPatternFanout` guards the
  // recursive single-pattern calls from re-entering the fan-out; the internal
  // chunk-merge recursion is likewise skipped. The fan-out (speculative
  // prefilter + combined single-spawn + legacy per-pattern recursion) lives
  // in lib/grep-pattern-fanout.mjs.
  if (patterns.length > 1 && outputMode === 'content' && !options._grepChunkMerge && !options._grepPatternFanout) {
    return await runGrepPatternFanout(request);
  }

  const patternChunkCap = multilineMode ? GREP_MULTILINE_PATTERN_CAP : GREP_ARRAY_PATTERN_CAP;
  // Chunked pattern[] fetch + deterministic merge replay lives in
  // lib/grep-chunk-merge.mjs.
  if (patterns.length > patternChunkCap) return await runGrepChunkMerge({ ...request, patternChunkCap });

  return await runCachedGrepSearch({
    ...request,
    forceGrepFilename: !!options._grepChunkMerge || !!options._grepPatternFanout,
  });
}

function dedupedPathList(paths) {
  const seen = new Set();
  return paths.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p && !seen.has(p) && seen.add(p));
}

// Read-only search: grep no longer records a whole-file read snapshot.
// That snapshot existed only to satisfy the apply_patch read-before-edit
// guard, and computing it turned a single-file grep into rg PLUS a full
// whole-file read+hash (recordReadSnapshot hashes the whole file when the
// range covers it). Edit-safety is unaffected: the read and apply_patch
// paths still record their own snapshots.
async function runCachedGrepSearch(request) {
  const { options, grepResolvedPath } = request;
  const cacheKey = grepCacheKeyFor(request);
  const cached = cacheGet(cacheKey);
  // Cache-hit returns a PRIOR grep's output; the file may have changed since
  // that result was cached. Recording a fresh whole-file snapshot here would
  // mismatch what the caller actually saw (stale cached lines) and defeat
  // drift detection. So only the fresh-compute path (below) records a read.
  if (cached !== null) {
    recordLocalSearchCacheHit('result');
    return cached;
  }

  return await runResultCacheInFlight(cacheKey, ({ signal }) => runGrepSearch({ ...request, cacheKey }, signal), {
    signal: options?.signal || options?.abortSignal || null,
    scopes: [grepResolvedPath],
  });
}

// Fan-out prefilter scoping keys the cache on the candidate list a parent
// multi-pattern grep passed down.
function candidateFilesKey(options) {
  const files = options._grepCandidateFiles;
  if (!Array.isArray(files) || files.length === 0) return '';
  return createHash('sha256').update(files.join('\x01')).digest('hex').slice(0, 16);
}

function grepCacheKeyFor(request) {
  const { args, options } = request;
  return buildGrepCacheKey({
    patterns: request.patterns,
    includeNoise: args.include_noise === true,
    text: args.text === true,
    searchPath: normalizeOutputPath(request.grepResolvedPath),
    globPatterns: request.normalizedGlobPatterns,
    outputMode: request.outputMode,
    headLimit: request.headLimit,
    offset: request.offset,
    caseInsensitive: request.caseInsensitive,
    showLineNumbers: request.showLineNumbers,
    beforeN: request.beforeN,
    afterN: request.afterN,
    contextN: request.contextN,
    multilineMode: request.multilineMode,
    onlyMatching: args['-o'] === true,
    fileType: request.fileType,
    pcre2: request.pcre2Mode,
    withFilename: request.forceGrepFilename,
    contextCharBudget: request.callContextCharBudget,
    // Capped requests carry the "[capped at N of M]" notice; key on the
    // original count so they never collide with an exact N-pattern request
    // (or a differently-capped one) in the internal result cache.
    patternCapTotal: request.patternCapTotal,
    candidatesKey: candidateFilesKey(options),
  });
}

// One fresh (uncached) grep: stat the scope, then answer through the
// adaptive-context, legacy-context or plain windowed path. A native-server
// failure on a single file is answered by the JS rescue reader.
async function runGrepSearch(request, sharedSignal) {
  let grepStat;
  try {
    grepStat = await statReachable(request.grepResolvedPath);
  } catch (err) {
    return grepMissingPathResult(request, err);
  }
  const scope = await buildGrepScope(request, grepStat, sharedSignal);
  try {
    return await runGrepScope(scope);
  } catch (err) {
    if (sharedSignal?.aborted) throw err;
    return grepFailureResult(scope, err);
  }
}

async function grepMissingPathResult({ workDir, grepResolvedPath, searchPath, executeChildBuiltinTool }, err) {
  const msg = `Error: path does not exist: ${normalizeOutputPath(grepResolvedPath)} (${err?.code || 'ENOENT'})`;
  let hint = buildNotFoundHint(workDir, grepResolvedPath, 'Search', err?.code, {});
  if (!hint) hint = await _suggestIndexedPaths(grepResolvedPath, executeChildBuiltinTool, workDir);
  return msg + finalizeReadFamilyEnoentTail(hint, searchPath, err?.code);
}

// Per-call search scope on top of the resolved request: the stat, the
// true-cased spawn root, the shared rg argument base and the exec options.
async function buildGrepScope(request, grepStat, sharedSignal) {
  const { args, workDir, options, patterns, normalizedGlobPatterns, multilineMode, fileType } = request;
  const filenameOmitted = request.forceGrepFilename ? false : grepStat.isFile();
  // Single-FILE scope: a positive glob filter can only re-filter the one
  // explicitly targeted file — either a no-op (basename matches) or a
  // mistake that silently turns an explicit file search into
  // "(no matches)". The explicit operand wins; drop the filter.
  if (grepStat.isFile() && normalizedGlobPatterns.length > 0) {
    normalizedGlobPatterns.length = 0;
  }

  const { searchPath, rgSpawnCwd } = await grepSpawnRoot(request.searchPath, workDir, grepStat);
  // Fan-out prefilter scoping: a parent multi-pattern grep already ran one
  // combined --files-with-matches walk and passed the COMPLETE candidate
  // list; every rg below searches only those files (no directory walk).
  const scopedCandidateFiles =
    Array.isArray(options._grepCandidateFiles) && options._grepCandidateFiles.length > 0 && grepStat.isDirectory()
      ? options._grepCandidateFiles
      : null;
  const singleFileScope = grepStat.isFile();
  // Bound ONLY the file sizes the JS rescue can actually answer. A bigger
  // file keeps the full budget, so the short deadline can never cost a
  // caller an answer it would otherwise have received. (A procfs file
  // reports size 0 and is therefore always bounded — exactly the case that
  // motivated the bound.)
  const boundSingleFile = singleFileScope && Number(grepStat.size) <= GREP_RESCUE_MAX_BYTES;
  return {
    ...request,
    searchPath,
    grepStat,
    filenameOmitted,
    rgSpawnCwd,
    // What every rg invocation shares: the probe, the anchor pass and the
    // main search only differ in output shaping.
    rgBase: {
      patterns,
      includeNoise: args.include_noise === true,
      text: args.text === true,
      searchPath,
      globPatterns: normalizedGlobPatterns,
      multilineMode,
      fileType,
    },
    scopedCandidateFiles,
    singleFileScope,
    searchExecOptions: {
      cwd: rgSpawnCwd,
      signal: sharedSignal,
      ...(boundSingleFile ? { timeout: SINGLE_FILE_SEARCH_DEADLINE_MS } : {}),
    },
  };
}

// The search path and the cwd rg spawns in. rg builds --glob overrides
// rooted at its process cwd and relativizes each candidate against it with
// a CASE-SENSITIVE prefix strip; workDir is case-normalized (lowercased)
// while callers pass real-cased absolute paths, so the strip fails and
// slash-anchored globs (src/**/*.mjs) silently match nothing. Spawn rg at
// the TRUE-CASED search root so relativization — and therefore glob
// anchoring — always engages. Relative searchPath keeps the workDir cwd
// (both sides already share workDir's casing).
async function grepSpawnRoot(searchPath, workDir, grepStat) {
  if (!isAbsolute(searchPath)) return { searchPath, rgSpawnCwd: workDir };
  const trueCased = await trueCasePath(searchPath);
  return { searchPath: trueCased, rgSpawnCwd: grepStat.isDirectory() ? trueCased : workDir };
}

function grepNoMatches(scope, totalKnown) {
  return grepNoMatchesBody({
    patterns: scope.patterns,
    globPatterns: scope.normalizedGlobPatterns,
    isDirectory: scope.grepStat.isDirectory(),
    searchPath: scope.searchPath,
    totalKnown,
  });
}

// Cased-letter hint shared by EVERY no-match body (context modes included):
// a zero-match single-pattern search whose pattern carries cased letters may
// have failed only on case. ONE case-insensitive files_with_matches probe;
// non-empty output nudges toward `-i`. Skipped for pattern arrays, when `-i`
// is already set, and for directory scopes: a broad no-match must not
// trigger a second whole-tree scan just to produce an advisory hint.
async function grepCaseHintSuffix({ args, grepStat, patterns, rgBase, searchExecOptions }) {
  if (grepStat.isDirectory() || args['-i'] === true || patterns.length !== 1 || !/[A-Za-z]/.test(patterns[0])) {
    return '';
  }
  try {
    const probeArgs = buildGrepRgArgs({
      ...rgBase,
      outputMode: 'files_with_matches',
      caseInsensitive: true,
      showLineNumbers: false,
      beforeN: null,
      afterN: null,
      contextN: null,
      onlyMatching: false,
    });
    const probeOut = await runRg(probeArgs, searchExecOptions);
    if (String(probeOut).split('\n').some(Boolean)) {
      return ' (case-insensitive would match — try -i)';
    }
  } catch {
    /* best-effort hint */
  }
  return '';
}

// Empty rendering → the no-match body, plus the casing hint on a proven
// zero-match at offset 0: an empty window past a positive offset (or past
// pre-offset matches) means real case-sensitive hits were skipped, so the
// hint would mislead.
async function grepEmptyBody(scope, totalKnown, provenZeroMatches) {
  let body = grepNoMatches(scope, totalKnown);
  if (totalKnown && scope.offset === 0 && provenZeroMatches) body += await grepCaseHintSuffix(scope);
  return body;
}

// Answers one stat-resolved scope: fused adaptive context, legacy context
// blocks, or the plain windowed listing.
async function runGrepScope(scope) {
  const { args, outputMode, headLimit, headLimitCoerced, beforeN, afterN, contextN } = scope;
  const rgArgs = buildGrepRgArgs({
    ...scope.rgBase,
    outputMode,
    caseInsensitive: scope.caseInsensitive,
    showLineNumbers: scope.showLineNumbers,
    beforeN,
    afterN,
    contextN,
    onlyMatching: args['-o'] === true,
    pcre2: scope.pcre2Mode,
    withFilename: scope.forceGrepFilename,
    candidateFiles: scope.scopedCandidateFiles,
  });
  const contextMode = outputMode === 'content' && (beforeN > 0 || afterN > 0 || contextN > 0);
  if (contextMode) {
    // A symmetric content search is a fused two-pass operation: pass 1
    // streams only rg anchors, then pass 2 expands sparse searches to
    // patch-ready source. Broad results expand up to three priority spans
    // and retain compact range anchors, all within the whole-call character
    // budget. Explicit context:0 remains bare. The automatic window is
    // asymmetric and travels as -B/-A, so it qualifies on the flag rather
    // than on a symmetric contextN.
    if (adaptiveContextEligible(scope)) {
      const adaptive = await runAdaptiveContextGrep(scope);
      if (adaptive !== null) return adaptive;
      // Non-empty but unparsable rg output (binary diagnostics or an
      // unexpected platform format) falls through to the legacy context
      // renderer rather than losing the result.
    }
    return runLegacyContextGrep(scope, rgArgs);
  }
  const callerExplicitUnlimited = headLimitCoerced === 0;
  const effectiveHeadLimit =
    headLimit === Infinity && !callerExplicitUnlimited && outputMode === 'content' ? GREP_CONTENT_HARD_CAP : headLimit;
  return runPlainGrep(scope, rgArgs, effectiveHeadLimit);
}

function adaptiveContextEligible({ args, autoContext, contextN, beforeN, afterN, showLineNumbers, multilineMode }) {
  return (
    (autoContext || (contextN > 0 && !(beforeN > 0) && !(afterN > 0))) &&
    showLineNumbers &&
    !multilineMode &&
    args['-o'] !== true
  );
}

// A windowed stream's completeness: a scan partial keeps its collected
// lines under the partial warning; a cap overflow carries the caller's cap
// warning instead.
function streamedOutcome(streamed, capWarning) {
  if (streamed.partial) return { totalKnown: false, partialSuffix: grepPartialWarning(streamed) };
  return { totalKnown: streamed.complete, partialSuffix: streamed.complete ? '' : capWarning };
}

// Shared tail of both context renderers: no-match fallback, scoped-cache
// bookkeeping, caching of a complete rendering, and the progress line.
async function finishContextGrep(scope, rendered, { totalKnown, partialSuffix, cacheSafe }) {
  const { options, cacheKey, grepResolvedPath, patternCapNote } = scope;
  const sourceComplete = rendered.sourceComplete !== false;
  const body = rendered.text || (await grepEmptyBody(scope, totalKnown, rendered.total === 0));
  const out = patternCapNote + body + partialSuffix;
  if (options?.scopedCacheOutcome && (!totalKnown || rendered.omitted > 0 || !sourceComplete)) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  if (totalKnown && rendered.omitted === 0 && sourceComplete && cacheSafe) {
    cacheSet(cacheKey, out, { scopes: [grepResolvedPath] });
  }
  reportToolProgress(options, `found ${rendered.total} matches`);
  return out;
}

async function runAdaptiveContextGrep(scope) {
  const { headLimit, offset, searchExecOptions } = scope;
  const anchorArgs = buildGrepRgArgs({
    ...scope.rgBase,
    outputMode: scope.outputMode,
    caseInsensitive: scope.caseInsensitive,
    showLineNumbers: true,
    beforeN: null,
    afterN: null,
    contextN: null,
    onlyMatching: false,
    pcre2: scope.pcre2Mode,
    withFilename: scope.forceGrepFilename,
    candidateFiles: scope.scopedCandidateFiles,
  });
  const anchorCap = Math.min(4000, headLimit === Infinity ? 4000 : Math.max(200, offset + headLimit + 4));
  const streamed = await runRgWindowedLines(anchorArgs, searchExecOptions, {
    offset: 0,
    limit: anchorCap,
    summaryLimit: 0,
  });
  const outcome = streamedOutcome(
    streamed,
    `\n[warning] anchor output capped at ${anchorCap} matches; results partial — narrow path/glob/pattern for the full match set.`
  );
  const ctx = await expandGrepAnchorContextOutput({
    allLines: streamed.lines,
    workDir: scope.workDir,
    rgSpawnCwd: scope.rgSpawnCwd,
    grepResolvedPath: scope.grepResolvedPath,
    searchPath: scope.searchPath,
    outputMode: scope.outputMode,
    filenameOmitted: scope.filenameOmitted,
    headLimit,
    offset,
    totalKnown: outcome.totalKnown,
    requestedContext: scope.contextN,
    maxContext: GREP_AUTO_CONTEXT_LINES,
    patterns: scope.patterns,
    caseInsensitive: scope.caseInsensitive,
    charBudget: scope.callContextCharBudget,
    signal: searchExecOptions.signal,
  });
  if (ctx.total > 0 || streamed.lines.length === 0) {
    return finishContextGrep(scope, ctx, { ...outcome, cacheSafe: streamed.cacheSafe !== false });
  }
  return null;
}

// Streams only enough lines to satisfy the block window (offset +
// head_limit + tail reserve), so rg is stopped early and a broad
// content_with_context never retains a full 20MB stdout copy. A cap hit →
// complete:false → partial (lower-bound) phrasing.
async function runLegacyContextGrep(scope, rgArgs) {
  const { headLimit, offset, beforeN, afterN, contextN } = scope;
  const perBlock = 2 + (beforeN || 0) + (afterN || 0) + 2 * (contextN || 0);
  const blockBudget = headLimit === Infinity ? Infinity : offset + headLimit + 4;
  const lineCap =
    blockBudget === Infinity
      ? GREP_CONTEXT_LINE_HARD_CAP
      : Math.min(GREP_CONTEXT_LINE_HARD_CAP, Math.max(200, blockBudget * Math.max(1, perBlock) + 8));
  const streamed = await runRgWindowedLines(rgArgs, scope.searchExecOptions, {
    offset: 0,
    limit: lineCap,
    summaryLimit: 0,
  });
  const outcome = streamedOutcome(
    streamed,
    `\n[warning] context output capped at ${lineCap} lines to bound memory; results partial — narrow path/glob/pattern for the full match set.`
  );
  const ctx = formatGrepContextOutput({
    allLines: streamed.lines,
    workDir: scope.workDir,
    outputMode: scope.outputMode,
    filenameOmitted: scope.filenameOmitted,
    headLimit,
    offset,
    searchPath: scope.searchPath,
    totalKnown: outcome.totalKnown,
  });
  return finishContextGrep(scope, ctx, { ...outcome, cacheSafe: streamed.cacheSafe !== false });
}

async function runPlainGrep(scope, rgArgs, effectiveHeadLimit) {
  const { options, outputMode, headLimit, offset, cacheKey, grepResolvedPath } = scope;
  const window = await collectGrepWindow(scope, rgArgs, effectiveHeadLimit);
  let { windowed } = window;
  if (outputMode === 'files_with_matches' && windowed.length > 1) {
    windowed = await sortNewestFirst(windowed, scope.rgSpawnCwd);
  }
  let body = formatGrepOutput({
    windowed,
    totalWindowed: window.totalWindowed,
    totalKnown: window.totalKnown,
    headLimit,
    offset,
    outputMode,
    beforeN: scope.beforeN,
    afterN: scope.afterN,
    contextN: scope.contextN,
    workDir: scope.workDir,
    filenameOmitted: scope.filenameOmitted,
    disableContentGrouping: scope.forceGrepFilename,
    includeMatchCount: false,
  });
  if (!body) body = await grepEmptyBody(scope, window.totalKnown, window.totalWindowed === 0);
  const out = scope.patternCapNote + body + window.partialSuffix;
  const shownLines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
  const remaining = Math.max(0, window.totalWindowed - shownLines.length);
  // Mirrors formatGrepOutput truncation / totalKnown semantics.
  if (options?.scopedCacheOutcome && (!window.totalKnown || remaining > 0)) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  if (window.totalKnown && remaining === 0 && window.cacheSafe) {
    cacheSet(cacheKey, out, { scopes: [grepResolvedPath] });
  }
  if (typeof options?.onProgress === 'function') {
    reportToolProgress(options, grepProgressText(outputMode, windowed, window.totalWindowed));
  }
  return out;
}

// The match window: streamed under a head limit (rg stops early), else the
// whole stdout sliced at the offset. runRg boxes stdout and sets .truncated
// when the 20MB stdout cap tripped; that result is incomplete so
// formatGrepOutput emits the truncation notice instead of presenting it as
// complete.
async function collectGrepWindow(scope, rgArgs, effectiveHeadLimit) {
  const { outputMode, offset, searchExecOptions } = scope;
  if (effectiveHeadLimit !== Infinity) {
    const streamed = await runRgWindowedLines(rgArgs, searchExecOptions, {
      offset,
      limit: effectiveHeadLimit,
      summaryLimit: outputMode === 'content' ? 120 : 0,
    });
    return {
      windowed: streamed.lines,
      totalWindowed: streamed.totalSeen,
      cacheSafe: streamed.cacheSafe !== false,
      ...streamedOutcome(streamed, ''),
    };
  }
  const stdout = await runRg(rgArgs, searchExecOptions);
  const allLines = String(stdout).split('\n').filter(Boolean);
  const windowed = offset > 0 ? allLines.slice(offset) : allLines;
  const boxed = typeof stdout === 'object' ? stdout : {};
  return {
    windowed,
    totalWindowed: windowed.length,
    totalKnown: !boxed.truncated && !boxed.partial,
    cacheSafe: boxed.cacheSafe !== false,
    partialSuffix: boxed.partial ? grepPartialWarning(stdout) : '',
  };
}

// files_with_matches: newest-first (mtime desc, path tiebreak) so recently
// edited files surface first. Statting is bounded (64 workers, 5s
// deadline); stat-failed entries keep rg traversal order after the statted
// ones. Sort covers the shown window — with the default head limit the
// common case is the complete result set.
async function sortNewestFirst(windowed, rgSpawnCwd) {
  const withStat = await statPathsForMtime(windowed, rgSpawnCwd, 64, { deadlineMs: 5000 });
  const statted = [];
  const unstatted = [];
  for (let i = 0; i < windowed.length; i++) {
    const entry = withStat[i];
    if (entry?.stat) statted.push({ line: windowed[i], mtimeMs: entry.mtimeMs });
    else unstatted.push(windowed[i]);
  }
  statted.sort((a, b) => {
    const dm = b.mtimeMs - a.mtimeMs;
    if (dm !== 0) return dm;
    return a.line.localeCompare(b.line);
  });
  return [...statted.map((e) => e.line), ...unstatted];
}

function grepProgressText(outputMode, windowed, totalWindowed) {
  if (outputMode === 'files_with_matches') return `found ${totalWindowed} files`;
  if (outputMode !== 'count') return `found ${totalWindowed} matches`;
  let found = 0;
  for (const line of windowed) {
    const counted = parseGrepCountLine(line);
    if (counted) found += counted.count;
  }
  return `found ${found} matches`;
}

// A file scope the native server could not serve is answered by reading the
// file; only a scanner that cannot reproduce the request declines.
async function grepFailureResult(scope, err) {
  const nativeMissed =
    err?.code === 'NATIVE_SEARCH_TIMEOUT' ||
    err?.code === 'NATIVE_SEARCH_UNAVAILABLE' ||
    err?.code === 'NATIVE_SEARCH_UNSUPPORTED';
  if (nativeMissed && scope.singleFileScope) {
    const rescued = await runGrepSingleFileRescue({
      filePath: scope.grepResolvedPath,
      searchPath: scope.searchPath,
      patterns: scope.patterns,
      caseInsensitive: scope.caseInsensitive,
      multilineMode: scope.multilineMode,
      onlyMatching: scope.args['-o'] === true,
      fileType: scope.fileType,
      outputMode: scope.outputMode,
      showLineNumbers: scope.showLineNumbers,
      withFilename: scope.forceGrepFilename,
      filenameOmitted: scope.filenameOmitted,
      beforeN: scope.beforeN,
      afterN: scope.afterN,
      contextN: scope.contextN,
      headLimit: scope.headLimit,
      offset: scope.offset,
      workDir: scope.workDir,
      patternCapNote: scope.patternCapNote,
    });
    if (rescued !== null) return rescued;
  }
  const stderr = err?.stderr ? String(err.stderr).trim() : '';
  const msg = stderr || err?.message || String(err);
  return `Error: ${msg.slice(0, 500)}`;
}
