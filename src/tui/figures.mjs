/**
 * figures.mjs — TUI glyph constants.
 *
 * Claude Code uses Unicode markers heavily. Keep those markers intact so UI
 * styling does not change under environment-dependent ASCII conversion.
 */

export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●';
export const BULLET_OPERATOR = '·';
export const UP_ARROW = '↑';
export const DOWN_ARROW = '↓';

// Tool-result tree gutter.
export const RESULT_GUTTER_GLYPH = '⎿';

// Blockquote indicator
export const BLOCKQUOTE_BAR = '▎';

// The "therefore" sign — Claude Code's collapsed-thinking prefix (∴ Thinking).
export const THEREFORE = '∴';
// Turn-complete marker — kept distinct from live-thinking's therefore sign.
export const TURN_DONE_MARKER = '◈';
