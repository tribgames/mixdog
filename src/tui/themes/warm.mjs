/**
 * src/tui/themes/warm.mjs — Warm (sunset amber / gold).
 *
 * A soft golden-amber accent over a warm near-black surface with a faintly
 * cream body text. Less saturated and more editorial than a pure orange brand:
 * the signature is honeyed amber `#f0b45a` with a lighter gold shimmer, paired
 * with a complementary warm-rose for emphasis. Spreads `basePalette` first so
 * the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Warm — sunset amber / gold accent with a faint cream body. */
export const warmPalette = {
  ...basePalette,
  background: 'transparent',
  // Signature honeyed amber + lighter gold shimmer.
  claude: 'rgb(240,180,90)',
  logo: 'rgb(255,170,70)', // welcome banner — brighter, more saturated amber-orange
  claudeShimmer: 'rgb(250,210,140)',
  mixdogOrange: 'rgb(240,180,90)',
  mixdogAmber: 'rgb(250,210,140)',
  mixdogIvory: 'rgb(245,236,220)',
  spinnerGlyph: 'rgb(255,120,70)', // most-emphasized: reddish coral-orange
  spinnerText: 'rgb(255,120,70)',
  spinnerShimmer: 'rgb(255,160,110)', // brighter coral shimmer
  thinkingAccent: 'rgb(160,150,138)',
  thinkingText: 'rgb(212,202,188)',
  thinkingBase: 'rgb(160,150,138)',
  thinkingGlow: 'rgb(232,222,206)',
  statusText: 'rgb(238,228,212)',
  statusSubtle: 'rgb(160,150,138)',
  timerText: 'rgb(160,150,138)',
  text: 'rgb(238,228,212)', // faint cream body
  inverseText: 'rgb(26,20,12)',
  selectionText: 'rgb(26,20,12)',
  selectionBackground: 'rgb(238,228,212)',
  inactive: 'rgb(150,140,128)',
  subtle: 'rgb(132,124,112)',
  promptBorder: 'rgb(120,110,96)',
  success: 'rgb(150,194,120)',
  error: 'rgb(232,118,108)',
  warning: 'rgb(240,180,90)',
  suggestion: 'rgb(250,210,140)',
  panelTitle: 'rgb(240,180,90)',
  permission: 'rgb(232,118,108)',
  code: 'rgb(250,210,140)',
  codeBlock: 'rgb(228,218,202)',
  mdHeading: 'rgb(240,180,90)',
  mdCode: 'rgb(250,210,140)',
  mdCodeBlock: 'rgb(228,218,202)',
  mdQuote: 'rgb(150,140,128)',
  mdQuoteBorder: 'rgb(150,140,128)',
  mdHr: 'rgb(150,140,128)',
  mdListBullet: 'rgb(240,180,90)',
  mdCodeBlockBorder: 'rgb(58,50,40)',
  mdCodeBlockBg: 'rgb(34,29,22)',
  mdCodeSpanBg: 'rgb(44,37,28)',
  mdLink: 'rgb(250,210,140)',
  mdLinkText: 'rgb(224,158,120)',
  mdStrong: 'rgb(250,210,140)',
  mdEmph: 'rgb(232,170,130)',
  mdDiffAdded: 'rgb(150,194,120)',
  mdDiffRemoved: 'rgb(232,118,108)',
  mdDiffHunk: 'rgb(224,158,120)',
  mdDiffHeader: 'rgb(240,180,90)',
  mdDiffContext: 'rgb(150,140,128)',
  mdDiffAddedBg: 'rgb(30,42,28)',
  mdDiffRemovedBg: 'rgb(50,28,28)',
  syntaxComment: 'rgb(150,140,128)',
  syntaxKeyword: 'rgb(240,180,90)',
  syntaxFunction: 'rgb(250,210,140)',
  syntaxVariable: 'rgb(232,118,108)',
  syntaxString: 'rgb(180,196,130)',
  syntaxNumber: 'rgb(232,170,130)',
  syntaxType: 'rgb(224,158,120)',
  syntaxOperator: 'rgb(214,178,150)',
  syntaxPunctuation: 'rgb(238,228,212)',
  userMessageBackground: 'rgb(46,40,34)',
  userMessageBackgroundHover: 'rgb(60,52,42)',
  fastMode: 'rgb(255,150,40)',
};
