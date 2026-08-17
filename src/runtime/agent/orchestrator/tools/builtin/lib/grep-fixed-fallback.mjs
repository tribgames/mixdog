// grep fixed-string rescue: when rg rejects a pattern as regex (parse error)
// outside multiline mode, extract literal terms from the pattern(s) and rerun
// the search with --fixed-strings so the caller still gets evidence instead of
// a bare parse error. Returns the fallback output, or null when no fixed terms
// could be derived or the rerun itself failed (caller then surfaces the
// original rg error). Extracted from search-grep-tool.mjs.
import { buildGrepRgArgs } from '../search-builders.mjs';
import { runRg, runRgWindowedLines } from '../native-search-runner.mjs';
import {
    regexPatternToFixedTerms,
    uniqueStrings,
} from './search-input-helpers.mjs';
import { formatGrepOutput } from './grep-output.mjs';

export async function runGrepFixedStringFallback({
    args,
    patterns,
    patternCapNote,
    searchPath,
    grepResolvedPath,
    workDir,
    normalizedGlobPatterns,
    outputMode,
    caseInsensitive,
    showLineNumbers,
    beforeN,
    afterN,
    contextN,
    fileType,
    forceGrepFilename,
    filenameOmitted,
    scopedCandidateFiles,
    headLimit,
    offset,
    contentHardCap,
    rgSpawnCwd,
    signal,
}) {
    const fixedPatterns = uniqueStrings(patterns.flatMap(regexPatternToFixedTerms));
    if (fixedPatterns.length === 0) return null;
    try {
        const fallbackArgs = buildGrepRgArgs({
            patterns: fixedPatterns,
            searchPath,
            globPatterns: normalizedGlobPatterns,
            outputMode,
            caseInsensitive,
            showLineNumbers,
            beforeN,
            afterN,
            contextN,
            multilineMode: false,
            fileType,
            onlyMatching: args['-o'] === true,
            fixedStrings: true,
            withFilename: forceGrepFilename,
            candidateFiles: scopedCandidateFiles,
        });
        const effectiveHeadLimit = headLimit === Infinity
            ? (outputMode === 'content' ? contentHardCap : Infinity)
            : headLimit;
        let windowed;
        let totalWindowed = 0;
        let totalKnown = true;
        let rgPartialSuffix = '';
        if (effectiveHeadLimit !== Infinity) {
            const streamed = await runRgWindowedLines(fallbackArgs, { cwd: rgSpawnCwd, signal }, {
                offset,
                limit: effectiveHeadLimit,
                summaryLimit: outputMode === 'content' ? 120 : 0,
            });
            windowed = streamed.lines;
            totalWindowed = streamed.totalSeen;
            totalKnown = streamed.complete;
            if (streamed.partial) {
                totalKnown = false;
                rgPartialSuffix = streamed.timeout
                    ? '\n[warning] rg timed out; partial fixed-string fallback results shown.'
                    : streamed.rgStderr
                    ? `\n[warning] rg exit 2 (partial fixed-string fallback results): ${String(streamed.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial fixed-string fallback results)';
            }
        } else {
            const stdout = await runRg(fallbackArgs, { cwd: rgSpawnCwd, signal });
            const allLines = String(stdout).split('\n').filter(Boolean);
            windowed = offset > 0 ? allLines.slice(offset) : allLines;
            totalWindowed = windowed.length;
            if (typeof stdout === 'object' && stdout.truncated) totalKnown = false;
            if (typeof stdout === 'object' && stdout.partial) {
                totalKnown = false;
                rgPartialSuffix = stdout.timeout
                    ? '\n[warning] rg timed out; partial fixed-string fallback results shown.'
                    : stdout.rgStderr
                    ? `\n[warning] rg exit 2 (partial fixed-string fallback results): ${String(stdout.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial fixed-string fallback results)';
            }
        }
        const fallbackPrefix = patternCapNote + '[regex parse fallback: fixed-string terms]\n';
        let body = formatGrepOutput({
            windowed,
            totalWindowed,
            totalKnown,
            headLimit,
            offset,
            outputMode,
            patterns: fixedPatterns,
            beforeN,
            afterN,
            contextN,
            searchPath,
            grepResolvedPath,
            workDir,
            globPatterns: normalizedGlobPatterns,
            fileType,
            filenameOmitted,
            prefix: fallbackPrefix,
        });
        if (!body || (windowed.length === 0 && totalWindowed === 0)) {
            body = `${fallbackPrefix}(no matches) fixed_terms=${JSON.stringify(fixedPatterns)} path=${searchPath}`;
        }
        return body + rgPartialSuffix;
    } catch { return null; /* fall through to the original rg error */ }
}
