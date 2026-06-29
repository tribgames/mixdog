/**
 * src/tui/theme.mjs — active-theme registry for the React/ink TUI.
 *
 * ink accepts `rgb(r,g,b)` strings directly on the `color`/`backgroundColor`
 * props, so these are plain strings (no escape wrapping needed — ink emits the
 * SGR and honors NO_COLOR/non-TTY itself).
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

// ── Palettes ──────────────────────────────────────────────────────────────
// Each palette is a COMPLETE set of theme keys. Non-default palettes spread the
// Mixdog base first so a missing key can never leak the previous theme's color
// through Object.assign.

/** Default Mixdog dark palette (preserves the original colors verbatim). */
const mixdogPalette = {
  background: 'rgb(13,13,13)', // opaque TUI surface; masks clipped scrollback behind fixed rows
  claude: 'rgb(215,119,87)', // orange title/header accent
  claudeShimmer: 'rgb(235,159,127)',
  mixdogOrange: 'rgb(215,119,87)',
  mixdogAmber: 'rgb(235,159,127)',
  mixdogIvory: 'rgb(232,226,215)',
  spinnerGlyph: 'rgb(215,119,87)',
  spinnerText: 'rgb(215,119,87)',
  spinnerShimmer: 'rgb(255,214,186)',
  thinkingAccent: 'rgb(168,168,168)',
  thinkingText: 'rgb(198,198,198)', // live reasoning body text
  thinkingBase: 'rgb(168,168,168)',  // quiet base; thinking rows should not compete with answers
  thinkingGlow: 'rgb(220,220,220)', // subtle highlight for the thinking shimmer
  statusText: 'rgb(198,198,198)',
  statusSubtle: 'rgb(168,168,168)',
  timerText: 'rgb(168,168,168)', // live elapsed timer — metadata weight, no bright accent
  text: 'rgb(198,198,198)', // primary text
  inverseText: 'rgb(0,0,0)', // text on an inverted (light) background
  inactive: 'rgb(136,136,136)', // secondary text
  subtle: 'rgb(140,140,140)', // helper text / quiet rules
  promptBorder: 'rgb(158,158,158)', // input border / prompt
  success: 'rgb(28,150,78)', // muted green accent
  error: 'rgb(210,60,76)', // muted red accent
  warning: 'rgb(204,157,44)', // muted amber
  suggestion: 'rgb(47,127,255)', // path/link blue
  panelTitle: 'rgb(215,119,87)', // panel/picker titles stay orange
  permission: 'rgb(239,68,88)', // permission red
  code: 'rgb(47,127,255)', // inline code/link accent
  codeBlock: 'rgb(136,190,142)', // code block body
  // Markdown (pi dark.json md* tokens — headings/code/quotes only in format-token)
  mdHeading: 'rgb(240,198,116)', // #f0c674 warm yellow-beige
  mdCode: 'rgb(138,190,183)', // #8abeb7 muted teal (inline codespan)
  mdCodeBlock: 'rgb(181,189,104)', // #b5bd68 muted green (fenced blocks)
  mdQuote: 'rgb(128,128,128)', // #808080 quote body
  mdQuoteBorder: 'rgb(128,128,128)', // blockquote bar
  mdHr: 'rgb(128,128,128)', // horizontal rule
  mdListBullet: 'rgb(138,190,183)', // list markers (pi accent)
  // Markdown extras (fenced fences / inline links / emphasis) — warm dark base.
  mdCodeBlockBorder: 'rgb(110,110,110)', // ``` fence + lang label rule
  mdLink: 'rgb(47,127,255)', // link URL (suggestion blue)
  mdLinkText: 'rgb(138,190,183)', // link label (teal accent)
  mdStrong: 'rgb(235,159,127)', // **bold** warm amber
  mdEmph: 'rgb(229,192,123)', // *italic* soft yellow
  // Diff / patch rendering (OpenCode + Codex conventions, ANSI-safe).
  mdDiffAdded: 'rgb(120,200,130)', // + lines (green)
  mdDiffRemoved: 'rgb(224,108,117)', // - lines (red)
  mdDiffHunk: 'rgb(130,139,184)', // @@ hunk markers
  mdDiffHeader: 'rgb(170,150,210)', // ---/+++ / diff --git headers
  mdDiffContext: 'rgb(140,140,140)', // unchanged context lines
  mdDiffAddedBg: 'rgb(33,58,43)', // #213A2B muted add tint (codex dark)
  mdDiffRemovedBg: 'rgb(74,34,29)', // #4A221D muted del tint (codex dark)
  // Lightweight syntax highlight palette (regex token classes).
  syntaxComment: 'rgb(128,128,128)',
  syntaxKeyword: 'rgb(215,119,87)', // brand orange
  syntaxFunction: 'rgb(138,190,183)', // teal
  syntaxVariable: 'rgb(224,108,117)', // red-pink
  syntaxString: 'rgb(181,189,104)', // #b5bd68 green
  syntaxNumber: 'rgb(235,159,127)', // amber
  syntaxType: 'rgb(229,192,123)', // yellow
  syntaxOperator: 'rgb(138,190,183)', // teal/cyan
  syntaxPunctuation: 'rgb(198,198,198)', // body text
  userMessageBackground: 'rgb(108,108,108)', // user prompt band
  userMessageBackgroundHover: 'rgb(120,120,120)', // hover variant
  fastMode: 'rgb(255,120,20)',
};

/** Pi dark — earendil-works/pi interactive dark.json (teal accent, soft body). */
const piDarkPalette = {
  ...mixdogPalette,
  claude: 'rgb(138,190,183)', // pi accent teal as the title/header accent
  claudeShimmer: 'rgb(170,214,208)',
  spinnerGlyph: 'rgb(138,190,183)',
  spinnerText: 'rgb(138,190,183)',
  spinnerShimmer: 'rgb(170,214,208)',
  panelTitle: 'rgb(138,190,183)',
  thinkingText: 'rgb(190,190,190)',
  statusText: 'rgb(212,212,212)',
  text: 'rgb(212,212,212)', // #d4d4d4
  promptBorder: 'rgb(120,128,140)',
  success: 'rgb(181,189,104)', // #b5bd68
  error: 'rgb(204,102,102)', // #cc6666
  warning: 'rgb(255,255,0)', // #ffff00
  suggestion: 'rgb(95,135,255)', // #5f87ff
  permission: 'rgb(204,102,102)',
  code: 'rgb(95,135,255)',
  codeBlock: 'rgb(181,189,104)',
  mdCodeBlockBorder: 'rgb(96,104,116)',
  mdLink: 'rgb(95,135,255)',
  mdLinkText: 'rgb(138,190,183)',
  mdStrong: 'rgb(181,189,104)',
  mdEmph: 'rgb(229,192,123)',
  mdDiffAdded: 'rgb(181,189,104)', // #b5bd68
  mdDiffRemoved: 'rgb(204,102,102)', // #cc6666
  mdDiffHunk: 'rgb(129,162,190)',
  mdDiffHeader: 'rgb(178,148,187)',
  mdDiffContext: 'rgb(150,150,150)',
  mdDiffAddedBg: 'rgb(30,46,34)',
  mdDiffRemovedBg: 'rgb(58,32,32)',
  syntaxKeyword: 'rgb(178,148,187)', // pi mauve keyword
  syntaxFunction: 'rgb(129,162,190)', // soft blue
  syntaxString: 'rgb(181,189,104)',
  syntaxNumber: 'rgb(222,147,95)',
  syntaxOperator: 'rgb(138,190,183)',
  userMessageBackground: 'rgb(52,53,65)', // #343541
  userMessageBackgroundHover: 'rgb(64,65,79)',
};

/** Claude dark — Claude Code darkTheme RGB values (orange brand, white body). */
const claudeDarkPalette = {
  ...mixdogPalette,
  background: 'rgb(13,13,13)', // keep the opaque dark surface (Claude's bg is decorative)
  claude: 'rgb(215,119,87)',
  claudeShimmer: 'rgb(235,159,127)',
  spinnerGlyph: 'rgb(215,119,87)',
  spinnerText: 'rgb(215,119,87)',
  spinnerShimmer: 'rgb(255,214,186)',
  panelTitle: 'rgb(215,119,87)',
  text: 'rgb(235,235,235)',
  thinkingText: 'rgb(200,200,200)',
  thinkingBase: 'rgb(153,153,153)',
  thinkingGlow: 'rgb(225,225,225)',
  statusText: 'rgb(220,220,220)',
  statusSubtle: 'rgb(150,150,150)',
  timerText: 'rgb(150,150,150)',
  inactive: 'rgb(153,153,153)',
  subtle: 'rgb(120,120,120)',
  promptBorder: 'rgb(136,136,136)',
  success: 'rgb(78,186,101)',
  error: 'rgb(255,107,128)',
  warning: 'rgb(255,193,7)',
  suggestion: 'rgb(177,185,249)', // blue-purple
  permission: 'rgb(177,185,249)',
  code: 'rgb(177,185,249)',
  codeBlock: 'rgb(200,200,200)', // plain code body (no brand coloring)
  mdHeading: 'rgb(235,159,127)', // warm heading accent
  mdCode: 'rgb(177,185,249)', // inline codespan = permission/suggestion blue-purple
  mdCodeBlock: 'rgb(200,200,200)', // fenced blocks stay plain
  mdQuote: 'rgb(140,140,140)',
  mdQuoteBorder: 'rgb(140,140,140)',
  mdHr: 'rgb(140,140,140)',
  mdListBullet: 'rgb(177,185,249)',
  mdCodeBlockBorder: 'rgb(120,120,120)',
  mdLink: 'rgb(177,185,249)',
  mdLinkText: 'rgb(150,200,210)',
  mdStrong: 'rgb(235,159,127)',
  mdEmph: 'rgb(229,192,123)',
  mdDiffAdded: 'rgb(78,186,101)',
  mdDiffRemoved: 'rgb(255,107,128)',
  mdDiffHunk: 'rgb(150,160,200)',
  mdDiffHeader: 'rgb(177,185,249)',
  mdDiffContext: 'rgb(150,150,150)',
  mdDiffAddedBg: 'rgb(28,46,34)',
  mdDiffRemovedBg: 'rgb(58,30,36)',
  syntaxComment: 'rgb(140,140,140)',
  syntaxKeyword: 'rgb(235,159,127)',
  syntaxFunction: 'rgb(177,185,249)',
  syntaxVariable: 'rgb(255,107,128)',
  syntaxString: 'rgb(140,200,150)',
  syntaxNumber: 'rgb(235,159,127)',
  syntaxType: 'rgb(229,192,123)',
  syntaxOperator: 'rgb(150,200,210)',
  syntaxPunctuation: 'rgb(220,220,220)',
  userMessageBackground: 'rgb(55,55,55)',
  userMessageBackgroundHover: 'rgb(70,70,70)',
  fastMode: 'rgb(255,120,20)',
};

/** Claude light — Claude Code lightTheme RGB values (black body, light surface). */
const claudeLightPalette = {
  ...mixdogPalette,
  background: 'rgb(250,250,250)', // light opaque surface
  claude: 'rgb(215,119,87)',
  claudeShimmer: 'rgb(245,149,117)',
  spinnerGlyph: 'rgb(215,119,87)',
  spinnerText: 'rgb(215,119,87)',
  spinnerShimmer: 'rgb(245,149,117)',
  panelTitle: 'rgb(215,119,87)',
  text: 'rgb(0,0,0)',
  inverseText: 'rgb(255,255,255)',
  thinkingText: 'rgb(80,80,80)',
  thinkingAccent: 'rgb(120,120,120)',
  thinkingBase: 'rgb(120,120,120)',
  thinkingGlow: 'rgb(40,40,40)',
  statusText: 'rgb(40,40,40)',
  statusSubtle: 'rgb(102,102,102)',
  timerText: 'rgb(102,102,102)',
  inactive: 'rgb(102,102,102)',
  subtle: 'rgb(175,175,175)',
  promptBorder: 'rgb(153,153,153)',
  success: 'rgb(44,122,57)',
  error: 'rgb(171,43,63)',
  warning: 'rgb(150,108,30)',
  suggestion: 'rgb(87,105,247)',
  permission: 'rgb(87,105,247)',
  code: 'rgb(87,105,247)',
  codeBlock: 'rgb(30,30,30)',
  mdHeading: 'rgb(150,108,30)',
  mdCode: 'rgb(87,105,247)',
  mdCodeBlock: 'rgb(30,30,30)', // plain, readable on a light surface
  mdQuote: 'rgb(102,102,102)',
  mdQuoteBorder: 'rgb(102,102,102)',
  mdHr: 'rgb(175,175,175)',
  mdListBullet: 'rgb(87,105,247)',
  mdCodeBlockBorder: 'rgb(184,184,184)',
  mdLink: 'rgb(87,105,247)',
  mdLinkText: 'rgb(49,135,149)', // teal-cyan readable on light
  mdStrong: 'rgb(214,108,39)', // warm orange
  mdEmph: 'rgb(176,133,31)', // amber
  mdDiffAdded: 'rgb(61,154,87)', // #3d9a57
  mdDiffRemoved: 'rgb(209,56,61)', // #d1383d
  mdDiffHunk: 'rgb(112,134,181)', // #7086b5
  mdDiffHeader: 'rgb(123,91,182)', // #7b5bb6
  mdDiffContext: 'rgb(102,102,102)',
  mdDiffAddedBg: 'rgb(218,251,225)', // #dafbe1
  mdDiffRemovedBg: 'rgb(255,235,233)', // #ffebe9
  syntaxComment: 'rgb(138,138,138)',
  syntaxKeyword: 'rgb(201,77,36)', // #c94d24
  syntaxFunction: 'rgb(59,125,216)', // #3b7dd8
  syntaxVariable: 'rgb(209,56,61)',
  syntaxString: 'rgb(61,154,87)',
  syntaxNumber: 'rgb(176,133,31)',
  syntaxType: 'rgb(176,133,31)',
  syntaxOperator: 'rgb(49,135,149)',
  syntaxPunctuation: 'rgb(26,26,26)',
  userMessageBackground: 'rgb(238,238,238)',
  userMessageBackgroundHover: 'rgb(248,248,248)',
  fastMode: 'rgb(255,106,0)',
};

// ── Registry / metadata ─────────────────────────────────────────────────────
const THEME_REGISTRY = {
  mixdog: { id: 'mixdog', label: 'Mixdog dark', description: 'Default Mixdog palette — warm dark with teal markdown.', palette: mixdogPalette },
  'pi-dark': { id: 'pi-dark', label: 'Pi dark', description: 'earendil-works/pi dark — teal accent, soft body text.', palette: piDarkPalette },
  'claude-dark': { id: 'claude-dark', label: 'Claude dark', description: 'Claude Code dark — orange brand, bright body text.', palette: claudeDarkPalette },
  'claude-light': { id: 'claude-light', label: 'Claude light', description: 'Claude Code light — black body on a light surface.', palette: claudeLightPalette },
};

const DEFAULT_THEME_ID = 'mixdog';
const THEME_ORDER = ['mixdog', 'pi-dark', 'claude-dark', 'claude-light'];

/**
 * Live singleton consumed across the TUI. Seeded with the default palette and
 * mutated in-place by `applyPalette()` so `import { theme }` references stay
 * valid after a theme switch.
 */
export const theme = { ...mixdogPalette };

let _activeThemeId = DEFAULT_THEME_ID;
let _themeVersion = 0;

/** Monotonic counter bumped on every theme switch (cache-invalidation key). */
export function getThemeVersion() {
  return _themeVersion;
}

/** Active theme id (e.g. 'mixdog'). */
export function getThemeSetting() {
  return _activeThemeId;
}

/** Coerce any value to a known theme id, falling back to the default. */
export function resolveThemeId(id) {
  const key = String(id || '').trim();
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

function applyPalette(id) {
  const entry = THEME_REGISTRY[resolveThemeId(id)];
  Object.assign(theme, entry.palette);
  _activeThemeId = entry.id;
  _themeVersion += 1;
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
    if (stored && THEME_REGISTRY[resolveThemeId(stored)] && resolveThemeId(stored) === String(stored)) {
      applyPalette(stored);
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
} from './figures.mjs';

/** Turn marker — BLACK_CIRCLE (`⏺` on macOS; `●` elsewhere). */
export const TURN_MARKER = BLACK_CIRCLE;
/** Result-tree gutter — `⎿`, ASCII only when requested. */
export const RESULT_GUTTER = `  ${RESULT_GUTTER_GLYPH}  `;
