/**
 * src/tui/theme.mjs — pi-tui theme objects + Claude-Code-style glyphs/colors.
 *
 * Colors are ported VERBATIM from Claude Code's dark theme
 * (refs/claude-code/src/utils/theme.ts → darkTheme), emitted as 24-bit
 * truecolor via src/ui/ansi.mjs (which honors NO_COLOR / TTY). This replaces the
 * earlier all-gray 16-color look with CC's actual palette: white body text,
 * Claude-orange turn markers, etc. Dark-fixed for now (terminal background
 * detection can pick light later).
 *
 * Glyphs mirror figures.ts: turn marker `●`, result tree `  ⎿  `, effort dots.
 */
import { bold, italic, underline, strike, dim, compose, rgb } from '../ui/ansi.mjs';

/* --- Claude Code dark palette (rgb from theme.ts darkTheme) ---------------- */
const CC = {
  claude: rgb(215, 119, 87), // brand orange — turn marker / accents
  text: rgb(255, 255, 255), // white — body text
  inactive: rgb(153, 153, 153), // light gray — secondary
  subtle: rgb(80, 80, 80), // dark gray — borders/rules
  promptBorder: rgb(136, 136, 136), // medium gray — input border/prompt
  success: rgb(78, 186, 101), // green
  error: rgb(255, 107, 128), // red
  warning: rgb(255, 193, 7), // amber
  suggestion: rgb(177, 185, 249), // light blue-purple — links/select
  code: rgb(235, 159, 127), // claudeShimmer-ish — inline code/accents
  diffAddedWord: rgb(56, 166, 96), // medium green — code blocks
};

/* --- Claude-Code glyphs ----------------------------------------------------
 * CC uses `⏺` on macOS and `●` elsewhere (figures.ts BLACK_CIRCLE). We default
 * to `●` for cross-platform terminal alignment.
 */
export const TURN_MARKER = '●';
/** Dim result-tree prefix, exactly Claude Code's `  ⎿  ` (2 + glyph + 2). */
export const RESULT_PREFIX = '  ⎿  ';
/** Continuation indent for wrapped result lines (aligns under the glyph). */
export const RESULT_INDENT = '     ';
/** Prompt glyph shown before the input editor (CC `>`); MarkerBlock adds the
 * trailing space, rendering `> ` + the editor content. */
export const PROMPT_GLYPH = '>';

/** Effort-level glyphs (figures.ts EFFORT_*). */
export const EFFORT_GLYPH = {
  low: '○',
  medium: '◐',
  high: '●',
  max: '◉',
};

/** MarkdownTheme — consumed by `new Markdown(text, px, py, markdownTheme)`. */
export const markdownTheme = {
  heading: compose(bold, CC.claude), // headings in Claude orange, bold
  link: CC.suggestion,
  linkUrl: CC.inactive,
  code: CC.code,
  codeBlock: CC.diffAddedWord,
  codeBlockBorder: CC.subtle,
  quote: compose(italic, CC.inactive),
  quoteBorder: CC.subtle,
  hr: CC.subtle,
  listBullet: CC.claude,
  bold: bold,
  italic: italic,
  strikethrough: strike,
  underline: underline,
};

/** SelectListTheme — the autocomplete/select dropdown inside the Editor. */
export const selectListTheme = {
  selectedPrefix: CC.claude,
  selectedText: compose(bold, CC.text),
  description: CC.inactive,
  scrollInfo: CC.inactive,
  noMatch: CC.inactive,
};

/** EditorTheme — consumed by `new Editor(tui, editorTheme)`. */
export const editorTheme = {
  // CC promptBorder gray — more legible than plain dim.
  borderColor: CC.promptBorder,
  selectList: selectListTheme,
};

/** Semantic colors for chat chrome (turn markers, notices, prompt). */
export const colors = {
  /** Assistant turn marker — Claude orange (the brand `●`). */
  assistantMarker: CC.claude,
  /** Tool-call turn marker — orange too (CC shows actions in brand color). */
  toolMarker: CC.claude,
  /** Error turn marker + text. */
  errorMarker: compose(bold, CC.error),
  /** Body text — white. */
  text: CC.text,
  /** Dim result tree + secondary chrome. */
  resultTree: CC.inactive,
  /** Tool name in a call card. */
  toolName: bold,
  /** Argument summary — secondary gray. */
  toolArg: CC.inactive,
  /** Prompt prefix color. */
  prompt: CC.claude,
};

/** Re-export dim for callers that still want a plain dim line. */
export { dim };
