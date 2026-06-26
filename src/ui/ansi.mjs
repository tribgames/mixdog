/**
 * src/ui/ansi.mjs — tiny ANSI color/style helpers (zero deps).
 *
 * Philosophy: minimal. We write raw SGR escape sequences directly rather
 * than pull in chalk/kleur. Every helper is a `(text) => string` that wraps the
 * text in an escape pair and resets afterwards.
 *
 * Color is suppressed (helpers return the text unchanged) when EITHER:
 *   - the NO_COLOR env var is set (any value) — https://no-color.org, or
 *   - stdout is not a TTY (piped/redirected/CI) — `process.stdout.isTTY` falsy.
 *
 * The decision is computed once at import time but can be recomputed via
 * `refreshColorSupport()` (used by tests / when output is rebound).
 */
import { stdout, env } from 'node:process';

let COLOR_ENABLED = computeColorEnabled();

function computeColorEnabled() {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  // FORCE_COLOR overrides the TTY check (common in CI snapshots).
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== '') {
    return true;
  }
  return Boolean(stdout && stdout.isTTY);
}

/** Recompute color support (e.g. after env changes in tests). */
export function refreshColorSupport() {
  COLOR_ENABLED = computeColorEnabled();
  return COLOR_ENABLED;
}

/** Whether styling is currently active. */
export function colorEnabled() {
  return COLOR_ENABLED;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** Build a `(text) => string` wrapper for the given SGR open code(s). */
function sgr(open) {
  const openSeq = `${ESC}${open}m`;
  return (text) => {
    if (!COLOR_ENABLED) return String(text ?? '');
    const s = String(text ?? '');
    // Re-open after any nested reset so composed styles survive concatenation.
    return openSeq + s.replace(/\x1b\[0m/g, RESET + openSeq) + RESET;
  };
}

// --- Styles -----------------------------------------------------------------
export const bold = sgr('1');
export const dim = sgr('38;2;136;136;136');
export const italic = sgr('3');
export const underline = sgr('4');
export const inverse = sgr('7');
export const strike = sgr('9');

// --- Foreground colors ------------------------------------------------------
export const black = sgr('30');
export const red = sgr('38;2;220;70;88');
export const green = sgr('38;2;0;170;75');
export const yellow = sgr('38;2;255;193;7');
export const blue = sgr('38;2;77;159;255');
export const magenta = sgr('38;2;177;133;219');
export const cyan = sgr('38;2;136;136;136');
export const white = sgr('38;2;198;198;198');
export const gray = sgr('38;2;198;198;198');
export const grey = gray;

// Bright variants (used sparingly for headings / accents).
export const brightRed = sgr('38;2;220;70;88');
export const brightGreen = sgr('38;2;0;185;88');
export const brightYellow = sgr('38;2;255;210;80');
export const brightBlue = sgr('38;2;93;173;255');
export const brightMagenta = sgr('38;2;190;150;230');
export const brightCyan = sgr('38;2;168;168;168');
export const brightWhite = sgr('38;2;220;220;220');

// --- Background colors ------------------------------------------------------
export const bgGray = sgr('100');
export const bgBlack = sgr('40');
export const bgBlue = sgr('44');

// --- Truecolor (24-bit) -----------------------------------------------------
// Claude Code defines its palette as explicit rgb() values (refs/claude-code
// src/utils/theme.ts darkTheme). 16-color SGR can't reproduce them, so we emit
// 24-bit SGR. Honors NO_COLOR / TTY exactly like the named helpers above.

/** Foreground truecolor wrapper: `rgb(215,119,87)('x')`. */
export function rgb(r, g, b) {
  return sgr(`38;2;${r};${g};${b}`);
}

/** Background truecolor wrapper: `rgbBg(55,55,55)('x')`. */
export function rgbBg(r, g, b) {
  return sgr(`48;2;${r};${g};${b}`);
}

/** Strip every SGR escape from a string (for width math / non-TTY fallbacks). */
export function stripAnsi(text) {
  return String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible width of a string ignoring ANSI escapes (approx, 1 col/char). */
export function visibleWidth(text) {
  return stripAnsi(text).length;
}

/** Compose multiple style fns left-to-right: compose(bold, red)('x'). */
export function compose(...fns) {
  return (text) => fns.reduceRight((acc, fn) => fn(acc), String(text ?? ''));
}
