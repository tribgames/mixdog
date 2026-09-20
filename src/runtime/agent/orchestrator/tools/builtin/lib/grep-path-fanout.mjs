// grep path[] fan-out: multiple string paths in one grep call.
// search-grep-tool.mjs keeps argument normalization and the single-path
// execution flow; `executeGrepTool` is injected to avoid an import cycle.
import { isAbsolute } from 'node:path';
import {
  GREP_AUTO_CONTEXT_LINES,
  hasGlobMagic,
  normalizeInputPath,
  normalizeOutputPath,
  normalizeSearchPattern,
  trueCasePath,
} from '../path-utils.mjs';
import { isUncOrSmbPath, resolveSearchScope } from '../search-path-diagnostics.mjs';
import { buildGrepRgArgs } from '../search-builders.mjs';
import { runRgWindowedLines } from '../native-search-runner.mjs';
import { statReachable } from '../fs-reachability.mjs';
import { markScopedCacheIncomplete } from '../../../session/cache/scoped-cache-outcome.mjs';
import { GREP_CONTEXT_MAX, hasUnsupportedRipgrepRegex } from '../arg-guard.mjs';
import { coerceNonNegInt, resolveHeadLimit } from './search-input-helpers.mjs';
import { formatGrepOutput } from './grep-output.mjs';
import { expandGrepAnchorContextOutput } from './grep-context-expander.mjs';

// Case-insensitive path keys on Windows, where rg echoes the operand path
// in whatever case the caller wrote it.
const PATH_KEYS_CASE_INSENSITIVE = process.platform === 'win32';
function pathKey(value) {
  return PATH_KEYS_CASE_INSENSITIVE ? value.toLowerCase() : value;
}

// The single-pattern request the combined path[] pass can answer, parsed
// the way the canonical single-path parsing in search-grep-tool.mjs does
// (keep in sync); null when the arguments fall outside its narrow
// eligibility: single pattern, no glob/type, default flags, content-ish or
// files_with_matches mode. MIXDOG_GREP_PATH_COMBINED=0 disables.
function combinedPathRequest(args, defaultHeadLimit) {
  if (
    process.env.MIXDOG_GREP_PATH_COMBINED === '0' ||
    args.glob ||
    args.type ||
    args.multiline === true ||
    args['-o'] === true ||
    args['-n'] === false ||
    args['-A'] !== undefined ||
    args['-B'] !== undefined
  ) {
    return null;
  }
  const rawPat = args.pattern;
  let singleList = [];
  if (Array.isArray(rawPat)) singleList = rawPat.filter((p) => typeof p === 'string' && p);
  else if (typeof rawPat === 'string' && rawPat) singleList = [rawPat];
  if (singleList.length !== 1) return null;
  const pattern = normalizeSearchPattern(singleList[0]);
  if (!pattern || /\\n/.test(pattern) || hasUnsupportedRipgrepRegex([pattern])) return null;
  const rawMode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
  if (!['', 'content', 'content_with_context', 'files_with_matches'].includes(rawMode)) return null;
  const outMode = rawMode === 'files_with_matches' ? 'files_with_matches' : 'content';
  const hlRaw = coerceNonNegInt(args.head_limit);
  if (Number.isNaN(hlRaw)) return null;
  const offRaw = coerceNonNegInt(args.offset);
  if (Number.isNaN(offRaw)) return null;
  const ctxRaw = args['-C'] !== undefined && args['-C'] !== null && args['-C'] !== '' ? args['-C'] : args.context;
  let contextN = null;
  if (ctxRaw !== undefined && ctxRaw !== null && ctxRaw !== '') {
    const n = Number(ctxRaw);
    if (!Number.isFinite(n) || n < 0) return null;
    contextN = Math.min(Math.floor(n), GREP_CONTEXT_MAX);
  }
  return {
    pattern,
    outMode,
    headLimit: resolveHeadLimit(hlRaw, defaultHeadLimit),
    offset: offRaw === null ? 0 : offRaw,
    contextN,
    // Leave contextN null for the automatic window: the expander reads that as
    // "no caller-requested radius" and applies the asymmetric default.
    autoContext: outMode === 'content' && contextN === null && (rawMode === '' || rawMode === 'content_with_context'),
    caseInsensitive: args['-i'] === true,
  };
}

// Every path resolved to an existing non-UNC file or directory, in input
// order; null when one is a glob, unreachable, or on a share — the legacy
// fan-out owns those diagnostics.
async function resolvePathRoots(list, workDir) {
  const roots = [];
  for (const p of list) {
    const cleaned = normalizeInputPath(p);
    if (hasGlobMagic(cleaned)) return null;
    const resolved = resolveSearchScope(cleaned, workDir);
    if (isUncOrSmbPath(cleaned) || isUncOrSmbPath(resolved)) return null;
    let st;
    try {
      st = await statReachable(resolved);
    } catch {
      return null;
    }
    roots.push({
      arg: p,
      abs: normalizeOutputPath(isAbsolute(resolved) ? await trueCasePath(resolved) : resolved),
      isDir: st.isDirectory(),
    });
  }
  return roots;
}

// rg echoes each match under the operand path exactly as passed
// (normalized absolute), so normalized-prefix compare is exact. Nested
// roots duplicate a line into every containing section, matching legacy
// independent scans. Lines are re-relativized against workDir so section
// bodies render like a workDir-rooted search.
function attributeLinesToRoots(lines, roots, wdFwd) {
  const byRoot = roots.map(() => []);
  const workDirKey = `${pathKey(wdFwd)}/`;
  for (const line of lines) {
    const norm = line.replace(/\\/g, '/');
    const lineKey = pathKey(norm);
    const rel = lineKey.startsWith(workDirKey) ? norm.slice(wdFwd.length + 1) : line;
    for (let i = 0; i < roots.length; i++) {
      const rootKey = pathKey(roots[i].abs);
      if (lineKey === rootKey || lineKey.startsWith(`${rootKey}/`) || lineKey.startsWith(`${rootKey}:`)) {
        byRoot[i].push(rel);
      }
    }
  }
  return byRoot;
}

// A FILE root drops the filename prefix (its section header already names
// the file) and a DIR root keeps grouped-by-file rendering — the legacy
// per-path presentation.
function renderedRootLines(root, windowedLines, wdFwd) {
  if (root.isDir) return windowedLines;
  const rootRel = pathKey(root.abs).startsWith(`${pathKey(wdFwd)}/`) ? root.abs.slice(wdFwd.length + 1) : root.abs;
  const rootPrefix = `${pathKey(rootRel)}:`;
  return windowedLines.map((l) => {
    const lineFwd = l.replace(/\\/g, '/');
    return pathKey(lineFwd).startsWith(rootPrefix) ? lineFwd.slice(rootRel.length + 1) : l;
  });
}

async function combinedPathBody(request, root, linesFor, { workDir, wdFwd, options, perBudget }) {
  const { pattern, outMode, headLimit, offset, contextN, autoContext, caseInsensitive } = request;
  if (outMode === 'content' && (autoContext || contextN > 0)) {
    const ctx = await expandGrepAnchorContextOutput({
      allLines: linesFor,
      workDir,
      rgSpawnCwd: wdFwd,
      grepResolvedPath: root.abs,
      searchPath: root.arg,
      outputMode: outMode,
      filenameOmitted: false,
      headLimit,
      offset,
      totalKnown: true,
      requestedContext: contextN,
      maxContext: GREP_AUTO_CONTEXT_LINES,
      patterns: [pattern],
      caseInsensitive,
      charBudget: perBudget,
      signal: options.signal,
    });
    if (ctx.text) return ctx.text;
    return `(no matches) pattern=${JSON.stringify(pattern)} path=${root.arg}; path exists (${root.isDir ? 'dir' : 'file'})`;
  }
  const post = offset > 0 ? linesFor.slice(offset) : linesFor;
  const windowedLines = headLimit === Infinity ? post : post.slice(0, headLimit);
  return formatGrepOutput({
    windowed: renderedRootLines(root, windowedLines, wdFwd),
    totalWindowed: post.length,
    totalKnown: true,
    headLimit,
    offset,
    outputMode: outMode,
    patterns: [pattern],
    beforeN: null,
    afterN: null,
    contextN,
    searchPath: root.arg,
    grepResolvedPath: root.abs,
    workDir,
    globPatterns: [],
    fileType: '',
    filenameOmitted: !root.isDir,
    prefix: '',
  });
}

// Combined single-spawn path[] fan-out (mirrors the pattern[] combined
// path): ONE rg run with every path as a positional operand, then
// normalized-prefix attribution rebuilds the per-path sections — P paths
// cost 1 child spawn instead of P. Null when the pass declines and the
// legacy bounded-concurrency fan-out must answer.
async function runCombinedPathFanout({ args, list, workDir, options, callContextCharBudget, defaultHeadLimit }) {
  const request = combinedPathRequest(args, defaultHeadLimit);
  if (!request) return null;
  const roots = await resolvePathRoots(list, workDir);
  if (!roots) return null;
  const { headLimit, offset } = request;
  const rgArgs = combinedPathRgArgs(args, request, roots, workDir);
  const perWindow = headLimit === Infinity ? 300 : offset + headLimit + 4;
  const cap = Math.min(4000, Math.max(400, perWindow * roots.length));
  let streamed;
  try {
    streamed = await runRgWindowedLines(
      rgArgs,
      { cwd: workDir, signal: options.signal },
      { offset: 0, limit: cap, summaryLimit: 0 }
    );
  } catch {
    return null;
  }
  if (!streamed.complete || streamed.partial) return null;
  const wdFwd = normalizeOutputPath(workDir).replace(/\/+$/, '');
  const byRoot = attributeLinesToRoots(streamed.lines, roots, wdFwd);
  const perBudget = Math.max(512, Math.floor(callContextCharBudget / roots.length));
  return renderCombinedPathSections(request, roots, byRoot, { workDir, wdFwd, options, perBudget });
}

// One rg invocation over every root's files at once.
function combinedPathRgArgs(args, request, roots, workDir) {
  return buildGrepRgArgs({
    patterns: [request.pattern],
    includeNoise: args.include_noise === true,
    text: args.text === true,
    searchPath: workDir,
    globPatterns: [],
    outputMode: request.outMode,
    caseInsensitive: request.caseInsensitive,
    showLineNumbers: true,
    beforeN: null,
    afterN: null,
    contextN: null,
    multilineMode: false,
    fileType: '',
    onlyMatching: false,
    pcre2: false,
    withFilename: true,
    candidateFiles: roots.map((r) => r.abs),
  });
}

// The per-root sections in argument order; roots without a hit collapse
// into one trailing no-match line.
async function renderCombinedPathSections(request, roots, byRoot, bodyContext) {
  const sections = [];
  const noMatchRoots = [];
  for (let i = 0; i < roots.length; i++) {
    if (byRoot[i].length === 0) {
      noMatchRoots.push(roots[i].arg);
      continue;
    }
    const body = await combinedPathBody(request, roots[i], byRoot[i], bodyContext);
    sections.push(`# grep ${roots[i].arg}\n${body}`);
  }
  if (noMatchRoots.length > 0) {
    sections.push(
      `(no matches) pattern=${JSON.stringify(request.pattern)} paths: ${noMatchRoots.join(', ')}; paths exist`
    );
  }
  return sections.join('\n\n');
}

// Runs the multi-path fan-out for `list` (2+ deduped path strings) and returns
// the combined output text. Recursive calls pass a single string path, so
// recursion bottoms out after one level. Results retain input order even
// though every path starts immediately.
export async function runGrepPathFanout(input) {
  const combined = await runCombinedPathFanout(input);
  if (combined !== null) return combined;
  const { args, list, workDir, executeChildBuiltinTool, readStateScope, options, callContextCharBudget } = input;
  const nestedOptions = {
    ...options,
    _grepPathFanout: true,
    _grepContextCharBudget: Math.max(512, Math.floor(callContextCharBudget / list.length)),
  };
  const configuredOutputCap =
    Number(options?.toolOutputMaxBytes) > 0
      ? Math.trunc(Number(options.toolOutputMaxBytes))
      : Math.trunc(Number(process.env.MIXDOG_TOOL_OUTPUT_MAX_BYTES));
  const bodies = await Promise.all(
    list.map(async (p) => {
      try {
        return await input.executeGrepTool(
          { ...args, path: p },
          workDir,
          executeChildBuiltinTool,
          readStateScope,
          nestedOptions
        );
      } catch (err) {
        return `Error: ${err?.message || err}`;
      }
    })
  );
  const output = list.map((p, index) => `# grep ${p}\n${bodies[index]}`).join('\n\n');
  if (
    configuredOutputCap > 0 &&
    Buffer.byteLength(output, 'utf8') > configuredOutputCap &&
    options?.scopedCacheOutcome
  ) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  return output;
}
