// fuzzy-match.mjs — lightweight subsequence fuzzy scorer for filename / path
// search. Returns a score where a
// higher value is a better match, or null when the query is not a subsequence
// of the candidate.
//
// Scoring favors, in rough order of weight:
//   - matches at the START of the basename (last path segment)
//   - matches at a word boundary (/, \, _, -, ., space, or camelCase hump)
//   - contiguous runs of matched characters
//   - exact-case hits (small tie-break)
//   - shorter / earlier candidates (mild brevity + earliness pull)
//
// Matching is case-insensitive. The query is matched as an ordered subsequence
// (the chars must appear in order but need not be contiguous), which is what
// lets partial names surface matching files.

function isBoundaryChar(ch) {
    return ch === '/' || ch === '\\' || ch === '_' || ch === '-' || ch === '.' || ch === ' ';
}

// A camelCase hump (lower/digit followed by upper) is also a word boundary.
function isHump(prevCh, ch) {
    return prevCh !== undefined
        && /[a-z0-9]/.test(prevCh)
        && /[A-Z]/.test(ch);
}

function prepareFuzzyScore(query) {
    if (!query) return 0;
    const normalizedQuery = String(query).replace(/[\/\\_.\-\s]+/g, '');
    if (!normalizedQuery) return 0;
    const q = normalizedQuery.toLowerCase();
    const qlen = q.length;
    return (str) => {
        const s = str.toLowerCase();
        const slen = s.length;
        if (qlen === 0) return 0;
        if (qlen > slen) return null;

        const lastSep = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'));

        let score = 0;
        let si = 0;
        let prevMatch = -2;
        let firstMatchIdx = -1;

        for (let qi = 0; qi < qlen; qi++) {
            const qc = q[qi];
            let found = -1;
            for (let k = si; k < slen; k++) {
                if (s[k] === qc) { found = k; break; }
            }
            if (found === -1) return null;
            if (firstMatchIdx === -1) firstMatchIdx = found;

            score += 1; // base point per matched char

            if (found === prevMatch + 1) score += 5; // contiguous run

            const prevCh = found > 0 ? str[found - 1] : undefined;
            if (prevCh === undefined || isBoundaryChar(prevCh) || isHump(prevCh, str[found])) {
                score += 8; // word-boundary start
            }

            if (str[found] === normalizedQuery[qi]) score += 1; // exact-case tie-break

            prevMatch = found;
            si = found + 1;
        }

        // Matches that begin inside the basename (after the last separator) are far
        // more relevant than ones buried in directory components.
        if (firstMatchIdx > lastSep) score += 10;

        // Mild pulls: shorter candidates and earlier first matches rank higher.
        score -= Math.floor(slen / 16);
        score -= Math.floor(firstMatchIdx / 8);

        return score;
    };
}

/**
 * @param {string} query   user query (partial name)
 * @param {string} str     candidate path (relative)
 * @returns {number|null}  score, or null if `query` is not a subsequence
 */
function fuzzyScore(query, str) {
    const scorer = prepareFuzzyScore(query);
    return typeof scorer === 'function' ? scorer(str) : scorer;
}

// Below this per-query-char score, a subsequence-only match (query chars in
// order but scattered mid-word, no contiguity/boundary structure) is treated
// as noise rather than a real hit. Contiguous substring / basename matches
// bypass the floor entirely — an exact hit must never be filtered.
// Measured separation for scattered junk vs real hits ("readme" probe):
// genuine matches score ≥8/char (boundary + contiguity structure), while
// incidental subsequences on unrelated paths land at 5–6/char — 6.5 splits
// them. The floor is tested against the RAW subsequence score (see
// fuzzyRank), never the +40 basename rank bonus, which otherwise vaults
// weak basename subsequences straight past any floor.
const SUBSEQUENCE_MIN_PER_CHAR = 6.5;

// Separator/case-insensitive normalization used for the "contiguous substring"
// strong-match test. Mirrors the query normalization in fuzzyScore so
// "tool-events.log" matches a "tool-events.log" basename or a ".../tool-events.log"
// path regardless of separators.
function normalizeForContains(s) {
    return String(s || '').toLowerCase().replace(/[\/\\_.\-\s]+/g, '');
}

function fuzzyAsciiMask(value) {
    let lo = 0;
    let hi = 0;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
        let code = text.charCodeAt(index);
        if (code >= 65 && code <= 90) code += 32;
        let bit = -1;
        if (code >= 48 && code <= 57) bit = code - 48;
        else if (code >= 97 && code <= 122) bit = code - 97 + 10;
        if (bit < 0) continue;
        if (bit < 32) lo |= (1 << bit);
        else hi |= (1 << (bit - 32));
    }
    return { lo: lo >>> 0, hi: hi >>> 0 };
}

export function prepareFuzzyItems(paths) {
    return (paths || []).map((path) => {
        const value = String(path || '');
        const mask = fuzzyAsciiMask(value);
        return {
            path: value,
            _fuzzyMaskLo: mask.lo,
            _fuzzyMaskHi: mask.hi,
            _fuzzyLastSep: Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')),
        };
    });
}

function compareRanked(a, b) {
    return (b.score - a.score)
        || (a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : 0);
}

function compareRankedNodes(a, b) {
    return compareRanked(a.entry, b.entry) || (a.ordinal - b.ordinal);
}

function siftDownRankedHeap(heap, index) {
    for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let worst = index;
        if (left < heap.length && compareRankedNodes(heap[left], heap[worst]) > 0) worst = left;
        if (right < heap.length && compareRankedNodes(heap[right], heap[worst]) > 0) worst = right;
        if (worst === index) return;
        const node = heap[index];
        heap[index] = heap[worst];
        heap[worst] = node;
        index = worst;
    }
}

// Keep the worst retained candidate at index zero. The ordinal completes the
// public comparator only for heap bookkeeping, preserving stable-sort behavior
// for duplicate score/path entries.
function retainTopRanked(heap, entry, ordinal, limit) {
    const node = { entry, ordinal };
    if (heap.length < limit) {
        heap.push(node);
        for (let index = heap.length - 1; index > 0;) {
            const parent = Math.floor((index - 1) / 2);
            if (compareRankedNodes(heap[index], heap[parent]) <= 0) break;
            const parentNode = heap[parent];
            heap[parent] = heap[index];
            heap[index] = parentNode;
            index = parent;
        }
        return;
    }
    if (compareRankedNodes(node, heap[0]) < 0) {
        heap[0] = node;
        siftDownRankedHeap(heap, 0);
    }
}

/**
 * Rank candidates by fuzzy score against `query`, dropping non-matches.
 * @param {string} query
 * @param {Array<{path:string}>} items  each must expose a `path` string
 * @param {number} [limit]
 * @returns {Array<{item:object, score:number}>}  sorted desc, then path asc
 */
export function fuzzyRank(query, items, limit = 0) {
    const state = makeTokenScorer(query);
    const scored = [];
    // Preserve slice's legacy coercion behavior for non-integer public callers;
    // normal tool limits are positive integers and take the bounded fast path.
    const bounded = Number.isInteger(limit) && limit > 0;
    for (let ordinal = 0; ordinal < items.length; ordinal++) {
        const sc = scoreItemAgainstToken(state, items[ordinal]);
        if (sc === null) continue;
        const entry = { item: items[ordinal], score: sc };
        if (bounded) retainTopRanked(scored, entry, ordinal, limit);
        else scored.push(entry);
    }
    if (!bounded) {
        scored.sort(compareRanked);
        return limit > 0 ? scored.slice(0, limit) : scored;
    }
    return scored
        .sort(compareRankedNodes)
        .map(({ entry }) => entry);
}

// Prepared per-token scoring state shared by fuzzyRank / fuzzyRankMulti.
function makeTokenScorer(token) {
    const normQuery = normalizeForContains(token);
    return {
        normQuery,
        queryMask: fuzzyAsciiMask(normQuery),
        score: prepareFuzzyScore(token),
        // Floor scales with query length: a scattered subsequence earns ~1
        // point per char, while any contiguous run (+5/char) or word-boundary
        // hit (+8) pushes a genuine match well past 6.5/char.
        floor: normQuery.length * SUBSEQUENCE_MIN_PER_CHAR,
    };
}

// Gate + score ONE candidate against ONE prepared token. Returns the rank
// score (basename bonus included) or null when the candidate fails the ASCII
// mask prefilter or the subsequence quality floor.
function scoreItemAgainstToken(state, item) {
    const p = String(item.path || '');
    if (Number.isInteger(item._fuzzyMaskLo)
        && (((item._fuzzyMaskLo >>> 0) & state.queryMask.lo) >>> 0) !== state.queryMask.lo) return null;
    if (Number.isInteger(item._fuzzyMaskHi)
        && (((item._fuzzyMaskHi >>> 0) & state.queryMask.hi) >>> 0) !== state.queryMask.hi) return null;
    const lastSep = Number.isInteger(item._fuzzyLastSep)
        ? item._fuzzyLastSep
        : Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const base = p.slice(lastSep + 1);
    const pathScore = typeof state.score === 'function' ? state.score(p) : state.score;
    const baseScore = typeof state.score === 'function' ? state.score(base) : state.score;
    const sc = Math.max(pathScore ?? -Infinity, baseScore === null ? -Infinity : baseScore + 40);
    if (!Number.isFinite(sc)) return null;
    // Strong match: the query (separators stripped) is a contiguous
    // substring of the basename or the full path. These ALWAYS pass so an
    // exact substring/basename hit can never be starved out as noise.
    const strong = state.normQuery.length > 0 && normalizeForContains(p).includes(state.normQuery);
    // Otherwise it is subsequence-only: keep it only if it clears the
    // per-char floor. Weak scattered matches (the pgAdmin-style junk that
    // merely contains the query chars in order) fall below it and drop out.
    // Compare the RAW subsequence score — the +40 basename rank bonus is
    // for ordering only and must not lift junk over the quality floor.
    const rawSc = Math.max(pathScore ?? -Infinity, baseScore ?? -Infinity);
    if (!strong && rawSc < state.floor) return null;
    return sc;
}

/** Split a find query into whitespace-separated fragments. */
export function splitFuzzyQueryTokens(query) {
    return String(query || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Multi-fragment AND ranking: every whitespace-separated fragment of `query`
 * must independently match a candidate (same gate as fuzzyRank); the rank
 * score is the fragment sum. Single-fragment queries delegate to fuzzyRank
 * unchanged.
 */
export function fuzzyRankMulti(query, items, limit = 0) {
    const tokens = splitFuzzyQueryTokens(query);
    if (tokens.length <= 1) return fuzzyRank(tokens[0] ?? String(query || ''), items, limit);
    const states = tokens.map(makeTokenScorer);
    const scored = [];
    const bounded = Number.isInteger(limit) && limit > 0;
    for (let ordinal = 0; ordinal < items.length; ordinal++) {
        const item = items[ordinal];
        let total = 0;
        for (const state of states) {
            const sc = scoreItemAgainstToken(state, item);
            if (sc === null) { total = null; break; }
            total += sc;
        }
        if (total === null) continue;
        const entry = { item, score: total };
        if (bounded) retainTopRanked(scored, entry, ordinal, limit);
        else scored.push(entry);
    }
    if (!bounded) {
        scored.sort(compareRanked);
        return limit > 0 ? scored.slice(0, limit) : scored;
    }
    return scored
        .sort(compareRankedNodes)
        .map(({ entry }) => entry);
}
