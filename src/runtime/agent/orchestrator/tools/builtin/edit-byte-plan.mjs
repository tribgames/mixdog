import { stripTrailingWhitespaceForEdit } from '../edit-normalize.mjs';
import {
    bufferWithTrailingLf,
    concatByteReplacements,
    hashBytesWithReplacements,
} from './edit-byte-utils.mjs';
import {
    countLfInString,
    maybeAutoStripLineNumberPrefixes,
} from './edit-context-utils.mjs';
import { replacementForOriginalSlice } from './edit-match-utils.mjs';

export function tryBuildExactEditBuffer(rawBuf, oldStr, newStr, replaceAll, _snapshot, _filePath) {
    if (!Buffer.isBuffer(rawBuf) || typeof oldStr !== 'string' || oldStr.length === 0 || typeof newStr !== 'string') return null;
    const oldBytes = Buffer.from(oldStr, 'utf-8');
    if (oldBytes.length === 0) return null;
    let eOldBytes = oldBytes;
    const _pureDeletion = newStr === '' && !oldStr.endsWith('\n') && !oldStr.endsWith('\r');
    // Single-occurrence pure deletion: probe globally so the unique
    // match also covers its trailing line terminator (CRLF first to
    // avoid leaving a stray \r on CRLF files, then LF, then lone-CR).
    // Replace-all pure deletion CANNOT use a single global rewrite of
    // eOldBytes — when occurrences are mixed (some followed by \n, some
    // bare / at EOF), an eOldBytes that includes the terminator would
    // silently skip every bare occurrence. Per-occurrence absorption
    // below extends each span over its own trailing \r\n / \n / \r so
    // every match is removed regardless of what follows it.
    if (_pureDeletion && !replaceAll) {
        // Judge ambiguity on the BARE oldBytes BEFORE newline absorption.
        // Absorbing a trailing terminator first can narrow a >1-occurrence
        // bare match down to a unique extended span (e.g. 'X' present as
        // 'X\r\n...X'), silently single-deleting instead of surfacing the
        // ambiguous-match error. If the bare oldBytes occurs more than once
        // return null — the same signal the spans.length>1 path emits (→ the
        // caller's code-9 ambiguous-match error). Only absorb when the bare
        // match is unique.
        const _firstBare = rawBuf.indexOf(oldBytes);
        if (_firstBare !== -1 && rawBuf.indexOf(oldBytes, _firstBare + 1) !== -1) {
            return null;
        }
        const oldWithCrlf = Buffer.from(`${oldStr}\r\n`, 'utf-8');
        const oldWithLf = bufferWithTrailingLf(oldBytes);
        const oldWithCr = Buffer.from(`${oldStr}\r`, 'utf-8');
        if (rawBuf.indexOf(oldWithCrlf) !== -1) {
            eOldBytes = oldWithCrlf;
        } else if (rawBuf.indexOf(oldWithLf) !== -1) {
            eOldBytes = oldWithLf;
        } else if (rawBuf.indexOf(oldWithCr) !== -1) {
            eOldBytes = oldWithCr;
        }
    }
    const _perOccurrenceAbsorb = _pureDeletion && replaceAll;
    if (!replaceAll) {
        const _fb = rawBuf.indexOf(eOldBytes);
        if (_fb !== -1 && rawBuf.indexOf(eOldBytes, _fb + 1) !== -1) return null;
    }
    const spans = [];
    let idx = 0;
    while ((idx = rawBuf.indexOf(eOldBytes, idx)) !== -1) {
        let _end = idx + eOldBytes.length;
        if (_perOccurrenceAbsorb) {
            // CRLF (\r\n) first so we don't strand a stray \r; then LF;
            // then lone-CR. Bare / EOF occurrences leave _end as-is.
            if (rawBuf[_end] === 0x0d && rawBuf[_end + 1] === 0x0a) _end += 2;
            else if (rawBuf[_end] === 0x0a) _end += 1;
            else if (rawBuf[_end] === 0x0d) _end += 1;
        }
        spans.push({ start: idx, end: _end });
        if (!replaceAll && spans.length > 1) return null;
        idx += eOldBytes.length;
    }
    if (spans.length === 0) return null;
    const fileUtf8 = rawBuf.toString('utf-8');
    const replacements = spans.map((span) => ({
        ...span,
        newBytes: Buffer.from(
            replacementForOriginalSlice(newStr, rawBuf.subarray(span.start, span.end).toString('utf-8'), fileUtf8),
            'utf-8',
        ),
    }));
    const sameSize = replacements.every((span) => span.end - span.start === span.newBytes.length);
    if (spans.length === 1) {
        const first = spans[0].start;
        if (sameSize) {
            return {
                replacements,
                sameSize: true,
                contentHash: hashBytesWithReplacements(rawBuf, replacements),
            };
        }
        return {
            replacements,
            sameSize: false,
            updated: Buffer.concat([
                rawBuf.subarray(0, first),
                replacements[0].newBytes,
                rawBuf.subarray(spans[0].end),
            ], rawBuf.length - (spans[0].end - first) + replacements[0].newBytes.length),
        };
    }
    if (sameSize) {
        return {
            replacements,
            sameSize: true,
            contentHash: hashBytesWithReplacements(rawBuf, replacements),
        };
    }
    return {
        replacements,
        sameSize: false,
        updated: concatByteReplacements(rawBuf, replacements),
    };
}

export function tryBuildMultiExactEditBuffer(rawBuf, edits, args, snapshot, filePath) {
    if (!Buffer.isBuffer(rawBuf) || !Array.isArray(edits) || edits.length === 0) return null;
    // Fast path treats every edit as locating its span in the ORIGINAL buffer
    // and applies all replacements at once. Sequential-apply semantics differ
    // whenever edit A's new_string can synthesise (or destroy) bytes that
    // edit B's old_string would match. Disable the fast path unless edits
    // are provably independent — no pair where one's new_string contains
    // another's old_string. The slow path runs them sequentially.
    if (edits.length > 1) {
        for (let a = 0; a < edits.length; a++) {
            const ea = edits[a];
            if (!ea || typeof ea.old_string !== 'string' || typeof ea.new_string !== 'string') return null;
            for (let b = 0; b < edits.length; b++) {
                if (a === b) continue;
                const eb = edits[b];
                if (!eb || typeof eb.old_string !== 'string') return null;
                if (eb.old_string.length === 0) continue;
                if (ea.new_string.indexOf(eb.old_string) !== -1) return null;
            }
        }
    }
    const isMarkdown = /\.(?:md|mdx)$/i.test(filePath);
    const replacements = [];
    const normalizedEdits = [];
    for (let i = 0; i < edits.length; i++) {
        const entry = edits[i];
        if (!entry || typeof entry.old_string !== 'string' || typeof entry.new_string !== 'string') return null;
        let oldString = entry.old_string;
        let newString = entry.new_string;
        {
            const _nulIdx = newString.indexOf('\u0000');
            if (_nulIdx !== -1) {
                return { error: `Error [code 11]: edit ${i} — new_string contains NUL byte (U+0000) at offset ${_nulIdx} — source text must not contain NUL: ${filePath}` };
            }
        }
        const replaceAll = entry.replace_all === true;
        // Size gate moved out of the pre-loop guard: the exact byte
        // path proves uniqueness below (spans.length === 1 for
        // !replaceAll), so an exact-unique multi edit applies at any
        // size. The fold-fallback path in edit-engine still enforces
        // the >=30-line code-10 wording for genuine fold-misses.
        if (/^\s*\d+[\t│→]/.test(oldString)) {
            const stripped = maybeAutoStripLineNumberPrefixes(oldString);
            if (stripped === null) return null;
            oldString = stripped;
        }
        // Final-line-aware hygiene — same rule as the edit-engine slow path
        // (stripTrailingWhitespaceForEdit), so fast/slow paths cannot diverge
        // on identical inputs.
        if (!isMarkdown) newString = stripTrailingWhitespaceForEdit(newString, oldString);
        if (oldString.length === 0) {
            return { error: `Error: edit ${i} — old_string must be non-empty` };
        }
        if (oldString === newString) {
            return { error: `Error: edit ${i} — new_string must differ from old_string` };
        }
        if (newString === '' || countLfInString(oldString) !== countLfInString(newString)) return null;
        const oldBytes = Buffer.from(oldString, 'utf-8');
        const fileUtf8 = rawBuf.toString('utf-8');
        if (oldBytes.length === 0) return null;
        if (!replaceAll) {
            const _fb = rawBuf.indexOf(oldBytes);
            if (_fb !== -1 && rawBuf.indexOf(oldBytes, _fb + 1) !== -1) return null;
        }
        normalizedEdits.push({ oldString, newString, replaceAll });
        const spans = [];
        let idx = 0;
        while ((idx = rawBuf.indexOf(oldBytes, idx)) !== -1) {
            const spanEnd = idx + oldBytes.length;
            const sliceText = rawBuf.subarray(idx, spanEnd).toString('utf-8');
            const newBytes = Buffer.from(
                replacementForOriginalSlice(newString, sliceText, fileUtf8),
                'utf-8',
            );
            spans.push({ start: idx, end: spanEnd, editIndex: i, newBytes });
            if (!replaceAll && spans.length > 1) return null;
            idx += oldBytes.length;
        }
        if (spans.length === 0) return null;
        replacements.push(...spans);
    }
    replacements.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < replacements.length; i++) {
        if (replacements[i].start < replacements[i - 1].end) return null;
    }
    // Independence guard (above) only checks new_string-contains-old_string; it
    // misses old_strings SYNTHESISED across edit boundaries (e.g. "A"->"y" turns
    // "Az yz" into "yz yz", making a later "yz"->Q match twice — which sequential
    // apply would reject as ambiguous). Verify the fast (apply-in-original)
    // result equals an in-order SEQUENTIAL replay; on any divergence or
    // sequential-reject, return null so the caller runs the slow sequential
    // path. Fail-safe: a false mismatch only costs a fallback, never corruption.
    {
        const _fastBytes = concatByteReplacements(rawBuf, replacements);
        let seq = rawBuf.toString('utf-8');
        for (const { oldString: _o, newString: _n, replaceAll: _ra } of normalizedEdits) {
            const repl = replacementForOriginalSlice(_n, _o, seq);
            if (_ra) {
                if (!seq.includes(_o)) return null;
                seq = seq.split(_o).join(repl);
            } else {
                const first = seq.indexOf(_o);
                if (first === -1 || seq.indexOf(_o, first + _o.length) !== -1) return null;
                seq = seq.slice(0, first) + repl + seq.slice(first + _o.length);
            }
        }
        if (!Buffer.from(seq, 'utf-8').equals(_fastBytes)) return null;
    }
    const sameSize = replacements.every((span) => span.end - span.start === span.newBytes.length);
    if (sameSize) {
        return {
            replacements,
            sameSize: true,
            contentHash: hashBytesWithReplacements(rawBuf, replacements),
        };
    }
    return {
        replacements,
        sameSize: false,
        updated: concatByteReplacements(rawBuf, replacements),
    };
}
