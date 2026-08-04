/**
 * src/tui/themes/basic.mjs — Basic (amber-gold default dark).
 *
 * A clean amber / golden-orange accent carries the default theme identity
 * (titles, headings, links, code), with a slightly hotter orange live spinner.
 * Body text stays neutral/cool for readability so the theme does not feel
 * muddy or yellowed. Warm stays more terracotta / cream, while Indigo owns the
 * cool violet-blue family. Spreads `basePalette` first so the full key set is
 * always present.
 */
import { basePalette } from './base.mjs';

/** Basic — amber-gold default dark with a hot orange live state. */
export const basicPalette = {
  ...basePalette,
  background: 'transparent',
  text: 'rgb(232,234,238)',
  statusText: 'rgb(232,234,238)',
  // Thinking + spinner run a hotter orange than the golden UI accent.
  thinkingText: 'rgb(238,184,122)',
  thinkingGlow: 'rgb(255,214,158)',
  mixdogIvory: 'rgb(232,234,238)',
  inactive: 'rgb(142,144,150)',
  subtle: 'rgb(124,126,132)',
  thinkingAccent: 'rgb(242,136,48)',
  thinkingBase: 'rgb(242,136,48)',
  statusSubtle: 'rgb(154,156,162)',
  timerText: 'rgb(154,156,162)',
  promptBorder: 'rgb(112,112,118)',
  // Accent: bright orange across titles, headings, links and code.
  claude: 'rgb(255,150,58)',
  logo: 'rgb(238,150,64)', // welcome banner — slightly deeper than the accent
  mixdogOrange: 'rgb(255,150,58)',
  panelTitle: 'rgb(255,150,58)',
  mdHeading: 'rgb(255,150,58)',
  claudeShimmer: 'rgb(255,210,118)',
  mixdogAmber: 'rgb(255,210,118)',
  suggestion: 'rgb(255,196,92)',
  code: 'rgb(246,184,78)',
  mdLink: 'rgb(255,196,92)',
  mdListBullet: 'rgb(184,140,74)', // muted amber structural marker
  mdCode: 'rgb(246,184,78)',
  mdLinkText: 'rgb(255,218,138)',
  // Spinner glyph/text/shimmer run a warm orange (a touch hotter than the gold
  // accent, but no longer strongly red) so they harmonize with the thinking tone.
  spinnerGlyph: 'rgb(244,120,58)',
  spinnerText: 'rgb(244,120,58)',
  spinnerShimmer: 'rgb(255,164,110)',
  codeBlock: 'rgb(224,226,230)',
  mdCodeBlock: 'rgb(224,226,230)',
  success: 'rgb(140,190,118)',
  error: 'rgb(224,92,96)',
  warning: 'rgb(236,170,90)',
  permission: 'rgb(224,92,96)',
  mdStrong: 'rgb(255,196,92)',
  mdEmph: 'rgb(255,218,138)',
  inverseText: 'rgb(24,18,18)',
  selectionText: 'rgb(255,238,208)',
  selectionBackground: 'rgb(96,58,28)',
  mdCodeBlockBg: 'rgb(27,27,30)',
  mdCodeSpanBg: 'rgb(38,37,38)',
  mdCodeBlockBorder: 'rgb(50,49,50)',
  userMessageBackground: 'rgb(36,35,36)',
  userMessageBackgroundHover: 'rgb(48,46,46)',
  mdQuote: 'rgb(124,126,132)',
  mdQuoteBorder: 'rgb(124,126,132)',
  mdHr: 'rgb(124,126,132)',
  syntaxComment: 'rgb(124,126,132)',
  mdDiffContext: 'rgb(124,126,132)',
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
  syntaxVariable: 'rgb(232,234,238)',
  syntaxOperator: 'rgb(255,196,92)',
  syntaxPunctuation: 'rgb(224,226,230)',
  fastMode: 'rgb(255,140,40)',
};
