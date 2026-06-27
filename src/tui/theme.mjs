/**
 * src/tui/theme.mjs — Claude Code dark palette for the React/ink TUI.
 *
 * Claude Code-inspired dark palette tuned for Windows Terminal.
 * ink accepts `rgb(r,g,b)` strings directly on the `color`/`backgroundColor`
 * props, so these are plain strings (no escape wrapping needed — ink emits the
 * SGR and honors NO_COLOR/non-TTY itself).
 *
 * Dark-fixed for now (terminal background detection can pick light later).
 */
export const theme = {
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
  text: 'rgb(198,198,198)', // Claude Code-like primary text
  inverseText: 'rgb(0,0,0)', // text on an inverted (light) background
  inactive: 'rgb(136,136,136)', // secondary text
  subtle: 'rgb(140,140,140)', // helper text / quiet rules
  promptBorder: 'rgb(158,158,158)', // input border / prompt
  success: 'rgb(28,150,78)', // muted Claude-like green accent
  error: 'rgb(210,60,76)', // muted Claude-like red accent
  warning: 'rgb(204,157,44)', // muted amber
  suggestion: 'rgb(47,127,255)', // dense Claude-like path/link blue
  panelTitle: 'rgb(215,119,87)', // panel/picker titles stay orange
  permission: 'rgb(239,68,88)', // permission red
  code: 'rgb(47,127,255)', // inline code/link accent
  codeBlock: 'rgb(136,190,142)', // code block body
  userMessageBackground: 'rgb(108,108,108)', // Claude Code prompt band
  userMessageBackgroundHover: 'rgb(120,120,120)', // hover variant
  fastMode: 'rgb(255,120,20)',
};

/* --- Glyphs (refs/claude-code/src/constants/figures.ts) ------------------- */
import {
  BLACK_CIRCLE,
  RESULT_GUTTER_GLYPH,
} from './figures.mjs';

/** Turn marker — CC BLACK_CIRCLE (`⏺` on macOS; `●` elsewhere). */
export const TURN_MARKER = BLACK_CIRCLE;
/** Result-tree gutter — CC MessageResponse style `⎿`, ASCII only when requested. */
export const RESULT_GUTTER = `  ${RESULT_GUTTER_GLYPH}  `;
