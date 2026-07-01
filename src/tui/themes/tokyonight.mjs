/**
 * src/tui/themes/tokyonight.mjs — Tokyo Night (Storm).
 *
 * Source: folke/tokyonight.nvim "storm" — bg #24283b, bgDark #1f2335,
 * fg #c0caf5, comment #565f89, blue #7aa2f7 (signature accent),
 * magenta #bb9af7, cyan #7dcfff, green #9ece6a, orange #ff9e64,
 * yellow #e0af68, red #f7768e, terminalBlack #414868.
 */
import { basePalette } from './base.mjs';

/** Tokyo Night Storm — soft blue/purple dark with neon markdown. */
export const tokyonightPalette = {
  ...basePalette,
  background: 'transparent', // bg #24283b
  claude: 'rgb(122,162,247)', // blue accent
  logo: 'rgb(160,190,255)', // welcome banner — brighter than accent
  claudeShimmer: 'rgb(160,190,255)', // lighter blue
  mixdogOrange: 'rgb(122,162,247)', // signature accent (blue)
  mixdogAmber: 'rgb(160,190,255)', // lighter accent
  mixdogIvory: 'rgb(192,202,245)', // fg
  spinnerGlyph: 'rgb(255,158,100)', // most-emphasized: orange
  spinnerText: 'rgb(255,158,100)',
  spinnerShimmer: 'rgb(255,180,130)',
  thinkingAccent: 'rgb(86,95,137)', // comment #565f89
  thinkingText: 'rgb(192,202,245)', // fg
  thinkingBase: 'rgb(86,95,137)', // comment
  thinkingGlow: 'rgb(215,222,255)', // brighter fg
  statusText: 'rgb(192,202,245)', // fg
  statusSubtle: 'rgb(86,95,137)', // comment
  timerText: 'rgb(86,95,137)', // comment
  text: 'rgb(192,202,245)', // fg #c0caf5
  inverseText: 'rgb(36,40,59)', // background
  selectionText: 'rgb(225,232,255)',
  selectionBackground: 'rgb(52,72,130)',
  inactive: 'rgb(86,95,137)', // comment
  subtle: 'rgb(86,95,137)', // comment
  promptBorder: 'rgb(86,95,137)', // comment (muted grey)
  success: 'rgb(158,206,106)', // green #9ece6a
  error: 'rgb(247,118,142)', // red #f7768e
  warning: 'rgb(255,158,100)', // orange #ff9e64
  suggestion: 'rgb(122,162,247)', // blue
  panelTitle: 'rgb(122,162,247)', // blue
  permission: 'rgb(247,118,142)', // red
  code: 'rgb(122,162,247)', // blue
  codeBlock: 'rgb(192,202,245)', // fg
  mdHeading: 'rgb(187,154,247)', // magenta #bb9af7
  mdCode: 'rgb(158,206,106)', // green
  mdCodeBlock: 'rgb(192,202,245)', // fg
  mdQuote: 'rgb(86,95,137)', // comment
  mdQuoteBorder: 'rgb(86,95,137)', // comment
  mdHr: 'rgb(86,95,137)', // comment
  mdListBullet: 'rgb(122,162,247)', // blue accent
  mdCodeBlockBorder: 'rgb(65,72,104)', // terminalBlack #414868
  mdCodeBlockBg: 'rgb(42,46,66)', // surface (lifted from bg)
  mdCodeSpanBg: 'rgb(50,55,77)', // one step above codeBlockBg
  mdLink: 'rgb(122,162,247)', // blue
  mdLinkText: 'rgb(125,207,255)', // cyan #7dcfff
  mdStrong: 'rgb(255,158,100)', // orange
  mdEmph: 'rgb(224,175,104)', // yellow #e0af68
  mdDiffAdded: 'rgb(158,206,106)', // green
  mdDiffRemoved: 'rgb(247,118,142)', // red
  mdDiffHunk: 'rgb(86,95,137)', // comment
  mdDiffHeader: 'rgb(187,154,247)', // magenta
  mdDiffContext: 'rgb(86,95,137)', // comment
  mdDiffAddedBg: 'rgb(32,48,40)', // dark green derived from bg
  mdDiffRemovedBg: 'rgb(55,34,44)', // dark red derived from bg
  syntaxComment: 'rgb(86,95,137)', // comment
  syntaxKeyword: 'rgb(187,154,247)', // magenta
  syntaxFunction: 'rgb(122,162,247)', // blue
  syntaxVariable: 'rgb(247,118,142)', // red
  syntaxString: 'rgb(158,206,106)', // green
  syntaxNumber: 'rgb(255,158,100)', // orange
  syntaxType: 'rgb(224,175,104)', // yellow
  syntaxOperator: 'rgb(125,207,255)', // cyan
  syntaxPunctuation: 'rgb(192,202,245)', // fg
  userMessageBackground: 'rgb(31,35,53)', // bgDark #1f2335
  userMessageBackgroundHover: 'rgb(65,72,104)', // terminalBlack #414868
  fastMode: 'rgb(255,150,70)', // vivid in-theme orange
};
