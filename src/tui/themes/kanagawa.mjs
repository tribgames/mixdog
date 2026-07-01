/**
 * src/tui/themes/kanagawa.mjs — Kanagawa (Wave).
 *
 * Source: rebelot/kanagawa.nvim "wave" — sumiInk3 #1F1F28 (bg),
 * fujiWhite #DCD7BA (fg), crystalBlue #7E9CD8 (signature accent),
 * oniViolet #957FB8, springGreen #98BB6C, carpYellow #E6C384,
 * springBlue #7FB4CA, surimiOrange #FFA066, peachRed #FF5D62,
 * waveRed #E46876, waveAqua2 #7AA89F, fujiGray #727169.
 */
import { basePalette } from './base.mjs';

/** Kanagawa Wave — muted ink dark with crystal-blue accent. */
export const kanagawaPalette = {
  ...basePalette,
  background: 'transparent', // sumiInk3 #1F1F28
  claude: 'rgb(210,126,153)', // sakuraPink accent (opencode)
  logo: 'rgb(232,156,182)', // welcome banner — brighter than accent
  claudeShimmer: 'rgb(156,171,202)', // springViolet2 #9CABCA (lighter accent)
  mixdogOrange: 'rgb(210,126,153)', // sakuraPink accent (opencode)
  mixdogAmber: 'rgb(156,171,202)', // lighter accent
  mixdogIvory: 'rgb(220,215,186)', // fujiWhite #DCD7BA
  spinnerGlyph: 'rgb(228,104,118)', // most-emphasized: waveRed
  spinnerText: 'rgb(228,104,118)',
  spinnerShimmer: 'rgb(255,140,150)',
  thinkingAccent: 'rgb(114,113,105)', // fujiGray #727169
  thinkingText: 'rgb(220,215,186)', // fg
  thinkingBase: 'rgb(114,113,105)', // fujiGray
  thinkingGlow: 'rgb(235,231,205)', // brighter fg
  statusText: 'rgb(220,215,186)', // fg
  statusSubtle: 'rgb(114,113,105)', // fujiGray
  timerText: 'rgb(114,113,105)', // fujiGray
  text: 'rgb(220,215,186)', // fujiWhite #DCD7BA
  inverseText: 'rgb(31,31,40)', // background
  selectionText: 'rgb(238,232,204)',
  selectionBackground: 'rgb(61,70,96)',
  inactive: 'rgb(114,113,105)', // fujiGray
  subtle: 'rgb(114,113,105)', // fujiGray
  promptBorder: 'rgb(114,113,105)', // fujiGray (muted grey)
  success: 'rgb(152,187,108)', // springGreen #98BB6C
  error: 'rgb(232,36,36)', // dragonRed #E82424
  warning: 'rgb(215,166,87)', // roninYellow #D7A657
  suggestion: 'rgb(126,156,216)', // crystalBlue
  panelTitle: 'rgb(210,126,153)', // sakuraPink
  permission: 'rgb(228,104,118)', // waveRed #E46876
  code: 'rgb(126,156,216)', // crystalBlue
  codeBlock: 'rgb(220,215,186)', // fg
  mdHeading: 'rgb(149,127,184)', // oniViolet
  mdCode: 'rgb(152,187,108)', // lotusGreen #98BB6C
  mdCodeBlock: 'rgb(220,215,186)', // fg
  mdQuote: 'rgb(114,113,105)', // fujiGray
  mdQuoteBorder: 'rgb(114,113,105)', // fujiGray
  mdHr: 'rgb(114,113,105)', // fujiGray
  mdListBullet: 'rgb(126,156,216)', // crystalBlue accent
  mdCodeBlockBorder: 'rgb(54,54,70)', // sumiInk5 #363646
  mdCodeBlockBg: 'rgb(42,42,55)', // sumiInk4 #2A2A37 (lifted)
  mdCodeSpanBg: 'rgb(54,54,70)', // sumiInk5 #363646
  mdLink: 'rgb(126,156,216)', // crystalBlue
  mdLinkText: 'rgb(118,148,106)', // waveAqua #76946A
  mdStrong: 'rgb(215,166,87)', // roninYellow #D7A657
  mdEmph: 'rgb(195,141,157)', // carpYellow opencode #C38D9D
  mdDiffAdded: 'rgb(152,187,108)', // springGreen
  mdDiffRemoved: 'rgb(255,93,98)', // peachRed
  mdDiffHunk: 'rgb(45,79,103)', // waveBlue #2D4F67
  mdDiffHeader: 'rgb(149,127,184)', // oniViolet #957FB8
  mdDiffContext: 'rgb(114,113,105)', // fujiGray
  mdDiffAddedBg: 'rgb(37,46,37)', // #252E25
  mdDiffRemovedBg: 'rgb(54,32,32)', // #362020
  syntaxComment: 'rgb(114,113,105)', // fujiGray
  syntaxKeyword: 'rgb(149,127,184)', // oniViolet
  syntaxFunction: 'rgb(126,156,216)', // crystalBlue
  syntaxVariable: 'rgb(220,215,186)', // fujiWhite
  syntaxString: 'rgb(152,187,108)', // springGreen
  syntaxNumber: 'rgb(215,166,87)', // roninYellow #D7A657
  syntaxType: 'rgb(195,141,157)', // carpYellow opencode #C38D9D
  syntaxOperator: 'rgb(210,126,153)', // sakuraPink
  syntaxPunctuation: 'rgb(220,215,186)', // fg
  userMessageBackground: 'rgb(42,42,55)', // sumiInk4 #2A2A37
  userMessageBackgroundHover: 'rgb(34,50,73)', // waveBlue1 #223249
  fastMode: 'rgb(255,158,59)', // roninYellow #FF9E3B (vivid in-theme orange)
};
