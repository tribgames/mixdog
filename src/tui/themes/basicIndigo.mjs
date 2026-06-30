/**
 * src/tui/themes/basicIndigo.mjs — Basic Indigo (Mixdog indigo + blue brand dark).
 *
 * The Mixdog house theme: indigo-blue brand accent paired with a soft
 * sky/lavender secondary, on a deep lifted near-black surface. Spreads
 * `basePalette` first so the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Basic Indigo — Mixdog indigo + blue brand dark. */
export const basicIndigoPalette = {
  ...basePalette,
  background: 'transparent',
  text: 'rgb(228,228,230)',
  statusText: 'rgb(228,228,230)',
  thinkingText: 'rgb(198,198,198)',
  thinkingGlow: 'rgb(220,220,220)',
  mixdogIvory: 'rgb(232,226,215)',
  inactive: 'rgb(136,136,138)',
  subtle: 'rgb(128,128,132)',
  thinkingAccent: 'rgb(150,150,154)',
  thinkingBase: 'rgb(150,150,154)',
  statusSubtle: 'rgb(150,150,154)',
  timerText: 'rgb(150,150,154)',
  promptBorder: 'rgb(120,120,126)',
  claude: 'rgb(99,147,255)',
  logo: 'rgb(130,165,255)', // welcome banner — brighter than the accent
  mixdogOrange: 'rgb(99,147,255)',
  spinnerGlyph: 'rgb(255,126,26)', // most-emphasized: brand orange (pops against indigo UI)
  spinnerText: 'rgb(255,126,26)',
  panelTitle: 'rgb(99,147,255)',
  mdHeading: 'rgb(99,147,255)',
  claudeShimmer: 'rgb(154,190,255)',
  spinnerShimmer: 'rgb(255,165,90)', // brighter brand-orange shimmer
  mixdogAmber: 'rgb(154,190,255)',
  suggestion: 'rgb(154,190,255)',
  code: 'rgb(80,128,250)',
  mdLink: 'rgb(154,190,255)',
  mdListBullet: 'rgb(118,134,158)', // muted slate (structural marker, matches basic)
  mdCode: 'rgb(80,128,250)',
  mdLinkText: 'rgb(124,205,235)',
  codeBlock: 'rgb(208,208,210)',
  mdCodeBlock: 'rgb(208,208,210)',
  success: 'rgb(86,180,110)',
  error: 'rgb(225,95,95)',
  warning: 'rgb(231,172,78)',
  permission: 'rgb(225,95,95)',
  mdStrong: 'rgb(154,190,255)',
  mdEmph: 'rgb(183,170,255)',
  inverseText: 'rgb(18,18,20)',
  selectionText: 'rgb(18,18,20)',
  selectionBackground: 'rgb(208,208,210)',
  mdCodeBlockBg: 'rgb(28,28,32)',
  mdCodeSpanBg: 'rgb(37,37,43)',
  mdCodeBlockBorder: 'rgb(48,48,54)',
  userMessageBackground: 'rgb(40,40,44)',
  userMessageBackgroundHover: 'rgb(52,52,56)',
  mdQuote: 'rgb(128,128,132)',
  mdQuoteBorder: 'rgb(128,128,132)',
  mdHr: 'rgb(128,128,132)',
  syntaxComment: 'rgb(128,128,132)',
  mdDiffContext: 'rgb(128,128,132)',
  mdDiffAdded: 'rgb(86,180,110)',
  mdDiffRemoved: 'rgb(225,95,95)',
  mdDiffHunk: 'rgb(124,160,225)',
  mdDiffHeader: 'rgb(154,190,255)',
  mdDiffAddedBg: 'rgb(28,46,34)',
  mdDiffRemovedBg: 'rgb(48,28,30)',
  syntaxKeyword: 'rgb(154,190,255)',
  syntaxFunction: 'rgb(124,205,235)',
  syntaxString: 'rgb(150,190,120)',
  syntaxNumber: 'rgb(183,170,255)',
  syntaxType: 'rgb(124,205,235)',
  syntaxVariable: 'rgb(228,228,230)',
  syntaxOperator: 'rgb(154,190,255)',
  syntaxPunctuation: 'rgb(208,208,210)',
  fastMode: 'rgb(255,126,26)',
};
