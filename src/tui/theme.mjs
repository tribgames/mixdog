// readStoredThemeSetting lives in theme-config.mjs, not here: the desktop renderer imports this module without Node's fs.

import { THEME_REGISTRY, THEME_ORDER, THEME_ALIASES, DEFAULT_THEME_ID, basicPalette } from './themes/index.mjs';
import { BLACK_CIRCLE, RESULT_GUTTER_GLYPH, RESULT_GUTTER_CONT_GLYPH, RIGHT_ARROW, LEFT_ARROW } from './figures.mjs';

/**
 * Live singleton consumed across the TUI. Seeded with the default palette and
 * mutated in-place by `applyPalette()` so `import { theme }` references stay
 * valid after a theme switch.
 */
export const theme = { ...basicPalette };

let _activeThemeId = DEFAULT_THEME_ID;
let _themeVersion = 0;

/** Monotonic counter bumped on every theme switch (cache-invalidation key). */
export function getThemeVersion() {
  return _themeVersion;
}

/** Active theme id (e.g. 'onedark'). */
export function getThemeSetting() {
  return _activeThemeId;
}

/** Coerce any value to a known theme id, falling back to the default. */
function resolveThemeId(id) {
  const key = String(id || '').trim();
  if (THEME_ALIASES[key] && THEME_REGISTRY[THEME_ALIASES[key]]) return THEME_ALIASES[key];
  return THEME_REGISTRY[key] ? key : DEFAULT_THEME_ID;
}

/** Picker-ready metadata for every theme, in display order. */
export function listThemes() {
  return THEME_ORDER.filter((id) => THEME_REGISTRY[id]).map((id) => {
    const entry = THEME_REGISTRY[id];
    return {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      current: entry.id === _activeThemeId,
    };
  });
}

/**
 * Paintable Box background.
 *
 * Keep this disabled by default: applying a full-screen Box background makes
 * every descendant Text inherit that background through Ink's BackgroundContext,
 * which is fragile with nested/ANSI-heavy output and can destabilize theme
 * switching on some terminals. Themes may still set `background` for terminal
 * OSC 11 (`emitTerminalBackground`) and for future opt-in surfaces, but the TUI
 * itself stays transparent unless explicitly allowed.
 */
export function surfaceBackground() {
  if (theme.paintSurfaceBackground !== true) return undefined;
  return /^rgb\(\d+,\s*\d+,\s*\d+\)$/.test(String(theme.background || '')) ? theme.background : undefined;
}

export function emitTerminalBackground(rgbString) {
  try {
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(rgbString || '').replace(/\s+/g, ''));
    if (!m) {
      if (process.stdout?.isTTY) process.stdout.write('\x1b]111\x07');
      return;
    }
    const hex = (n) =>
      Math.max(0, Math.min(255, Number(n)))
        .toString(16)
        .padStart(2, '0');
    // OSC 11 ; rgb:RR/GG/BB  (BEL-terminated). Many terminals also accept #RRGGBB.
    const seq = `\x1b]11;rgb:${hex(m[1])}${hex(m[1])}/${hex(m[2])}${hex(m[2])}/${hex(m[3])}${hex(m[3])}\x07`;
    if (process.stdout?.isTTY) process.stdout.write(seq);
  } catch {
    /* terminals that ignore OSC 11 are harmless */
  }
}

function applyPalette(id) {
  const entry = THEME_REGISTRY[resolveThemeId(id)];
  Object.assign(theme, entry.palette);
  _activeThemeId = entry.id;
  _themeVersion += 1;
  emitTerminalBackground(theme.background);
  return entry;
}

/**
 * Apply a theme by id to this process's palette. Unknown ids fall back to the default without
 * throwing. The stored `ui.theme` belongs to the core: a caller that persists asks the core
 * (`config/setTheme`) itself. Returns `{ id, label, description }` for the applied theme.
 */
export function setThemeSetting(id) {
  const entry = applyPalette(id);
  return { id: entry.id, label: entry.label, description: entry.description };
}

/**
 * Apply a stored theme id (`readStoredThemeSetting`) at boot. Unknown/missing values leave the
 * default in place; returns the resolved active id.
 */
export function applyStoredThemeSetting(stored) {
  const storedKey = String(stored || '').trim();
  if (storedKey && (THEME_REGISTRY[storedKey] || THEME_ALIASES[storedKey])) {
    applyPalette(resolveThemeId(storedKey));
  }
  return _activeThemeId;
}

/* --- Glyphs --------------------------------------------------------------- */

/** Turn marker — BLACK_CIRCLE (`⏺` on macOS; `●` elsewhere). */
export const TURN_MARKER = BLACK_CIRCLE;
/** Agent call marker — `←` (request going out to a sub-agent). */
export const AGENT_CALL_MARKER = LEFT_ARROW;
/** Agent response marker — `→` (result coming back in to the transcript). */
export const AGENT_RESPONSE_MARKER = RIGHT_ARROW;
/** Result-tree gutter — `└` (U+2514) padded to a 2-col hanging indent. */
export const RESULT_GUTTER = `  ${RESULT_GUTTER_GLYPH}  `;
export const RESULT_GUTTER_CONT = `  ${RESULT_GUTTER_CONT_GLYPH}  `;
