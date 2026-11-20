//! `components/Message.jsx`: the rows of the transcript that carry words.
//!
//! * An assistant message is `●` in a two-wide gutter and, beside it, the markdown in a column of an explicit width (three
//!   columns less than the terminal's: the gutter and a safety cell at the right edge, where an auto-wrap would drift
//!   the next redraw).
//! * A user message is a band of the user-message background one cell short of the right edge, the text indented under the
//!   gutter; consecutive prompts stack flush, any other user message has a row above it.
//! * A notice is dim text, with a `·` before it unless it is plain or an error.

use mixdog_markdown_ansi::stream::{reset_streaming_markdown_stable_prefix, window_plain_streaming_text};
use mixdog_markdown_ansi::table::assistant_body_width;
use mixdog_term::frame::Style;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_termtext::display_width;
use mixdog_tui_style::theme::TURN_MARKER;
use mixdog_tui_style::{Key, theme_color};
use serde_json::Value;

use super::layout::{Block, Stack, TextBox, rect};
use super::markdown::streaming_markdown;
use super::skills::{applied_skills_line, user_text_segments};
use crate::{Run, grid_color, runs_to_ansi, themed};

/// The gutter of a transcript row: two cells.
const GUTTER: usize = 2;

/// `AssistantMessage`.
pub(crate) struct AssistantMessage {
    body_x: usize,
    body: Stack,
}

impl AssistantMessage {
    /// `text` streaming or settled, in a terminal of `columns` columns; `assistant_id` keys the streaming caches, and
    /// `streaming_window_rows` is the number of rows a plain streaming text is cut to (0: no cut).
    pub(crate) fn new(text: &str, streaming: bool, columns: usize, assistant_id: Option<&str>, streaming_window_rows: usize) -> Self {
        let id = assistant_id.filter(|id| !id.is_empty());
        let body_width = assistant_body_width(columns);
        let windowed;
        let render_text = if streaming && streaming_window_rows > 0 {
            windowed = window_plain_streaming_text(text, body_width, streaming_window_rows, id);
            windowed.as_str()
        } else {
            text
        };
        let body = streaming_markdown(render_text, Some(body_width), id, streaming, body_width);
        if !streaming && let Some(id) = id {
            reset_streaming_markdown_stable_prefix(id);
        }
        Self { body_x: GUTTER.max(display_width(TURN_MARKER)), body }
    }
}

impl Block for AssistantMessage {
    fn rows(&self) -> u16 {
        1 + self.body.rows().max(1)
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        painter.line(x, y + 1, TURN_MARKER, themed(Key::Text));
        self.body.paint(painter, x + self.body_x as i32, y + 1);
    }
}

/// `UserMessage`.
pub(crate) struct UserMessage {
    margin_top: u16,
    band: usize,
    band_style: Style,
    text: TextBox,
    skills: TextBox,
}

impl UserMessage {
    /// `text` of a row whose previous row is a user message too when `attached`, in a terminal of `columns` columns. A row
    /// without text has no text line.
    pub(crate) fn new(text: Option<&str>, attached: bool, columns: usize, applied_skills: Option<&Value>) -> Self {
        // One cell short of the right edge, and the content narrower by the gutter at the left and a cell at the right.
        let band = columns.saturating_sub(1).max(1);
        let content = band.saturating_sub(GUTTER + 1);
        let band_style = Style { bg: grid_color(theme_color(Key::UserMessageBackground)), ..Style::default() };
        let ivory = Style { fg: grid_color(theme_color(Key::MixdogIvory)), ..Style::default() };
        let segments = user_text_segments(text.unwrap_or(""), applied_skills);
        let body = match text {
            None => String::new(),
            Some(text) if segments.len() == 1 && !segments[0].mention => runs_to_ansi(&[(text.to_owned(), ivory)]),
            Some(_) => {
                let mark = Style { fg: grid_color(theme_color(Key::PanelTitle)), bold: true, ..Style::default() };
                let runs: Vec<Run> = segments.into_iter().map(|segment| (segment.text, if segment.mention { mark } else { ivory })).collect();
                runs_to_ansi(&runs)
            }
        };
        let skills = applied_skills_line(applied_skills);
        Self {
            margin_top: u16::from(!attached),
            band,
            band_style,
            text: TextBox::new(body, band_style, TextWrap::Wrap, content),
            skills: TextBox::new(skills, Style { fg: grid_color(theme_color(Key::Subtle)), ..band_style }, TextWrap::Wrap, content),
        }
    }
}

impl Block for UserMessage {
    fn rows(&self) -> u16 {
        self.margin_top + self.text.rows() + self.skills.rows()
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        let top = y + i32::from(self.margin_top);
        let height = self.text.rows() + self.skills.rows();
        painter.fill(rect(x, top, self.band, height), self.band_style);
        self.text.paint(painter, x + GUTTER as i32, top);
        self.skills.paint(painter, x + GUTTER as i32, top + i32::from(self.text.rows()));
    }
}

/// `NoticeMessage`.
pub(crate) struct Notice {
    prefix: Option<(Style, usize)>,
    body: TextBox,
}

impl Notice {
    /// `text` of a `tone` (`error`, `warn`, `info`, `plain`, or anything else) in a terminal of `columns` columns.
    pub(crate) fn new(text: &str, tone: Option<&str>, columns: usize) -> Self {
        let accent = match tone {
            Some("error") => Key::Error,
            Some("warn") => Key::Warning,
            _ => Key::Inactive,
        };
        let body_key = if matches!(tone, Some("info" | "plain")) { Key::Inactive } else { Key::StatusText };
        let has_prefix = !matches!(tone, Some("plain" | "error"));
        let icon = if has_prefix { 2 } else { 0 };
        let row = columns.saturating_sub(1).max(1);
        let body_width = row.saturating_sub(GUTTER + icon).max(1);
        Self { prefix: has_prefix.then(|| (themed(accent), icon)), body: TextBox::new(text.to_owned(), themed(body_key), TextWrap::Wrap, body_width) }
    }
}

impl Block for Notice {
    fn rows(&self) -> u16 {
        1 + self.body.rows().max(u16::from(self.prefix.is_some()))
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        let top = y + 1;
        let mut body_x = x + GUTTER as i32;
        if let Some((style, icon)) = self.prefix {
            painter.line(body_x, top, "\u{b7}", style);
            body_x += icon as i32;
        }
        self.body.paint(painter, body_x, top);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::{Cell, Grid};
    use serde_json::json;

    fn rows_of(block: &dyn Block, columns: u16) -> Vec<String> {
        let mut grid = Grid::new(columns, block.rows());
        block.paint(&mut Painter::new(&mut grid), 0, 0);
        (0..grid.height).map(|y| grid.row_text(y).trim_end().to_owned()).collect()
    }

    #[test]
    fn an_assistant_message_has_a_row_above_and_the_marker_in_the_gutter() {
        let message = AssistantMessage::new("hello", false, 30, Some("msg-1"), 0);
        assert_eq!(message.rows(), 2);
        assert_eq!(rows_of(&message, 30), ["", &format!("{TURN_MARKER} hello")]);
    }

    #[test]
    fn an_assistant_body_is_three_columns_narrower_than_the_terminal() {
        let message = AssistantMessage::new("aaaa bbbb cccc dddd", false, 13, Some("msg-2"), 0);
        // 13 columns leave a body of 10.
        assert_eq!(rows_of(&message, 13), ["", &format!("{TURN_MARKER} aaaa bbbb"), "  cccc dddd"]);
    }

    #[test]
    fn a_streaming_window_keeps_the_last_rows_of_a_plain_text() {
        let text = "line one\nline two\nline three";
        let windowed = AssistantMessage::new(text, true, 40, Some("msg-window"), 2);
        let shown = rows_of(&windowed, 40).join("\n");
        assert!(!shown.contains("line one") && shown.contains("line two") && shown.contains("line three"));
        let whole = AssistantMessage::new(text, false, 40, Some("msg-window"), 2);
        assert!(rows_of(&whole, 40).join("\n").contains("line one"));
    }

    #[test]
    fn an_empty_assistant_message_still_takes_its_marker_row() {
        assert_eq!(AssistantMessage::new("", false, 40, None, 0).rows(), 2);
    }

    #[test]
    fn a_user_message_is_a_band_one_cell_short_of_the_edge() {
        let message = UserMessage::new(Some("hello"), false, 20, None);
        assert_eq!(message.rows(), 2);
        let mut grid = Grid::new(20, message.rows());
        message.paint(&mut Painter::new(&mut grid), 0, 0);
        let bg = grid_color(theme_color(Key::UserMessageBackground));
        assert!(grid.row(0).iter().all(Cell::is_plain_blank));
        assert_eq!(grid.row_text(1).trim_end(), "  hello");
        assert_eq!(grid.cell(0, 1).unwrap().style.bg, bg);
        assert_eq!(grid.cell(18, 1).unwrap().style.bg, bg);
        assert!(grid.cell(19, 1).unwrap().is_plain_blank());
    }

    #[test]
    fn a_user_message_after_a_user_message_has_no_row_above_and_wraps_in_the_band() {
        let message = UserMessage::new(Some("one two three four"), true, 14, None);
        // The band is 13 wide and the text 10: "one two" / "three four".
        assert_eq!(rows_of(&message, 14), ["  one two", "  three four"]);
    }

    #[test]
    fn a_user_message_lists_the_skills_it_applied_and_marks_their_tokens() {
        let skills = json!(["api"]);
        let message = UserMessage::new(Some("run $api now"), false, 40, Some(&skills));
        assert_eq!(rows_of(&message, 40), ["", "  run $api now", "  Skills applied: api"]);
        let mut grid = Grid::new(40, message.rows());
        message.paint(&mut Painter::new(&mut grid), 0, 0);
        let mark = grid_color(theme_color(Key::PanelTitle));
        assert_eq!(grid.cell(6, 1).unwrap().style.fg, mark);
        assert!(grid.cell(6, 1).unwrap().style.bold);
        assert_ne!(grid.cell(3, 1).unwrap().style.fg, mark);
        assert_eq!(UserMessage::new(Some("run $api now"), false, 40, None).rows(), 2);
    }

    #[test]
    fn a_user_message_without_text_is_only_its_row_above() {
        assert_eq!(UserMessage::new(None, false, 40, None).rows(), 1);
        assert_eq!(UserMessage::new(Some(""), true, 40, None).rows(), 0);
    }

    #[test]
    fn notices_carry_a_dot_unless_plain_or_an_error() {
        for (tone, expected) in [
            (Some("error"), "hello"),
            (Some("plain"), "hello"),
            (Some("warn"), "\u{b7} hello"),
            (Some("info"), "\u{b7} hello"),
            (Some("other"), "\u{b7} hello"),
            (None, "\u{b7} hello"),
        ] {
            let rows = rows_of(&Notice::new("hello", tone, 40), 40);
            assert_eq!(rows[0], "");
            assert_eq!(rows[1].trim(), expected, "tone {tone:?}");
        }
    }

    #[test]
    fn a_warning_notice_is_drawn_in_the_warning_colour() {
        let notice = Notice::new("hello", Some("warn"), 40);
        let mut grid = Grid::new(40, notice.rows());
        notice.paint(&mut Painter::new(&mut grid), 0, 0);
        assert_eq!(grid.cell(2, 1).unwrap().style.fg, grid_color(theme_color(Key::Warning)));
    }

    #[test]
    fn a_notice_wraps_in_the_body_beside_the_dot() {
        let rows = rows_of(&Notice::new("aaaa bbbb cccc", Some("warn"), 12), 12);
        // 12 columns: a row of 11, two of padding, two of dot, a body of 7.
        assert_eq!(rows, ["", "  \u{b7} aaaa", "    bbbb", "    cccc"]);
    }
}
