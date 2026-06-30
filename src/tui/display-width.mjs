/**
 * display-width.mjs — shared visible display-width helper for the assistant
 * render path.
 *
 * Why this exists: string-width@8 defaults East-Asian-Width "Ambiguous" glyphs
 * to NARROW (1 cell). A specific, common problem set renders 2 cells wide in
 * Windows Terminal — circled digits / enclosed alphanumerics (U+2460–U+24FF)
 * and arrows (U+2190–U+21FF). When our width math counts them as 1 but the
 * terminal draws 2, following text overlaps.
 *
 * Policy (narrow + gated + consistent):
 *   - Widen ONLY the two problem ranges below. NEVER widen box-drawing
 *     (U+2500–U+257F └ │ ⎿ ─), block elements, or the figures.mjs glyphs —
 *     those are also EAW-ambiguous but must stay 1 cell.
 *   - Enabled by default ONLY under Windows Terminal (WT_SESSION set).
 *   - MIXDOG_TUI_AMBIGUOUS_WIDE overrides the default: '1' forces on, '0'
 *     forces off; the override always wins.
 *   - When OFF, behaviour is byte-for-byte identical to plain string-width.
 *
 * IMPORTANT: vendor/ink/build/display-width.js replicates this exact policy so
 * ink's MEASUREMENT agrees with OUR wrap/row math. If you change the ranges or
 * the gate here, change them THERE too (see the sync note in that file).
 */
import stringWidth from 'string-width';

/**
 * True for code points we treat as wide (2 cells) when the policy is ON:
 *   - U+2460–U+24FF Enclosed Alphanumerics (① ② ③ …)
 *   - U+2190–U+21FF Arrows (→ ← ↑ ↓ …)
 * Deliberately excludes box-drawing / blocks / figures.
 */
export function isProblemCodePoint(cp) {
  return (cp >= 0x2460 && cp <= 0x24ff) || (cp >= 0x2190 && cp <= 0x21ff);
}

/** Resolve the wide policy from env. Override wins over the WT_SESSION default. */
export function resolveAmbiguousWidePolicy(env = process.env) {
  const override = env?.MIXDOG_TUI_AMBIGUOUS_WIDE;
  if (override === '1') return true;
  if (override === '0') return false;
  return Boolean(env?.WT_SESSION);
}

/** Resolved once at module load (matches the "computed once" requirement). */
export const AMBIGUOUS_WIDE = resolveAmbiguousWidePolicy();

/**
 * Pure width with an explicit policy flag (used by tests and by `displayWidth`).
 * base = string-width (ANSI-aware). When `wide` is on, add +1 for each problem
 * code point that string-width counted as a single cell, turning it into 2.
 * ANSI escape bytes are all ASCII and never fall in the problem ranges, so the
 * raw code-point scan adds nothing for them.
 */
export function displayWidthWith(str, wide) {
  const s = String(str ?? '');
  const base = stringWidth(s);
  if (!wide) return base;
  let extra = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (isProblemCodePoint(cp) && stringWidth(ch) === 1) extra += 1;
  }
  return base + extra;
}

/** Visible display width under the resolved policy. */
export function displayWidth(str) {
  return displayWidthWith(str, AMBIGUOUS_WIDE);
}
