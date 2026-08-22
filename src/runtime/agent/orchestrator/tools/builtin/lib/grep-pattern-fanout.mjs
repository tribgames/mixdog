// grep pattern[] fan-out: two or more patterns in a content search run as
// INDEPENDENT greps (mirroring the path[] batching in grep-path-fanout.mjs):
// each pattern keeps its own full head_limit budget and its own truncation
// notice, and identical path:line match lines are de-duplicated across
// patterns. Extracted from search-grep-tool.mjs; `executeGrepTool` is injected
// to avoid an import cycle.
import { isAbsolute } from 'path';
import { GREP_AUTO_CONTEXT_LINES, trueCasePath } from '../path-utils.mjs';
import { buildGrepRgArgs } from '../search-builders.mjs';
import { runRgWindowedLines } from '../native-search-runner.mjs';
import { statReachable } from '../fs-reachability.mjs';
import { dedupeFanoutMatchLines, formatGrepOutput } from './grep-output.mjs';
import { expandGrepAnchorContextOutput } from './grep-context-expander.mjs';
import { markScopedCacheIncomplete } from '../../../session/cache/scoped-cache-outcome.mjs';

export async function runGrepPatternFanout({
    args,
    patterns,
    workDir,
    executeChildBuiltinTool,
    readStateScope,
    options,
    callContextCharBudget,
    patternCapNote,
    searchPath,
    grepResolvedPath,
    normalizedGlobPatterns,
    outputMode,
    headLimit,
    offset,
    caseInsensitive,
    showLineNumbers,
    beforeN,
    afterN,
    contextN,
    multilineMode,
    pcre2Mode,
    fileType,
    executeGrepTool,
}) {
    // Fan-out prefilter, started CONCURRENTLY with the combined attempt
    // below: ONE rg --files-with-matches pass over ALL patterns yields
    // every file any pattern touches. The combined single-spawn path
    // returns without ever awaiting it; the frequent match-heavy bail
    // path (cap/partial) used to pay this pass as a THIRD serial rg wave
    // — overlapping it with the combined attempt removes one full spawn
    // round-trip (~100ms on win32) from every bailed multi-pattern grep.
    // Owner-fair gating keeps the speculative spawn a self-cost of this
    // call. Best-effort: any failure/cap/partial falls back to the
    // unscoped fan-out unchanged. MIXDOG_GREP_FANOUT_PREFILTER=0 disables.
    const GREP_FANOUT_PREFILTER_FILE_CAP = 400;
    const startFanoutPrefilter = async () => {
        try {
            let preSpawnCwd = workDir;
            let preSearchPath = searchPath;
            const preStat = await statReachable(grepResolvedPath);
            if (!preStat.isDirectory()) return null;
            if (isAbsolute(preSearchPath)) {
                preSearchPath = await trueCasePath(preSearchPath);
                preSpawnCwd = preSearchPath;
            }
            const prefilterArgs = buildGrepRgArgs({
                patterns,
                searchPath: preSearchPath,
                globPatterns: normalizedGlobPatterns,
                outputMode: 'files_with_matches',
                caseInsensitive,
                showLineNumbers: false,
                beforeN: null,
                afterN: null,
                contextN: null,
                multilineMode,
                fileType,
                onlyMatching: false,
                pcre2: pcre2Mode,
                withFilename: false,
            });
            const pre = await runRgWindowedLines(
                prefilterArgs,
                { cwd: preSpawnCwd, signal: options.signal },
                // Speculative whole-scope pass: bulk lane keeps it from
                // competing with interactive searches for disk bandwidth.
                { offset: 0, limit: GREP_FANOUT_PREFILTER_FILE_CAP, summaryLimit: 0, bulkHint: true },
            );
            return pre.complete && !pre.partial ? pre.lines : null;
        } catch { return null; }
    };
    const fanoutPrefilterPromise = process.env.MIXDOG_GREP_FANOUT_PREFILTER !== '0'
        ? startFanoutPrefilter()
        : null;
    // Combined single-spawn fan-out: ONE rg run carrying every pattern
    // (-e p1 -e p2 …), then JS-side attribution of each matched line back
    // to its pattern(s) rebuilds the per-pattern sections. K patterns cost
    // 1 child spawn instead of K: under the win32 child-spawn gate the
    // per-spawn queue/AV overhead — not scan size — dominates fan-out
    // cost. Eligibility mirrors the per-pattern paths this replaces;
    // anything exotic (multiline, -o, hidden line numbers, JS-alien
    // regex, non-dir scope, capped/partial stream) falls through to the
    // legacy per-pattern fan-out below. MIXDOG_GREP_FANOUT_COMBINED=0
    // disables.
    combined: if (process.env.MIXDOG_GREP_FANOUT_COMBINED !== '0'
        && !multilineMode
        && args['-o'] !== true
        && showLineNumbers) {
        let jsRegexps;
        try {
            jsRegexps = patterns.map((p) => new RegExp(p, caseInsensitive ? 'i' : ''));
        } catch { break combined; }
        let preStat;
        try { preStat = await statReachable(grepResolvedPath); } catch { break combined; }
        if (!preStat.isDirectory()) break combined;
        let rgCwd = workDir;
        let rgSearchPath = searchPath;
        if (isAbsolute(rgSearchPath)) {
            rgSearchPath = await trueCasePath(rgSearchPath);
            rgCwd = rgSearchPath;
        }
        const combinedArgs = buildGrepRgArgs({
            patterns,
            searchPath: rgSearchPath,
            globPatterns: normalizedGlobPatterns,
            outputMode,
            caseInsensitive,
            showLineNumbers: true,
            beforeN: null,
            afterN: null,
            contextN: null,
            multilineMode: false,
            fileType,
            onlyMatching: false,
            pcre2: pcre2Mode,
            withFilename: true,
        });
        const perPatternWindow = headLimit === Infinity ? 300 : (offset + headLimit + 4);
        const combinedCap = Math.min(4000, Math.max(400, perPatternWindow * patterns.length));
        // Unfiltered multi-pattern directory scans are the broad-scope shape
        // that saturated the interactive pool; route them to the bulk lane.
        const combinedBulkHint = normalizedGlobPatterns.length === 0 && !fileType;
        let streamed;
        try {
            streamed = await runRgWindowedLines(
                combinedArgs,
                { cwd: rgCwd, signal: options.signal },
                { offset: 0, limit: combinedCap, summaryLimit: 0, bulkHint: combinedBulkHint },
            );
        } catch { break combined; }
        // Cap overflow (complete:false without partial) still falls back: the
        // per-pattern rescan restores correct per-pattern windows. Timeout and
        // scan-error partials keep their collected lines instead — the legacy
        // fallback would rescan the same scope from scratch and usually time
        // out again, discarding everything the first pass already found.
        if (streamed.partial ? streamed.lines.length === 0 : !streamed.complete) break combined;
        const combinedPartial = streamed.partial === true;
        const combinedPartialSuffix = !combinedPartial
            ? ''
            : streamed.timeout
                ? '\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.'
                : streamed.rgStderr
                    ? `\n[warning] rg exit 2 (partial results): ${String(streamed.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial results)';
        if (combinedPartial && options?.scopedCacheOutcome) {
            markScopedCacheIncomplete(options.scopedCacheOutcome);
        }
        const adaptive = contextN > 0 && !(beforeN > 0) && !(afterN > 0);
        const byPattern = patterns.map(() => []);
        const residual = [];
        // `path:line:text` is ambiguous exactly when the PATH itself contains
        // `:<digits>:` — impossible on Windows/NTFS, legal on POSIX
        // (`logs/2024:12:31/app.log:7:msg`). Enumerate EVERY candidate split:
        // when they agree on which patterns matched, attribution is exact no
        // matter which split is the real one. When they disagree this scope
        // cannot be attributed from a single combined stream, so fall back to
        // the per-pattern rescan (exact by construction) instead of emitting a
        // false per-pattern no-match plus an "unattributed matches" bucket.
        const candidateMatchTexts = (line) => {
            const out = [];
            const re = /:(\d+):/g;
            let hit = null;
            while ((hit = re.exec(line))) {
                out.push(line.slice(hit.index + hit[0].length));
                re.lastIndex = hit.index + 1;
            }
            if (out.length === 0) out.push(line);
            return out;
        };
        let ambiguousAttribution = false;
        for (const line of streamed.lines) {
            const texts = candidateMatchTexts(line);
            let hitAny = false;
            for (let i = 0; i < jsRegexps.length; i++) {
                const matched = jsRegexps[i].test(texts[0]);
                for (let c = 1; c < texts.length; c++) {
                    if (jsRegexps[i].test(texts[c]) !== matched) { ambiguousAttribution = true; break; }
                }
                if (ambiguousAttribution) break;
                if (matched) { byPattern[i].push(line); hitAny = true; }
            }
            if (ambiguousAttribution) break;
            if (!hitAny) residual.push(line);
        }
        if (ambiguousAttribution) break combined;
        const seenCombined = new Set();
        const perBudget = Math.max(512, Math.floor(callContextCharBudget / patterns.length));
        const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
        const noMatchBody = (p) => `(no matches) pattern=${JSON.stringify(p)} path=${searchPath}${globStr}; path exists (dir)`;
        const sections = [];
        const noMatchPatterns = [];
        for (let i = 0; i < patterns.length; i++) {
            const p = patterns[i];
            const linesFor = byPattern[i];
            let body;
            if (linesFor.length === 0) {
                noMatchPatterns.push(p);
                continue;
            } else if (adaptive) {
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
                    patterns: [p],
                    caseInsensitive,
                    charBudget: perBudget,
                    signal: options.signal,
                });
                body = ctx.text || noMatchBody(p);
            } else {
                const post = offset > 0 ? linesFor.slice(offset) : linesFor;
                const windowedLines = headLimit === Infinity ? post : post.slice(0, headLimit);
                body = formatGrepOutput({
                    windowed: windowedLines,
                    totalWindowed: post.length,
                    totalKnown: !combinedPartial,
                    headLimit,
                    offset,
                    outputMode,
                    patterns: [p],
                    beforeN,
                    afterN,
                    contextN,
                    searchPath,
                    grepResolvedPath,
                    workDir,
                    globPatterns: normalizedGlobPatterns,
                    fileType,
                    filenameOmitted: false,
                    prefix: '',
                    disableContentGrouping: true,
                });
            }
            sections.push(`# grep pattern:${JSON.stringify(p)}\n${dedupeFanoutMatchLines(body, seenCombined)}`);
        }
        if (noMatchPatterns.length > 0) {
            // Under a partial scan a zero-hit pattern is NOT a proven no-match.
            sections.push(`(no matches${combinedPartial ? ' in partial results' : ''}) pattern=${JSON.stringify(noMatchPatterns)} path=${searchPath}${globStr}; path exists`);
        }
        if (residual.length > 0) {
            // Rust/JS regex divergence or --max-columns truncation left
            // matches no pattern claimed; surface them rather than drop.
            sections.push(`# grep (unattributed matches)\n${residual.slice(0, 40).join('\n')}`);
        }
        return patternCapNote + sections.join('\n\n') + combinedPartialSuffix;
    }
    // Prefilter result (started above, overlapped with the combined
    // attempt): when it completed under the cap, each per-pattern grep
    // below scopes to that candidate list — K patterns cost 1 repo walk +
    // K file-list scans instead of K full walks. Zero candidates
    // short-circuits with no further spawns.
    let fanoutCandidateFiles = null;
    if (fanoutPrefilterPromise) {
        const pre = await fanoutPrefilterPromise;
        if (pre) {
            if (pre.length === 0) {
                const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
                return `${patternCapNote}(no matches) pattern=${JSON.stringify(patterns)} path=${searchPath}${globStr}; path exists (dir)`;
            }
            fanoutCandidateFiles = pre;
        }
    }
    const seen = new Set();
    const subOptions = {
        ...options,
        _grepPatternFanout: true,
        _grepContextCharBudget: Math.max(512, Math.floor(callContextCharBudget / patterns.length)),
        ...(fanoutCandidateFiles ? { _grepCandidateFiles: fanoutCandidateFiles } : {}),
    };
    // Each pattern is an INDEPENDENT grep; run them concurrently and then
    // apply dedup/section assembly in the original pattern order so the
    // shared `seen` set and output text stay byte-identical to the
    // sequential version.
    const runPattern = async (p) => {
        try {
            return await executeGrepTool({ ...args, pattern: p }, workDir, executeChildBuiltinTool, readStateScope, subOptions);
        } catch (err) {
            return `Error: ${err && err.message ? err.message : err}`;
        }
    };
    const subs = options._grepPathFanout
        ? await patterns.reduce(async (all, p) => [...await all, await runPattern(p)], Promise.resolve([]))
        : await Promise.all(patterns.map(runPattern));
    // Consolidate single-line no-match sub-results: K missed patterns
    // collapse into ONE summary line instead of K header+body sections.
    const parts = [];
    const missedPatterns = [];
    for (let i = 0; i < patterns.length; i++) {
        const body = dedupeFanoutMatchLines(subs[i], seen);
        if (typeof body === 'string' && body.startsWith('(no matches) ') && !body.includes('\n')) {
            missedPatterns.push(patterns[i]);
            continue;
        }
        parts.push(`# grep pattern:${JSON.stringify(patterns[i])}\n${body}`);
    }
    if (missedPatterns.length > 0) {
        const missGlob = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
        parts.push(`(no matches) pattern=${JSON.stringify(missedPatterns)} path=${searchPath}${missGlob}; path exists`);
    }
    return patternCapNote + parts.join('\n\n');
}
