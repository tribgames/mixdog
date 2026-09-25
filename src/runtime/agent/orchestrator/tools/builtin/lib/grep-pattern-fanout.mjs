// grep pattern[] fan-out: two or more patterns in a content search run as
// INDEPENDENT greps (mirroring the path[] batching in grep-path-fanout.mjs):
// each pattern keeps its own full head_limit budget and its own truncation
// notice, and identical path:line match lines are de-duplicated across
// patterns. `executeGrepTool` is injected
// to avoid an import cycle.
import { isAbsolute } from 'node:path';
import { GREP_AUTO_CONTEXT_LINES, trueCasePath } from '../path-utils.mjs';
import { buildGrepRgArgs } from '../search-builders.mjs';
import { runRgWindowedLines } from '../native-search-runner.mjs';
import { statReachable } from '../fs-reachability.mjs';
import {
  dedupeFanoutMatchLines,
  formatGrepFanoutSections,
  formatGrepOutput,
  grepNoMatchesBody,
  grepPartialWarning,
} from './grep-output.mjs';
import { expandGrepAnchorContextOutput, prepareGrepContextSources } from './grep-context-expander.mjs';
import { markScopedCacheIncomplete } from '../../../session/cache/scoped-cache-outcome.mjs';

const GREP_FANOUT_PREFILTER_FILE_CAP = 400;

function perPatternCharBudget({ callContextCharBudget, patterns }) {
  return Math.max(512, Math.floor(callContextCharBudget / patterns.length));
}

// rg is spawned inside an absolute search path (true-cased so its output
// paths match the disk), else inside the workDir.
async function rgScope(workDir, searchPath) {
  if (!isAbsolute(searchPath)) return { cwd: workDir, searchPath };
  const trueCased = await trueCasePath(searchPath);
  return { cwd: trueCased, searchPath: trueCased };
}

function fanoutRgArgs(request, searchPath, overrides) {
  return buildGrepRgArgs({
    patterns: request.patterns,
    includeNoise: request.args.include_noise === true,
    text: request.args.text === true,
    searchPath,
    globPatterns: request.normalizedGlobPatterns,
    caseInsensitive: request.caseInsensitive,
    beforeN: null,
    afterN: null,
    contextN: null,
    fileType: request.fileType,
    onlyMatching: false,
    pcre2: request.pcre2Mode,
    ...overrides,
  });
}

// ONE rg --files-with-matches pass over ALL patterns can scope the fallback
// fan-out to candidate files. It starts only after the combined pass
// declines: the old speculative overlap left a whole-tree bulk scan running
// after a successful combined result had already returned.
async function fanoutPrefilterCandidates(request) {
  const { options, workDir, searchPath, grepResolvedPath, multilineMode } = request;
  try {
    const preStat = await statReachable(grepResolvedPath);
    if (!preStat.isDirectory()) return null;
    const scope = await rgScope(workDir, searchPath);
    const prefilterArgs = fanoutRgArgs(request, scope.searchPath, {
      outputMode: 'files_with_matches',
      showLineNumbers: false,
      multilineMode,
      withFilename: false,
    });
    const pre = await request.runWindowedLines(
      prefilterArgs,
      { cwd: scope.cwd, signal: options.signal },
      // Whole-scope fallback pass: the broad admission lane keeps it
      // from competing with interactive searches for disk bandwidth.
      { offset: 0, limit: GREP_FANOUT_PREFILTER_FILE_CAP, summaryLimit: 0, bulkHint: true }
    );
    return pre.complete && !pre.partial ? pre.lines : null;
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

// Eligibility mirrors the per-pattern paths the combined pass replaces;
// anything exotic (multiline, -o, hidden line numbers) takes the legacy
// per-pattern fan-out. MIXDOG_GREP_FANOUT_COMBINED=0 disables.
function combinedFanoutEligible({ args, multilineMode, beforeN, afterN, showLineNumbers }) {
  return (
    process.env.MIXDOG_GREP_FANOUT_COMBINED !== '0' &&
    !multilineMode &&
    args['-o'] !== true &&
    !(beforeN > 0) &&
    !(afterN > 0) &&
    showLineNumbers
  );
}

// `path:line:text` is ambiguous exactly when the PATH itself contains
// `:<digits>:` — impossible on Windows/NTFS, legal on POSIX
// (`logs/2024:12:31/app.log:7:msg`). Every candidate split is enumerated:
// when they agree on which patterns matched, attribution is exact no
// matter which split is the real one.
function candidateMatchTexts(line) {
  const out = [];
  const re = /:(\d+):/g;
  let hit = re.exec(line);
  while (hit) {
    out.push(line.slice(hit.index + hit[0].length));
    re.lastIndex = hit.index + 1;
    hit = re.exec(line);
  }
  if (out.length === 0) out.push(line);
  return out;
}

// Attributes each combined-stream line back to the pattern(s) it matched.
// When the candidate splits disagree this scope cannot be attributed from
// a single combined stream (`ambiguous`), so the caller falls back to the
// per-pattern rescan (exact by construction) instead of emitting a false
// per-pattern no-match plus an "unattributed matches" bucket.
function attributeCombinedLines(lines, jsRegexps) {
  const byPattern = jsRegexps.map(() => []);
  const residual = [];
  for (const line of lines) {
    const texts = candidateMatchTexts(line);
    let hitAny = false;
    for (let i = 0; i < jsRegexps.length; i++) {
      const matched = jsRegexps[i].test(texts[0]);
      for (let c = 1; c < texts.length; c++) {
        if (jsRegexps[i].test(texts[c]) !== matched) return { ambiguous: true };
      }
      if (matched) {
        byPattern[i].push(line);
        hitAny = true;
      }
    }
    if (!hitAny) residual.push(line);
  }
  return { ambiguous: false, byPattern, residual };
}

// One pattern's section body from its attributed lines: an adaptive
// context expansion, or the plain windowed listing.
async function combinedPatternBody(request, pattern, linesFor, { adaptive, rgCwd, combinedPartial, sources }) {
  const { options, workDir, grepResolvedPath, searchPath, outputMode, headLimit, offset, contextN } = request;
  if (adaptive) {
    const ctx = await expandGrepAnchorContextOutput({
      allLines: linesFor,
      workDir,
      rgSpawnCwd: rgCwd,
      grepResolvedPath,
      searchPath,
      outputMode,
      filenameOmitted: false,
      headLimit,
      offset,
      totalKnown: !combinedPartial,
      requestedContext: contextN,
      maxContext: GREP_AUTO_CONTEXT_LINES,
      patterns: [pattern],
      caseInsensitive: request.caseInsensitive,
      charBudget: perPatternCharBudget(request),
      signal: options.signal,
      sources,
    });
    if (options.scopedCacheOutcome && (ctx.omitted > 0 || !ctx.sourceComplete)) {
      markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    if (ctx.text) return ctx.text;
    return grepNoMatchesBody({ totalKnown: !combinedPartial });
  }
  const post = offset > 0 ? linesFor.slice(offset) : linesFor;
  return formatGrepOutput({
    windowed: headLimit === Infinity ? post : post.slice(0, headLimit),
    totalWindowed: post.length,
    totalKnown: !combinedPartial,
    headLimit,
    offset,
    outputMode,
    beforeN: request.beforeN,
    afterN: request.afterN,
    contextN,
    workDir,
    filenameOmitted: false,
    prefix: '',
    disableContentGrouping: true,
  });
}

async function renderCombinedSections(request, { byPattern, residual, combinedPartial, rgCwd }) {
  const { patterns, options, searchPath, contextN, beforeN, afterN } = request;
  const adaptive = request.autoContext || (contextN > 0 && !(beforeN > 0) && !(afterN > 0));
  const sources = adaptive
    ? await prepareGrepContextSources(byPattern, {
        workDir: request.workDir,
        rgSpawnCwd: rgCwd,
        grepResolvedPath: request.grepResolvedPath,
        searchPath,
        outputMode: request.outputMode,
        filenameOmitted: false,
        headLimit: request.headLimit,
        offset: request.offset,
        requestedContext: contextN,
        maxContext: GREP_AUTO_CONTEXT_LINES,
        signal: options.signal,
      })
    : null;
  const seenCombined = new Set();
  const bodies = [];
  for (let i = 0; i < patterns.length; i++) {
    if (byPattern[i].length === 0) {
      bodies.push(grepNoMatchesBody({ totalKnown: !combinedPartial }));
      continue;
    }
    const body = await combinedPatternBody(request, patterns[i], byPattern[i], {
      adaptive,
      rgCwd,
      combinedPartial,
      sources,
    });
    bodies.push(dedupeFanoutMatchLines(body, seenCombined));
  }
  const sections = [formatGrepFanoutSections({ dimension: 'pattern', labels: patterns, bodies })];
  if (residual.length > 0) {
    // Rust/JS regex divergence or --max-columns truncation left
    // matches no pattern claimed; surface them rather than drop.
    sections.push(`# grep (unattributed matches)\n${residual.slice(0, 40).join('\n')}`);
  }
  return sections.join('\n\n');
}

// The one rg run carrying every pattern, windowed to what the per-pattern
// sections can show; null when the spawn itself failed. Unfiltered
// multi-pattern directory scans are the broad-scope shape that saturated the
// interactive pool; they route to the bulk lane.
async function streamCombinedLines(request, scope) {
  const { patterns, options, headLimit, offset } = request;
  const combinedArgs = fanoutRgArgs(request, scope.searchPath, {
    outputMode: request.outputMode,
    showLineNumbers: true,
    multilineMode: false,
    withFilename: true,
  });
  const perPatternWindow = headLimit === Infinity ? 300 : offset + headLimit + 4;
  const combinedCap = Math.min(4000, Math.max(400, perPatternWindow * patterns.length));
  const combinedBulkHint = request.normalizedGlobPatterns.length === 0 && !request.fileType;
  try {
    return await request.runWindowedLines(
      combinedArgs,
      { cwd: scope.cwd, signal: options.signal },
      { offset: 0, limit: combinedCap, summaryLimit: 0, bulkHint: combinedBulkHint }
    );
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

// Combined single-spawn fan-out: ONE rg run carrying every pattern
// (-e p1 -e p2 …), then JS-side attribution of each matched line back
// to its pattern(s) rebuilds the per-pattern sections. K patterns cost
// 1 child spawn instead of K: under the win32 child-spawn gate the
// per-spawn queue/AV overhead — not scan size — dominates fan-out
// cost. Returns null when the pass declines (JS-alien regex, non-dir
// scope, capped stream, ambiguous attribution) and the legacy
// per-pattern fan-out must answer.
async function runCombinedFanout(request) {
  const { patterns, options, workDir, searchPath, grepResolvedPath } = request;
  let jsRegexps;
  try {
    jsRegexps = patterns.map((p) => new RegExp(p, request.caseInsensitive ? 'i' : ''));
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
  let preStat;
  try {
    preStat = await statReachable(grepResolvedPath);
  } catch {
    return null;
  }
  if (!preStat.isDirectory()) return null;
  const scope = await rgScope(workDir, searchPath);
  const streamed = await streamCombinedLines(request, scope);
  if (!streamed) return null;
  // Cap overflow (complete:false without partial) still falls back: the
  // per-pattern rescan restores correct per-pattern windows. Timeout and
  // scan-error partials keep their collected lines instead — the legacy
  // fallback would rescan the same scope from scratch and usually time
  // out again, discarding everything the first pass already found.
  if (streamed.partial ? streamed.lines.length === 0 : !streamed.complete) return null;
  const combinedPartial = streamed.partial === true;
  if (combinedPartial && options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  const attributed = attributeCombinedLines(streamed.lines, jsRegexps);
  if (attributed.ambiguous) return null;
  const sections = await renderCombinedSections(request, { ...attributed, combinedPartial, rgCwd: scope.cwd });
  return request.patternCapNote + sections + (combinedPartial ? grepPartialWarning(streamed) : '');
}

// Each pattern is an INDEPENDENT grep; they run concurrently and the
// dedup/section assembly follows the original pattern order so the shared
// `seen` set and output text stay byte-identical to the sequential version.
async function runPerPatternFanout(request) {
  const { args, patterns, options, workDir, patternCapNote } = request;
  options.signal?.throwIfAborted();
  // One fallback prefilter: when it completes under the cap, K patterns
  // cost one repo walk plus K file-list scans instead of K full walks.
  // Zero candidates short-circuits.
  const candidateFiles =
    process.env.MIXDOG_GREP_FANOUT_PREFILTER !== '0' ? await fanoutPrefilterCandidates(request) : null;
  if (candidateFiles && candidateFiles.length === 0) {
    return patternCapNote + grepNoMatchesBody({ totalKnown: true });
  }
  const subOptions = {
    ...options,
    _grepPatternFanout: true,
    _grepContextCharBudget: perPatternCharBudget(request),
    ...(candidateFiles ? { _grepCandidateFiles: candidateFiles } : {}),
  };
  const runPattern = async (p) => {
    try {
      return await request.executeGrepTool(
        { ...args, pattern: p },
        workDir,
        request.executeChildBuiltinTool,
        request.readStateScope,
        subOptions
      );
    } catch (err) {
      options.signal?.throwIfAborted();
      return `Error: ${err?.message || err}`;
    }
  };
  let subs;
  if (options._grepPathFanout) {
    subs = [];
    for (const pattern of patterns) subs.push(await runPattern(pattern));
  } else {
    subs = await Promise.all(patterns.map(runPattern));
  }
  return patternCapNote + assembleFanoutSections(request, subs);
}

// The per-pattern sections in pattern order. Single-line no-match
// sub-results are consolidated: K missed patterns collapse into ONE summary
// line instead of K header+body sections.
function assembleFanoutSections(request, subs) {
  const seen = new Set();
  return formatGrepFanoutSections({
    dimension: 'pattern',
    labels: request.patterns,
    bodies: subs.map((body) => dedupeFanoutMatchLines(body, seen)),
  });
}

export async function runGrepPatternFanout(input) {
  const { options } = input;
  options.signal?.throwIfAborted();
  const request = {
    autoContext: false,
    ...input,
    runWindowedLines:
      typeof options?.__runRgWindowedLines === 'function' ? options.__runRgWindowedLines : runRgWindowedLines,
  };
  if (combinedFanoutEligible(request)) {
    const combined = await runCombinedFanout(request);
    if (combined !== null) return combined;
  }
  return runPerPatternFanout(request);
}
