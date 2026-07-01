/**
 * src/tui/themes/warm.mjs — Warm (sunset amber / gold).
 *
 * A soft golden-amber accent over a warm near-black surface with a near-neutral
 * body text — the amber/gold cast is confined to accents (logo, headings,
 * code, links) instead of washing over body text and frames. Less saturated
 * and more editorial than a pure orange brand:
 * the signature is honeyed amber `#f0b45a` with a lighter gold shimmer, paired
 * with a complementary warm-rose for emphasis. Spreads `basePalette` first so
 * the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Warm — sunset amber / gold accent with a near-neutral body. */
export const warmPalette = {
  ...basePalette,
  background: 'transparent',
  // Signature honeyed amber + lighter gold shimmer.
  claude: 'rgb(240,180,90)',
  logo: 'rgb(255,170,70)', // welcome banner — brighter, more saturated amber-orange
  claudeShimmer: 'rgb(250,210,140)',
  mixdogOrange: 'rgb(240,180,90)',
  mixdogAmber: 'rgb(250,210,140)',
  mixdogIvory: 'rgb(236,232,226)', // near-neutral — accent color carries emphasis, not the body tone
  spinnerGlyph: 'rgb(255,120,70)', // most-emphasized: reddish coral-orange
  spinnerText: 'rgb(255,120,70)',
  spinnerShimmer: 'rgb(255,160,110)', // brighter coral shimmer
  thinkingAccent: 'rgb(156,153,147)',
  thinkingText: 'rgb(206,202,196)',
  thinkingBase: 'rgb(156,153,147)',
  thinkingGlow: 'rgb(226,222,216)',
  statusText: 'rgb(225,221,215)',
  statusSubtle: 'rgb(156,153,147)',
  timerText: 'rgb(156,153,147)',
  text: 'rgb(225,221,215)', // near-neutral body — warm wash removed, accents carry the warmth
  inverseText: 'rgb(24,22,19)',
  selectionText: 'rgb(24,22,19)',
  selectionBackground: 'rgb(225,221,215)',
  inactive: 'rgb(148,145,140)',
  subtle: 'rgb(130,127,122)',
  promptBorder: 'rgb(110,107,101)', // frame — near-neutral, no more honeyed cast
  success: 'rgb(150,194,120)',
  error: 'rgb(232,118,108)',
  warning: 'rgb(240,180,90)',
  suggestion: 'rgb(250,210,140)',
  panelTitle: 'rgb(240,180,90)',
  permission: 'rgb(232,118,108)',
  code: 'rgb(250,210,140)',
  codeBlock: 'rgb(220,216,210)',
  mdHeading: 'rgb(240,180,90)',
  mdCode: 'rgb(250,210,140)',
  mdCodeBlock: 'rgb(220,216,210)',
  mdQuote: 'rgb(144,141,136)',
  mdQuoteBorder: 'rgb(144,141,136)',
  mdHr: 'rgb(144,141,136)',
  mdListBullet: 'rgb(240,180,90)',
  mdCodeBlockBorder: 'rgb(54,51,47)',
  mdCodeBlockBg: 'rgb(30,29,27)',
  mdCodeSpanBg: 'rgb(40,38,34)',
  mdLink: 'rgb(250,210,140)',
  mdLinkText: 'rgb(224,158,120)',
  mdStrong: 'rgb(250,210,140)',
  mdEmph: 'rgb(232,170,130)',
  mdDiffAdded: 'rgb(150,194,120)',
  mdDiffRemoved: 'rgb(232,118,108)',
  mdDiffHunk: 'rgb(224,158,120)',
  mdDiffHeader: 'rgb(240,180,90)',
  mdDiffContext: 'rgb(144,141,136)',
  mdDiffAddedBg: 'rgb(30,42,28)',
  mdDiffRemovedBg: 'rgb(50,28,28)',
  syntaxComment: 'rgb(144,141,136)',
  syntaxKeyword: 'rgb(240,180,90)',
  syntaxFunction: 'rgb(250,210,140)',
  syntaxVariable: 'rgb(232,118,108)',
  syntaxString: 'rgb(180,196,130)',
  syntaxNumber: 'rgb(232,170,130)',
  syntaxType: 'rgb(224,158,120)',
  syntaxOperator: 'rgb(188,182,174)',
  syntaxPunctuation: 'rgb(225,221,215)',
  userMessageBackground: 'rgb(42,40,37)',
  userMessageBackgroundHover: 'rgb(54,52,48)',
  fastMode: 'rgb(255,150,40)',
};
