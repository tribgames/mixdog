// grep pattern[] chunk-merge: when a pattern array exceeds the per-spawn cap,
// split it into chunks, fetch every chunk concurrently with the full aggregate
// budget, then replay the sequential room-based accumulation over the results
// in chunk order. rg output order is deterministic, so slicing this superset
// by the sequential `room` yields identical lines, and the re-extract with
// `room` reproduces the same truncation flags — the merged output and
// `truncatedAggregate` are byte-identical to the old serial loop while the
// grep calls overlap. Extracted from search-grep-tool.mjs; `executeGrepTool`
// is injected to avoid an import cycle.
import { markScopedCacheIncomplete } from '../../../session/cache/scoped-cache-outcome.mjs';
import {
    buildGrepChunkMergePrefix,
    chunkPatternList,
    computeGrepChunkAggregateBudget,
    extractGrepChunkResultLines,
    mergeGrepChunkLines,
} from './search-grep-chunks.mjs';
import { formatGrepOutput } from './grep-output.mjs';

export async function runGrepChunkMerge({
    args,
    patterns,
    patternChunkCap,
    workDir,
    executeChildBuiltinTool,
    readStateScope,
    options,
    patternCapNote,
    searchPath,
    grepResolvedPath,
    normalizedGlobPatterns,
    outputMode,
    headLimit,
    headLimitCoerced,
    offset,
    beforeN,
    afterN,
    contextN,
    fileType,
    executeGrepTool,
}) {
    const patternChunks = chunkPatternList(patterns, patternChunkCap);
    const aggregateBudget = computeGrepChunkAggregateBudget(offset, headLimit, headLimitCoerced);
    let truncatedAggregate = false;
    const chunkBaseArgs = {
        ...args,
        offset: 0,
        ...(outputMode === 'count' ? { output_mode: 'content' } : {}),
    };
    const chunkMergeOptions = { ...options, _grepChunkMerge: true };
    const chunkBodies = await Promise.all(patternChunks.map((chunk) => executeGrepTool(
        { ...chunkBaseArgs, pattern: chunk, head_limit: aggregateBudget },
        workDir,
        executeChildBuiltinTool,
        readStateScope,
        chunkMergeOptions,
    )));
    const mergedRaw = [];
    for (const chunkBody of chunkBodies) {
        if (mergedRaw.length >= aggregateBudget) {
            truncatedAggregate = true;
            break;
        }
        const room = aggregateBudget - mergedRaw.length;
        const extracted = extractGrepChunkResultLines(chunkBody, room);
        if (extracted.error) return extracted.error.startsWith('Error:') ? extracted.error : `Error: ${extracted.error}`;
        const slice = extracted.lines.slice(0, room);
        mergedRaw.push(...slice);
        if (extracted.truncated || extracted.lines.length > room) truncatedAggregate = true;
    }
    const chunkPrefix = buildGrepChunkMergePrefix(
        patternChunks.length,
        truncatedAggregate,
        aggregateBudget,
        outputMode,
    );
    const merged = mergeGrepChunkLines(mergedRaw, {
        outputMode,
        beforeN,
        afterN,
        contextN,
    });
    const sliced = offset > 0 ? merged.slice(offset) : merged;
    const limit = headLimit === Infinity ? sliced.length : headLimit;
    const windowed = limit === Infinity ? sliced : sliced.slice(0, limit);
    // Cache-outcome fidelity: the concurrent chunk fetches run with the full
    // aggregateBudget as head_limit, so a child may report itself complete
    // even though the replay above trimmed its lines to a smaller `room`
    // (truncatedAggregate), the final head_limit window dropped lines, or an
    // offset paged past earlier matches. Mirror the other grep return paths
    // and mark the scoped cache incomplete so a partial/paged chunk-merge
    // result is never cached as whole.
    if (options?.scopedCacheOutcome && (truncatedAggregate || offset > 0 || windowed.length < sliced.length)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    if (!windowed.length) {
        const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
        const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
        return `${patternCapNote}${chunkPrefix}(no matches) pattern=${patternStr} path=${searchPath}${globStr}`;
    }
    return formatGrepOutput({
        windowed,
        // POST-offset total so formatGrepOutput's remaining/total math (which
        // re-adds `offset`) does not conjure phantom "more" results from the
        // offset-skipped prefix.
        totalWindowed: sliced.length,
        totalKnown: !truncatedAggregate,
        headLimit,
        offset,
        outputMode,
        patterns,
        beforeN,
        afterN,
        contextN,
        searchPath,
        grepResolvedPath,
        workDir,
        globPatterns: normalizedGlobPatterns,
        fileType,
        filenameOmitted: false,
        prefix: patternCapNote + chunkPrefix,
    });
}
