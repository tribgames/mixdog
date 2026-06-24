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
  claude: 'rgb(255,138,86)', // warm brand accent
  claudeShimmer: 'rgb(255,190,142)',
  text: 'rgb(240,240,240)', // primary text
  inverseText: 'rgb(0,0,0)', // text on an inverted (light) background
  inactive: 'rgb(212,212,212)', // secondary text
  subtle: 'rgb(154,154,154)', // helper text / quiet rules
  promptBorder: 'rgb(200,200,200)', // input border / prompt
  success: 'rgb(126,231,135)', // green
  error: 'rgb(255,92,115)', // red
  warning: 'rgb(255,216,74)', // amber
  suggestion: 'rgb(95,135,255)', // selector/title blue
  permission: 'rgb(177,185,249)', // CC darkTheme permission
  code: 'rgb(177,185,249)', // inline code accent = CC permission
  codeBlock: 'rgb(126,231,135)', // code block body
  userMessageBackground: 'rgb(128,128,128)', // selected row / user bubble background
  userMessageBackgroundHover: 'rgb(148,148,148)', // hover variant
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
