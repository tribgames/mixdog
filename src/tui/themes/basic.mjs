/**
 * src/tui/themes/basic.mjs — Basic (amber-gold default dark).
 *
 * A clean amber / golden-orange accent carries the default theme identity
 * (titles, headings, links, code), with a slightly hotter orange live spinner.
 * Warm stays more terracotta / cream, while Indigo owns the cool violet-blue
 * family. Spreads `basePalette` first so the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Basic — amber-gold default dark with a hot orange live state. */
export const basicPalette = {
  ...basePalette,
  background: 'transparent',
  text: 'rgb(231,226,224)',
  statusText: 'rgb(231,226,224)',
  // Thinking + spinner run a hotter orange than the golden UI accent.
  thinkingText: 'rgb(238,184,122)',
  thinkingGlow: 'rgb(255,214,158)',
  mixdogIvory: 'rgb(231,226,224)',
  inactive: 'rgb(140,132,132)',
  subtle: 'rgb(128,120,120)',
  thinkingAccent: 'rgb(242,136,48)',
  thinkingBase: 'rgb(242,136,48)',
  statusSubtle: 'rgb(152,144,144)',
  timerText: 'rgb(152,144,144)',
  promptBorder: 'rgb(116,108,108)',
  // Accent: amber-gold across titles, headings, links and code.
  claude: 'rgb(232,156,48)',
  logo: 'rgb(255,184,72)', // welcome banner — brighter than the accent
  mixdogOrange: 'rgb(232,156,48)',
  panelTitle: 'rgb(232,156,48)',
  mdHeading: 'rgb(232,156,48)',
  claudeShimmer: 'rgb(255,210,118)',
  mixdogAmber: 'rgb(255,210,118)',
  suggestion: 'rgb(255,196,92)',
  code: 'rgb(246,184,78)',
  mdLink: 'rgb(255,196,92)',
  mdListBullet: 'rgb(184,140,74)', // muted amber structural marker
  mdCode: 'rgb(246,184,78)',
  mdLinkText: 'rgb(255,218,138)',
  // Spinner glyph/text/shimmer run hotter orange (separate from the gold accent).
  spinnerGlyph: 'rgb(242,136,48)',
  spinnerText: 'rgb(242,136,48)',
  spinnerShimmer: 'rgb(255,184,96)',
  codeBlock: 'rgb(222,214,212)',
  mdCodeBlock: 'rgb(222,214,212)',
  success: 'rgb(140,190,118)',
  error: 'rgb(224,92,96)',
  warning: 'rgb(236,170,90)',
  permission: 'rgb(224,92,96)',
  mdStrong: 'rgb(255,196,92)',
  mdEmph: 'rgb(255,218,138)',
  inverseText: 'rgb(24,18,18)',
  selectionText: 'rgb(255,238,208)',
  selectionBackground: 'rgb(92,62,24)',
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
  mdDiffHunk: 'rgb(255,196,92)',
  mdDiffHeader: 'rgb(255,210,118)',
  mdDiffAddedBg: 'rgb(28,42,28)',
  mdDiffRemovedBg: 'rgb(52,28,30)',
  syntaxKeyword: 'rgb(232,156,48)',
  syntaxFunction: 'rgb(255,196,92)',
  syntaxString: 'rgb(170,194,128)',
  syntaxNumber: 'rgb(236,170,90)',
  syntaxType: 'rgb(255,218,138)',
  syntaxVariable: 'rgb(231,226,224)',
  syntaxOperator: 'rgb(255,196,92)',
  syntaxPunctuation: 'rgb(222,214,212)',
  fastMode: 'rgb(255,140,40)',
};
