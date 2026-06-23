// Edit input normalization helpers — extracted from builtin.mjs so the
// matching tiers (curly-quote fold / NFC-fold) can be tested in isolation
// and audited without scrolling through the full tool dispatcher.
//
import { findCrlfNormalisedMatches } from './builtin/edit-match-utils.mjs';
//
// HARD RULE — tier ordering + ambiguity gates. Invariant-safe tiers run
// first (byte-exact, curly-quote fold, NFC-fold, CRLF-fold). Last-resort Claude-Code
// parity tiers (rstrip-fold, indent-fold, eol-fold) are lossy views but
// safe: each runs only after invariant-safe tiers (including CRLF-fold) miss, rejects >1 folded
// hit with code 9 (diagnoseFoldTierAmbiguity), and always replaces a real
// content.substring slice — never synthesised folded bytes. Still removed:
// case/dash/fullwidth/Unicode-space folding and unconstrained indent-shift
// (whole-block re-indent), which can alias unrelated regions.
//
// All helpers preserve the same byte-exact invariant: matchers return a
// real substring of `content` (never a synthesised one), and length-
// preserving folds keep input.length so an indexOf hit re-indexes the
// original bytes. See per-function comments for stage-specific guards.

// CC parity: curly-quote tolerant match. Models can't reliably emit `‘`
// / `’` / `“` / `”`, so when a file has curly quotes but
// old_string uses straight (or vice versa) the literal indexOf misses.
// This is the ONLY fold retained in this stage and it is invariant-safe:
// a curly quote and its straight counterpart are the same character in a
// different typographic encoding. Each mapped codepoint is a single
// UTF-16 code unit (BMP only, no surrogate pairs), so an `indexOf` hit in
// the folded view re-indexes the original file substring without
// arithmetic adjustment — the caller can
// `content.substring(idx, idx + searchStr.length)` and get a byte-exact
// slice back.
//
// Folded codepoints:
//   Single  → "'" : U+2018-U+201B (curly + low/high-reversed-9).
//   Double  → '"' : U+201C-U+201F (curly + low/high-reversed-9).
//
// Deliberately NOT folded (would be heuristic-risky, not invariant-safe):
// case, dash/minus variants, fullwidth forms, and Unicode whitespace —
// each can map text that is genuinely different to the same view and hit
// the wrong location. NFC / NFD is handled in its own invariant-safe tier
// (nfcFoldMatch). ZWSP / BOM remain hint-only.
export const MATCH_FOLD_RE = /[‘-‟]/g;
export function normalizeForMatch(s) {
    return String(s).replace(MATCH_FOLD_RE, (c) => {
        const code = c.charCodeAt(0);
        if (code >= 0x2018 && code <= 0x201B) return "'";
        return '"';
    });
}

// NFC/NFD fold helper. Returns the byte-exact slice from `content` whose
// normalised form equals the normalised search, or null if no unique
// safe match exists.
//
// Why NFD (not NFC) is the comparison medium: NFC composition is NOT
// char-by-char — multiple input chars can collapse into one (e.g. Hangul
// `각` → `각`). That breaks any attempt to map an
// index in nfcContent back to original char positions via per-char NFC
// length accumulation. NFD decomposition IS char-by-char additive: each
// input char produces its own NFD output independent of neighbours, so
// per-char NFD length accumulates monotonically and origStart / origEnd
// are recoverable in O(N) total work.
//
// Invariants:
//   • Returned string === content.substring(start, end) for some
//     (start, end); never synthesised from normalised bytes.
//   • At least one side drifts under normalisation; otherwise the exact
//     tier already covered it (early bail).
//   • Exactly one occurrence of nfdSearch in nfdContent — multi-match
//     collapses to null so the caller still receives Error [code 8].
//   • origStart lands on an original-content char boundary, not in the
//     middle of an NFD decomposition.
export function nfcFoldMatch(content, searchStr) {
    if (typeof content !== 'string' || typeof searchStr !== 'string') return null;
    if (searchStr.length === 0 || content.length === 0) return null;
    let nfdSearch;
    let nfdContent;
    try {
        nfdSearch = searchStr.normalize('NFD');
        nfdContent = content.normalize('NFD');
    } catch {
        return null;
    }
    if (nfdSearch === searchStr && nfdContent === content) return null;
    if (nfdSearch.length === 0) return null;
    const firstIdx = nfdContent.indexOf(nfdSearch);
    if (firstIdx === -1) return null;
    if (nfdContent.indexOf(nfdSearch, firstIdx + 1) !== -1) return null;
    let origStart = 0;
    let nfdCursor = 0;
    while (origStart < content.length && nfdCursor < firstIdx) {
        nfdCursor += content[origStart].normalize('NFD').length;
        origStart++;
    }
    if (nfdCursor !== firstIdx) return null;
    const targetLen = nfdSearch.length;
    let endNfd = 0;
    let origEnd = origStart;
    while (origEnd < content.length) {
        endNfd += content[origEnd].normalize('NFD').length;
        origEnd++;
        if (endNfd === targetLen) {
            const slice = content.substring(origStart, origEnd);
            return slice.normalize('NFD') === nfdSearch ? slice : null;
        }
        if (endNfd > targetLen) return null;
    }
    return null;
}

function _lineNumbersForIndices(content, indices, max = 3) {
    const lines = [];
    for (let k = 0; k < Math.min(max, indices.length); k++) {
        const idx = indices[k];
        let lineNo = 1;
        for (let i = 0; i < idx; i++) {
            if (content.charCodeAt(i) === 10) lineNo++;
        }
        lines.push(lineNo);
    }
    return lines;
}

function _collectOverlapAwareIndices(haystack, needle, limit = 64) {
    const indices = [];
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        indices.push(idx);
        if (indices.length >= limit) break;
        idx += 1;
    }
    return indices;
}


function _parseLineRecords(s) {
    if (typeof s !== 'string' || s.length === 0) return [];
    const parts = s.split(/(\r\n|\n|\r)/);
    const records = [];
    for (let i = 0; i < parts.length; i += 2) {
        records.push({
            body: parts[i] ?? '',
            sep: i + 1 < parts.length ? parts[i + 1] : '',
        });
    }
    return records;
}

function _lineRecordOffset(content, contentRecords, lineIdx) {
    let off = 0;
    for (let i = 0; i < lineIdx; i++) {
        off += contentRecords[i].body.length + contentRecords[i].sep.length;
    }
    return off;
}

function _sliceFromLineWindow(content, contentRecords, startLine, searchRecords) {
    const numLines = searchRecords.length;
    const start = _lineRecordOffset(content, contentRecords, startLine);
    let len = 0;
    for (let j = 0; j < numLines; j++) {
        const rec = contentRecords[startLine + j];
        const sRec = searchRecords[j];
        len += rec.body.length;
        const isLast = j === numLines - 1;
        if (!isLast) len += rec.sep.length;
        else if (sRec.sep !== '') len += rec.sep.length;
    }
    return content.substring(start, start + len);
}

function _lineRecordsMatch(contentRecords, searchRecords, startLine, normalizeBody) {
    const n = searchRecords.length;
    if (startLine + n > contentRecords.length) return false;
    for (let j = 0; j < n; j++) {
        const cRec = contentRecords[startLine + j];
        const sRec = searchRecords[j];
        if (normalizeBody(cRec.body) !== normalizeBody(sRec.body)) return false;
        const isLast = j === n - 1;
        if (isLast && sRec.sep === '') continue;
        if (cRec.sep !== sRec.sep) return false;
    }
    return true;
}

function _normalizeLineBodyRstrip(body) {
    return String(body).replace(/[ \t]+$/, '');
}

// CC parity: convertLeadingTabsToSpaces (leading tab run only, 2 spaces/tab).
function _normalizeLeadingIndentLine(body) {
    const s = String(body);
    if (!s.includes('\t')) return s;
    const m = s.match(/^(\t+)(.*)$/);
    if (!m) return s;
    return `${'  '.repeat(m[1].length)}${m[2]}`;
}

function _lineOrientedFoldMatch(content, searchStr, normalizeBody) {
    const searchRecords = _parseLineRecords(searchStr);
    const contentRecords = _parseLineRecords(content);
    if (searchRecords.length === 0) return null;
    let slice = null;
    for (let start = 0; start + searchRecords.length <= contentRecords.length; start++) {
        if (!_lineRecordsMatch(contentRecords, searchRecords, start, normalizeBody)) continue;
        if (slice !== null) return null;
        slice = _sliceFromLineWindow(content, contentRecords, start, searchRecords);
        if (!content.includes(slice)) return null;
    }
    return slice;
}

function _diagnoseLineOrientedFold(content, searchStr, normalizeBody, stage) {
    const searchRecords = _parseLineRecords(searchStr);
    const contentRecords = _parseLineRecords(content);
    const starts = [];
    for (let start = 0; start + searchRecords.length <= contentRecords.length; start++) {
        if (_lineRecordsMatch(contentRecords, searchRecords, start, normalizeBody)) starts.push(start);
    }
    if (starts.length <= 1) return null;
    const lines = starts.map((st) => _lineNumbersForIndices(content, [_lineRecordOffset(content, contentRecords, st)], 1)[0] || 1);
    return { stage, count: starts.length, lines };
}

function _eolFoldVariants(searchStr) {
    const variants = [];
    const endsWithCrlf = searchStr.endsWith('\r\n');
    const endsWithLf = !endsWithCrlf && searchStr.endsWith('\n');
    if (!endsWithCrlf && !endsWithLf) {
        variants.push(`${searchStr}\n`, `${searchStr}\r\n`);
    } else if (endsWithCrlf) {
        const bare = searchStr.slice(0, -2);
        if (bare.length > 0) variants.push(bare);
    } else if (endsWithLf) {
        const bare = searchStr.slice(0, -1);
        if (bare.length > 0) variants.push(bare);
    }
    return variants;
}

function _isTrailingEolBoundary(content, endIdx) {
    if (endIdx >= content.length) return true;
    if (content.charCodeAt(endIdx) === 10) return true;
    if (content.charCodeAt(endIdx) === 13 && content.charCodeAt(endIdx + 1) === 10) return true;
    return false;
}

function _sliceAtTrailingEolBoundary(content, start, bare, _searchStr) {
    const bareEnd = start + bare.length;
    if (!_isTrailingEolBoundary(content, bareEnd)) return null;
    if (bareEnd === content.length) return content.substring(start, bareEnd);
    if (content.charCodeAt(bareEnd) === 13 && content.charCodeAt(bareEnd + 1) === 10) {
        return content.substring(start, bareEnd + 2);
    }
    if (content.charCodeAt(bareEnd) === 10) return content.substring(start, bareEnd + 1);
    return content.substring(start, bareEnd);
}

function _collectEolBoundaryBareIndices(content, bare) {
    const indices = [];
    let idx = 0;
    while ((idx = content.indexOf(bare, idx)) !== -1) {
        if (_isTrailingEolBoundary(content, idx + bare.length)) indices.push(idx);
        idx += 1;
    }
    return indices;
}

function crlfFoldMatch(content, searchStr) {
    const match = findCrlfNormalisedMatches(content, searchStr);
    if (!match || match.ranges.length !== 1) return null;
    const { start, end } = match.ranges[0];
    return content.substring(start, end);
}

function _diagnoseCrlfFoldAmbiguity(content, searchStr) {
    const match = findCrlfNormalisedMatches(content, searchStr);
    if (!match || match.ranges.length <= 1) return null;
    const indices = match.ranges.map((r) => r.start);
    return {
        stage: 'crlf-fold',
        count: match.ranges.length,
        lines: _lineNumbersForIndices(content, indices),
    };
}

function eolFoldMatch(content, searchStr) {
    if (typeof content !== 'string' || typeof searchStr !== 'string' || searchStr.length === 0) return null;
    if (content.includes(searchStr)) return null;
    const variants = _eolFoldVariants(searchStr);
    const endsWithCrlf = searchStr.endsWith('\r\n');
    const endsWithLf = !endsWithCrlf && searchStr.endsWith('\n');
    let slice = null;
    let total = 0;
    for (const needle of variants) {
        if (!needle) continue;
        const isBare = (endsWithCrlf || endsWithLf) && needle.length < searchStr.length;
        const indices = isBare
            ? _collectEolBoundaryBareIndices(content, needle)
            : _collectOverlapAwareIndices(content, needle);
        if (indices.length === 0) continue;
        total += indices.length;
        if (indices.length === 1 && slice === null) {
            slice = isBare
                ? _sliceAtTrailingEolBoundary(content, indices[0], needle, searchStr)
                : content.substring(indices[0], indices[0] + needle.length);
        } else if (indices.length > 0) {
            if (indices.length > 1 || slice !== null) slice = null;
        }
    }
    if (total === 1 && slice !== null) return slice;
    return null;
}

function _diagnoseEolFoldAmbiguity(content, searchStr) {
    const variants = _eolFoldVariants(searchStr);
    const endsWithCrlf = searchStr.endsWith('\r\n');
    const endsWithLf = !endsWithCrlf && searchStr.endsWith('\n');
    const indices = [];
    for (const needle of variants) {
        if (!needle) continue;
        const isBare = (endsWithCrlf || endsWithLf) && needle.length < searchStr.length;
        if (isBare) indices.push(..._collectEolBoundaryBareIndices(content, needle));
        else indices.push(..._collectOverlapAwareIndices(content, needle));
    }
    if (indices.length <= 1) return null;
    return { stage: 'eol-fold', count: indices.length, lines: _lineNumbersForIndices(content, indices) };
}

// Smoke / audit: eol-fold ambiguity in isolation (ignores exact-tier literal hits).
export function diagnoseEolFoldAmbiguity(content, searchStr) {
    return _diagnoseEolFoldAmbiguity(content, searchStr);
}

// When invariant-safe or last-resort fold tiers would match more than once, surface code 9
// (ambiguous) instead of falling through to code 8 (not found).
export function diagnoseFoldTierAmbiguity(content, searchStr) {
    if (typeof content !== 'string' || typeof searchStr !== 'string' || searchStr.length === 0) {
        return null;
    }
    if (content.includes(searchStr)) return null;

    const nContent = normalizeForMatch(content);
    const nSearch = normalizeForMatch(searchStr);
    if (nContent !== content || nSearch !== searchStr) {
        const indices = _collectOverlapAwareIndices(nContent, nSearch);
        if (indices.length > 1) {
            return {
                stage: 'fold',
                count: indices.length,
                lines: _lineNumbersForIndices(content, indices),
            };
        }
    }

    let nfdSearch;
    let nfdContent;
    try {
        nfdSearch = searchStr.normalize('NFD');
        nfdContent = content.normalize('NFD');
    } catch {
        return null;
    }
    const nfdDrift = !(nfdSearch === searchStr && nfdContent === content);
    if (nfdDrift && nfdSearch.length > 0) {
        const nfdIndices = _collectOverlapAwareIndices(nfdContent, nfdSearch);
        if (nfdIndices.length > 1) {
            const lines = [];
            for (let k = 0; k < Math.min(3, nfdIndices.length); k++) {
                const firstIdx = nfdIndices[k];
                let origStart = 0;
                let nfdCursor = 0;
                while (origStart < content.length && nfdCursor < firstIdx) {
                    nfdCursor += content[origStart].normalize('NFD').length;
                    origStart++;
                }
                lines.push(_lineNumbersForIndices(content, [origStart], 1)[0] || 1);
            }
            return { stage: 'nfc-fold', count: nfdIndices.length, lines };
        }
    }

    const crlfAmb = _diagnoseCrlfFoldAmbiguity(content, searchStr);
    if (crlfAmb) return crlfAmb;
    const rstripAmb = _diagnoseLineOrientedFold(content, searchStr, _normalizeLineBodyRstrip, 'rstrip-fold');
    if (rstripAmb) return rstripAmb;
    const indentAmb = _diagnoseLineOrientedFold(content, searchStr, _normalizeLeadingIndentLine, 'indent-fold');
    if (indentAmb) return indentAmb;
    return _diagnoseEolFoldAmbiguity(content, searchStr);
}

// Tiered matcher: exact → curly-quote fold → NFC-fold → crlf-fold →
// rstrip-fold → indent-fold → eol-fold (last resort). `info.stage` is set
// to the tier that landed. Returns null if every tier fails — the caller
// may still attempt engine CRLF range replace or surfaces Error [code 8].
export function findActualString(content, searchStr, info) {
    if (typeof content !== 'string' || typeof searchStr !== 'string' || searchStr.length === 0) return null;
    if (content.includes(searchStr)) {
        if (info) info.stage = 'exact';
        return searchStr;
    }
    const nContent = normalizeForMatch(content);
    const nSearch = normalizeForMatch(searchStr);
    if (nContent !== content || nSearch !== searchStr) {
        const idx = nContent.indexOf(nSearch);
        if (idx !== -1) {
            if (nContent.indexOf(nSearch, idx + 1) === -1) {
                if (info) info.stage = 'fold';
                return content.substring(idx, idx + searchStr.length);
            }
        }
    }
    const nfcSlice = nfcFoldMatch(content, searchStr);
    if (nfcSlice !== null) {
        if (info) info.stage = 'nfc-fold';
        return nfcSlice;
    }
    const crlfSlice = crlfFoldMatch(content, searchStr);
    if (crlfSlice !== null) {
        if (info) info.stage = 'crlf-fold';
        return crlfSlice;
    }
    const rstripSlice = _lineOrientedFoldMatch(content, searchStr, _normalizeLineBodyRstrip);
    if (rstripSlice !== null) {
        if (info) info.stage = 'rstrip-fold';
        return rstripSlice;
    }
    const indentSlice = _lineOrientedFoldMatch(content, searchStr, _normalizeLeadingIndentLine);
    if (indentSlice !== null) {
        if (info) info.stage = 'indent-fold';
        return indentSlice;
    }
    const eolSlice = eolFoldMatch(content, searchStr);
    if (eolSlice !== null) {
        if (info) info.stage = 'eol-fold';
        return eolSlice;
    }
    return null;
}

// Strip trailing space/tab from each line of `s` while preserving every
// line terminator exactly as encountered (LF, CRLF, or lone CR). Used for
// insert-side new_string normalization and as the rstrip-fold view (match
// location only via findActualString's last-resort tier + ambiguity gate).
// Models routinely append stray spaces at line ends; in source code that
// has no semantic meaning, so silent diffs from those bytes are pure
// noise. Caller is responsible for skipping markdown (where `"  \n"` is
// the hard-line-break syntax).
export function stripTrailingWhitespacePerLine(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    const parts = s.split(/(\r\n|\n|\r)/);
    let changed = false;
    for (let i = 0; i < parts.length; i += 2) {
        const before = parts[i];
        if (before === undefined) continue;
        const after = before.replace(/[ \t]+$/, '');
        if (after !== before) {
            parts[i] = after;
            changed = true;
        }
    }
    return changed ? parts.join('') : s;
}

// Trailing-whitespace hygiene for Edit new_string, FINAL-LINE AWARE. The
// per-line strip exists to drop model-emitted trailing-space noise, but when
// old_string itself ends in space/tab the edit span deliberately ends
// MID-LINE inside meaningful whitespace (old `const m = ` / new
// `const mX = `) — stripping new_string's final line there silently eats a
// load-bearing space and corrupts the line. Non-final lines always end at a
// terminator, so they are unconditionally safe to strip.
export function stripTrailingWhitespaceForEdit(newString, oldString) {
    if (typeof newString !== 'string' || newString.length === 0) return newString;
    if (!/[ \t]$/.test(String(oldString ?? ''))) {
        return stripTrailingWhitespacePerLine(newString);
    }
    const i = newString.lastIndexOf('\n');
    if (i === -1) return newString;
    return stripTrailingWhitespacePerLine(newString.slice(0, i + 1)) + newString.slice(i + 1);
}

// ─────────────────────────────────────────────────────────────────────────
// Typography preservation — Claude Code parity (FileEditTool/utils.ts:96-199).
//
// CORE-PRINCIPLE EXCEPTION: every tier in this module is a deterministic,
// invariant-based recovery; this single helper is a heuristic — explicitly
// opted in because the alternative (always emitting ASCII `'` / `"` into a
// curly-quoted file) silently drifts the typography of every edited prose
// file. Note this only rewrites `newString` bytes the model is about to
// insert; it never affects WHERE the match lands. The heuristic is
// well-bounded:
//
//   • Only ASCII `'` / `"` characters in `newString` are touched. All
//     other bytes — letters, numbers, punctuation, code identifiers,
//     existing curly quotes — pass through unmodified.
//   • Triggered only when `matchedSlice` (the file's actual bytes at the
//     match position) contains at least one curly quote AND differs from
//     `oldString` (i.e. the model emitted straight, the file had curly).
//   • Contraction guard: an apostrophe between two Unicode letters is
//     classified as a contraction (`it's`, `don't`) and always becomes
//     RIGHT_SINGLE (`'`), regardless of preceding-char context.
//   • LEFT / RIGHT inference: an opening quote is one preceded by
//     whitespace, an opening bracket, an em / en dash, or string start.
//     Otherwise closing.
//
// Known limitations (accepted):
//   • Mid-sentence quote in code string literals — irrelevant because
//     code files almost never contain curly quotes (skip-by-design via
//     the `hasDoubleQuotes || hasSingleQuotes` gate).
//   • CJK / Korean prose where quote-adjacent characters are letters —
//     the contraction guard may fire and pick RIGHT. Net effect: a
//     consistent right-quote rather than a drift back to ASCII, which
//     is still a typography preservation, just not perfectly directional.
// ─────────────────────────────────────────────────────────────────────────

export const LEFT_SINGLE_CURLY_QUOTE = '‘';
export const RIGHT_SINGLE_CURLY_QUOTE = '’';
export const LEFT_DOUBLE_CURLY_QUOTE = '“';
export const RIGHT_DOUBLE_CURLY_QUOTE = '”';

function _isOpeningContext(chars, index) {
    if (index === 0) return true;
    const prev = chars[index - 1];
    return (
        prev === ' '
        || prev === '\t'
        || prev === '\n'
        || prev === '\r'
        || prev === '('
        || prev === '['
        || prev === '{'
        || prev === '—' // em dash
        || prev === '–' // en dash
    );
}

function _applyCurlyDoubleQuotes(str) {
    const chars = Array.from(str);
    const result = [];
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] === '"') {
            result.push(_isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE);
        } else {
            result.push(chars[i]);
        }
    }
    return result.join('');
}

function _applyCurlySingleQuotes(str) {
    const chars = Array.from(str);
    const result = [];
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] === "'") {
            const prev = i > 0 ? chars[i - 1] : undefined;
            const next = i < chars.length - 1 ? chars[i + 1] : undefined;
            const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
            const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
            if (prevIsLetter && nextIsLetter) {
                // Contraction (e.g. "it's", "don't") — always right curly.
                result.push(RIGHT_SINGLE_CURLY_QUOTE);
            } else {
                result.push(_isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE);
            }
        } else {
            result.push(chars[i]);
        }
    }
    return result.join('');
}

export function preserveQuoteTypography(oldString, matchedSlice, newString) {
    if (typeof matchedSlice !== 'string' || typeof newString !== 'string') return newString;
    if (oldString === matchedSlice) return newString;
    const hasDoubleQuotes =
        matchedSlice.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
        matchedSlice.includes(RIGHT_DOUBLE_CURLY_QUOTE);
    const hasSingleQuotes =
        matchedSlice.includes(LEFT_SINGLE_CURLY_QUOTE) ||
        matchedSlice.includes(RIGHT_SINGLE_CURLY_QUOTE);
    if (!hasDoubleQuotes && !hasSingleQuotes) return newString;
    let result = newString;
    if (hasDoubleQuotes) result = _applyCurlyDoubleQuotes(result);
    if (hasSingleQuotes) result = _applyCurlySingleQuotes(result);
    return result;
}

// Single-stage inline note → " (via fold)" suffix for error messages.
// Empty when the stage is missing or exact (the steady-state path).
export function formatStageInline(stage) {
    return (stage && stage !== 'exact') ? ` (via ${stage})` : '';
}

// Stage stats → " [fold:2, crlf-fold:0]" suffix. Empty / null counts
// render as empty string so exact-only edits stay terse. Stable key order
// (Object.entries insertion order) keeps two edits with the same matches
// rendering identically.
export function formatStageNote(stageCounts) {
    if (!stageCounts) return '';
    const entries = Object.entries(stageCounts).filter(([, v]) => v > 0);
    if (entries.length === 0) return '';
    return ` [${entries.map(([k, v]) => `${k}:${v}`).join(', ')}]`;
}
