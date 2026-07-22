/**
 * src/tui/theme.mjs — active-theme runtime for the React/ink TUI.
 *
 * ink accepts `rgb(r,g,b)` strings directly on the `color`/`backgroundColor`
 * props, so palette values are plain strings (no escape wrapping needed — ink
 * emits the SGR and honors NO_COLOR/non-TTY itself).
 *
 * Palettes now live in `./themes/*.mjs`: `themes/base.mjs` holds the full
 * One Dark key set, each theme module spreads that base plus its overrides, and
 * `themes/index.mjs` wires them into THEME_REGISTRY / THEME_ORDER /
 * DEFAULT_THEME_ID. This module keeps only the runtime: the live singleton and
 * the switch/persistence/glyph logic.
 *
 * The exported `theme` is a SINGLETON object: every TUI module does
 * `import { theme } from '../theme.mjs'` and reads live keys off it. A theme
 * switch mutates this object in-place (`Object.assign(theme, palette)`) so the
 * existing imports observe the new colors without re-importing. A monotonic
 * `themeVersion` lets modules that cache derived values (chalk colorizers,
 * parsed RGB tuples) invalidate when the active theme changes.
 *
 * The setting persists under `ui.theme` in mixdog-config.json. The config
 * module is imported lazily through a dist-aware dynamic specifier (esbuild
 * leaves dynamic-import strings alone), so this color module stays free of a
 * static keychain/config dependency.
 */

import {
  THEME_REGISTRY,
  THEME_ORDER,
  THEME_ALIASES,
  DEFAULT_THEME_ID,
  basicPalette,
} from './themes/index.mjs';

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
      if (process.stdout && process.stdout.isTTY) process.stdout.write('\x1b]111\x07');
      return;
    }
    const hex = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    // OSC 11 ; rgb:RR/GG/BB  (BEL-terminated). Many terminals also accept #RRGGBB.
    const seq = `\x1b]11;rgb:${hex(m[1])}${hex(m[1])}/${hex(m[2])}${hex(m[2])}/${hex(m[3])}${hex(m[3])}\x07`;
    if (process.stdout && process.stdout.isTTY) process.stdout.write(seq);
  } catch { /* terminals that ignore OSC 11 are harmless */ }
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
 * Apply a theme by id. Unknown ids fall back to the default without throwing.
 * Persists `ui.theme` to mixdog-config.json unless `persist` is false.
 * Returns `{ id, label, description }` for the applied theme.
 */
export function setThemeSetting(id, { persist = true } = {}) {
  const entry = applyPalette(id);
  if (persist) void persistThemeSetting(entry.id);
  return { id: entry.id, label: entry.label, description: entry.description };
}

// ── Persistence (lazy, dist-aware) ──────────────────────────────────────────
const CONFIG_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../runtime/shared/config.mjs'
  : '../runtime/shared/config.mjs';
let _configModulePromise = null;
function loadConfigModule() {
  if (!_configModulePromise) _configModulePromise = import(CONFIG_MODULE);
  return _configModulePromise;
}

async function persistThemeSetting(id) {
  try {
    const { updateConfig } = await loadConfigModule();
    updateConfig((cfg) => {
      const ui = cfg && typeof cfg.ui === 'object' && cfg.ui ? cfg.ui : {};
      return { ...cfg, ui: { ...ui, theme: id } };
    });
  } catch {
    // Persistence is best-effort; a missing/locked config must never crash the TUI.
  }
}

/**
 * Read `ui.theme` from mixdog-config.json and apply it (no re-persist). Safe to
 * call once at boot; returns the resolved active id. Unknown/missing values
 * leave the default in place.
 */
export async function loadThemeSettingFromConfig() {
  try {
    const { readConfig } = await loadConfigModule();
    const cfg = readConfig() || {};
    const stored = cfg && cfg.ui && typeof cfg.ui === 'object' ? cfg.ui.theme : null;
    const storedKey = String(stored || '').trim();
    if (storedKey && (THEME_REGISTRY[storedKey] || THEME_ALIASES[storedKey])) {
      applyPalette(resolveThemeId(storedKey));
    }
  } catch {
    // Fall back to the already-applied default theme.
  }
  return _activeThemeId;
}

/* --- Glyphs --------------------------------------------------------------- */
import {
  BLACK_CIRCLE,
  RESULT_GUTTER_GLYPH,
  RESULT_GUTTER_CONT_GLYPH,
  RIGHT_ARROW,
  LEFT_ARROW,
} from './figures.mjs';

/** Turn marker — BLACK_CIRCLE (`⏺` on macOS; `●` elsewhere). */
export const TURN_MARKER = BLACK_CIRCLE;
/** Agent call marker — `←` (request going out to a sub-agent). */
export const AGENT_CALL_MARKER = LEFT_ARROW;
/** Agent response marker — `→` (result coming back in to the transcript). */
export const AGENT_RESPONSE_MARKER = RIGHT_ARROW;
/** Result-tree gutter — `└` (U+2514) padded to a 2-col hanging indent. */
export const RESULT_GUTTER = `  ${RESULT_GUTTER_GLYPH}  `;
/**
 * Continuation rail for every result row AFTER the first — `│` (U+2502) at the
 * same 2-col hanging indent so a multi-line tool result keeps a continuous left
 * rail under the `└` head. Same width/padding as RESULT_GUTTER so the body text
 * column never shifts between the first and following rows.
 */
export const RESULT_GUTTER_CONT = `  ${RESULT_GUTTER_CONT_GLYPH}  `;
