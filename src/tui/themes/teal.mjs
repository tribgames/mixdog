/**
 * src/tui/themes/teal.mjs — Teal.
 *
 * Values: accent teal #8abeb7, body text #d4d4d4, page bg #18181e,
 * green #b5bd68, red #cc6666, warning pure yellow #ffff00, blue #81a2be,
 * mdHeading #f0c674, gray #808080. Syntax uses a VS Code Dark+-style palette
 * (keyword #569CD6, string #CE9178, function #DCDCAA, etc.). Spreads
 * `basePalette` first so the full key set is always present.
 */
import { basePalette } from './base.mjs';

/** Teal — teal accent with soft body text. */
export const tealPalette = {
  ...basePalette,
  background: 'transparent', // export.pageBg #18181e
  claude: 'rgb(138,190,183)', // accent #8abeb7
  logo: 'rgb(174,216,210)', // welcome banner — brighter than accent
  claudeShimmer: 'rgb(170,214,208)', // lighter accent
  mixdogOrange: 'rgb(138,190,183)',
  mixdogAmber: 'rgb(170,214,208)',
  mixdogIvory: 'rgb(212,212,212)', // text #d4d4d4
  spinnerGlyph: 'rgb(235,140,110)', // most-emphasized: warm coral (complementary to teal)
  spinnerText: 'rgb(235,140,110)',
  spinnerShimmer: 'rgb(245,170,145)',
  thinkingAccent: 'rgb(128,128,128)', // gray #808080
  thinkingText: 'rgb(128,128,128)', // thinkingText = gray #808080
  thinkingBase: 'rgb(128,128,128)',
  thinkingGlow: 'rgb(200,200,200)',
  statusText: 'rgb(212,212,212)', // text #d4d4d4
  statusSubtle: 'rgb(128,128,128)', // gray
  timerText: 'rgb(128,128,128)',
  text: 'rgb(212,212,212)', // text #d4d4d4
  inverseText: 'rgb(24,24,30)',
  selectionText: 'rgb(220,245,242)',
  selectionBackground: 'rgb(35,78,82)',
  inactive: 'rgb(128,128,128)', // muted/gray #808080
  subtle: 'rgb(102,102,102)', // dim/dimGray #666666
  promptBorder: 'rgb(80,80,80)', // borderMuted/darkGray #505050
  success: 'rgb(181,189,104)', // green #b5bd68
  error: 'rgb(204,102,102)', // red #cc6666
  warning: 'rgb(255,255,0)', // yellow #ffff00 (pi uses pure yellow)
  suggestion: 'rgb(129,162,190)', // mdLink #81a2be
  panelTitle: 'rgb(138,190,183)', // accent
  permission: 'rgb(204,102,102)', // red
  code: 'rgb(138,190,183)', // mdCode = accent
  codeBlock: 'rgb(181,189,104)', // mdCodeBlock = green
  mdHeading: 'rgb(240,198,116)', // mdHeading #f0c674
  mdCode: 'rgb(138,190,183)', // accent
  mdCodeBlock: 'rgb(181,189,104)', // green
  mdQuote: 'rgb(128,128,128)', // gray
  mdQuoteBorder: 'rgb(128,128,128)',
  mdHr: 'rgb(128,128,128)',
  mdListBullet: 'rgb(138,190,183)', // accent
  mdCodeBlockBorder: 'rgb(54,56,62)', // just above mdCodeSpanBg
  mdCodeBlockBg: 'rgb(30,30,36)', // export.cardBg #1e1e24
  mdCodeSpanBg: 'rgb(40,40,46)', // one step above cardBg
  mdLink: 'rgb(129,162,190)', // mdLink #81a2be
  mdLinkText: 'rgb(138,190,183)', // teal accent (readable link label)
  mdStrong: 'rgb(240,198,116)', // heading-warm
  mdEmph: 'rgb(229,192,123)',
  mdDiffAdded: 'rgb(181,189,104)', // toolDiffAdded = green
  mdDiffRemoved: 'rgb(204,102,102)', // toolDiffRemoved = red
  mdDiffHunk: 'rgb(129,162,190)',
  mdDiffHeader: 'rgb(149,117,205)', // customMessageLabel #9575cd purple
  mdDiffContext: 'rgb(128,128,128)', // toolDiffContext = gray
  mdDiffAddedBg: 'rgb(40,50,40)', // toolSuccessBg #283228
  mdDiffRemovedBg: 'rgb(60,40,40)', // toolErrorBg #3c2828
  syntaxComment: 'rgb(106,153,85)', // #6A9955 (VS Code Dark+)
  syntaxKeyword: 'rgb(86,156,214)', // #569CD6
  syntaxFunction: 'rgb(220,220,170)', // #DCDCAA
  syntaxVariable: 'rgb(156,220,254)', // #9CDCFE
  syntaxString: 'rgb(206,145,120)', // #CE9178
  syntaxNumber: 'rgb(181,206,168)', // #B5CEA8
  syntaxType: 'rgb(78,201,176)', // #4EC9B0
  syntaxOperator: 'rgb(212,212,212)', // #D4D4D4
  syntaxPunctuation: 'rgb(212,212,212)', // #D4D4D4
  userMessageBackground: 'rgb(52,53,65)', // userMsgBg #343541
  userMessageBackgroundHover: 'rgb(64,65,79)',
  fastMode: 'rgb(255,120,20)',
};
