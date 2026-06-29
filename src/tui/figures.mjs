/**
 * figures.mjs — TUI glyph constants.
 *
 * Unicode markers are used heavily in the TUI. Each glyph is declared with its
 * `\uXXXX` escape (encoding-safe across editors/transports) and the literal
 * glyph + usage is kept in the trailing comment for readability.
 */

// Turn marker. \u23fa (⏺) aligns better but is poorly supported off macOS, so
// other platforms use \u25cf (●).
export const BLACK_CIRCLE = process.platform === 'darwin' ? '\u23fa' : '\u25cf'; // ⏺ / ● - turn marker
export const BULLET_OPERATOR = '\u00b7'; // · - inline separator
export const UP_ARROW = '\u2191'; // ↑ - history/scroll up
export const DOWN_ARROW = '\u2193'; // ↓ - history/scroll down

// Tool-result tree gutter. \u2514 (└, BOX DRAWINGS LIGHT UP AND RIGHT) renders
// in virtually every monospace font; the previous \u23bf (bracket extension)
// had no glyph in common terminal fonts (Cascadia/Consolas) and fell back to a
// literal "L", breaking the result tree alignment.
export const RESULT_GUTTER_GLYPH = '\u2514'; // └ - tool-result tree gutter
export const RESULT_GUTTER_CONT_GLYPH = '\u2502'; // │ - tool-result continuation rail

export const BLOCKQUOTE_BAR = '\u258e'; // ▎ - blockquote line prefix

export const THEREFORE = '\u2234'; // ∴ - collapsed-thinking prefix (∴ Thinking)
// Turn-complete marker — kept distinct from live-thinking's therefore sign.
export const TURN_DONE_MARKER = '\u25c8'; // ◈ - turn-complete marker
