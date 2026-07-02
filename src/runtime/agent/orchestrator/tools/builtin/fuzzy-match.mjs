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

/**
 * @param {string} query   user query (partial name)
 * @param {string} str     candidate path (relative)
 * @returns {number|null}  score, or null if `query` is not a subsequence
 */
export function fuzzyScore(query, str) {
    if (!query) return 0;
    const normalizedQuery = String(query).replace(/[\/\\_.\-\s]+/g, '');
    if (!normalizedQuery) return 0;
    const q = normalizedQuery.toLowerCase();
    const s = str.toLowerCase();
    const qlen = q.length;
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
}

/**
 * Rank candidates by fuzzy score against `query`, dropping non-matches.
 * @param {string} query
 * @param {Array<{path:string}>} items  each must expose a `path` string
 * @param {number} [limit]
 * @returns {Array<{item:object, score:number}>}  sorted desc, then path asc
 */
export function fuzzyRank(query, items, limit = 0) {
    const scored = [];
    for (const item of items) {
        const pathScore = fuzzyScore(query, item.path);
        const base = String(item.path || '').split(/[\\/]/).pop() || '';
        const baseScore = fuzzyScore(query, base);
        const sc = Math.max(pathScore ?? -Infinity, baseScore === null ? -Infinity : baseScore + 40);
        if (Number.isFinite(sc)) scored.push({ item, score: sc });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : 0));
    return limit > 0 ? scored.slice(0, limit) : scored;
}
