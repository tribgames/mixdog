/**
 * figures.mjs — glyph constants, ported verbatim from Claude Code.
 *
 * Source: refs/claude-code/src/constants/figures.ts. Values kept identical so
 * the TUI's markers/spinners/indicators match Claude Code exactly. `env.platform`
 * → process.platform here.
 */

// The former (⏺) is better vertically aligned, but isn't usually supported on
// Windows/Linux, so those get the plain ● .
export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●';
export const BULLET_OPERATOR = '∙';
export const TEARDROP_ASTERISK = '✻';
export const UP_ARROW = '↑'; // ↑ - opus 1m merge notice
export const DOWN_ARROW = '↓'; // ↓ - scroll hint
export const LIGHTNING_BOLT = '↯'; // ↯ - fast mode indicator
export const EFFORT_LOW = '○'; // ○
export const EFFORT_MEDIUM = '◐'; // ◐
export const EFFORT_HIGH = '●'; // ●
export const EFFORT_MAX = '◉'; // ◉ (Opus 4.6 only)

// Media/trigger status indicators
export const PLAY_ICON = '▶'; // ▶
export const PAUSE_ICON = '⏸'; // ⏸

// MCP subscription indicators
export const REFRESH_ARROW = '↻'; // ↻
export const CHANNEL_ARROW = '←'; // ←
export const INJECTED_ARROW = '→'; // →
export const FORK_GLYPH = '⑂'; // ⑂

// Review status indicators
export const DIAMOND_OPEN = '◇'; // ◇ running
export const DIAMOND_FILLED = '◆'; // ◆ completed/failed
export const REFERENCE_MARK = '※'; // ※

// Issue flag indicator
export const FLAG_ICON = '⚑'; // ⚑

// Blockquote indicator
export const BLOCKQUOTE_BAR = '▎'; // ▎ left one-quarter block
export const HEAVY_HORIZONTAL = '━'; // ━

// The "therefore" sign — Claude Code's collapsed-thinking prefix (∴ Thinking).
export const THEREFORE = '∴'; // ∴

// Prompt pointer (CC uses figures.pointer ❯ for the input glyph).
export const POINTER = '❯'; // ❯
