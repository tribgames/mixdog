/**
 * src/tui/themes/warm.mjs — Warm (terracotta / cream sunset).
 *
 * A warmer split from Basic: terracotta, peach, rose-gold and cream over a
 * brown-black surface. Basic now owns clean amber/yellow-orange; Warm leans
 * softer, earthier and more sunset/editorial. Spreads `basePalette` first so
 * the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Warm — terracotta / cream sunset dark. */
export const warmPalette = {
  ...basePalette,
  background: 'transparent',
  // Signature terracotta + peach shimmer; cream body makes it warmer than Basic.
  claude: 'rgb(205,86,58)',
  logo: 'rgb(255,125,84)', // welcome banner — brighter peach terracotta
  claudeShimmer: 'rgb(255,176,130)',
  mixdogOrange: 'rgb(205,86,58)',
  mixdogAmber: 'rgb(255,176,130)',
  mixdogIvory: 'rgb(244,226,204)',
  spinnerGlyph: 'rgb(255,84,48)', // most-emphasized: hot sunset orange
  spinnerText: 'rgb(255,84,48)',
  spinnerShimmer: 'rgb(255,140,96)',
  thinkingAccent: 'rgb(178,106,82)',
  thinkingText: 'rgb(226,188,164)',
  thinkingBase: 'rgb(132,72,58)',
  thinkingGlow: 'rgb(252,220,190)',
  statusText: 'rgb(244,226,204)',
  statusSubtle: 'rgb(176,118,96)',
  timerText: 'rgb(176,118,96)',
  text: 'rgb(244,226,204)',
  inverseText: 'rgb(36,17,14)',
  selectionText: 'rgb(255,228,204)',
  selectionBackground: 'rgb(102,48,34)',
  inactive: 'rgb(170,124,102)',
  subtle: 'rgb(146,94,78)',
  promptBorder: 'rgb(120,70,58)',
  success: 'rgb(150,194,120)',
  error: 'rgb(230,86,78)',
  warning: 'rgb(238,142,78)',
  suggestion: 'rgb(255,176,130)',
  panelTitle: 'rgb(205,86,58)',
  permission: 'rgb(230,86,78)',
  code: 'rgb(255,176,130)',
  codeBlock: 'rgb(238,214,190)',
  mdHeading: 'rgb(205,86,58)',
  mdCode: 'rgb(255,176,130)',
  mdCodeBlock: 'rgb(238,214,190)',
  mdQuote: 'rgb(178,118,94)',
  mdQuoteBorder: 'rgb(146,94,78)',
  mdHr: 'rgb(146,94,78)',
  mdListBullet: 'rgb(205,86,58)',
  mdCodeBlockBorder: 'rgb(76,38,30)',
  mdCodeBlockBg: 'rgb(42,22,18)',
  mdCodeSpanBg: 'rgb(62,31,24)',
  mdLink: 'rgb(255,176,130)',
  mdLinkText: 'rgb(255,126,104)',
  mdStrong: 'rgb(255,176,130)',
  mdEmph: 'rgb(230,126,112)',
  mdDiffAdded: 'rgb(150,194,120)',
  mdDiffRemoved: 'rgb(230,86,78)',
  mdDiffHunk: 'rgb(255,126,104)',
  mdDiffHeader: 'rgb(255,176,130)',
  mdDiffContext: 'rgb(178,118,94)',
  mdDiffAddedBg: 'rgb(38,50,30)',
  mdDiffRemovedBg: 'rgb(64,26,24)',
  syntaxComment: 'rgb(178,118,94)',
  syntaxKeyword: 'rgb(205,86,58)',
  syntaxFunction: 'rgb(255,176,130)',
  syntaxVariable: 'rgb(230,86,78)',
  syntaxString: 'rgb(180,196,130)',
  syntaxNumber: 'rgb(230,126,112)',
  syntaxType: 'rgb(255,126,104)',
  syntaxOperator: 'rgb(226,188,164)',
  syntaxPunctuation: 'rgb(244,226,204)',
  userMessageBackground: 'rgb(58,32,25)',
  userMessageBackgroundHover: 'rgb(76,38,30)',
  fastMode: 'rgb(255,84,48)',
};
