/**
 * src/tui/themes/warm.mjs — Warm (Claude Code style).
 *
 * Faithful port of claude-code's `darkTheme` (src/utils/theme.ts). Values are
 * taken verbatim from that palette where a 1:1 key exists: brand orange
 * `claude #d77757`, `claudeShimmer #eb9f7f`, blue-purple `permission/suggestion
 * #b1b9f9`, white body text, `subtle #505050`, semantic success/error/warning,
 * and the darkTheme diff tints. The spinner uses `claude`/`claudeShimmer` as
 * its glyph/shimmer (matching claude-code's `defaultColor='claude'`,
 * `defaultShimmerColor='claudeShimmer'`). Spreads `basePalette` first.
 */
import { basePalette } from './base.mjs';

/** Warm — Claude-style warm orange accent with bright body text. */
export const warmPalette = {
  ...basePalette,
  background: 'rgb(13,13,13)', // claude-code's bg is decorative cyan; the TUI surface stays opaque dark
  claude: 'rgb(215,119,87)', // darkTheme.claude #d77757 (brand orange)
  claudeShimmer: 'rgb(235,159,127)', // darkTheme.claudeShimmer #eb9f7f
  mixdogOrange: 'rgb(215,119,87)',
  mixdogAmber: 'rgb(235,159,127)',
  mixdogIvory: 'rgb(255,255,255)',
  spinnerGlyph: 'rgb(215,119,87)', // = claude (claude-code defaultColor='claude')
  spinnerText: 'rgb(215,119,87)',
  spinnerShimmer: 'rgb(235,159,127)', // = claudeShimmer (defaultShimmerColor='claudeShimmer')
  thinkingAccent: 'rgb(153,153,153)', // darkTheme.inactive #999999
  thinkingText: 'rgb(200,200,200)',
  thinkingBase: 'rgb(153,153,153)',
  thinkingGlow: 'rgb(225,225,225)',
  statusText: 'rgb(220,220,220)',
  statusSubtle: 'rgb(153,153,153)', // darkTheme.inactive
  timerText: 'rgb(153,153,153)',
  text: 'rgb(255,255,255)', // darkTheme.text — pure white body
  inverseText: 'rgb(0,0,0)', // darkTheme.inverseText
  selectionText: 'rgb(0,0,0)',
  selectionBackground: 'rgb(255,255,255)',
  inactive: 'rgb(153,153,153)', // darkTheme.inactive #999999
  subtle: 'rgb(80,80,80)', // darkTheme.subtle #505050
  promptBorder: 'rgb(136,136,136)', // darkTheme.promptBorder #888888
  success: 'rgb(78,186,101)', // darkTheme.success
  error: 'rgb(255,107,128)', // darkTheme.error
  warning: 'rgb(255,193,7)', // darkTheme.warning
  suggestion: 'rgb(177,185,249)', // darkTheme.suggestion #b1b9f9 (blue-purple)
  panelTitle: 'rgb(215,119,87)',
  permission: 'rgb(177,185,249)', // darkTheme.permission #b1b9f9
  code: 'rgb(177,185,249)', // blue-purple code accent (permission)
  codeBlock: 'rgb(200,200,200)', // plain light body (claude-code keeps code uncolored)
  mdHeading: 'rgb(235,159,127)',
  mdCode: 'rgb(177,185,249)', // blue-purple markdown code accent
  mdCodeBlock: 'rgb(200,200,200)',
  mdQuote: 'rgb(140,140,140)',
  mdQuoteBorder: 'rgb(140,140,140)',
  mdHr: 'rgb(140,140,140)',
  mdListBullet: 'rgb(177,185,249)',
  mdCodeBlockBorder: 'rgb(60,61,66)',
  mdCodeBlockBg: 'rgb(34,35,40)',
  mdCodeSpanBg: 'rgb(42,43,48)',
  mdLink: 'rgb(177,185,249)',
  mdLinkText: 'rgb(150,200,210)',
  mdStrong: 'rgb(235,159,127)',
  mdEmph: 'rgb(229,192,123)',
  mdDiffAdded: 'rgb(56,166,96)', // darkTheme.diffAddedWord #38a660
  mdDiffRemoved: 'rgb(179,89,107)', // darkTheme.diffRemovedWord #b3596b
  mdDiffHunk: 'rgb(150,160,200)',
  mdDiffHeader: 'rgb(177,185,249)',
  mdDiffContext: 'rgb(153,153,153)',
  mdDiffAddedBg: 'rgb(34,92,43)', // darkTheme.diffAdded #225c2b
  mdDiffRemovedBg: 'rgb(122,41,54)', // darkTheme.diffRemoved #7a2936
  syntaxComment: 'rgb(140,140,140)',
  syntaxKeyword: 'rgb(235,159,127)',
  syntaxFunction: 'rgb(177,185,249)',
  syntaxVariable: 'rgb(255,107,128)',
  syntaxString: 'rgb(140,200,150)',
  syntaxNumber: 'rgb(235,159,127)',
  syntaxType: 'rgb(229,192,123)',
  syntaxOperator: 'rgb(150,200,210)',
  syntaxPunctuation: 'rgb(220,220,220)',
  userMessageBackground: 'rgb(55,55,55)', // darkTheme.userMessageBackground
  userMessageBackgroundHover: 'rgb(70,70,70)', // darkTheme.userMessageBackgroundHover
  fastMode: 'rgb(255,120,20)', // darkTheme.fastMode
};
