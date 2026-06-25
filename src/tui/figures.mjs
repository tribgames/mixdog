/**
 * figures.mjs — TUI glyph constants.
 *
 * Claude Code uses Unicode markers heavily. Keep those markers intact so UI
 * styling does not change under environment-dependent ASCII conversion.
 */

export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●';
export const BULLET_OPERATOR = '·';
export const TEARDROP_ASTERISK = '✻';
export const UP_ARROW = '↑';
export const DOWN_ARROW = '↓';
export const LIGHTNING_BOLT = '↯';
export const EFFORT_LOW = '○';
export const EFFORT_MEDIUM = '◐';
export const EFFORT_HIGH = '●';
export const EFFORT_MAX = '◉';

// Media/trigger status indicators
export const PLAY_ICON = '▶';
export const PAUSE_ICON = '⏸';

// Tool-result tree gutter.
export const RESULT_GUTTER_GLYPH = '⎿';

// MCP subscription indicators
export const REFRESH_ARROW = '↻';
export const CHANNEL_ARROW = '←';
export const INJECTED_ARROW = '→';
export const FORK_GLYPH = '⑂';

// Review status indicators
export const DIAMOND_OPEN = '◇';
export const DIAMOND_FILLED = '◆';
export const REFERENCE_MARK = '※';

// Issue flag indicator
export const FLAG_ICON = '⚑';

// Blockquote indicator
export const BLOCKQUOTE_BAR = '▎';
export const HEAVY_HORIZONTAL = '━';

// The "therefore" sign — Claude Code's collapsed-thinking prefix (∴ Thinking).
export const THEREFORE = '∴';
// Turn-complete marker — kept distinct from live-thinking's therefore sign.
export const TURN_DONE_MARKER = '◈';

// Prompt pointer (CC uses figures.pointer ❯ for the input glyph).
export const POINTER = '❯';
