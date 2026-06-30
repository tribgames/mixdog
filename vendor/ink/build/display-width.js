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
 * and U+2190–U+21FF (arrows) to 2 cells when ON. NEVER widen box-drawing
 * (U+2500–U+257F), block elements, or other ambiguous glyphs. ON by default
 * only under Windows Terminal (WT_SESSION); MIXDOG_TUI_AMBIGUOUS_WIDE='1'/'0'
 * overrides and wins. OFF ⇒ identical to plain string-width.
 */
import stringWidth from 'string-width';

function isProblemCodePoint(cp) {
    return (cp >= 0x2460 && cp <= 0x24ff) || (cp >= 0x2190 && cp <= 0x21ff);
}

function resolveAmbiguousWidePolicy(env = process.env) {
    const override = env?.MIXDOG_TUI_AMBIGUOUS_WIDE;
    if (override === '1')
        return true;
    if (override === '0')
        return false;
    return Boolean(env?.WT_SESSION);
}

// Resolved once at module load (matches src/tui/display-width.mjs).
export const AMBIGUOUS_WIDE = resolveAmbiguousWidePolicy();

export function displayWidthWith(str, wide) {
    const s = String(str ?? '');
    const base = stringWidth(s);
    if (!wide)
        return base;
    let extra = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (isProblemCodePoint(cp) && stringWidth(ch) === 1)
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
