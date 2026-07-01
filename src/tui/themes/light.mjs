/**
 * src/tui/themes/light.mjs — GitHub Light (high-contrast light theme).
 *
 * Faithful port of GitHub's light palette (via opencode's github.json light
 * variant): pure white bg #ffffff, near-black ink text #24292f, blue accent
 * #0969da, with GitHub's standard diff tints. Chosen for readability — high
 * fg/bg contrast that works for actual coding, unlike soft pastel light themes.
 * Spreads `basePalette` first so the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** GitHub Light — bright white surface with high-contrast dark ink. */
export const lightPalette = {
  ...basePalette,
  background: 'rgb(255,255,255)', // lightBg #ffffff
  text: 'rgb(36,41,47)', // lightFg #24292f
  inverseText: 'rgb(255,255,255)',
  selectionText: 'rgb(36,41,47)',
  selectionBackground: 'rgb(180,213,255)', // classic light-mode selection blue
  inactive: 'rgb(87,96,106)', // lightFgMuted #57606a
  subtle: 'rgb(110,119,129)', // #6e7781
  promptBorder: 'rgb(208,215,222)', // #d0d7de
  statusText: 'rgb(36,41,47)',
  statusSubtle: 'rgb(87,96,106)',
  timerText: 'rgb(87,96,106)',
  thinkingText: 'rgb(36,41,47)',
  thinkingBase: 'rgb(110,119,129)',
  thinkingAccent: 'rgb(87,96,106)',
  thinkingGlow: 'rgb(20,24,28)',
  claude: 'rgb(9,105,218)', // lightBlue #0969da (signature accent)
  logo: 'rgb(9,105,218)', // welcome banner — high-contrast on white
  claudeShimmer: 'rgb(84,153,237)',
  mixdogOrange: 'rgb(9,105,218)',
  mixdogAmber: 'rgb(84,153,237)',
  mixdogIvory: 'rgb(36,41,47)',
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
  codeBlock: 'rgb(36,41,47)',
  userMessageBackground: 'rgb(240,243,246)', // lightBgPanel #f0f3f6
  userMessageBackgroundHover: 'rgb(246,248,250)', // lightBgAlt #f6f8fa
  fastMode: 'rgb(188,76,0)', // lightOrange #bc4c00
  mdHeading: 'rgb(9,105,218)', // lightBlue
  mdCode: 'rgb(191,57,137)', // lightPink #bf3989 (inline code)
  mdCodeBlock: 'rgb(36,41,47)',
  mdQuote: 'rgb(87,96,106)',
  mdQuoteBorder: 'rgb(208,215,222)',
  mdHr: 'rgb(208,215,222)',
  mdListBullet: 'rgb(9,105,218)',
  mdCodeBlockBorder: 'rgb(216,222,228)', // #d8dee4
  mdCodeBlockBg: 'rgb(246,248,250)', // #f6f8fa
  mdCodeSpanBg: 'rgb(240,243,246)', // #f0f3f6
  mdLink: 'rgb(9,105,218)',
  mdLinkText: 'rgb(27,124,131)', // lightCyan #1b7c83
  mdStrong: 'rgb(188,76,0)', // lightOrange #bc4c00
  mdEmph: 'rgb(154,103,0)', // lightYellow #9a6700
  mdDiffAdded: 'rgb(26,127,55)',
  mdDiffRemoved: 'rgb(207,34,46)',
  mdDiffHunk: 'rgb(9,105,218)',
  mdDiffHeader: 'rgb(130,80,223)', // lightPurple #8250df
  mdDiffContext: 'rgb(87,96,106)',
  mdDiffAddedBg: 'rgb(218,251,225)', // #dafbe1
  mdDiffRemovedBg: 'rgb(255,235,233)', // #ffebe9
  syntaxComment: 'rgb(87,96,106)',
  syntaxKeyword: 'rgb(207,34,46)', // lightRed
  syntaxFunction: 'rgb(130,80,223)', // lightPurple
  syntaxVariable: 'rgb(188,76,0)', // lightOrange
  syntaxString: 'rgb(9,105,218)', // lightBlue
  syntaxNumber: 'rgb(27,124,131)', // lightCyan
  syntaxType: 'rgb(188,76,0)', // lightOrange
  syntaxOperator: 'rgb(207,34,46)', // lightRed
  syntaxPunctuation: 'rgb(36,41,47)',
};
