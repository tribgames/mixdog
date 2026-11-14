//! TUI glyph constants (`src/tui/figures.mjs`). Each glyph is written as its `\u{XXXX}` escape with the literal in
//! the comment.

/// `⏺` / `●`: the turn marker. U+23FA aligns better but is poorly supported off macOS, so other platforms use U+25CF.
pub const BLACK_CIRCLE: &str = if cfg!(target_os = "macos") { "\u{23fa}" } else { "\u{25cf}" };
/// `·`: inline separator.
pub const BULLET_OPERATOR: &str = "\u{00b7}";
/// `↑`: history / scroll up.
pub const UP_ARROW: &str = "\u{2191}";
/// `↓`: history / scroll down.
pub const DOWN_ARROW: &str = "\u{2193}";
/// `→`: agent call / dispatch marker.
pub const RIGHT_ARROW: &str = "\u{2192}";
/// `←`: agent response marker.
pub const LEFT_ARROW: &str = "\u{2190}";
/// `└`: tool-result tree gutter (BOX DRAWINGS LIGHT UP AND RIGHT, in virtually every monospace font).
pub const RESULT_GUTTER_GLYPH: &str = "\u{2514}";
/// `│`: tool-result continuation rail.
pub const RESULT_GUTTER_CONT_GLYPH: &str = "\u{2502}";
/// `▎`: blockquote line prefix.
pub const BLOCKQUOTE_BAR: &str = "\u{258e}";
/// `◈`: turn-complete marker, kept distinct from live thinking's therefore sign.
pub const TURN_DONE_MARKER: &str = "\u{25c8}";
/// `─`: markdown horizontal rule fill (BOX DRAWINGS LIGHT HORIZONTAL), repeated to the content width.
pub const HR_LINE: &str = "\u{2500}";
