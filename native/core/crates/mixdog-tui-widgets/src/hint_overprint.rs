//! `components/ItemRightHintOverprint.jsx`: a truncated right-side hint overprinted on the last row of a transcript
//! item without reserving a row (a negative margin pulls the hint band up).

use mixdog_js::is_js_space;
use mixdog_term::frame::Rect;
use mixdog_term::paint::Painter;
use mixdog_tui_style::Key;

use crate::themed;

/// The width of the hint cell when the owner gives none.
pub const DEFAULT_RIGHT_MESSAGE_WIDTH: u16 = 24;

/// `cleanRightMessage(value)`: a hint or status message collapsed to one truncatable line.
pub fn clean_right_message(value: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in value.chars() {
        if is_js_space(ch) {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(' ');
        }
        gap = false;
        out.push(ch);
    }
    out
}

/// `promptStatusColor(tone)`: the theme key of a hint tone.
pub fn prompt_status_key(tone: &str) -> Key {
    match tone {
        "error" => Key::Error,
        "warn" | "cancel" => Key::Warning,
        "plain" => Key::Subtle,
        _ => Key::Inactive,
    }
}

/// `ItemRightHintOverprint`: puts the hint on the last of the `children_rows` rows the item took from row `y`,
/// flush with the right edge of `area` and `width` cells wide (24 when `width` is zero) with a cell of margin on each
/// side. Nothing is painted for a blank message; no row is taken. Returns the rows of the item, unchanged.
pub fn paint_item_right_hint(
    painter: &mut Painter,
    area: Rect,
    y: u16,
    children_rows: u16,
    right_message: &str,
    tone: &str,
    width: u16,
) -> u16 {
    let text = clean_right_message(right_message);
    if !text.is_empty() && children_rows > 0 {
        let box_width = if width == 0 { DEFAULT_RIGHT_MESSAGE_WIDTH } else { width };
        painter.overprint_hint(y + children_rows - 1, area, &text, box_width, themed(prompt_status_key(tone)));
    }
    children_rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_is_one_trimmed_line() {
        assert_eq!(clean_right_message(" \n "), "");
        assert_eq!(clean_right_message("two\n words"), "two words");
        assert_eq!(clean_right_message("  a \t b  "), "a b");
    }

    #[test]
    fn tones_pick_their_theme_keys() {
        assert_eq!(prompt_status_key("error"), Key::Error);
        assert_eq!(prompt_status_key("cancel"), Key::Warning);
        assert_eq!(prompt_status_key("plain"), Key::Subtle);
        assert_eq!(prompt_status_key("info"), Key::Inactive);
    }
}
