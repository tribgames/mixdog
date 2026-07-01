/**
 * src/tui/themes/base.mjs — One Dark base palette (the full key set).
 *
 * Every TUI theme is defined as a COMPLETE set of `rgb(r,g,b)` string keys.
 * Non-default palettes spread this base first (`{ ...basePalette, ...overrides }`)
 * so a missing key can never leak the previous theme's color through the live
 * `Object.assign(theme, palette)` switch in theme.mjs.
 *
 * Source: One Dark (atom/joshdick) — bg0 #282c34, fg #abb2bf, blue #61afef
 * (signature accent), purple #c678dd, green #98c379, orange #d19a66,
 * yellow #e5c07b, cyan #56b6c2, red #e86671, grey #5c6370.
 */

/** One Dark — full key set; signature accent is blue (#61afef). */
export const basePalette = {
  background: 'transparent', // bg0 #282c34
  claude: 'rgb(97,175,239)', // blue accent
  logo: 'rgb(120,195,255)', // welcome banner — brighter than the accent
  claudeShimmer: 'rgb(140,200,245)', // lighter blue
  mixdogOrange: 'rgb(97,175,239)', // signature accent (blue)
  mixdogAmber: 'rgb(140,200,245)', // lighter accent
  mixdogIvory: 'rgb(171,178,191)', // fg #abb2bf
  spinnerGlyph: 'rgb(97,175,239)',
  spinnerText: 'rgb(97,175,239)',
  spinnerShimmer: 'rgb(140,200,245)',
  thinkingAccent: 'rgb(132,139,152)', // light_grey #848b98
  thinkingText: 'rgb(171,178,191)', // fg
  thinkingBase: 'rgb(92,99,112)', // grey #5c6370
  thinkingGlow: 'rgb(200,206,216)', // brighter fg
  statusText: 'rgb(171,178,191)', // fg
  statusSubtle: 'rgb(132,139,152)', // light_grey
  timerText: 'rgb(132,139,152)', // light_grey
  text: 'rgb(171,178,191)', // fg
  inverseText: 'rgb(40,44,52)', // background
  // Picker/list focus row. This is intentionally stronger than text selection.
  selectionText: 'rgb(230,238,255)', // readable on selectionBackground
  selectionBackground: 'rgb(38,79,120)', // classic dark-mode selection blue
  // Mouse/drag text-selection overlay. Claude Code keeps this role separate:
  // it replaces the cell background while text remains copy-highlight readable.
  selectionHighlightText: 'rgb(255,255,255)',
  selectionHighlightBackground: 'rgb(38,79,120)',
  inactive: 'rgb(132,139,152)', // light_grey
  subtle: 'rgb(132,139,152)', // light_grey
  promptBorder: 'rgb(92,99,112)', // grey
  success: 'rgb(152,195,121)', // green #98c379
  error: 'rgb(224,108,117)', // red #e06c75
  warning: 'rgb(229,192,123)', // yellow #e5c07b
  suggestion: 'rgb(97,175,239)', // blue
  panelTitle: 'rgb(97,175,239)', // blue
  permission: 'rgb(224,108,117)', // red
  code: 'rgb(97,175,239)', // blue
  codeBlock: 'rgb(171,178,191)', // fg
  mdHeading: 'rgb(229,192,123)', // yellow
  mdCode: 'rgb(152,195,121)', // green
  mdCodeBlock: 'rgb(171,178,191)', // fg
  mdQuote: 'rgb(132,139,152)', // light_grey
  mdQuoteBorder: 'rgb(132,139,152)', // light_grey
  mdHr: 'rgb(132,139,152)', // light_grey
  mdListBullet: 'rgb(97,175,239)', // blue accent
  mdCodeBlockBorder: 'rgb(59,63,76)', // bg3 #3b3f4c
  mdCodeBlockBg: 'rgb(49,53,63)', // bg1 #31353f
  mdCodeSpanBg: 'rgb(57,63,74)', // bg2 #393f4a
  mdLink: 'rgb(97,175,239)', // blue
  mdLinkText: 'rgb(86,182,194)', // cyan #56b6c2
  mdStrong: 'rgb(209,154,102)', // orange #d19a66
  mdEmph: 'rgb(229,192,123)', // yellow
  mdDiffAdded: 'rgb(152,195,121)', // green
  mdDiffRemoved: 'rgb(224,108,117)', // red
  mdDiffHunk: 'rgb(92,99,112)', // grey
  mdDiffHeader: 'rgb(198,120,221)', // purple #c678dd
  mdDiffContext: 'rgb(132,139,152)', // light_grey
  mdDiffAddedBg: 'rgb(49,57,43)', // diff_add #31392b
  mdDiffRemovedBg: 'rgb(56,43,44)', // diff_delete #382b2c
  syntaxComment: 'rgb(92,99,112)', // grey
  syntaxKeyword: 'rgb(198,120,221)', // purple
  syntaxFunction: 'rgb(97,175,239)', // blue
  syntaxVariable: 'rgb(224,108,117)', // red
  syntaxString: 'rgb(152,195,121)', // green
  syntaxNumber: 'rgb(209,154,102)', // orange
  syntaxType: 'rgb(229,192,123)', // yellow
  syntaxOperator: 'rgb(86,182,194)', // cyan
  syntaxPunctuation: 'rgb(171,178,191)', // fg
  userMessageBackground: 'rgb(49,53,63)', // bg1
  userMessageBackgroundHover: 'rgb(57,63,74)', // bg2
  fastMode: 'rgb(255,140,60)', // vivid in-theme orange
};
