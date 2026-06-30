/**
 * src/tui/theme.mjs — active-theme registry for the React/ink TUI.
 *
 * ink accepts `rgb(r,g,b)` strings directly on the `color`/`backgroundColor`
 * props, so these are plain strings (no escape wrapping needed — ink emits the
 * SGR and honors NO_COLOR/non-TTY itself).
 *
 * The exported `theme` is a SINGLETON object: every TUI module does
 * `import { theme } from '../theme.mjs'` and reads live keys off it. A theme
 * switch mutates this object in-place (`Object.assign(theme, palette)`) so the
 * existing imports observe the new colors without re-importing. A monotonic
 * `themeVersion` lets modules that cache derived values (chalk colorizers,
 * parsed RGB tuples) invalidate when the active theme changes.
 *
 * The setting persists under `ui.theme` in mixdog-config.json. The config
 * module is imported lazily through a dist-aware dynamic specifier (esbuild
 * leaves dynamic-import strings alone), so this color module stays free of a
 * static keychain/config dependency.
 */

// ── Palettes ──────────────────────────────────────────────────────────────
// Each palette is a COMPLETE set of theme keys. Non-default palettes spread the
// Mixdog base first so a missing key can never leak the previous theme's color
// through Object.assign.

/** Default Mixdog dark palette (preserves the original colors verbatim). */
const mixdogPalette = {
  background: 'rgb(13,13,13)', // opaque TUI surface; masks clipped scrollback behind fixed rows
  claude: 'rgb(215,119,87)', // orange title/header accent
  claudeShimmer: 'rgb(235,159,127)',
  mixdogOrange: 'rgb(215,119,87)',
  mixdogAmber: 'rgb(235,159,127)',
  mixdogIvory: 'rgb(232,226,215)',
  spinnerGlyph: 'rgb(215,119,87)',
  spinnerText: 'rgb(215,119,87)',
  spinnerShimmer: 'rgb(255,214,186)',
  thinkingAccent: 'rgb(168,168,168)',
  thinkingText: 'rgb(198,198,198)', // live reasoning body text
  thinkingBase: 'rgb(168,168,168)',  // quiet base; thinking rows should not compete with answers
  thinkingGlow: 'rgb(220,220,220)', // subtle highlight for the thinking shimmer
  statusText: 'rgb(198,198,198)',
  statusSubtle: 'rgb(168,168,168)',
  timerText: 'rgb(168,168,168)', // live elapsed timer — metadata weight, no bright accent
  text: 'rgb(198,198,198)', // primary text
  inverseText: 'rgb(0,0,0)', // text on an inverted (light) background
  selectionText: 'rgb(0,0,0)', // text inside an active drag/copy selection
  selectionBackground: 'rgb(245,245,245)', // selection highlight band
  inactive: 'rgb(136,136,136)', // secondary text
  subtle: 'rgb(140,140,140)', // helper text / quiet rules
  promptBorder: 'rgb(158,158,158)', // input border / prompt
  success: 'rgb(28,150,78)', // muted green accent
  error: 'rgb(210,60,76)', // muted red accent
  warning: 'rgb(204,157,44)', // muted amber
  suggestion: 'rgb(47,127,255)', // path/link blue
  panelTitle: 'rgb(215,119,87)', // panel/picker titles stay orange
  permission: 'rgb(239,68,88)', // permission red
  code: 'rgb(47,127,255)', // inline code/link accent
  codeBlock: 'rgb(136,190,142)', // code block body
  // Markdown (pi dark.json md* tokens — headings/code/quotes only in format-token)
  mdHeading: 'rgb(240,198,116)', // #f0c674 warm yellow-beige
  mdCode: 'rgb(138,190,183)', // #8abeb7 muted teal (inline codespan)
  mdCodeBlock: 'rgb(181,189,104)', // #b5bd68 muted green (fenced blocks)
  mdQuote: 'rgb(128,128,128)', // #808080 quote body
  mdQuoteBorder: 'rgb(128,128,128)', // blockquote bar
  mdHr: 'rgb(128,128,128)', // horizontal rule
  mdListBullet: 'rgb(138,190,183)', // list markers (pi accent)
  // Markdown extras (fenced fences / inline links / emphasis) — warm dark base.
  mdCodeBlockBorder: 'rgb(110,110,110)', // ``` fence + lang label rule
  mdLink: 'rgb(47,127,255)', // link URL (suggestion blue)
  mdLinkText: 'rgb(138,190,183)', // link label (teal accent)
  mdStrong: 'rgb(235,159,127)', // **bold** warm amber
  mdEmph: 'rgb(229,192,123)', // *italic* soft yellow
  // Diff / patch rendering (OpenCode + Codex conventions, ANSI-safe).
  mdDiffAdded: 'rgb(120,200,130)', // + lines (green)
  mdDiffRemoved: 'rgb(224,108,117)', // - lines (red)
  mdDiffHunk: 'rgb(130,139,184)', // @@ hunk markers
  mdDiffHeader: 'rgb(170,150,210)', // ---/+++ / diff --git headers
  mdDiffContext: 'rgb(140,140,140)', // unchanged context lines
  mdDiffAddedBg: 'rgb(33,58,43)', // #213A2B muted add tint (codex dark)
  mdDiffRemovedBg: 'rgb(74,34,29)', // #4A221D muted del tint (codex dark)
  // Lightweight syntax highlight palette (regex token classes).
  syntaxComment: 'rgb(128,128,128)',
  syntaxKeyword: 'rgb(215,119,87)', // brand orange
  syntaxFunction: 'rgb(138,190,183)', // teal
  syntaxVariable: 'rgb(224,108,117)', // red-pink
  syntaxString: 'rgb(181,189,104)', // #b5bd68 green
  syntaxNumber: 'rgb(235,159,127)', // amber
  syntaxType: 'rgb(229,192,123)', // yellow
  syntaxOperator: 'rgb(138,190,183)', // teal/cyan
  syntaxPunctuation: 'rgb(198,198,198)', // body text
  userMessageBackground: 'rgb(108,108,108)', // user prompt band
  userMessageBackgroundHover: 'rgb(120,120,120)', // hover variant
  fastMode: 'rgb(255,120,20)',
};

/** Teal dark — teal accent, soft body. */
const piDarkPalette = {
  ...mixdogPalette,
  claude: 'rgb(138,190,183)', // pi accent teal as the title/header accent
  claudeShimmer: 'rgb(170,214,208)',
  spinnerGlyph: 'rgb(138,190,183)',
  spinnerText: 'rgb(138,190,183)',
  spinnerShimmer: 'rgb(170,214,208)',
  panelTitle: 'rgb(138,190,183)',
  thinkingText: 'rgb(190,190,190)',
  statusText: 'rgb(212,212,212)',
  text: 'rgb(212,212,212)', // #d4d4d4
  promptBorder: 'rgb(120,128,140)',
  success: 'rgb(181,189,104)', // #b5bd68
  error: 'rgb(204,102,102)', // #cc6666
  warning: 'rgb(255,255,0)', // #ffff00
  suggestion: 'rgb(95,135,255)', // #5f87ff
  permission: 'rgb(204,102,102)',
  selectionText: 'rgb(26,27,33)',
  selectionBackground: 'rgb(212,212,212)',
  code: 'rgb(95,135,255)',
  codeBlock: 'rgb(181,189,104)',
  mdCodeBlockBorder: 'rgb(96,104,116)',
  mdLink: 'rgb(95,135,255)',
  mdLinkText: 'rgb(138,190,183)',
  mdStrong: 'rgb(181,189,104)',
  mdEmph: 'rgb(229,192,123)',
  mdDiffAdded: 'rgb(181,189,104)', // #b5bd68
  mdDiffRemoved: 'rgb(204,102,102)', // #cc6666
  mdDiffHunk: 'rgb(129,162,190)',
  mdDiffHeader: 'rgb(178,148,187)',
  mdDiffContext: 'rgb(150,150,150)',
  mdDiffAddedBg: 'rgb(30,46,34)',
  mdDiffRemovedBg: 'rgb(58,32,32)',
  syntaxKeyword: 'rgb(178,148,187)', // pi mauve keyword
  syntaxFunction: 'rgb(129,162,190)', // soft blue
  syntaxString: 'rgb(181,189,104)',
  syntaxNumber: 'rgb(222,147,95)',
  syntaxOperator: 'rgb(138,190,183)',
  userMessageBackground: 'rgb(52,53,65)', // #343541
  userMessageBackgroundHover: 'rgb(64,65,79)',
};

/** Warm dark — orange accent, bright body text. */
const claudeDarkPalette = {
  ...mixdogPalette,
  background: 'rgb(13,13,13)', // keep the opaque dark surface (Claude's bg is decorative)
  claude: 'rgb(215,119,87)',
  claudeShimmer: 'rgb(235,159,127)',
  spinnerGlyph: 'rgb(215,119,87)',
  spinnerText: 'rgb(215,119,87)',
  spinnerShimmer: 'rgb(255,214,186)',
  panelTitle: 'rgb(215,119,87)',
  text: 'rgb(235,235,235)',
  thinkingText: 'rgb(200,200,200)',
  thinkingBase: 'rgb(153,153,153)',
  thinkingGlow: 'rgb(225,225,225)',
  statusText: 'rgb(220,220,220)',
  statusSubtle: 'rgb(150,150,150)',
  timerText: 'rgb(150,150,150)',
  inactive: 'rgb(153,153,153)',
  subtle: 'rgb(120,120,120)',
  promptBorder: 'rgb(136,136,136)',
  success: 'rgb(78,186,101)',
  error: 'rgb(255,107,128)',
  warning: 'rgb(255,193,7)',
  suggestion: 'rgb(177,185,249)', // blue-purple
  permission: 'rgb(177,185,249)',
  selectionText: 'rgb(13,13,13)',
  selectionBackground: 'rgb(235,235,235)',
  code: 'rgb(177,185,249)',
  codeBlock: 'rgb(200,200,200)', // plain code body (no brand coloring)
  mdHeading: 'rgb(235,159,127)', // warm heading accent
  mdCode: 'rgb(177,185,249)', // inline codespan = permission/suggestion blue-purple
  mdCodeBlock: 'rgb(200,200,200)', // fenced blocks stay plain
  mdQuote: 'rgb(140,140,140)',
  mdQuoteBorder: 'rgb(140,140,140)',
  mdHr: 'rgb(140,140,140)',
  mdListBullet: 'rgb(177,185,249)',
  mdCodeBlockBorder: 'rgb(120,120,120)',
  mdLink: 'rgb(177,185,249)',
  mdLinkText: 'rgb(150,200,210)',
  mdStrong: 'rgb(235,159,127)',
  mdEmph: 'rgb(229,192,123)',
  mdDiffAdded: 'rgb(78,186,101)',
  mdDiffRemoved: 'rgb(255,107,128)',
  mdDiffHunk: 'rgb(150,160,200)',
  mdDiffHeader: 'rgb(177,185,249)',
  mdDiffContext: 'rgb(150,150,150)',
  mdDiffAddedBg: 'rgb(28,46,34)',
  mdDiffRemovedBg: 'rgb(58,30,36)',
  syntaxComment: 'rgb(140,140,140)',
  syntaxKeyword: 'rgb(235,159,127)',
  syntaxFunction: 'rgb(177,185,249)',
  syntaxVariable: 'rgb(255,107,128)',
  syntaxString: 'rgb(140,200,150)',
  syntaxNumber: 'rgb(235,159,127)',
  syntaxType: 'rgb(229,192,123)',
  syntaxOperator: 'rgb(150,200,210)',
  syntaxPunctuation: 'rgb(220,220,220)',
  userMessageBackground: 'rgb(55,55,55)',
  userMessageBackgroundHover: 'rgb(70,70,70)',
  fastMode: 'rgb(255,120,20)',
};

/** Violet dark — classic purple/pink/cyan contrast. */
const draculaPalette = {
  ...mixdogPalette,
  background: 'rgb(40,42,54)',
  claude: 'rgb(189,147,249)', // purple
  claudeShimmer: 'rgb(212,182,251)',
  spinnerGlyph: 'rgb(189,147,249)',
  spinnerText: 'rgb(189,147,249)',
  spinnerShimmer: 'rgb(212,182,251)',
  panelTitle: 'rgb(189,147,249)',
  text: 'rgb(248,248,242)',
  thinkingText: 'rgb(180,180,200)',
  thinkingBase: 'rgb(98,114,164)',
  thinkingGlow: 'rgb(220,220,235)',
  statusText: 'rgb(230,230,235)',
  statusSubtle: 'rgb(98,114,164)',
  timerText: 'rgb(98,114,164)',
  inactive: 'rgb(98,114,164)',
  subtle: 'rgb(98,114,164)',
  promptBorder: 'rgb(98,114,164)',
  success: 'rgb(80,250,123)', // green
  error: 'rgb(255,85,85)', // red
  warning: 'rgb(241,250,140)', // yellow
  suggestion: 'rgb(139,233,253)', // cyan
  permission: 'rgb(255,85,85)',
  selectionText: 'rgb(40,42,54)',
  selectionBackground: 'rgb(248,248,242)',
  code: 'rgb(139,233,253)',
  codeBlock: 'rgb(248,248,242)',
  mdHeading: 'rgb(189,147,249)',
  mdCode: 'rgb(80,250,123)',
  mdCodeBlock: 'rgb(248,248,242)',
  mdQuote: 'rgb(98,114,164)',
  mdQuoteBorder: 'rgb(98,114,164)',
  mdHr: 'rgb(98,114,164)',
  mdListBullet: 'rgb(189,147,249)',
  mdCodeBlockBorder: 'rgb(68,71,90)',
  mdLink: 'rgb(139,233,253)',
  mdLinkText: 'rgb(255,121,198)', // pink
  mdStrong: 'rgb(255,184,108)', // orange
  mdEmph: 'rgb(241,250,140)',
  mdDiffAdded: 'rgb(80,250,123)',
  mdDiffRemoved: 'rgb(255,85,85)',
  mdDiffHunk: 'rgb(98,114,164)',
  mdDiffHeader: 'rgb(255,121,198)',
  mdDiffContext: 'rgb(98,114,164)',
  mdDiffAddedBg: 'rgb(26,58,26)',
  mdDiffRemovedBg: 'rgb(58,26,26)',
  syntaxComment: 'rgb(98,114,164)',
  syntaxKeyword: 'rgb(255,121,198)',
  syntaxFunction: 'rgb(80,250,123)',
  syntaxVariable: 'rgb(248,248,242)',
  syntaxString: 'rgb(241,250,140)',
  syntaxNumber: 'rgb(189,147,249)',
  syntaxType: 'rgb(139,233,253)',
  syntaxOperator: 'rgb(255,121,198)',
  syntaxPunctuation: 'rgb(248,248,242)',
  userMessageBackground: 'rgb(68,71,90)',
  userMessageBackgroundHover: 'rgb(82,85,104)',
};

/** Midnight dark — soft blue/purple contrast. */
const tokyonightPalette = {
  ...mixdogPalette,
  background: 'rgb(26,27,38)',
  claude: 'rgb(130,170,255)', // blue
  claudeShimmer: 'rgb(170,198,255)',
  spinnerGlyph: 'rgb(130,170,255)',
  spinnerText: 'rgb(130,170,255)',
  spinnerShimmer: 'rgb(170,198,255)',
  panelTitle: 'rgb(130,170,255)',
  text: 'rgb(200,211,245)',
  thinkingText: 'rgb(170,180,210)',
  thinkingBase: 'rgb(130,139,184)',
  thinkingGlow: 'rgb(210,218,250)',
  statusText: 'rgb(200,211,245)',
  statusSubtle: 'rgb(130,139,184)',
  timerText: 'rgb(130,139,184)',
  inactive: 'rgb(130,139,184)',
  subtle: 'rgb(115,122,162)',
  promptBorder: 'rgb(115,122,162)',
  success: 'rgb(195,232,141)',
  error: 'rgb(255,117,127)',
  warning: 'rgb(255,150,108)',
  suggestion: 'rgb(130,170,255)',
  permission: 'rgb(255,117,127)',
  selectionText: 'rgb(26,27,38)',
  selectionBackground: 'rgb(200,211,245)',
  code: 'rgb(130,170,255)',
  codeBlock: 'rgb(200,211,245)',
  mdHeading: 'rgb(192,153,255)', // purple
  mdCode: 'rgb(195,232,141)', // green
  mdCodeBlock: 'rgb(200,211,245)',
  mdQuote: 'rgb(255,199,119)',
  mdQuoteBorder: 'rgb(130,139,184)',
  mdHr: 'rgb(130,139,184)',
  mdListBullet: 'rgb(130,170,255)',
  mdCodeBlockBorder: 'rgb(84,92,126)',
  mdLink: 'rgb(130,170,255)',
  mdLinkText: 'rgb(134,225,252)', // cyan
  mdStrong: 'rgb(255,150,108)', // orange
  mdEmph: 'rgb(255,199,119)', // yellow
  mdDiffAdded: 'rgb(79,214,190)',
  mdDiffRemoved: 'rgb(197,59,83)',
  mdDiffHunk: 'rgb(130,139,184)',
  mdDiffHeader: 'rgb(192,153,255)',
  mdDiffContext: 'rgb(130,139,184)',
  mdDiffAddedBg: 'rgb(32,48,59)',
  mdDiffRemovedBg: 'rgb(55,34,44)',
  syntaxComment: 'rgb(130,139,184)',
  syntaxKeyword: 'rgb(192,153,255)',
  syntaxFunction: 'rgb(130,170,255)',
  syntaxVariable: 'rgb(255,117,127)',
  syntaxString: 'rgb(195,232,141)',
  syntaxNumber: 'rgb(255,150,108)',
  syntaxType: 'rgb(255,199,119)',
  syntaxOperator: 'rgb(134,225,252)',
  syntaxPunctuation: 'rgb(200,211,245)',
  userMessageBackground: 'rgb(34,36,54)',
  userMessageBackgroundHover: 'rgb(46,49,71)',
};

/** Frost dark — cool arctic blue/teal contrast. */
const nordPalette = {
  ...mixdogPalette,
  background: 'rgb(46,52,64)',
  claude: 'rgb(136,192,208)', // nord8 frost
  claudeShimmer: 'rgb(168,212,224)',
  spinnerGlyph: 'rgb(136,192,208)',
  spinnerText: 'rgb(136,192,208)',
  spinnerShimmer: 'rgb(168,212,224)',
  panelTitle: 'rgb(136,192,208)',
  text: 'rgb(236,239,244)',
  thinkingText: 'rgb(200,206,218)',
  thinkingBase: 'rgb(139,149,167)',
  thinkingGlow: 'rgb(226,230,238)',
  statusText: 'rgb(216,222,233)',
  statusSubtle: 'rgb(139,149,167)',
  timerText: 'rgb(139,149,167)',
  inactive: 'rgb(139,149,167)',
  subtle: 'rgb(118,128,146)',
  promptBorder: 'rgb(76,86,106)',
  success: 'rgb(163,190,140)',
  error: 'rgb(191,97,106)',
  warning: 'rgb(208,135,112)',
  suggestion: 'rgb(129,161,193)',
  permission: 'rgb(191,97,106)',
  selectionText: 'rgb(46,52,64)',
  selectionBackground: 'rgb(236,239,244)',
  code: 'rgb(129,161,193)',
  codeBlock: 'rgb(216,222,233)',
  mdHeading: 'rgb(136,192,208)',
  mdCode: 'rgb(163,190,140)',
  mdCodeBlock: 'rgb(216,222,233)',
  mdQuote: 'rgb(139,149,167)',
  mdQuoteBorder: 'rgb(139,149,167)',
  mdHr: 'rgb(139,149,167)',
  mdListBullet: 'rgb(136,192,208)',
  mdCodeBlockBorder: 'rgb(67,76,94)',
  mdLink: 'rgb(129,161,193)',
  mdLinkText: 'rgb(143,188,187)',
  mdStrong: 'rgb(235,203,139)',
  mdEmph: 'rgb(208,135,112)',
  mdDiffAdded: 'rgb(163,190,140)',
  mdDiffRemoved: 'rgb(191,97,106)',
  mdDiffHunk: 'rgb(139,149,167)',
  mdDiffHeader: 'rgb(180,142,173)',
  mdDiffContext: 'rgb(139,149,167)',
  mdDiffAddedBg: 'rgb(50,62,52)',
  mdDiffRemovedBg: 'rgb(70,52,56)',
  syntaxComment: 'rgb(139,149,167)',
  syntaxKeyword: 'rgb(129,161,193)',
  syntaxFunction: 'rgb(136,192,208)',
  syntaxVariable: 'rgb(143,188,187)',
  syntaxString: 'rgb(163,190,140)',
  syntaxNumber: 'rgb(180,142,173)',
  syntaxType: 'rgb(143,188,187)',
  syntaxOperator: 'rgb(129,161,193)',
  syntaxPunctuation: 'rgb(216,222,233)',
  userMessageBackground: 'rgb(67,76,94)',
  userMessageBackgroundHover: 'rgb(76,86,106)',
};

/** Earth dark — retro warm earthy contrast. */
const gruvboxPalette = {
  ...mixdogPalette,
  background: 'rgb(40,40,40)',
  claude: 'rgb(131,165,152)', // blue-bright
  claudeShimmer: 'rgb(166,194,184)',
  spinnerGlyph: 'rgb(131,165,152)',
  spinnerText: 'rgb(131,165,152)',
  spinnerShimmer: 'rgb(166,194,184)',
  panelTitle: 'rgb(131,165,152)',
  text: 'rgb(235,219,178)',
  thinkingText: 'rgb(213,198,161)',
  thinkingBase: 'rgb(146,131,116)',
  thinkingGlow: 'rgb(240,228,196)',
  statusText: 'rgb(235,219,178)',
  statusSubtle: 'rgb(146,131,116)',
  timerText: 'rgb(146,131,116)',
  inactive: 'rgb(146,131,116)',
  subtle: 'rgb(146,131,116)',
  promptBorder: 'rgb(102,92,84)',
  success: 'rgb(184,187,38)',
  error: 'rgb(251,73,52)',
  warning: 'rgb(254,128,25)',
  suggestion: 'rgb(131,165,152)',
  permission: 'rgb(251,73,52)',
  selectionText: 'rgb(40,40,40)',
  selectionBackground: 'rgb(235,219,178)',
  code: 'rgb(142,192,124)',
  codeBlock: 'rgb(235,219,178)',
  mdHeading: 'rgb(131,165,152)',
  mdCode: 'rgb(250,189,47)',
  mdCodeBlock: 'rgb(235,219,178)',
  mdQuote: 'rgb(146,131,116)',
  mdQuoteBorder: 'rgb(146,131,116)',
  mdHr: 'rgb(146,131,116)',
  mdListBullet: 'rgb(131,165,152)',
  mdCodeBlockBorder: 'rgb(80,73,69)',
  mdLink: 'rgb(142,192,124)',
  mdLinkText: 'rgb(184,187,38)',
  mdStrong: 'rgb(254,128,25)',
  mdEmph: 'rgb(211,134,155)',
  mdDiffAdded: 'rgb(152,151,26)',
  mdDiffRemoved: 'rgb(204,36,29)',
  mdDiffHunk: 'rgb(104,157,106)',
  mdDiffHeader: 'rgb(211,134,155)',
  mdDiffContext: 'rgb(146,131,116)',
  mdDiffAddedBg: 'rgb(50,48,47)',
  mdDiffRemovedBg: 'rgb(50,41,41)',
  syntaxComment: 'rgb(146,131,116)',
  syntaxKeyword: 'rgb(251,73,52)',
  syntaxFunction: 'rgb(184,187,38)',
  syntaxVariable: 'rgb(131,165,152)',
  syntaxString: 'rgb(250,189,47)',
  syntaxNumber: 'rgb(211,134,155)',
  syntaxType: 'rgb(142,192,124)',
  syntaxOperator: 'rgb(254,128,25)',
  syntaxPunctuation: 'rgb(235,219,178)',
  userMessageBackground: 'rgb(80,73,69)',
  userMessageBackgroundHover: 'rgb(102,92,84)',
};

/** Pastel dark — gentle violet/blue contrast. */
const catppuccinPalette = {
  ...mixdogPalette,
  background: 'rgb(30,30,46)',
  claude: 'rgb(137,180,250)', // blue
  claudeShimmer: 'rgb(180,190,254)',
  spinnerGlyph: 'rgb(137,180,250)',
  spinnerText: 'rgb(137,180,250)',
  spinnerShimmer: 'rgb(180,190,254)',
  panelTitle: 'rgb(137,180,250)',
  text: 'rgb(205,214,244)',
  thinkingText: 'rgb(186,194,222)',
  thinkingBase: 'rgb(147,153,178)',
  thinkingGlow: 'rgb(215,222,250)',
  statusText: 'rgb(205,214,244)',
  statusSubtle: 'rgb(147,153,178)',
  timerText: 'rgb(147,153,178)',
  inactive: 'rgb(147,153,178)',
  subtle: 'rgb(127,132,156)',
  promptBorder: 'rgb(88,91,112)',
  success: 'rgb(166,227,161)',
  error: 'rgb(243,139,168)',
  warning: 'rgb(249,226,175)',
  suggestion: 'rgb(137,180,250)',
  permission: 'rgb(243,139,168)',
  selectionText: 'rgb(30,30,46)',
  selectionBackground: 'rgb(205,214,244)',
  code: 'rgb(166,227,161)',
  codeBlock: 'rgb(205,214,244)',
  mdHeading: 'rgb(203,166,247)', // mauve
  mdCode: 'rgb(166,227,161)',
  mdCodeBlock: 'rgb(205,214,244)',
  mdQuote: 'rgb(249,226,175)',
  mdQuoteBorder: 'rgb(147,153,178)',
  mdHr: 'rgb(166,173,200)',
  mdListBullet: 'rgb(137,180,250)',
  mdCodeBlockBorder: 'rgb(49,50,68)',
  mdLink: 'rgb(137,180,250)',
  mdLinkText: 'rgb(137,220,235)', // sky
  mdStrong: 'rgb(250,179,135)', // peach
  mdEmph: 'rgb(249,226,175)',
  mdDiffAdded: 'rgb(166,227,161)',
  mdDiffRemoved: 'rgb(243,139,168)',
  mdDiffHunk: 'rgb(250,179,135)',
  mdDiffHeader: 'rgb(203,166,247)',
  mdDiffContext: 'rgb(147,153,178)',
  mdDiffAddedBg: 'rgb(36,49,43)',
  mdDiffRemovedBg: 'rgb(60,42,50)',
  syntaxComment: 'rgb(147,153,178)',
  syntaxKeyword: 'rgb(203,166,247)',
  syntaxFunction: 'rgb(137,180,250)',
  syntaxVariable: 'rgb(243,139,168)',
  syntaxString: 'rgb(166,227,161)',
  syntaxNumber: 'rgb(250,179,135)',
  syntaxType: 'rgb(249,226,175)',
  syntaxOperator: 'rgb(137,220,235)',
  syntaxPunctuation: 'rgb(205,214,244)',
  userMessageBackground: 'rgb(49,50,68)',
  userMessageBackgroundHover: 'rgb(69,71,90)',
};

/** Forest dark — soft natural green contrast. */
const everforestPalette = {
  ...mixdogPalette,
  background: 'rgb(45,53,59)',
  claude: 'rgb(167,192,128)', // green
  claudeShimmer: 'rgb(193,212,162)',
  spinnerGlyph: 'rgb(167,192,128)',
  spinnerText: 'rgb(167,192,128)',
  spinnerShimmer: 'rgb(193,212,162)',
  panelTitle: 'rgb(167,192,128)',
  text: 'rgb(211,198,170)',
  thinkingText: 'rgb(189,178,153)',
  thinkingBase: 'rgb(122,132,120)',
  thinkingGlow: 'rgb(220,210,185)',
  statusText: 'rgb(211,198,170)',
  statusSubtle: 'rgb(122,132,120)',
  timerText: 'rgb(122,132,120)',
  inactive: 'rgb(122,132,120)',
  subtle: 'rgb(122,132,120)',
  promptBorder: 'rgb(133,146,137)',
  success: 'rgb(167,192,128)',
  error: 'rgb(230,126,128)',
  warning: 'rgb(230,152,117)',
  suggestion: 'rgb(127,187,179)',
  permission: 'rgb(230,126,128)',
  selectionText: 'rgb(45,53,59)',
  selectionBackground: 'rgb(211,198,170)',
  code: 'rgb(131,192,146)',
  codeBlock: 'rgb(211,198,170)',
  mdHeading: 'rgb(214,153,182)', // purple
  mdCode: 'rgb(167,192,128)',
  mdCodeBlock: 'rgb(211,198,170)',
  mdQuote: 'rgb(219,188,127)',
  mdQuoteBorder: 'rgb(122,132,120)',
  mdHr: 'rgb(122,132,120)',
  mdListBullet: 'rgb(167,192,128)',
  mdCodeBlockBorder: 'rgb(52,63,68)',
  mdLink: 'rgb(167,192,128)',
  mdLinkText: 'rgb(131,192,146)', // cyan
  mdStrong: 'rgb(230,152,117)', // orange
  mdEmph: 'rgb(219,188,127)', // yellow
  mdDiffAdded: 'rgb(167,192,128)',
  mdDiffRemoved: 'rgb(230,126,128)',
  mdDiffHunk: 'rgb(131,192,146)',
  mdDiffHeader: 'rgb(214,153,182)',
  mdDiffContext: 'rgb(122,132,120)',
  mdDiffAddedBg: 'rgb(40,54,46)',
  mdDiffRemovedBg: 'rgb(58,42,44)',
  syntaxComment: 'rgb(122,132,120)',
  syntaxKeyword: 'rgb(214,153,182)',
  syntaxFunction: 'rgb(167,192,128)',
  syntaxVariable: 'rgb(230,126,128)',
  syntaxString: 'rgb(167,192,128)',
  syntaxNumber: 'rgb(230,152,117)',
  syntaxType: 'rgb(219,188,127)',
  syntaxOperator: 'rgb(131,192,146)',
  syntaxPunctuation: 'rgb(211,198,170)',
  userMessageBackground: 'rgb(52,63,68)',
  userMessageBackgroundHover: 'rgb(61,72,77)',
};

/** Light — near-white surface with high-contrast dark text. */
const whitePalette = {
  ...mixdogPalette,
  background: 'rgb(250,250,250)',
  text: 'rgb(28,28,30)',
  statusText: 'rgb(40,40,42)',
  statusSubtle: 'rgb(120,120,124)',
  thinkingText: 'rgb(60,60,64)',
  thinkingAccent: 'rgb(110,110,116)',
  thinkingBase: 'rgb(120,120,126)',
  thinkingGlow: 'rgb(80,80,86)',
  timerText: 'rgb(120,120,126)',
  inactive: 'rgb(120,120,126)',
  subtle: 'rgb(140,140,146)',
  promptBorder: 'rgb(180,180,186)',
  inverseText: 'rgb(250,250,250)',
  selectionText: 'rgb(20,20,22)',
  selectionBackground: 'rgb(180,213,255)',
  claude: 'rgb(199,108,78)',
  claudeShimmer: 'rgb(219,128,98)',
  mixdogOrange: 'rgb(199,108,78)',
  mixdogAmber: 'rgb(180,120,40)',
  mixdogIvory: 'rgb(72,68,64)',
  spinnerGlyph: 'rgb(199,108,78)',
  spinnerText: 'rgb(199,108,78)',
  spinnerShimmer: 'rgb(229,148,118)',
  panelTitle: 'rgb(199,108,78)',
  success: 'rgb(34,134,58)',
  error: 'rgb(207,34,46)',
  warning: 'rgb(154,103,0)',
  suggestion: 'rgb(9,105,218)',
  permission: 'rgb(207,34,46)',
  code: 'rgb(9,105,218)',
  codeBlock: 'rgb(36,41,47)',
  mdHeading: 'rgb(130,80,8)',
  mdCode: 'rgb(0,92,197)',
  mdCodeBlock: 'rgb(36,41,47)',
  mdQuote: 'rgb(106,115,125)',
  mdQuoteBorder: 'rgb(175,184,193)',
  mdHr: 'rgb(175,184,193)',
  mdListBullet: 'rgb(9,105,218)',
  mdCodeBlockBorder: 'rgb(200,206,212)',
  mdLink: 'rgb(9,105,218)',
  mdLinkText: 'rgb(0,92,197)',
  mdStrong: 'rgb(130,80,8)',
  mdEmph: 'rgb(154,103,0)',
  mdDiffAdded: 'rgb(34,134,58)',
  mdDiffRemoved: 'rgb(207,34,46)',
  mdDiffHunk: 'rgb(9,105,218)',
  mdDiffHeader: 'rgb(110,80,170)',
  mdDiffContext: 'rgb(106,115,125)',
  mdDiffAddedBg: 'rgb(218,243,224)',
  mdDiffRemovedBg: 'rgb(255,224,228)',
  syntaxComment: 'rgb(106,115,125)',
  syntaxKeyword: 'rgb(207,34,46)',
  syntaxFunction: 'rgb(9,105,218)',
  syntaxVariable: 'rgb(149,33,110)',
  syntaxString: 'rgb(10,120,60)',
  syntaxNumber: 'rgb(0,92,197)',
  syntaxType: 'rgb(130,80,8)',
  syntaxOperator: 'rgb(36,41,47)',
  syntaxPunctuation: 'rgb(36,41,47)',
  userMessageBackground: 'rgb(232,232,234)',
  userMessageBackgroundHover: 'rgb(222,222,226)',
  fastMode: 'rgb(255,106,0)',
};

// ── Registry / metadata ─────────────────────────────────────────────────────
const THEME_REGISTRY = {
  mixdog: { id: 'mixdog', label: 'Basic', description: 'Warm dark base with teal markdown accents.', palette: mixdogPalette },
  'pi-dark': { id: 'pi-dark', label: 'Teal', description: 'Teal accent with soft body text.', palette: piDarkPalette },
  'claude-dark': { id: 'claude-dark', label: 'Warm', description: 'Orange accent with bright body text.', palette: claudeDarkPalette },
  dracula: { id: 'dracula', label: 'Violet', description: 'Purple/pink accents with cyan links.', palette: draculaPalette },
  tokyonight: { id: 'tokyonight', label: 'Midnight', description: 'Soft blue/purple dark with neon markdown.', palette: tokyonightPalette },
  nord: { id: 'nord', label: 'Frost', description: 'Cool arctic blue/teal dark.', palette: nordPalette },
  gruvbox: { id: 'gruvbox', label: 'Earth', description: 'Retro warm earthy dark with green/orange accents.', palette: gruvboxPalette },
  catppuccin: { id: 'catppuccin', label: 'Pastel', description: 'Gentle pastel violet/blue dark.', palette: catppuccinPalette },
  everforest: { id: 'everforest', label: 'Forest', description: 'Soft natural green dark, easy on the eyes.', palette: everforestPalette },
  white: { id: 'white', label: 'Light', description: 'Bright white background with high-contrast dark text.', palette: whitePalette },
};

const DEFAULT_THEME_ID = 'mixdog';
const THEME_ORDER = ['mixdog', 'pi-dark', 'claude-dark', 'dracula', 'tokyonight', 'nord', 'gruvbox', 'catppuccin', 'everforest', 'white'];

/**
 * Live singleton consumed across the TUI. Seeded with the default palette and
 * mutated in-place by `applyPalette()` so `import { theme }` references stay
 * valid after a theme switch.
 */
export const theme = { ...mixdogPalette };

let _activeThemeId = DEFAULT_THEME_ID;
let _themeVersion = 0;

/** Monotonic counter bumped on every theme switch (cache-invalidation key). */
export function getThemeVersion() {
  return _themeVersion;
}

/** Active theme id (e.g. 'mixdog'). */
export function getThemeSetting() {
  return _activeThemeId;
}

/** Coerce any value to a known theme id, falling back to the default. */
export function resolveThemeId(id) {
  const key = String(id || '').trim();
  return THEME_REGISTRY[key] ? key : DEFAULT_THEME_ID;
}

/** Picker-ready metadata for every theme, in display order. */
export function listThemes() {
  return THEME_ORDER.filter((id) => THEME_REGISTRY[id]).map((id) => {
    const entry = THEME_REGISTRY[id];
    return {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      current: entry.id === _activeThemeId,
    };
  });
}

export function emitTerminalBackground(rgbString) {
  try {
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(rgbString || '').replace(/\s+/g, ''));
    if (!m) return;
    const hex = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    // OSC 11 ; rgb:RR/GG/BB  (BEL-terminated). Many terminals also accept #RRGGBB.
    const seq = `\x1b]11;rgb:${hex(m[1])}${hex(m[1])}/${hex(m[2])}${hex(m[2])}/${hex(m[3])}${hex(m[3])}\x07`;
    if (process.stdout && process.stdout.isTTY) process.stdout.write(seq);
  } catch { /* terminals that ignore OSC 11 are harmless */ }
}

function applyPalette(id) {
  const entry = THEME_REGISTRY[resolveThemeId(id)];
  Object.assign(theme, entry.palette);
  _activeThemeId = entry.id;
  _themeVersion += 1;
  emitTerminalBackground(theme.background);
  return entry;
}

/**
 * Apply a theme by id. Unknown ids fall back to the default without throwing.
 * Persists `ui.theme` to mixdog-config.json unless `persist` is false.
 * Returns `{ id, label, description }` for the applied theme.
 */
export function setThemeSetting(id, { persist = true } = {}) {
  const entry = applyPalette(id);
  if (persist) void persistThemeSetting(entry.id);
  return { id: entry.id, label: entry.label, description: entry.description };
}

// ── Persistence (lazy, dist-aware) ──────────────────────────────────────────
const CONFIG_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../runtime/shared/config.mjs'
  : '../runtime/shared/config.mjs';
let _configModulePromise = null;
function loadConfigModule() {
  if (!_configModulePromise) _configModulePromise = import(CONFIG_MODULE);
  return _configModulePromise;
}

async function persistThemeSetting(id) {
  try {
    const { updateConfig } = await loadConfigModule();
    updateConfig((cfg) => {
      const ui = cfg && typeof cfg.ui === 'object' && cfg.ui ? cfg.ui : {};
      return { ...cfg, ui: { ...ui, theme: id } };
    });
  } catch {
    // Persistence is best-effort; a missing/locked config must never crash the TUI.
  }
}

/**
 * Read `ui.theme` from mixdog-config.json and apply it (no re-persist). Safe to
 * call once at boot; returns the resolved active id. Unknown/missing values
 * leave the default in place.
 */
export async function loadThemeSettingFromConfig() {
  try {
    const { readConfig } = await loadConfigModule();
    const cfg = readConfig() || {};
    const stored = cfg && cfg.ui && typeof cfg.ui === 'object' ? cfg.ui.theme : null;
    if (stored && THEME_REGISTRY[resolveThemeId(stored)] && resolveThemeId(stored) === String(stored)) {
      applyPalette(stored);
    }
  } catch {
    // Fall back to the already-applied default theme.
  }
  return _activeThemeId;
}

/* --- Glyphs --------------------------------------------------------------- */
import {
  BLACK_CIRCLE,
  RESULT_GUTTER_GLYPH,
  RESULT_GUTTER_CONT_GLYPH,
} from './figures.mjs';

/** Turn marker — BLACK_CIRCLE (`⏺` on macOS; `●` elsewhere). */
export const TURN_MARKER = BLACK_CIRCLE;
/** Result-tree gutter — `└` (U+2514) padded to a 2-col hanging indent. */
export const RESULT_GUTTER = `  ${RESULT_GUTTER_GLYPH}  `;
/**
 * Continuation rail for every result row AFTER the first — `│` (U+2502) at the
 * same 2-col hanging indent so a multi-line tool result keeps a continuous left
 * rail under the `└` head. Same width/padding as RESULT_GUTTER so the body text
 * column never shifts between the first and following rows.
 */
export const RESULT_GUTTER_CONT = `  ${RESULT_GUTTER_CONT_GLYPH}  `;
