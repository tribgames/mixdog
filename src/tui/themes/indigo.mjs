/**
 * src/tui/themes/indigo.mjs — Indigo (cool violet-blue brand dark).
 *
 * The cool Mixdog brand theme: saturated indigo/violet-blue accents paired
 * with lavender/cyan secondary tones on lifted blue-black surfaces. Spreads
 * `basePalette` first so the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Indigo — cool violet-blue brand dark. */
export const indigoPalette = {
  ...basePalette,
  background: 'transparent',
  text: 'rgb(226,226,242)',
  statusText: 'rgb(226,226,242)',
  thinkingText: 'rgb(188,190,222)',
  thinkingGlow: 'rgb(218,220,255)',
  mixdogIvory: 'rgb(226,226,242)',
  inactive: 'rgb(132,136,170)',
  subtle: 'rgb(108,112,148)',
  thinkingAccent: 'rgb(118,124,178)',
  thinkingBase: 'rgb(86,92,142)',
  statusSubtle: 'rgb(132,136,170)',
  timerText: 'rgb(132,136,170)',
  promptBorder: 'rgb(78,82,124)',
  claude: 'rgb(126,105,255)',
  logo: 'rgb(160,145,255)', // welcome banner — brighter than the accent
  mixdogOrange: 'rgb(126,105,255)',
  spinnerGlyph: 'rgb(255,126,26)', // most-emphasized: brand orange (pops against indigo UI)
  spinnerText: 'rgb(255,126,26)',
  panelTitle: 'rgb(126,105,255)',
  mdHeading: 'rgb(160,145,255)',
  claudeShimmer: 'rgb(190,180,255)',
  spinnerShimmer: 'rgb(255,165,90)', // brighter brand-orange shimmer
  mixdogAmber: 'rgb(190,180,255)',
  suggestion: 'rgb(170,178,255)',
  code: 'rgb(140,166,255)',
  mdLink: 'rgb(170,178,255)',
  mdListBullet: 'rgb(126,105,255)',
  mdCode: 'rgb(140,166,255)',
  mdLinkText: 'rgb(126,220,242)',
  codeBlock: 'rgb(214,216,232)',
  mdCodeBlock: 'rgb(214,216,232)',
  success: 'rgb(86,180,110)',
  error: 'rgb(225,95,95)',
  warning: 'rgb(231,172,78)',
  permission: 'rgb(225,95,95)',
  mdStrong: 'rgb(190,180,255)',
  mdEmph: 'rgb(126,220,242)',
  inverseText: 'rgb(16,17,28)',
  selectionText: 'rgb(232,234,255)',
  selectionBackground: 'rgb(54,58,112)',
  mdCodeBlockBg: 'rgb(24,25,44)',
  mdCodeSpanBg: 'rgb(34,35,58)',
  mdCodeBlockBorder: 'rgb(48,50,82)',
  userMessageBackground: 'rgb(31,32,52)',
  userMessageBackgroundHover: 'rgb(42,44,72)',
  mdQuote: 'rgb(108,112,148)',
  mdQuoteBorder: 'rgb(108,112,148)',
  mdHr: 'rgb(108,112,148)',
  syntaxComment: 'rgb(108,112,148)',
  mdDiffContext: 'rgb(108,112,148)',
  mdDiffAdded: 'rgb(86,180,110)',
  mdDiffRemoved: 'rgb(225,95,95)',
  mdDiffHunk: 'rgb(126,105,255)',
  mdDiffHeader: 'rgb(190,180,255)',
  mdDiffAddedBg: 'rgb(24,46,38)',
  mdDiffRemovedBg: 'rgb(48,28,38)',
  syntaxKeyword: 'rgb(190,180,255)',
  syntaxFunction: 'rgb(126,220,242)',
  syntaxString: 'rgb(150,190,120)',
  syntaxNumber: 'rgb(255,176,92)',
  syntaxType: 'rgb(126,220,242)',
  syntaxVariable: 'rgb(226,226,242)',
  syntaxOperator: 'rgb(170,178,255)',
  syntaxPunctuation: 'rgb(214,216,232)',
  fastMode: 'rgb(255,126,26)',
};
