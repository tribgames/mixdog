export function editFailureSuffix(_content, _oldStr) {
    return '';
}

export function validateEditChunkSize(oldStr, replaceAll, allowLarge) {
    if (replaceAll || allowLarge) return null;
    const lines = String(oldStr || '').split(/\r?\n/).length;
    if (lines < 30) return null;
    return `Error [code 10]: old_string is ${lines} lines (>= 30).`;
}

export function occurrenceLinesPlain(content, needle, max = 3) {
    if (typeof needle !== 'string' || needle.length === 0) return [];
    const lines = [];
    let pos = 0, scanned = 0, lineNo = 1;
    while (lines.length < max) {
        const idx = content.indexOf(needle, pos);
        if (idx === -1) break;
        for (let i = scanned; i < idx; i++) {
            if (content.charCodeAt(i) === 10) lineNo++;
        }
        scanned = idx;
        lines.push(lineNo);
        pos = idx + needle.length;
    }
    return lines;
}

export function occurrenceLinesCrlf(content, ranges, max = 3) {
    if (!Array.isArray(ranges) || ranges.length === 0) return [];
    const lines = [];
    let scanned = 0, lineNo = 1;
    for (let k = 0; k < Math.min(max, ranges.length); k++) {
        const idx = ranges[k].start;
        for (let i = scanned; i < idx; i++) {
            if (content.charCodeAt(i) === 10) lineNo++;
        }
        scanned = idx;
        lines.push(lineNo);
    }
    return lines;
}

export function formatMatchLines(linesArr, totalCount) {
    if (linesArr.length === 0) return '';
    const more = totalCount > linesArr.length ? ` (+${totalCount - linesArr.length} more)` : '';
    return ` Matches at lines: ${linesArr.join(', ')}${more}.`;
}

export function buildCrlfNormalisedViewWithMap(text) {
    const source = String(text ?? '');
    let normalised = '';
    const map = [];
    for (let i = 0; i < source.length;) {
        map[normalised.length] = i;
        if (source[i] === '\r' && source[i + 1] === '\n') {
            normalised += '\n';
            i += 2;
        } else {
            normalised += source[i];
            i += 1;
        }
    }
    map[normalised.length] = source.length;
    return { normalised, map };
}

export function findCrlfNormalisedMatches(content, oldStr) {
    if (typeof oldStr !== 'string' || oldStr.length === 0) return null;
    if (String(content).indexOf('\r\n') === -1 && oldStr.indexOf('\r\n') === -1) return null;
    const { normalised, map } = buildCrlfNormalisedViewWithMap(content);
    const normalisedOld = oldStr.replace(/\r\n/g, '\n');
    if (normalisedOld.length === 0 || normalisedOld === oldStr && normalised === content) return null;
    const ranges = [];
    let idx = 0;
    while ((idx = normalised.indexOf(normalisedOld, idx)) !== -1) {
        ranges.push({
            normStart: idx,
            normEnd: idx + normalisedOld.length,
            start: map[idx],
            end: map[idx + normalisedOld.length],
        });
        idx += normalisedOld.length;
    }
    return { normalised, normalisedOld, ranges };
}

export function replacementForOriginalSlice(newStr, originalSlice, fileContent) {
    if (typeof newStr !== 'string') return newStr;
    const slice = String(originalSlice);
    if (!slice.includes('\r\n') && !slice.includes('\n')) {
        if (typeof fileContent !== 'string') return newStr;
        if (fileContent.indexOf('\r\n') === -1) return newStr;
        // Pure-CRLF file: every bare \n is part of a \r\n pair. Mixed
        // files (any bare \n that is not preceded by \r) stay untouched
        // so we don't synthesise CRLF where the file uses LF.
        for (let i = 0; i < fileContent.length; i += 1) {
            if (fileContent.charCodeAt(i) === 10 && (i === 0 || fileContent.charCodeAt(i - 1) !== 13)) {
                return newStr;
            }
        }
        return newStr.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    }
    const lfReplacement = newStr.replace(/\r\n/g, '\n');
    let result = slice.includes('\r\n')
        ? lfReplacement.replace(/\n/g, '\r\n')
        : lfReplacement;
    // A matched slice can end on the last line's trailing EOL CR (split
    // CRLF) while newStr — typically copied from a \r-stripped read view —
    // has none. If the replacement ends mid-line, re-attach that consumed
    // CR so the following LF still forms a \r\n instead of silently
    // degrading to a lone \n (mixed-EOL corruption). A slice ending in a
    // bare CR is always a split CRLF; the end-of-line guard avoids
    // appending a stray CR when the replacement already carries its own
    // line ending.
    if (slice.endsWith('\r') && !/[\r\n]$/.test(result)) result += '\r';
    return result;
}

export function replaceRangesFromOriginal(content, ranges, newStr) {
    if (!Array.isArray(ranges) || ranges.length === 0) return content;
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    let cursor = 0;
    let out = '';
    for (const range of sorted) {
        if (!range || range.start < cursor || range.end < range.start) continue;
        out += content.slice(cursor, range.start);
        const originalSlice = content.slice(range.start, range.end);
        out += replacementForOriginalSlice(newStr, originalSlice);
        cursor = range.end;
    }
    return out + content.slice(cursor);
}

export function replaceSingleLiteralAt(content, index, needle, replacement) {
    return content.slice(0, index) + replacement + content.slice(index + needle.length);
}

export function findLiteralOccurrenceState(haystack, needle) {
    if (!needle) return { count: 0, index: -1 };
    const first = haystack.indexOf(needle);
    if (first === -1) return { count: 0, index: -1 };
    // Overlap-aware ambiguity: `aa` in `aaa` has a second hit at first+1,
    // not only at first+needle.length (which misses overlapping pairs).
    const second = haystack.indexOf(needle, first + 1);
    if (second === -1) return { count: 1, index: first };
    return { count: 2, index: first };
}

export function countLiteralOccurrences(haystack, needle, limit = Infinity) {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        if (count >= limit) return count;
        idx += 1;
    }
    return count;
}

export function diagnoseOtherEdits(content, edits, failedIndex) {
    if (!Array.isArray(edits) || edits.length <= 1) return '';
    let okCount = 0;
    const problems = [];
    for (let j = 0; j < edits.length; j++) {
        if (j === failedIndex) continue;
        const e = edits[j];
        if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
            problems.push(`${j}=invalid`); continue;
        }
        const oldStr = e.old_string;
        if (oldStr.length === 0) { problems.push(`${j}=empty`); continue; }
        const cnt = countLiteralOccurrences(content, oldStr);
        if (cnt === 1) { okCount++; continue; }
        if (cnt > 1) {
            if (e.replace_all === true) okCount++;
            else problems.push(`${j}=ambig(${cnt})`);
            continue;
        }
        const crlf = findCrlfNormalisedMatches(content, oldStr);
        const crlfCnt = crlf ? crlf.ranges.length : 0;
        if (crlfCnt === 1) { okCount++; continue; }
        if (crlfCnt > 1) {
            if (e.replace_all === true) okCount++;
            else problems.push(`${j}=ambig(${crlfCnt})`);
            continue;
        }
        problems.push(`${j}=miss`);
    }
    if (problems.length === 0) return '';
    const head = okCount > 0 ? `${okCount} ok, ` : '';
    return `\n  Peers: ${head}${problems.join(', ')}`;
}
