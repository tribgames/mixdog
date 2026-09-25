// Grep argument resolution: patterns, regex mode, search scope and glob
// filters, output mode, window and context flags, file types. Returns either
// an early answer (`result`), a delegation to the glob tool (`delegate`), or
// the resolved `request` the search itself runs from.
import { isAbsolute } from 'node:path';
import { markScopedCacheIncomplete } from '../../../session/cache/scoped-cache-outcome.mjs';
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX, hasUnsupportedRipgrepRegex } from '../arg-guard.mjs';
import { statReachable } from '../fs-reachability.mjs';
import {
  canonicalizeGlobSlashes,
  extractGlobBaseDirectory,
  GREP_AUTO_CONTEXT_AFTER,
  GREP_AUTO_CONTEXT_BEFORE,
  hasGlobMagic,
  normalizeInputPath,
  normalizeOutputPath,
  normalizeSearchPattern,
} from '../path-utils.mjs';
import { isUncOrSmbPath, resolveSearchScope, uncRefusalMessage } from '../search-path-diagnostics.mjs';
import { _grepDefaultHeadLimit } from './grep-context-expander.mjs';
import { grepMissingPatternMessage } from './grep-output.mjs';
import {
  coerceNonNegInt,
  isRedundantAllFilesGlob,
  resolveHeadLimit,
  stringList,
  uniqueStrings,
} from './search-input-helpers.mjs';

const GREP_PATTERN_ARRAY_CAP = 10;
const ALLOWED_OUTPUT_MODES = new Set(['files_with_matches', 'content', 'content_with_context', 'count']);

// Rescue: a pattern containing an unescaped two-char "\n" (backslash + n)
// outside multiline mode makes rg hard-error with "the literal '\"\\n\"'
// is not allowed in a regex" — rg requires -U/--multiline before a
// pattern is allowed to match across a newline. An even backslash run
// (`\\n`) searches source text containing "\n" and must stay single-line.
function hasRegexNewlineEscape(pattern) {
  const text = String(pattern || '');
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== 'n') continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
    if (slashes % 2 === 1) return true;
  }
  return false;
}

function coerceContext(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.min(Math.floor(n), GREP_CONTEXT_MAX);
}

// Search root plus the ripgrep --glob filters, with absolute globs rebased
// onto that root.
// A magic-looking search path split into base + glob — unless it names a
// real file. Literal-first: {slug}.md and [id].tsx are REAL filenames in web
// projects. A magic-looking path that stats as-is IS the target —
// reinterpreting it as base+glob silently searched the parent with a
// brace-expanded filter and returned "(no matches)" for an existing file.
async function splitMagicSearchPath(searchPath, workDir) {
  try {
    await statReachable(resolveSearchScope(searchPath, workDir));
    return { searchPath, glob: null };
  } catch {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(searchPath);
    return { searchPath: baseDir || '.', glob: relativePattern.replace(/^\//, '') };
  }
}

// An absolute glob rebased onto the search root, or the error when it points
// outside. Windows is case-insensitive: compare path casing accordingly so a
// valid in-root absolute glob is not rejected when its drive/dir casing
// differs from the resolved root.
function rebaseAbsoluteGlob(glob, rootFwd) {
  const { baseDir, relativePattern } = extractGlobBaseDirectory(glob);
  const baseFwd = baseDir ? normalizeOutputPath(baseDir).replace(/\/+$/, '') : '';
  const rel = relativePattern.replace(/^\//, '');
  const ci = process.platform === 'win32';
  const baseCmp = ci ? baseFwd.toLowerCase() : baseFwd;
  const rootCmp = ci ? rootFwd.toLowerCase() : rootFwd;
  if (!baseFwd || baseCmp === rootCmp) return { pattern: rel };
  if (baseCmp.startsWith(`${rootCmp}/`)) {
    const prefix = baseFwd.slice(rootFwd.length + 1);
    return { pattern: prefix ? `${prefix}/${rel}` : rel };
  }
  return {
    result: `Error: absolute glob ${JSON.stringify(glob)} resolves outside search root ${JSON.stringify(rootFwd)}; pass a relative glob or move the search path`,
  };
}

async function resolveGrepScope(args, workDir) {
  let searchPath = args.path || '.';
  const rawGlobs = uniqueStrings(stringList(args.glob).map(normalizeInputPath));
  if (hasGlobMagic(searchPath)) {
    const split = await splitMagicSearchPath(searchPath, workDir);
    searchPath = split.searchPath;
    if (split.glob !== null) rawGlobs.unshift(split.glob);
  }
  const grepResolvedPath = resolveSearchScope(searchPath, workDir);
  if (isUncOrSmbPath(searchPath) || isUncOrSmbPath(grepResolvedPath)) {
    return { result: uncRefusalMessage('grep', searchPath, grepResolvedPath) };
  }
  const globPatterns = [];
  const rootFwd = normalizeOutputPath(grepResolvedPath).replace(/\/+$/, '');
  for (const g of rawGlobs) {
    if (!isAbsolute(g)) {
      globPatterns.push(g);
      continue;
    }
    const rebased = rebaseAbsoluteGlob(g, rootFwd);
    if (rebased.result !== undefined) return { result: rebased.result };
    globPatterns.push(rebased.pattern);
  }
  // ripgrep `--glob` uses forward slashes on all platforms; canonicalize
  // `\`→`/` (win32 only) so a `**\*.ts` filter matches instead of being
  // parsed as an escape sequence.
  const normalizedGlobPatterns = uniqueStrings(
    globPatterns.map(canonicalizeGlobSlashes).filter((g) => !isRedundantAllFilesGlob(g))
  );
  return { searchPath, grepResolvedPath, normalizedGlobPatterns };
}

// Output mode, head limit / offset window and -A/-B/-C context flags.
function resolveGrepWindow(args) {
  const rawOutputMode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
  if (rawOutputMode && !ALLOWED_OUTPUT_MODES.has(rawOutputMode)) {
    return {
      result: `Error: invalid output_mode ${JSON.stringify(args.output_mode)}; expected one of ${[...ALLOWED_OUTPUT_MODES].join(', ')}`,
    };
  }
  // Omitted output_mode and `content_with_context` both return content with a
  // generous surrounding-lines window. Explicit `content` remains bare.
  const wantAutoContext = rawOutputMode === '' || rawOutputMode === 'content_with_context';
  // Filename-only and count searches are explicit: callers must opt into
  // `files_with_matches` or `count` when they only need existence/count data.
  const outputMode = rawOutputMode === 'content_with_context' ? 'content' : rawOutputMode || 'content';
  const headLimitRaw = args.head_limit;
  const headLimitCoerced = coerceNonNegInt(headLimitRaw);
  if (Number.isNaN(headLimitCoerced)) {
    return {
      result: `Error: invalid limit ${JSON.stringify(headLimitRaw)}; expected a non-negative integer (0 = unlimited)`,
    };
  }
  const headLimit = resolveHeadLimit(headLimitCoerced, _grepDefaultHeadLimit());
  const offsetCoerced = coerceNonNegInt(args.offset);
  if (Number.isNaN(offsetCoerced)) {
    return { result: `Error: invalid offset ${JSON.stringify(args.offset)}; expected a non-negative integer` };
  }
  const offset = offsetCoerced || 0;
  const context = resolveGrepContextFlags(args, wantAutoContext);
  if (context.result !== undefined) return context;
  return { outputMode, headLimit, headLimitCoerced, offset, ...context };
}

// The -A/-B/-C window. content_with_context: with no explicit context flag,
// apply the automatic window so the match arrives with enough surrounding
// code to understand it without a separate read. It is asymmetric, so it
// travels as -B/-A and leaves contextN null — that null is what tells the
// expander the window is automatic rather than a caller-requested radius.
function resolveGrepContextFlags(args, wantAutoContext) {
  let afterN = coerceContext(args['-A']);
  let beforeN = coerceContext(args['-B']);
  const contextN =
    args['-C'] !== undefined && args['-C'] !== null && args['-C'] !== ''
      ? coerceContext(args['-C'])
      : coerceContext(args.context);
  let autoContext = false;
  if (wantAutoContext && afterN === null && beforeN === null && contextN === null) {
    beforeN = GREP_AUTO_CONTEXT_BEFORE;
    afterN = GREP_AUTO_CONTEXT_AFTER;
    autoContext = true;
  }
  if (contextN !== null && contextN > 0) {
    if (afterN === 0) afterN = null;
    if (beforeN === 0) beforeN = null;
  }
  for (const [name, value] of [
    ['-A', afterN],
    ['-B', beforeN],
    ['-C', contextN],
  ]) {
    if (Number.isNaN(value)) {
      return { result: `Error: invalid context option ${name}; expected a non-negative finite integer` };
    }
  }
  return { beforeN, afterN, contextN, autoContext };
}

// `type` accepts one ripgrep file type or a list of them.
function resolveGrepFileType(rawType) {
  let fileTypes = [];
  if (Array.isArray(rawType)) {
    for (const entry of rawType) {
      if (typeof entry !== 'string') {
        return { result: `Error: invalid type entry ${JSON.stringify(entry)}; expected string` };
      }
      const t = entry.trim();
      if (t) fileTypes.push(t);
    }
  } else if (typeof rawType === 'string') {
    const t = rawType.trim();
    if (t) fileTypes = [t];
  } else if (rawType !== undefined && rawType !== null) {
    return { result: `Error: invalid type ${JSON.stringify(rawType)}; expected string or string[]` };
  }
  if (fileTypes.length > 1) return { fileType: fileTypes };
  return { fileType: fileTypes.length === 1 ? fileTypes[0] : '' };
}

// The pattern list capped at GREP_PATTERN_ARRAY_CAP. Dropping input patterns
// means the returned result cannot cover the full requested pattern set —
// never cache it as complete. Applies to every downstream path (fan-out,
// chunk-merge, single combined).
function capGrepPatterns(requested, options) {
  if (requested.length <= GREP_PATTERN_ARRAY_CAP) {
    return { patterns: requested, patternCapNote: '', patternCapTotal: 0 };
  }
  if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  return {
    patterns: requested.slice(0, GREP_PATTERN_ARRAY_CAP),
    patternCapNote: `[capped at ${GREP_PATTERN_ARRAY_CAP} of ${requested.length} patterns]\n`,
    patternCapTotal: requested.length,
  };
}

// A pattern-less grep with a glob or magic path is a file search in disguise.
function globDelegateArgs(args) {
  const globArgs = {
    pattern: hasGlobMagic(args.path) ? args.path : args.glob,
    path: hasGlobMagic(args.path) ? undefined : args.path || '.',
  };
  if (args.head_limit !== undefined) globArgs.head_limit = args.head_limit;
  if (args.offset !== undefined) globArgs.offset = args.offset;
  return globArgs;
}

export async function resolveGrepRequest(args, workDir, options) {
  // Shape context immediately before deriving rg flags. This keeps the
  // Lead-direct MCP path and direct executeGrepTool callers on the same
  // policy even if they bypass or race the outer builtin arg guard.
  applyGrepContextLeadPolicy(args);
  args.path = normalizeInputPath(args.path);
  const { patterns, patternCapNote, patternCapTotal } = capGrepPatterns(
    uniqueStrings(stringList(args.pattern).map(normalizeSearchPattern)),
    options
  );
  if (patterns.length === 0) {
    if (args.glob || hasGlobMagic(args.path)) return { delegate: globDelegateArgs(args) };
    return { result: grepMissingPatternMessage() };
  }

  const patternsWantMultiline = patterns.some(hasRegexNewlineEscape);
  const multilineMode = args.multiline === true || patternsWantMultiline;
  // Rescue: rg's default Rust regex engine rejects lookaround/backreferences.
  // The embedded native PCRE2 matcher accepts the same syntax via -P/--pcre2.
  const pcre2Mode = hasUnsupportedRipgrepRegex(patterns);

  const scope = await resolveGrepScope(args, workDir);
  if (scope.result !== undefined) return scope;
  const window = resolveGrepWindow(args);
  if (window.result !== undefined) return window;
  const type = resolveGrepFileType(args.type);
  if (type.result !== undefined) return type;

  return {
    request: {
      patterns,
      patternCapNote,
      patternCapTotal,
      multilineMode,
      pcre2Mode,
      ...scope,
      ...window,
      caseInsensitive: args['-i'] === true,
      showLineNumbers: args['-n'] !== false,
      fileType: type.fileType,
    },
  };
}
