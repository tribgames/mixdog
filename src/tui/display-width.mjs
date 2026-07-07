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
 *   - Enabled by default on Windows (process.platform === 'win32') or under
 *     Windows Terminal (WT_SESSION set — covers WT reached via e.g. SSH from
 *     a non-Windows host).
 *   - MIXDOG_TUI_AMBIGUOUS_WIDE overrides the default: '1' forces on, '0'
 *     forces off; the override always wins.
 *   - When OFF, behaviour is byte-for-byte identical to plain string-width.
 *
 * IMPORTANT: vendor/ink/build/display-width.js replicates this exact policy so
 * ink's MEASUREMENT agrees with OUR wrap/row math. If you change the ranges or
 * the gate here, change them THERE too (see the sync note in that file).
 */
import stringWidth from 'string-width';

// Grapheme segmenter for cluster-aware width math (e.g. `↔️` = U+2194 U+FE0F
// is one cluster, counted once). Kept identical to vendor/ink/build/display-width.js.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * True for code points we treat as wide (2 cells) when the policy is ON:
 *   - U+2460–U+24FF Enclosed Alphanumerics (① ② ③ …)
 *   - U+2194–U+21FF Arrows (↔ ⇒ ⇧ …)
 * Deliberately excludes box-drawing / blocks / figures — including the four
 * Basic Arrows U+2190–U+2193 (← ↑ → ↓) that figures.mjs uses as 1-cell
 * markers (agent card ←/→, history ↑/↓): WT draws them 1 cell in
 * Cascadia, and widening them ate the marker's gutter padding space
 * ("←Spawn" rendered glued / shifted vs the ● rows).
 */
export function isProblemCodePoint(cp) {
  return (cp >= 0x2460 && cp <= 0x24ff) || (cp >= 0x2194 && cp <= 0x21ff);
}

// Fast precheck for the problem ranges above. Lets the hot path bail before
// the per-grapheme segmenter loop when a string (the overwhelmingly common
// ASCII/status-text case) contains no widenable glyph. Kept identical to
// vendor/ink/build/display-width.js.
const PROBLEM_RE = /[\u2194-\u21ff\u2460-\u24ff]/;

/**
 * Resolve the wide policy from env. Override wins over the default; the
 * default is ON on Windows (WT_SESSION does not reliably propagate to child
 * processes, so gate on the OS itself) or when WT_SESSION is present.
 */
export function resolveAmbiguousWidePolicy(env = process.env, platform = process.platform) {
  const override = env?.MIXDOG_TUI_AMBIGUOUS_WIDE;
  if (override === '1') return true;
  if (override === '0') return false;
  return platform === 'win32' || Boolean(env?.WT_SESSION);
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
  // Fast bail: no problem glyph ⇒ segmenting can only return `base`.
  if (!PROBLEM_RE.test(s)) return base;
  let extra = 0;
  // Widen per GRAPHEME CLUSTER, not per code point: a clustered glyph like
  // `↔️` (U+2194 U+FE0F) is one visible cell-group — count its problem base
  // once. Only add +1 when the WHOLE cluster still measures 1 cell under
  // string-width (so a cluster the terminal already draws as 2 isn't
  // double-widened).
  for (const { segment } of graphemeSegmenter.segment(s)) {
    const cp = segment.codePointAt(0);
    if (isProblemCodePoint(cp) && stringWidth(segment) === 1) extra += 1;
  }
  return base + extra;
}

/** Visible display width under the resolved policy. */
export function displayWidth(str) {
  return displayWidthWith(str, AMBIGUOUS_WIDE);
}
