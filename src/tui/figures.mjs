/**
 * figures.mjs — TUI glyph constants.
 *
 * Unicode markers are used heavily in the TUI. Keep those markers intact so UI
 * styling does not change under environment-dependent ASCII conversion.
 */

export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●';
export const BULLET_OPERATOR = '·';
export const UP_ARROW = '↑';
export const DOWN_ARROW = '↓';

// Tool-result tree gutter. U+2514 (BOX DRAWINGS LIGHT UP AND RIGHT) renders in
// virtually every monospace font; the previous U+23BF (bracket extension) had
// no glyph in common terminal fonts (Cascadia/Consolas) and fell back to a
// literal "L", breaking the result tree alignment.
export const RESULT_GUTTER_GLYPH = '└';

// Blockquote indicator
export const BLOCKQUOTE_BAR = '▎';

// The "therefore" sign — collapsed-thinking prefix (∴ Thinking).
export const THEREFORE = '∴';
// Turn-complete marker — kept distinct from live-thinking's therefore sign.
export const TURN_DONE_MARKER = '◈';
