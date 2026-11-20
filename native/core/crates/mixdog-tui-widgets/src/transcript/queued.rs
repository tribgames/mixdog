//! `components/QueuedCommands.jsx`: the lines typed while a turn is busy wait as dim bands just above the input box, and
//! become transcript rows only when they start executing.
//!
//! Each queued line reads as a band like a user message (the same background, the two-cell gutter, one cell short of the
//! right edge). The default shows the whole wrapped text at the width the promoted user row will use, so promotion does
//! not change its height; `compact` (the queue does not fit the frame) cuts each entry to one row.

use mixdog_js::{slice_utf16, utf16_len, value_to_string};
use mixdog_term::frame::Style;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_tui_style::{Key, theme_color};
use serde_json::Value;

use super::layout::{Block, TextBox, rect};
use crate::grid_color;

/// The gutter at the left of a band.
const GUTTER: usize = 2;

/// `String(value || '')`.
fn text_of(value: Option<&Value>) -> Option<String> {
    value
        .filter(|value| match value {
            Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
            Value::String(text) => !text.is_empty(),
            _ => true,
        })
        .map(value_to_string)
}

/// The compact form of an entry: its line breaks are spaces, and it is cut with an ellipsis when it is longer than
/// `content_width` UTF-16 units.
fn compact_text(source: &str, content_width: usize) -> String {
    let one_line = source.replace("\r\n", " ").replace('\n', " ");
    if utf16_len(&one_line) <= content_width {
        return one_line;
    }
    if content_width <= 1 {
        return "\u{2026}".repeat(content_width);
    }
    format!("{}\u{2026}", slice_utf16(&one_line, (content_width - 1).max(1)))
}

/// `QueuedCommands`.
pub(crate) struct QueuedCommands {
    band: usize,
    band_style: Style,
    entries: Vec<TextBox>,
}

impl QueuedCommands {
    /// The queue (`{ id, text, displayText }` entries), in a terminal of `columns` columns. An empty queue has no rows.
    pub(crate) fn new(queued: &[Value], columns: usize, compact: bool) -> Self {
        let band = columns.saturating_sub(1).max(1);
        let content = band.saturating_sub(GUTTER + 1);
        let compact_width = columns.saturating_sub(GUTTER + 2).max(1);
        let band_style = Style { bg: grid_color(theme_color(Key::UserMessageBackground)), ..Style::default() };
        let text_style = Style { fg: grid_color(theme_color(Key::MixdogIvory)), ..band_style };
        let entries = queued
            .iter()
            .map(|item| {
                let source = text_of(item.get("displayText")).or_else(|| text_of(item.get("text"))).unwrap_or_default();
                let shown = if compact { compact_text(&source, compact_width) } else { source };
                TextBox::new(shown, text_style, TextWrap::Wrap, content)
            })
            .collect();
        Self { band, band_style, entries }
    }
}

impl Block for QueuedCommands {
    fn rows(&self) -> u16 {
        self.entries.iter().map(TextBox::rows).fold(0u16, u16::saturating_add)
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        let mut at = y;
        for entry in &self.entries {
            painter.fill(rect(x, at, self.band, entry.rows()), self.band_style);
            entry.paint(painter, x + GUTTER as i32, at);
            at += i32::from(entry.rows());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::Grid;
    use serde_json::json;

    fn rows_of(queue: &QueuedCommands, columns: u16) -> Vec<String> {
        let mut grid = Grid::new(columns, queue.rows());
        queue.paint(&mut Painter::new(&mut grid), 0, 0);
        (0..grid.height).map(|y| grid.row_text(y).trim_end().to_owned()).collect()
    }

    #[test]
    fn an_empty_queue_has_no_rows() {
        assert_eq!(QueuedCommands::new(&[], 40, false).rows(), 0);
    }

    #[test]
    fn the_full_text_wraps_in_the_band_of_a_user_row() {
        let queue = QueuedCommands::new(&[json!({ "id": "a", "text": "first queued line that wraps around" })], 30, false);
        assert_eq!(rows_of(&queue, 30), ["  first queued line that", "  wraps around"]);
    }

    #[test]
    fn the_display_text_wins_over_the_text_and_a_blank_entry_takes_no_row() {
        let queue = QueuedCommands::new(&[json!({ "id": "a", "text": "raw", "displayText": "shown" }), json!({ "id": "b" })], 30, false);
        assert_eq!(rows_of(&queue, 30), ["  shown"]);
    }

    #[test]
    fn the_band_is_filled_one_cell_short_of_the_edge() {
        let queue = QueuedCommands::new(&[json!({ "id": "a", "text": "x" })], 10, false);
        let mut grid = Grid::new(10, 1);
        queue.paint(&mut Painter::new(&mut grid), 0, 0);
        let bg = grid_color(theme_color(Key::UserMessageBackground));
        assert_eq!(grid.cell(8, 0).unwrap().style.bg, bg);
        assert!(grid.cell(9, 0).unwrap().is_plain_blank());
    }

    #[test]
    fn compact_mode_is_one_row_per_entry_cut_with_an_ellipsis() {
        let entries = [json!({ "id": "a", "text": "line one\r\nline two that is long" }), json!({ "id": "b", "text": "short" })];
        let queue = QueuedCommands::new(&entries, 20, true);
        // Content width 16: 15 units and the ellipsis.
        assert_eq!(rows_of(&queue, 20), ["  line one line t\u{2026}", "  short"]);
    }

    #[test]
    fn compact_text_cuts_by_utf16_units() {
        assert_eq!(compact_text("abcdef", 4), "abc\u{2026}");
        assert_eq!(compact_text("abcd", 4), "abcd");
        assert_eq!(compact_text("abcdef", 1), "\u{2026}");
        assert_eq!(compact_text("a\nb\r\nc\rd", 20), "a b c\rd");
    }
}
