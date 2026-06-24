/**
 * src/tui/theme.mjs — Claude Code dark palette for the React/ink TUI.
 *
 * Colors follow refs/claude-code/src/utils/theme.ts (darkTheme), with the
 * body marker softened slightly for Windows Terminal rendering.
 * ink accepts `rgb(r,g,b)` strings directly on the `color`/`backgroundColor`
 * props, so these are plain strings (no escape wrapping needed — ink emits the
 * SGR and honors NO_COLOR/non-TTY itself).
 *
 * Dark-fixed for now (terminal background detection can pick light later).
 */
export const theme = {
  claude: 'rgb(215,119,87)', // brand orange — turn markers, accents
  claudeShimmer: 'rgb(235,159,127)',
  text: 'rgb(240,240,240)', // body text — soft white. Pure #fff (truecolor) renders heavy/bold-bright in Windows Terminal; a touch below white reads at normal weight while staying bright. Nudged 230→240 for a slightly brighter look without tripping the bold render.
  inverseText: 'rgb(0,0,0)', // text on an inverted (light) background
  inactive: 'rgb(153,153,153)', // secondary gray
  subtle: 'rgb(80,80,80)', // borders / rules
  promptBorder: 'rgb(136,136,136)', // input border / prompt
  success: 'rgb(78,186,101)', // green
  error: 'rgb(255,107,128)', // red
  warning: 'rgb(255,193,7)', // amber
  suggestion: 'rgb(177,185,249)', // CC darkTheme suggestion (light blue-purple)
  permission: 'rgb(177,185,249)', // CC darkTheme permission
  code: 'rgb(177,185,249)', // inline code accent = CC permission
  codeBlock: 'rgb(56,166,96)', // code block body (medium green)
  userMessageBackground: 'rgb(55,55,55)', // user bubble background (CC darkTheme)
  userMessageBackgroundHover: 'rgb(70,70,70)', // hover variant (CC darkTheme)
  fastMode: 'rgb(255,120,20)',
};

/* --- Glyphs (refs/claude-code/src/constants/figures.ts) ------------------- */
import {
  BLACK_CIRCLE,
  POINTER,
  EFFORT_LOW,
  EFFORT_MEDIUM,
  EFFORT_HIGH,
  EFFORT_MAX,
} from './figures.mjs';

/** Turn marker — CC BLACK_CIRCLE (`⏺` on macOS; `●` elsewhere). */
export const TURN_MARKER = BLACK_CIRCLE;
/** Result-tree gutter, exactly Claude Code's `  ⎿  `. */
export const RESULT_GUTTER = '  ⎿  ';
/** Continuation indent aligning under the result content. */
export const RESULT_INDENT = '     ';
/** Prompt prefix glyph before the input — CC figures.pointer `❯`. */
export const PROMPT_GLYPH = POINTER;

/** Effort-level glyphs (figures.ts EFFORT_*). */
export const EFFORT_GLYPH = { low: EFFORT_LOW, medium: EFFORT_MEDIUM, high: EFFORT_HIGH, max: EFFORT_MAX };
