/**
 * src/tui/themes/utils.mjs — palette post-processing helpers.
 *
 * Reference pattern (Claude Code / opencode / pi):
 * - keep body text neutral and highly readable;
 * - keep strong live-state colors for spinners/status;
 * - use accent colors sparingly for headings, links and syntax, preferably
 *   muted/desaturated enough for long coding sessions.
 *
 * Theme modules still define their full, expressive palettes. The registry runs
 * them through `softenTypographyColors()` so text-bearing accent roles are a
 * little less saturated without flattening each theme's signature color.
 */

const RGB_RE = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;

const SOFTEN_KEYS = [
  'mdHeading',
  'code',
  'mdLink',
  'mdLinkText',
  'mdStrong',
  'mdEmph',
  'mdDiffHunk',
  'mdDiffHeader',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
];

// Inline codespan (`emphasis`). Kept only lightly muted with a FIXED small
// amount instead of the saturation-scaled soften, so accented inline code reads
// a touch brighter/livelier instead of graying out on long sessions.
const ACCENT_SOFTEN_KEYS = [
  'mdCode',
];
const ACCENT_SOFTEN_AMOUNT = 0.14;

const SUBTLE_SOFTEN_KEYS = [
  'mdListBullet',
];

const UI_SOFTEN_KEYS = [
  'panelTitle',
];

function parseRgb(value) {
  const m = RGB_RE.exec(String(value || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function rgbString(rgb) {
  return `rgb(${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(',')})`;
}

function mix(a, b, amount) {
  return a.map((v, i) => v + (b[i] - v) * amount);
}

function saturation([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

function softenAmount(rgb, base = 0.05) {
  const s = saturation(rgb);
  if (s >= 0.85) return base + 0.20;
  if (s >= 0.65) return base + 0.15;
  if (s >= 0.45) return base + 0.10;
  if (s >= 0.25) return base + 0.06;
  return base + 0.02;
}

function softenKey(out, key, target, baseAmount = 0.08) {
  const rgb = parseRgb(out[key]);
  if (!rgb || !target) return;
  out[key] = rgbString(mix(rgb, target, softenAmount(rgb, baseAmount)));
}

function softenKeyFixed(out, key, target, amount) {
  const rgb = parseRgb(out[key]);
  if (!rgb || !target) return;
  out[key] = rgbString(mix(rgb, target, amount));
}

export function softenTypographyColors(palette) {
  const out = { ...palette };
  const text = parseRgb(out.text) || parseRgb(out.mdCodeBlock) || parseRgb(out.statusText);
  const subtle = parseRgb(out.subtle) || parseRgb(out.inactive) || text;
  if (!text) return out;
  const neutralText = subtle ? mix(text, subtle, 0.26) : text;

  for (const key of SOFTEN_KEYS) softenKey(out, key, neutralText, 0.06);
  for (const key of ACCENT_SOFTEN_KEYS) softenKeyFixed(out, key, neutralText, ACCENT_SOFTEN_AMOUNT);
  for (const key of SUBTLE_SOFTEN_KEYS) softenKey(out, key, subtle || neutralText, 0.22);
  for (const key of UI_SOFTEN_KEYS) softenKey(out, key, neutralText, 0.05);
  return out;
}
