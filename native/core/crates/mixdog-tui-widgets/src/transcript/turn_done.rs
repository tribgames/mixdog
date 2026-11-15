//! `components/TurnDone.jsx`: the line pinned after a turn's output (`turndone`) and the one a status item ends with
//! (`statusdone`):
//!
//! ```text
//! ◈ Thought for 12s        (or: Response complete / Work complete in 12s / Cancelled after 12s)
//! ◈ Done · 2 tasks
//! ```
//!
//! Each may carry the right hint of the prompt (`renderRightHint`): a truncated, right-aligned cell of its own width with a
//! cell of margin on both sides, which takes its width from the line and leaves the rest to the text.

use mixdog_js::js_trim;
use mixdog_term::frame::Style;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_termtext::display_width;
use mixdog_termtext::wrap::wrap_text;
use mixdog_tui_style::Key;
use mixdog_tui_style::figures::TURN_DONE_MARKER;
use mixdog_tui_style::time_format::{DurationOptions, format_duration};

use super::layout::{Block, TextBox, rect};
use crate::hint_overprint::{DEFAULT_RIGHT_MESSAGE_WIDTH, clean_right_message, prompt_status_key};
use crate::{Run, runs_to_ansi, themed};

/// `renderRightHint(rightText, rightMessageWidth, rightTone)`: the cleaned message, its style and the width of its cell.
#[derive(Clone, Debug)]
pub(crate) struct RightHint {
    text: String,
    style: Style,
    width: usize,
}

impl RightHint {
    /// The hint of `message` (cleaned to one line) in the colour of `tone`, in a cell `width` wide (`Number(width) || 24`, at
    /// least 1); none for a blank message.
    pub(crate) fn new(message: &str, tone: &str, width: f64) -> Option<Self> {
        let text = clean_right_message(message);
        if text.is_empty() {
            return None;
        }
        let width = if width.is_nan() || width == 0.0 { f64::from(DEFAULT_RIGHT_MESSAGE_WIDTH) } else { width };
        Some(Self { text, style: themed(prompt_status_key(tone)), width: width.max(1.0).min(f64::from(u16::MAX)) as usize })
    }

    /// The columns the hint takes from a line: its cell and a cell of margin on each side.
    fn taken(&self) -> usize {
        self.width + 2
    }

    /// Paints the hint on row `y` of a line `columns` wide whose first cell is at `x`: the cell sits after the text's box
    /// (which is what the cell leaves of the line, none when the cell is wider than the line, so the cell then runs past
    /// the edge), the text truncated at its end and right-aligned in the cell, and nothing is drawn outside the cell.
    pub(crate) fn paint(&self, painter: &mut Painter, x: i32, y: i32, columns: usize) {
        let cell = x + columns.saturating_sub(self.taken()) as i32 + 1;
        let fitted = wrap_text(&self.text, self.width, TextWrap::TruncateEnd);
        let fitted = fitted.lines().next().unwrap_or("");
        let shown = display_width(fitted).min(self.width);
        let previous = painter.push_clip(rect(cell, y, self.width, 1));
        painter.line(cell + (self.width - shown) as i32, y, fitted, self.style);
        painter.pop_clip(previous);
    }
}

/// A line of runs truncated at its end, and the hint at its right.
pub(crate) struct DoneLine {
    margin_top: u16,
    columns: usize,
    left: TextBox,
    hint: Option<RightHint>,
}

impl DoneLine {
    fn new(margin_top: u16, runs: &[Run], hint: Option<RightHint>, columns: usize) -> Self {
        let left_width = columns.saturating_sub(hint.as_ref().map_or(0, RightHint::taken));
        Self { margin_top, columns, left: TextBox::new(runs_to_ansi(runs), Style::default(), TextWrap::TruncateEnd, left_width), hint }
    }
}

impl Block for DoneLine {
    fn rows(&self) -> u16 {
        self.margin_top + 1
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        let row = y + i32::from(self.margin_top);
        self.left.paint(painter, x, row);
        if let Some(hint) = &self.hint {
            hint.paint(painter, x, row, self.columns);
        }
    }
}

/// `String(value || fallback).trim() || fallback`.
fn trimmed_or(value: &str, fallback: &str) -> String {
    let value = js_trim(if value.is_empty() { fallback } else { value });
    if value.is_empty() { fallback.to_owned() } else { value.to_owned() }
}

/// What a turn's line says: how it ended and how long it took (`elapsed_ms` is a JavaScript number, so a NaN is no time,
/// and so is anything under a second).
pub(crate) fn turn_done_copy(elapsed_ms: f64, status: &str, tool_count: f64, verb: &str) -> String {
    let elapsed = format_duration(elapsed_ms, DurationOptions::default());
    let done_verb = trimmed_or(verb, "Thought");
    let elapsed_number = if elapsed_ms.is_nan() { 0.0 } else { elapsed_ms.max(0.0) };
    if status == "cancelled" {
        return if elapsed.is_empty() { "Cancelled".to_owned() } else { format!("Cancelled after {elapsed}") };
    }
    if tool_count > 0.0 {
        return if elapsed.is_empty() { "Work complete".to_owned() } else { format!("Work complete in {elapsed}") };
    }
    if elapsed_number > 0.0 && elapsed_number < 10_000.0 {
        return "Response complete".to_owned();
    }
    if elapsed.is_empty() { done_verb } else { format!("{done_verb} for {elapsed}") }
}

fn marker_run() -> Run {
    (format!("{TURN_DONE_MARKER} "), themed(Key::SpinnerGlyph))
}

/// `TurnDone`, `margin_top` rows below the row before it, in a terminal of `columns` columns.
pub(crate) fn turn_done(elapsed_ms: f64, status: &str, tool_count: f64, verb: &str, margin_top: u16, hint: Option<RightHint>, columns: usize) -> DoneLine {
    let copy = turn_done_copy(elapsed_ms, status, tool_count, verb);
    DoneLine::new(margin_top, &[marker_run(), (copy, themed(Key::ThinkingAccent))], hint, columns)
}

/// `StatusDone`.
pub(crate) fn status_done(label: &str, detail: &str, margin_top: u16, hint: Option<RightHint>, columns: usize) -> DoneLine {
    let mut runs = vec![marker_run(), (trimmed_or(label, "Complete"), themed(Key::ThinkingAccent))];
    let suffix = js_trim(detail);
    if !suffix.is_empty() {
        runs.push((format!(" \u{b7} {suffix}"), themed(Key::Subtle)));
    }
    DoneLine::new(margin_top, &runs, hint, columns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::Grid;

    fn line(block: &DoneLine, columns: u16) -> Vec<String> {
        let mut grid = Grid::new(columns, block.rows());
        block.paint(&mut Painter::new(&mut grid), 0, 0);
        (0..grid.height).map(|y| grid.row_text(y).trim_end().to_owned()).collect()
    }

    #[test]
    fn the_copy_says_how_the_turn_ended() {
        let at = |ms: f64, status: &str, tools: f64| turn_done_copy(ms, status, tools, "Thought");
        assert_eq!(at(0.0, "done", 0.0), "Thought");
        assert_eq!(at(5000.0, "done", 0.0), "Response complete");
        assert_eq!(at(12000.0, "done", 0.0), "Thought for 12s");
        assert_eq!(at(12000.0, "done", 2.0), "Work complete in 12s");
        assert_eq!(at(0.0, "done", 2.0), "Work complete");
        assert_eq!(at(12000.0, "cancelled", 0.0), "Cancelled after 12s");
        assert_eq!(at(0.0, "cancelled", 0.0), "Cancelled");
        assert_eq!(at(f64::NAN, "done", 0.0), "Thought");
        assert_eq!(at(-5.0, "done", 0.0), "Thought");
        assert_eq!(turn_done_copy(12000.0, "done", 0.0, "  Mapped "), "Mapped for 12s");
        assert_eq!(turn_done_copy(12000.0, "done", 0.0, "   "), "Thought for 12s");
        assert_eq!(turn_done_copy(61000.0, "done", 0.0, "Thought"), "Thought for 1m 1s");
    }

    #[test]
    fn a_turn_done_line_has_its_marker_its_copy_and_a_row_above() {
        let block = turn_done(12000.0, "done", 0.0, "Thought", 1, None, 40);
        assert_eq!(block.rows(), 2);
        assert_eq!(line(&block, 40), ["", "\u{25c8} Thought for 12s"]);
        assert_eq!(turn_done(0.0, "done", 0.0, "Thought", 0, None, 40).rows(), 1);
    }

    #[test]
    fn the_hint_is_right_aligned_in_its_cell_with_a_margin_on_both_sides() {
        let hint = RightHint::new(" ready\n now ", "info", 12.0);
        let block = turn_done(12000.0, "done", 2.0, "Thought", 0, hint, 60);
        let row = &line(&block, 60)[0];
        assert!(row.starts_with("\u{25c8} Work complete in 12s"));
        assert!(row.ends_with("ready now"));
        // The cell is columns 47 to 58 and the margin cell 59 stays empty.
        assert_eq!(mixdog_termtext::display_width(row), 59);
    }

    #[test]
    fn a_long_hint_is_truncated_in_its_cell_and_a_long_copy_in_what_is_left() {
        let hint = RightHint::new("a very long hint that cannot fit", "info", 10.0);
        let row = line(&turn_done(0.0, "done", 0.0, "Thought", 0, hint, 30), 30).remove(0);
        assert_eq!(mixdog_termtext::display_width(&row), 29);
        assert!(row.ends_with('\u{2026}'));
        let narrow = line(&turn_done(12000.0, "done", 0.0, "Thought", 0, RightHint::new("x", "info", 10.0), 20), 20).remove(0);
        assert!(narrow.starts_with("\u{25c8} T") && narrow.contains('\u{2026}'));
    }

    #[test]
    fn a_blank_hint_is_none_and_its_width_defaults_to_24() {
        assert!(RightHint::new(" \n ", "info", 12.0).is_none());
        assert_eq!(RightHint::new("x", "info", f64::NAN).unwrap().width, 24);
        assert_eq!(RightHint::new("x", "info", 0.0).unwrap().width, 24);
        assert_eq!(RightHint::new("x", "info", -3.0).unwrap().width, 1);
    }

    #[test]
    fn a_status_line_adds_its_detail() {
        assert_eq!(line(&status_done("Done", "2 tasks", 0, None, 40), 40), ["\u{25c8} Done \u{b7} 2 tasks"]);
        assert_eq!(line(&status_done("", "", 0, None, 40), 40), ["\u{25c8} Complete"]);
        let hint = RightHint::new("next step", "info", 12.0);
        assert!(line(&status_done("Done", "2 tasks", 0, hint, 60), 60)[0].ends_with("next step"));
    }
}
