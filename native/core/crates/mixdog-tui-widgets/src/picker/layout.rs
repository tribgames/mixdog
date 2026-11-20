//! `components/picker/picker-layout.mjs`: the pure sizing and footer helpers of the picker.

use mixdog_term::frame::Color;
use mixdog_tui_style::Key;
use mixdog_tui_style::theme::Color as ThemeColor;

use crate::panel_cell_text::truncate_panel_text;
use crate::{grid_color, themed};

/// Most items shown at once before the list scrolls.
pub const MAX_VISIBLE: usize = 8;
pub const DEFAULT_LABEL_WIDTH: usize = 28;
pub const SELECT_HELP: &str = "\u{2191}/\u{2193} Select \u{b7} Enter Choose \u{b7} Esc Back";
pub const ADJUST_HELP: &str = "\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Adjust \u{b7} Enter Choose \u{b7} Esc Back";
pub const CONFIRM_HELP: &str = "\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Back/Next \u{b7} Enter Choose \u{b7} Esc Skip";

/// `clampLabelWidth(value, columns)`: a requested label width (zero asks for the default) within 45% of the columns.
pub fn clamp_label_width(value: usize, columns: usize) -> usize {
    let max_width = 12.max((columns as f64 * 0.45).floor() as usize);
    let requested = if value == 0 { DEFAULT_LABEL_WIDTH } else { value };
    requested.min(max_width).max(1)
}

/// `clampItemIndex(index, itemCount)`: a requested row index clamped into the item list (0 for an empty list).
pub fn clamp_item_index(index: usize, item_count: usize) -> usize {
    index.min(item_count.saturating_sub(1))
}

/// `clampMetaWidth(value, columns, labelWidth)`: the meta column (24 when none is asked for), at most what is left of
/// the columns after the label and the chrome.
pub fn clamp_meta_width(value: Option<usize>, columns: usize, label_width: usize) -> usize {
    let available = columns.saturating_sub(label_width + 16);
    let requested = match value {
        Some(width) if width > 0 => width,
        _ => 24,
    };
    requested.min(available)
}

/// What the owner gives for one footer line: a plain string, or an object with an optional glyph, colour and text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FooterInput {
    Plain(String),
    Object { glyph: String, color: Option<ThemeColor>, text: String },
}

impl FooterInput {
    pub fn plain(text: &str) -> Self {
        Self::Plain(text.to_owned())
    }
}

/// A footer line after [`normalize_footer_lines`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FooterLine {
    pub glyph: String,
    pub color: Color,
    pub text: String,
}

/// `normalizeFooterLines(activeFooter, columns)`: each line's text truncated to the columns left after its glyph (a
/// plain line is coloured as text, an object as the panel title unless it carries a colour); empty lines are dropped.
pub fn normalize_footer_lines(lines: &[FooterInput], columns: usize) -> Vec<FooterLine> {
    lines
        .iter()
        .map(|line| {
            let (glyph, color, text) = match line {
                FooterInput::Plain(text) => (String::new(), themed(Key::Text).fg, text.as_str()),
                FooterInput::Object { glyph, color, text } => (glyph.clone(), color.map_or(themed(Key::PanelTitle).fg, grid_color), text.as_str()),
            };
            let room = columns.saturating_sub(if glyph.is_empty() { 4 } else { 7 });
            FooterLine { text: truncate_panel_text(text, room), glyph, color }
        })
        .filter(|line| !line.glyph.is_empty() || !line.text.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_are_clamped_to_the_columns() {
        assert_eq!(clamp_label_width(0, 80), 28);
        assert_eq!(clamp_label_width(40, 80), 36);
        assert_eq!(clamp_label_width(5, 20), 5);
        assert_eq!(clamp_label_width(30, 20), 12);
        assert_eq!(clamp_meta_width(None, 100, 28), 24);
        assert_eq!(clamp_meta_width(Some(40), 60, 28), 16);
        assert_eq!(clamp_meta_width(Some(10), 30, 28), 0);
        assert_eq!(clamp_item_index(9, 3), 2);
        assert_eq!(clamp_item_index(2, 0), 0);
    }

    #[test]
    fn footer_lines_are_truncated_and_empty_ones_dropped() {
        let lines = normalize_footer_lines(
            &[
                FooterInput::plain("a long footer line"),
                FooterInput::plain(""),
                FooterInput::Object { glyph: "!".to_owned(), color: None, text: String::new() },
            ],
            12,
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "a long \u{2026}");
        assert_eq!(lines[1].glyph, "!");
    }
}
