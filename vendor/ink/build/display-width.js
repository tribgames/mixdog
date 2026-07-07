/**
 * display-width.js — [mixdog fork] vendored copy of the shared display-width
 * policy from src/tui/display-width.mjs.
 *
 * MUST STAY IN SYNC with src/tui/display-width.mjs. ink is aliased as an
 * external bundle (see scripts/build-tui.mjs), so it cannot cleanly import from
 * src; the small policy is replicated here verbatim instead. If the problem
 * ranges or the WT_SESSION/MIXDOG_TUI_AMBIGUOUS_WIDE gate change there, change
 * them here too — ink's MEASUREMENT must agree with OUR wrap/row math or the
 * overlap gets worse, not better.
 *
 * Policy: widen ONLY U+2460–U+24FF (enclosed alphanumerics / circled digits)
 * and U+2194–U+21FF (arrows) to 2 cells when ON. NEVER widen box-drawing
 * (U+2500–U+257F), block elements, the four Basic Arrows U+2190–U+2193
 * (← ↑ → ↓ — figures.mjs 1-cell markers), or other ambiguous glyphs. ON by default
 * on Windows (win32) or under Windows Terminal (WT_SESSION);
 * MIXDOG_TUI_AMBIGUOUS_WIDE='1'/'0' overrides and wins. OFF ⇒ identical to
 * plain string-width.
 */
import stringWidth from 'string-width';
// [mixdog fork] Grapheme segmenter for cluster-aware width math (e.g. `↔️` =
// U+2194 U+FE0F is one cluster, counted once). Kept in sync with
// src/tui/display-width.mjs.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isProblemCodePoint(cp) {
    // [mixdog fork] U+21BB (↻ quota-reset marker) excluded: WT draws it 1 cell,
    // so widening it shifted the right-aligned statusline label one col left.
    return (cp >= 0x2460 && cp <= 0x24ff) || (cp >= 0x2194 && cp <= 0x21ff && cp !== 0x21bb);
}

// [mixdog fork] Fast precheck for the problem ranges above. Lets the hot path
// bail before the per-grapheme segmenter loop when a string (the common
// ASCII/status-text case) contains no widenable glyph. Kept in sync with
// src/tui/display-width.mjs.
const PROBLEM_RE = /[\u2194-\u21ff\u2460-\u24ff]/;

function resolveAmbiguousWidePolicy(env = process.env, platform = process.platform) {
    const override = env?.MIXDOG_TUI_AMBIGUOUS_WIDE;
    if (override === '1')
        return true;
    if (override === '0')
        return false;
    return platform === 'win32' || Boolean(env?.WT_SESSION);
}

// Resolved once at module load (matches src/tui/display-width.mjs).
export const AMBIGUOUS_WIDE = resolveAmbiguousWidePolicy();

export function displayWidthWith(str, wide) {
    const s = String(str ?? '');
    const base = stringWidth(s);
    if (!wide)
        return base;
    // Fast bail: no problem glyph ⇒ segmenting can only return `base`.
    if (!PROBLEM_RE.test(s))
        return base;
    let extra = 0;
    // Widen per GRAPHEME CLUSTER, not per code point (kept in sync with
    // src/tui/display-width.mjs): a clustered glyph like `↔️` (U+2194 U+FE0F)
    // is counted once, and only when the whole cluster still measures 1 cell.
    for (const { segment } of graphemeSegmenter.segment(s)) {
        const cp = segment.codePointAt(0);
        if (isProblemCodePoint(cp) && stringWidth(segment) === 1)
            extra += 1;
    }
    return base + extra;
}

/** Visible display width under the resolved policy (ink-side stringWidth). */
export function displayStringWidth(str) {
    return displayWidthWith(str, AMBIGUOUS_WIDE);
}

/** widest-line equivalent under the policy. */
export function displayWidestLine(text) {
    let lineWidth = 0;
    for (const line of String(text ?? '').split('\n')) {
        lineWidth = Math.max(lineWidth, displayStringWidth(line));
    }
    return lineWidth;
}
