/**
 * src/tui/themes/basic.mjs — Basic (deep blue accent + orange spinner dark).
 *
 * A deep saturated blue carries the accent role (titles, headings, links,
 * code), while the thinking spinner runs a separate warm orange so the live
 * "working" state pops against the blue UI. Spreads `basePalette` first so the
 * full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Basic — deep blue accent with a warm orange thinking spinner. */
export const basicPalette = {
  ...basePalette,
  background: 'transparent',
  text: 'rgb(231,226,224)',
  statusText: 'rgb(231,226,224)',
  // Thinking + spinner run warm orange so the live "working" state stands out.
  thinkingText: 'rgb(236,182,128)',
  thinkingGlow: 'rgb(250,206,158)',
  mixdogIvory: 'rgb(231,226,224)',
  inactive: 'rgb(140,132,132)',
  subtle: 'rgb(128,120,120)',
  thinkingAccent: 'rgb(232,150,80)',
  thinkingBase: 'rgb(232,150,80)',
  statusSubtle: 'rgb(152,144,144)',
  timerText: 'rgb(152,144,144)',
  promptBorder: 'rgb(116,108,108)',
  // Accent: a deep saturated blue across titles, headings, links and code.
  claude: 'rgb(40,96,220)',
  logo: 'rgb(64,128,255)', // welcome banner — brighter than the accent
  mixdogOrange: 'rgb(40,96,220)',
  panelTitle: 'rgb(40,96,220)',
  mdHeading: 'rgb(40,96,220)',
  claudeShimmer: 'rgb(108,158,244)',
  mixdogAmber: 'rgb(108,158,244)',
  suggestion: 'rgb(108,158,244)',
  code: 'rgb(70,120,235)',
  mdLink: 'rgb(108,158,244)',
  mdListBullet: 'rgb(118,134,158)', // muted slate (structural marker, subtler than inline-code accent)
  mdCode: 'rgb(70,120,235)',
  mdLinkText: 'rgb(120,196,232)',
  // Spinner glyph/text/shimmer run the warm orange (separate from the accent).
  spinnerGlyph: 'rgb(232,150,80)',
  spinnerText: 'rgb(232,150,80)',
  spinnerShimmer: 'rgb(250,186,120)',
  codeBlock: 'rgb(222,214,212)',
  mdCodeBlock: 'rgb(222,214,212)',
  success: 'rgb(140,190,118)',
  error: 'rgb(224,92,96)',
  warning: 'rgb(236,170,90)',
  permission: 'rgb(224,92,96)',
  mdStrong: 'rgb(108,158,244)',
  mdEmph: 'rgb(120,196,232)',
  inverseText: 'rgb(24,18,18)',
  selectionText: 'rgb(24,18,18)',
  selectionBackground: 'rgb(222,214,212)',
  mdCodeBlockBg: 'rgb(28,25,25)',
  mdCodeSpanBg: 'rgb(40,34,34)',
  mdCodeBlockBorder: 'rgb(52,44,44)',
  userMessageBackground: 'rgb(42,36,36)',
  userMessageBackgroundHover: 'rgb(56,46,46)',
  mdQuote: 'rgb(128,120,120)',
  mdQuoteBorder: 'rgb(128,120,120)',
  mdHr: 'rgb(128,120,120)',
  syntaxComment: 'rgb(128,120,120)',
  mdDiffContext: 'rgb(128,120,120)',
  mdDiffAdded: 'rgb(140,190,118)',
  mdDiffRemoved: 'rgb(224,92,96)',
  mdDiffHunk: 'rgb(120,196,232)',
  mdDiffHeader: 'rgb(108,158,244)',
  mdDiffAddedBg: 'rgb(28,42,28)',
  mdDiffRemovedBg: 'rgb(52,28,30)',
  syntaxKeyword: 'rgb(40,96,220)',
  syntaxFunction: 'rgb(108,158,244)',
  syntaxString: 'rgb(170,194,128)',
  syntaxNumber: 'rgb(236,170,90)',
  syntaxType: 'rgb(120,196,232)',
  syntaxVariable: 'rgb(231,226,224)',
  syntaxOperator: 'rgb(108,158,244)',
  syntaxPunctuation: 'rgb(222,214,212)',
  fastMode: 'rgb(255,140,40)',
};
