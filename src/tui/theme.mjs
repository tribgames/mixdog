/**
 * src/tui/theme.mjs — Claude Code dark palette for the React/ink TUI.
 *
 * Colors follow refs/claude-code/src/utils/theme.ts (darkTheme).
 * ink accepts `rgb(r,g,b)` strings directly on the `color`/`backgroundColor`
 * props, so these are plain strings (no escape wrapping needed — ink emits the
 * SGR and honors NO_COLOR/non-TTY itself).
 *
 * Dark-fixed for now (terminal background detection can pick light later).
 */
export const theme = {
  claude: 'rgb(215,119,87)', // brand orange — turn markers, accents
  claudeShimmer: 'rgb(235,159,127)',
  text: 'rgb(255,255,255)', // CC darkTheme text
  inverseText: 'rgb(0,0,0)', // text on an inverted (light) background
  inactive: 'rgb(210,210,210)', // secondary gray
  subtle: 'rgb(150,150,150)', // borders / rules
  promptBorder: 'rgb(178,178,178)', // input border / prompt
  success: 'rgb(92,214,118)', // green
  error: 'rgb(255,92,122)', // red
  warning: 'rgb(255,210,64)', // amber
  suggestion: 'rgb(177,185,249)', // CC darkTheme suggestion (light blue-purple)
  permission: 'rgb(177,185,249)', // CC darkTheme permission
  code: 'rgb(177,185,249)', // inline code accent = CC permission
  codeBlock: 'rgb(56,166,96)', // code block body (medium green)
  userMessageBackground: 'rgb(72,72,72)', // selected row / user bubble background
  userMessageBackgroundHover: 'rgb(88,88,88)', // hover variant
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
