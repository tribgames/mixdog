// grep path[] fan-out: multiple string paths in one grep call. Extracted from
// search-grep-tool.mjs, which keeps argument normalization and the single-path
// execution flow; `executeGrepTool` is injected to avoid an import cycle.
import { isAbsolute } from 'path';
import {
    coerceShapeFlex,
    GREP_AUTO_CONTEXT_LINES,
    hasGlobMagic,
    normalizeInputPath,
    normalizeOutputPath,
    normalizeSearchPattern,
    trueCasePath,
} from '../path-utils.mjs';
import {
    isUncOrSmbPath,
    resolveSearchScope,
    stripEmbeddedPathQuotes,
} from '../search-path-diagnostics.mjs';
import { buildGrepRgArgs } from '../search-builders.mjs';
import { runRgWindowedLines } from '../native-search-runner.mjs';
import { statReachable } from '../fs-reachability.mjs';
import { markScopedCacheIncomplete } from '../../../session/cache/scoped-cache-outcome.mjs';
import { GREP_CONTEXT_MAX, hasUnsupportedRipgrepRegex } from '../arg-guard.mjs';
import { coerceNonNegInt } from './search-input-helpers.mjs';
import { formatGrepOutput } from './grep-output.mjs';
import { expandGrepAnchorContextOutput } from './grep-context-expander.mjs';

// Runs the multi-path fan-out for `list` (2+ deduped path strings) and returns
// the combined output text. Recursive calls pass a single string path, so
// recursion bottoms out after one level. Results retain input order even
// though every path starts immediately.
export async function runGrepPathFanout({
    args,
    list,
    workDir,
    executeChildBuiltinTool,
    readStateScope,
    options,
    callContextCharBudget,
    defaultHeadLimit,
    executeGrepTool,
}) {
    const capped = list;
    // Combined single-spawn path[] fan-out (mirrors the pattern[]
    // combined path in search-grep-tool.mjs): ONE rg run with every path as a
    // positional operand, then normalized-prefix attribution rebuilds the
    // per-path sections — P paths cost 1 child spawn instead of P.
    // Narrow eligibility: single pattern, no glob/type, default
    // flags, content-ish or files_with_matches mode, every path
    // resolving to an existing non-UNC file/dir. Anything else falls
    // through to the legacy bounded-concurrency fan-out (which owns
    // per-path ENOENT/UNC diagnostics). MIXDOG_GREP_PATH_COMBINED=0
    // disables.
    combinedPaths: if (process.env.MIXDOG_GREP_PATH_COMBINED !== '0'
        && !args.glob
        && !args.type
        && args.multiline !== true
        && args['-o'] !== true
        && args['-n'] !== false
        && args['-A'] === undefined
        && args['-B'] === undefined) {
        const rawPat = coerceShapeFlex(args.pattern);
        const singleList = Array.isArray(rawPat)
            ? rawPat.filter((p) => typeof p === 'string' && p)
            : (typeof rawPat === 'string' && rawPat ? [rawPat] : []);
        if (singleList.length !== 1) break combinedPaths;
        const pattern = normalizeSearchPattern(singleList[0]);
        if (!pattern || /\\n/.test(pattern) || hasUnsupportedRipgrepRegex([pattern])) break combinedPaths;
        const rawMode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
        if (!['', 'content', 'content_with_context', 'files_with_matches'].includes(rawMode)) break combinedPaths;
        const outMode = rawMode === 'files_with_matches' ? 'files_with_matches' : 'content';
        // Keep in sync with the canonical single-path parsing in
        // search-grep-tool.mjs.
        const hlRaw = coerceNonNegInt(args.head_limit);
        if (Number.isNaN(hlRaw)) break combinedPaths;
        const headLimit = hlRaw === null ? defaultHeadLimit : (hlRaw === 0 ? Infinity : hlRaw);
        const offRaw = coerceNonNegInt(args.offset);
        if (Number.isNaN(offRaw)) break combinedPaths;
        const offset = offRaw === null ? 0 : offRaw;
        const ctxRaw = args['-C'] !== undefined && args['-C'] !== null && args['-C'] !== ''
            ? args['-C']
            : args.context;
        let contextN = null;
        if (ctxRaw !== undefined && ctxRaw !== null && ctxRaw !== '') {
            const n = Number(ctxRaw);
            if (!Number.isFinite(n) || n < 0) break combinedPaths;
            contextN = Math.min(Math.floor(n), GREP_CONTEXT_MAX);
        }
        if (outMode === 'content' && contextN === null && (rawMode === '' || rawMode === 'content_with_context')) {
            contextN = GREP_AUTO_CONTEXT_LINES;
        }
        const caseInsensitive = args['-i'] === true;
        const roots = [];
        for (const p of capped) {
            const cleaned = stripEmbeddedPathQuotes(normalizeInputPath(p));
            if (hasGlobMagic(cleaned)) break combinedPaths;
            const resolved = resolveSearchScope(cleaned, workDir);
            if (isUncOrSmbPath(cleaned) || isUncOrSmbPath(resolved)) break combinedPaths;
            let st;
            try { st = await statReachable(resolved); } catch { break combinedPaths; }
            roots.push({
                arg: p,
                abs: normalizeOutputPath(isAbsolute(resolved) ? await trueCasePath(resolved) : resolved),
                isDir: st.isDirectory(),
            });
        }
        const rgArgs = buildGrepRgArgs({
            patterns: [pattern],
            searchPath: workDir,
            globPatterns: [],
            outputMode: outMode,
            caseInsensitive,
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
        const perWindow = headLimit === Infinity ? 300 : (offset + headLimit + 4);
        const cap = Math.min(4000, Math.max(400, perWindow * roots.length));
        let streamed;
        try {
            streamed = await runRgWindowedLines(
                rgArgs,
                { cwd: workDir, signal: options.signal },
                { offset: 0, limit: cap, summaryLimit: 0 },
            );
        } catch { break combinedPaths; }
        if (!streamed.complete || streamed.partial) break combinedPaths;
        // rg echoes each match under the operand path exactly as
        // passed (normalized absolute), so normalized-prefix compare
        // is exact. Nested roots duplicate a line into every
        // containing section, matching legacy independent scans.
        const ci = process.platform === 'win32';
        const keyOf = (s) => (ci ? s.toLowerCase() : s);
        const wdFwd = normalizeOutputPath(workDir).replace(/\/+$/, '');
        const byRoot = roots.map(() => []);
        for (const line of streamed.lines) {
            const norm = line.replace(/\\/g, '/');
            const lineKey = keyOf(norm);
            for (let i = 0; i < roots.length; i++) {
                const rootKey = keyOf(roots[i].abs);
                if (lineKey === rootKey
                    || lineKey.startsWith(rootKey + '/')
                    || lineKey.startsWith(rootKey + ':')) {
                    // Re-relativize against workDir so section bodies
                    // render like a workDir-rooted search.
                    const rel = lineKey.startsWith(keyOf(wdFwd) + '/')
                        ? norm.slice(wdFwd.length + 1)
                        : line;
                    byRoot[i].push(rel);
                }
            }
        }
        const perBudget = Math.max(512, Math.floor(callContextCharBudget / roots.length));
        const sections = [];
        const noMatchRoots = [];
        for (let i = 0; i < roots.length; i++) {
            const r = roots[i];
            const linesFor = byRoot[i];
            const noMatch = `(no matches) pattern=${JSON.stringify(pattern)} path=${r.arg}; path exists (${r.isDir ? 'dir' : 'file'})`;
            let body;
            if (linesFor.length === 0) {
                noMatchRoots.push(r.arg);
                continue;
            } else if (outMode === 'content' && contextN > 0) {
                const ctx = await expandGrepAnchorContextOutput({
                    allLines: linesFor,
                    workDir,
                    rgSpawnCwd: wdFwd,
                    grepResolvedPath: r.abs,
                    searchPath: r.arg,
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
                body = ctx.text || noMatch;
            } else {
                const post = offset > 0 ? linesFor.slice(offset) : linesFor;
                const windowedLines = headLimit === Infinity ? post : post.slice(0, headLimit);
                // Match the legacy per-path presentation: a FILE root
                // drops the filename prefix (its section header already
                // names the file) and a DIR root keeps grouped-by-file
                // rendering.
                const rootRel = keyOf(r.abs).startsWith(keyOf(wdFwd) + '/')
                    ? r.abs.slice(wdFwd.length + 1)
                    : r.abs;
                const rendered = r.isDir
                    ? windowedLines
                    : windowedLines.map((l) => {
                        const lineFwd = l.replace(/\\/g, '/');
                        return keyOf(lineFwd).startsWith(keyOf(rootRel) + ':')
                            ? lineFwd.slice(rootRel.length + 1)
                            : l;
                    });
                body = formatGrepOutput({
                    windowed: rendered,
                    totalWindowed: post.length,
                    totalKnown: true,
                    headLimit,
                    offset,
                    outputMode: outMode,
                    patterns: [pattern],
                    beforeN: null,
                    afterN: null,
                    contextN,
                    searchPath: r.arg,
                    grepResolvedPath: r.abs,
                    workDir,
                    globPatterns: [],
                    fileType: '',
                    filenameOmitted: !r.isDir,
                    prefix: '',
                });
            }
            sections.push(`# grep ${r.arg}\n${body}`);
        }
        if (noMatchRoots.length > 0) {
            sections.push(`(no matches) pattern=${JSON.stringify(pattern)} paths: ${noMatchRoots.join(', ')}; paths exist`);
        }
        return sections.join('\n\n');
    }
    const nestedOptions = {
        ...options,
        _grepPathFanout: true,
        _grepContextCharBudget: Math.max(512, Math.floor(callContextCharBudget / capped.length)),
    };
    const configuredOutputCap = Number(options?.toolOutputMaxBytes) > 0
        ? Math.trunc(Number(options.toolOutputMaxBytes))
        : Math.trunc(Number(process.env.MIXDOG_TOOL_OUTPUT_MAX_BYTES));
    const bodies = await Promise.all(capped.map(async (p) => {
        try {
            return await executeGrepTool(
                { ...args, path: p },
                workDir,
                executeChildBuiltinTool,
                readStateScope,
                nestedOptions,
            );
        } catch (err) {
            return `Error: ${err && err.message ? err.message : err}`;
        }
    }));
    const parts = capped.map((p, index) => `# grep ${p}\n${bodies[index]}`);
    const output = parts.join('\n\n');
    if (configuredOutputCap > 0
        && Buffer.byteLength(output, 'utf8') > configuredOutputCap
        && options?.scopedCacheOutcome) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    return output;
}
