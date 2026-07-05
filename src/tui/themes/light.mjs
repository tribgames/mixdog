/**
 * src/tui/themes/light.mjs — GitHub Light / VS Code 2026 Light (terminal TUI).
 *
 * High-contrast light palette for Windows Terminal and picker rows: white
 * surface, near-black ink, solid blue selection (#0069CC), visible chrome
 * borders, and GitHub/VS Code light syntax (no pastel wash). Spreads
 * `basePalette` first so the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** GitHub Light high-contrast — terminal-first readability. */
export const lightPalette = {
  ...basePalette,
  background: 'rgb(255,255,255)', // lightBg #ffffff
  text: 'rgb(32,32,32)', // VS Code 2026 Light fg #202020
  inverseText: 'rgb(255,255,255)',
  selectionText: 'rgb(255,255,255)', // quickInputList.focusForeground
  selectionBackground: 'rgb(0,105,204)', // #0069CC focus / active list
  selectionHighlightText: 'rgb(0,0,0)',
  selectionHighlightBackground: 'rgb(180,213,255)', // classic light-mode text selection blue
  inactive: 'rgb(87,96,106)', // lightFgMuted #57606a
  subtle: 'rgb(110,119,129)', // #6e7781
  promptBorder: 'rgb(175,184,193)', // darker than #d0d7de for visible chrome
  statusText: 'rgb(32,32,32)',
  statusSubtle: 'rgb(87,96,106)',
  timerText: 'rgb(87,96,106)',
  thinkingText: 'rgb(32,32,32)',
  thinkingBase: 'rgb(110,119,129)',
  thinkingAccent: 'rgb(87,96,106)',
  thinkingGlow: 'rgb(20,24,28)',
  claude: 'rgb(9,105,218)', // lightBlue #0969da (signature accent)
  logo: 'rgb(9,105,218)', // welcome banner — high-contrast on white
  claudeShimmer: 'rgb(84,153,237)',
  mixdogOrange: 'rgb(9,105,218)',
  mixdogAmber: 'rgb(84,153,237)',
  mixdogIvory: 'rgb(32,32,32)',
  spinnerGlyph: 'rgb(9,105,218)',
  spinnerText: 'rgb(9,105,218)',
  spinnerShimmer: 'rgb(84,153,237)',
  panelTitle: 'rgb(9,105,218)',
  success: 'rgb(26,127,55)', // lightGreen #1a7f37
  error: 'rgb(207,34,46)', // lightRed #cf222e
  warning: 'rgb(154,103,0)', // lightYellow #9a6700
  permission: 'rgb(207,34,46)',
  suggestion: 'rgb(9,105,218)',
  code: 'rgb(9,105,218)',
  codeBlock: 'rgb(32,32,32)',
  userMessageBackground: 'rgb(240,243,246)', // lightBgPanel #f0f3f6
  userMessageBackgroundHover: 'rgb(246,248,250)', // lightBgAlt #f6f8fa
  fastMode: 'rgb(188,76,0)', // lightOrange #bc4c00
  mdHeading: 'rgb(9,105,218)', // lightBlue
  mdCode: 'rgb(191,57,137)', // lightPink #bf3989 (inline code)
  mdCodeBlock: 'rgb(36,41,47)', // GitHub fg #24292f
  mdQuote: 'rgb(87,96,106)',
  mdQuoteBorder: 'rgb(175,184,193)',
  mdHr: 'rgb(175,184,193)',
  mdListBullet: 'rgb(9,105,218)',
  mdCodeBlockBorder: 'rgb(216,216,216)', // VS Code panel border #D8D8D8
  mdCodeBlockBg: 'rgb(246,248,250)', // #f6f8fa
  mdCodeSpanBg: 'rgb(240,243,246)', // #f0f3f6
  mdLink: 'rgb(9,105,218)',
  mdLinkText: 'rgb(27,124,131)', // lightCyan #1b7c83
  mdStrong: 'rgb(149,56,0)', // #953800
  mdEmph: 'rgb(154,103,0)', // lightYellow #9a6700
  mdDiffAdded: 'rgb(26,127,55)',
  mdDiffRemoved: 'rgb(207,34,46)',
  mdDiffHunk: 'rgb(9,105,218)',
  mdDiffHeader: 'rgb(130,80,223)', // lightPurple #8250df
  mdDiffContext: 'rgb(87,96,106)',
  mdDiffAddedBg: 'rgb(218,251,225)', // #dafbe1
  mdDiffRemovedBg: 'rgb(255,235,233)', // #ffebe9
  syntaxComment: 'rgb(110,119,129)', // #6e7781
  syntaxKeyword: 'rgb(207,34,46)', // lightRed
  syntaxFunction: 'rgb(130,80,223)', // lightPurple
  syntaxVariable: 'rgb(149,56,0)', // #953800
  syntaxString: 'rgb(10,48,105)', // #0a3069 dark blue strings
  syntaxNumber: 'rgb(27,124,131)', // lightCyan
  syntaxType: 'rgb(149,56,0)', // #953800
  syntaxOperator: 'rgb(207,34,46)', // lightRed
  syntaxPunctuation: 'rgb(36,41,47)', // dark ink
};
