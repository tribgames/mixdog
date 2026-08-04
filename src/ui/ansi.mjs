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
import { stdout, env, platform } from 'node:process';

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

/**
 * Whether the terminal can render 24-bit SGR colors.
 *
 * Apple Terminal is the one explicit negative because it advertises a normal
 * xterm TERM while not implementing truecolor. Unknown terminals retain the
 * historical truecolor default.
 */
export function supportsTruecolor(environment = env, platformName = platform) {
  const termProgram = String(environment?.TERM_PROGRAM || '').trim().toLowerCase();
  if (termProgram === 'apple_terminal') return false;

  const colorTerm = String(environment?.COLORTERM || '').trim().toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return true;
  if (environment?.WT_SESSION !== undefined && environment.WT_SESSION !== '') return true;
  if (['iterm.app', 'wezterm', 'ghostty', 'vscode'].includes(termProgram)) return true;
  if (/(?:direct|truecolor)/i.test(String(environment?.TERM || ''))) return true;
  if (platformName === 'win32') return true;
  return true;
}

const ANSI_256_CUBE_LEVELS = Object.freeze([0, 95, 135, 175, 215, 255]);

function colorByte(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0;
}

function nearestCubeLevel(value) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ANSI_256_CUBE_LEVELS.length; i++) {
    const distance = Math.abs(value - ANSI_256_CUBE_LEVELS[i]);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/** Convert an RGB triplet to the nearest stable xterm 256-color palette index. */
export function rgbToAnsi256(r, g, b) {
  const red = colorByte(r);
  const green = colorByte(g);
  const blue = colorByte(b);

  const redLevel = nearestCubeLevel(red);
  const greenLevel = nearestCubeLevel(green);
  const blueLevel = nearestCubeLevel(blue);
  const cubeRed = ANSI_256_CUBE_LEVELS[redLevel];
  const cubeGreen = ANSI_256_CUBE_LEVELS[greenLevel];
  const cubeBlue = ANSI_256_CUBE_LEVELS[blueLevel];
  const cubeDistance = ((red - cubeRed) ** 2)
    + ((green - cubeGreen) ** 2)
    + ((blue - cubeBlue) ** 2);

  const average = (red + green + blue) / 3;
  const grayLevel = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const grayValue = 8 + (grayLevel * 10);
  const grayDistance = ((red - grayValue) ** 2)
    + ((green - grayValue) ** 2)
    + ((blue - grayValue) ** 2);

  if (grayDistance < cubeDistance) return 232 + grayLevel;
  return 16 + (36 * redLevel) + (6 * greenLevel) + blueLevel;
}

/** Raw RGB SGR prefix, downsampled to 256 colors when truecolor is unavailable. */
export function rgbSgr(r, g, b, background = false) {
  const channel = background ? 48 : 38;
  if (supportsTruecolor()) return `${ESC}${channel};2;${r};${g};${b}m`;
  return `${ESC}${channel};5;${rgbToAnsi256(r, g, b)}m`;
}

function supportedSgrOpen(open) {
  const match = /^(38|48);2;([^;]+);([^;]+);([^;]+)$/.exec(String(open));
  if (!match || supportsTruecolor()) return open;
  return `${match[1]};5;${rgbToAnsi256(match[2], match[3], match[4])}`;
}

/** Build a `(text) => string` wrapper for the given SGR open code(s). */
function sgr(open) {
  return (text) => {
    if (!COLOR_ENABLED) return String(text ?? '');
    const s = String(text ?? '');
    const openSeq = `${ESC}${supportedSgrOpen(open)}m`;
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
export const brightGreen = sgr('38;2;0;185;88');

// --- Background colors ------------------------------------------------------

// --- RGB colors --------------------------------------------------------------
// Emit 24-bit SGR where supported, otherwise use the nearest 256-color entry.
// Honors NO_COLOR / TTY exactly like the named helpers above.

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
