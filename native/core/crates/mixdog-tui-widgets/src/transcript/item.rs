//! `components/TranscriptItem.jsx`: one transcript item (a store item object) as a row of the transcript, by its kind, and
//! the card a hook or approval denial of a tool call is drawn as.

use mixdog_js::{to_number, value_to_string};
use mixdog_term::frame::Style;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_termtext::display_width;
use mixdog_tui_style::Key;
use mixdog_tui_style::theme::{RESULT_GUTTER, TURN_MARKER};
use mixdog_view_model::card_model::inline_text::safe_inline_text;
use mixdog_view_model::tool_surface::format_tool_surface_default;
use serde_json::Value;

use super::layout::{Block, TextBox, rect};
use super::message::{AssistantMessage, Notice, UserMessage};
use super::tool_failures::{format_hook_denial_detail, is_hook_approval_denial_tool_item, should_suppress_fully_failed_tool_item, tool_item_result_text};
use super::turn_done::{RightHint, status_done, turn_done};
use crate::tool_cards::{CardCtx, render_tool_card};
use crate::transcript::{ItemCtx, render_notice, render_user_message};
use crate::{Line, Run, runs_to_ansi, themed};

/// The gutter of a transcript row: the marker's box is two cells wide.
const MARKER_BOX: usize = 2;

/// What an item draws as.
pub(crate) enum Drawn {
    /// Nothing: an unknown kind, or a failed tool batch that has nothing to read.
    Nothing,
    /// A component laid out here.
    Block(Box<dyn Block>),
    /// The lines of a tool card, laid out by the tool card.
    Lines(Vec<Line>),
}

/// `Boolean(value)`.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)` of a present value; none for an absent one (`undefined` or `null`).
fn text_of(value: Option<&Value>) -> Option<String> {
    value.filter(|value| !value.is_null()).map(value_to_string)
}

/// `String(value || fallback)`.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    if truthy(value) { value.map(value_to_string).unwrap_or_default() } else { fallback.to_owned() }
}

/// A JavaScript number prop with a default for an absent one (`undefined`; a `null` is 0).
fn number_or(value: Option<&Value>, default: f64) -> f64 {
    value.map_or(default, to_number)
}

/// `Number(value || 0)`.
fn number_of_truthy(value: Option<&Value>) -> f64 {
    if truthy(value) { value.map_or(0.0, to_number) } else { 0.0 }
}

/// `ToolHookDenialCard`: the tool's name and arguments, what denied it, and the denial's detail on a second row.
pub(crate) struct HookDenialCard {
    row_width: usize,
    marker_width: usize,
    header: TextBox,
    detail: Option<TextBox>,
}

impl HookDenialCard {
    pub(crate) fn new(item: &Value, columns: usize) -> Self {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        let surface = format_tool_surface_default(name, item.get("args").unwrap_or(&Value::Null));
        let label = safe_inline_text(&surface.label);
        let summary = safe_inline_text(&surface.summary);
        let detail = safe_inline_text(&format_hook_denial_detail(&tool_item_result_text(item)));
        let row_width = if columns == 0 { 80 } else { columns };
        let marker_width = MARKER_BOX.max(display_width(TURN_MARKER));
        let bold_text = Style { bold: true, ..themed(Key::Text) };
        let mut runs: Vec<Run> = vec![(label, bold_text)];
        if !summary.is_empty() {
            runs.push((format!(" ({summary})"), themed(Key::Text)));
        }
        runs.push((" \u{b7} Denied".to_owned(), themed(Key::Error)));
        let header = TextBox::new(runs_to_ansi(&runs), Style::default(), TextWrap::TruncateEnd, row_width.saturating_sub(marker_width));
        let detail_width = row_width.saturating_sub(display_width(RESULT_GUTTER)).max(1);
        let detail = (!detail.is_empty()).then(|| TextBox::new(detail, themed(Key::Error), TextWrap::TruncateEnd, detail_width));
        Self { row_width, marker_width, header, detail }
    }
}

impl Block for HookDenialCard {
    fn rows(&self) -> u16 {
        1 + 1 + u16::from(self.detail.is_some())
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        // Every row is a box of the card's width that hides what is past its edge.
        let top = y + 1;
        let previous = painter.push_clip(rect(x, top, self.row_width, 1));
        painter.line(x, top, TURN_MARKER, themed(Key::Error));
        self.header.paint(painter, x + self.marker_width as i32, top);
        painter.pop_clip(previous);
        if let Some(detail) = &self.detail {
            let row = top + 1;
            let previous = painter.push_clip(rect(x, row, self.row_width, 1));
            painter.line(x, row, RESULT_GUTTER, themed(Key::Subtle));
            detail.paint(painter, x + display_width(RESULT_GUTTER) as i32, row);
            painter.pop_clip(previous);
        }
    }
}

/// How many of a sent message's images went with only their smaller copy, as the core recorded on the row; none when it is
/// absent or not a positive whole number.
fn original_images_missing(item: &Value) -> Option<u64> {
    item.get("originalImagesMissing").and_then(Value::as_u64).filter(|count| *count > 0)
}

/// The note under such a message. The desktop words the same sentences by their English text in the reader's language;
/// the terminal has no catalog and shows them as they are.
fn original_images_missing_text(count: u64) -> String {
    match count {
        1 => "The full-size original of an image could not be found, so it was sent at its smaller size.".to_owned(),
        n => format!("The full-size originals of {n} images could not be found, so they were sent at their smaller size."),
    }
}

/// The right hint of an item and its parts as the item gave them.
fn hint_of(ctx: &ItemCtx) -> Option<RightHint> {
    RightHint::new(&ctx.right_message, &ctx.right_tone, ctx.right_message_width)
}

/// `Item`: how `item` is drawn in a terminal of `ctx.columns` columns. A completion row carries the hint itself; any
/// other row has it overprinted by the caller.
pub(crate) fn draw_item(item: &Value, ctx: &ItemCtx) -> Drawn {
    let columns = ctx.columns;
    match item.get("kind").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            let text = text_of(item.get("text"));
            let attached = ctx.prev_kind.as_deref() == Some("user");
            match original_images_missing(item) {
                // The note the core recorded on the message itself (`originalImagesMissing`), under it.
                Some(count) => {
                    let mut lines = render_user_message(text.as_deref(), attached, columns, item.get("appliedSkills"));
                    lines.extend(render_notice(&original_images_missing_text(count), Some("warn"), columns));
                    Drawn::Lines(lines)
                }
                None => Drawn::Block(Box::new(UserMessage::new(text.as_deref(), attached, columns, item.get("appliedSkills")))),
            }
        }
        "assistant" => {
            let text = text_of(item.get("text")).unwrap_or_default();
            let id = item.get("id").and_then(Value::as_str);
            Drawn::Block(Box::new(AssistantMessage::new(&text, truthy(item.get("streaming")), columns, id, ctx.streaming_window_rows)))
        }
        "tool" => {
            if should_suppress_fully_failed_tool_item(item) {
                return Drawn::Nothing;
            }
            if is_hook_approval_denial_tool_item(item) {
                return Drawn::Block(Box::new(HookDenialCard::new(item, columns)));
            }
            // The tool card is expanded by the transcript-wide switch or by the item, and every card keeps its row above
            // (`attached={false}`: consecutive cards stacked flush read broken).
            let mut card = item.clone();
            let expanded = ctx.tool_output_expanded || truthy(item.get("expanded"));
            if let Some(object) = card.as_object_mut() {
                object.insert("expanded".to_owned(), Value::Bool(expanded));
                object.insert("attached".to_owned(), Value::Bool(false));
            }
            Drawn::Lines(render_tool_card(&card, &CardCtx::new(columns, ctx.now_ms)))
        }
        "notice" => {
            let text = text_of(item.get("text")).unwrap_or_default();
            Drawn::Block(Box::new(Notice::new(&text, item.get("tone").and_then(Value::as_str), columns)))
        }
        "turndone" => Drawn::Block(Box::new(turn_done(
            number_or(item.get("elapsedMs"), 0.0),
            item.get("status").and_then(Value::as_str).unwrap_or("done"),
            number_of_truthy(item.get("toolCount")),
            &text_or(item.get("verb"), ""),
            1,
            hint_of(ctx),
            columns,
        ))),
        "statusdone" => Drawn::Block(Box::new(status_done(&text_or(item.get("label"), ""), &text_or(item.get("detail"), ""), 1, hint_of(ctx), columns))),
        _ => Drawn::Nothing,
    }
}

/// Whether the item's own line carries the hint (a completion row), so the caller must not overprint it.
pub(crate) fn carries_hint(item: &Value) -> bool {
    matches!(item.get("kind").and_then(Value::as_str), Some("turndone" | "statusdone"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::Grid;
    use serde_json::json;

    fn rows_of(card: &HookDenialCard, columns: u16) -> Vec<String> {
        let mut grid = Grid::new(columns, card.rows());
        card.paint(&mut Painter::new(&mut grid), 0, 0);
        (0..grid.height).map(|y| grid.row_text(y).trim_end().to_owned()).collect()
    }

    #[test]
    fn a_denial_card_is_a_header_and_a_detail_under_a_row_above() {
        let item =
            json!({ "kind": "tool", "name": "read", "args": { "file_path": "a.txt" }, "isError": true, "result": "Error: tool \"read\" denied by hook: nope" });
        let rows = rows_of(&HookDenialCard::new(&item, 40), 40);
        assert_eq!(rows[0], "");
        assert_eq!(rows[1], format!("{TURN_MARKER} Read (a.txt) \u{b7} Denied"));
        assert_eq!(rows[2], "  \u{2514}  denied by hook: nope");
    }

    #[test]
    fn a_denial_card_cleans_ansi_and_controls_and_adds_no_rows() {
        let item = json!({
            "name": "read",
            "args": { "file_path": "\u{1b}[31mpath\u{1b}[0m\u{0}part\tfile.txt" },
            "result": "Error: tool \"read\" denied\r\nreason\twith\u{0}controls\u{7f}",
        });
        let card = HookDenialCard::new(&item, 80);
        let rows = rows_of(&card, 80);
        assert!(rows[1].contains("path part file.txt") && rows[1].contains("Denied"));
        assert!(rows[2].contains("denied reason with controls"));
        assert_eq!(rows.iter().filter(|row| !row.trim().is_empty()).count(), 2);
    }

    #[test]
    fn a_denial_without_detail_is_one_row_and_the_card_truncates_to_its_width() {
        let item = json!({ "name": "read", "args": { "file_path": "a-very-long-file-name-that-does-not-fit.txt" }, "result": "" });
        let card = HookDenialCard::new(&item, 24);
        assert_eq!(card.rows(), 2);
        let rows = rows_of(&card, 24);
        assert!(rows[1].ends_with('\u{2026}') && mixdog_termtext::display_width(&rows[1]) <= 24);
    }

    #[test]
    fn the_kind_picks_the_component() {
        let ctx = ItemCtx::new(40);
        let rows = |item: Value| match draw_item(&item, &ctx) {
            Drawn::Block(block) => block.rows(),
            Drawn::Lines(lines) => lines.len() as u16,
            Drawn::Nothing => 0,
        };
        assert_eq!(rows(json!({ "kind": "user", "text": "hi" })), 2);
        assert_eq!(rows(json!({ "kind": "assistant", "text": "hi", "id": "a" })), 2);
        assert_eq!(rows(json!({ "kind": "notice", "text": "hi" })), 2);
        assert_eq!(rows(json!({ "kind": "turndone" })), 2);
        assert_eq!(rows(json!({ "kind": "statusdone", "label": "Done" })), 2);
        assert_eq!(rows(json!({ "kind": "mystery" })), 0);
        assert_eq!(rows(json!({ "text": "no kind" })), 0);
        assert_eq!(rows(json!({ "kind": "tool", "name": "read", "isError": true, "result": "" })), 0);
    }

    #[test]
    fn a_user_row_after_a_user_row_is_attached() {
        let mut ctx = ItemCtx::new(40);
        ctx.prev_kind = Some("user".to_owned());
        let Drawn::Block(block) = draw_item(&json!({ "kind": "user", "text": "hi" }), &ctx) else { panic!("a block") };
        assert_eq!(block.rows(), 1);
    }

    #[test]
    fn a_user_row_that_lost_originals_says_so_under_the_message() {
        let ctx = ItemCtx::new(200);
        let drawn = |item: Value| match draw_item(&item, &ctx) {
            Drawn::Lines(lines) => lines.iter().map(|line| line.0.clone()).collect::<Vec<_>>().join("\n"),
            Drawn::Block(_) => String::new(),
            Drawn::Nothing => panic!("a row"),
        };
        let one = drawn(json!({ "kind": "user", "text": "look", "originalImagesMissing": 1 }));
        assert!(one.contains("look") && one.contains("The full-size original of an image could not be found, so it was sent at its smaller size."));
        let two = drawn(json!({ "kind": "user", "text": "look", "originalImagesMissing": 2 }));
        assert!(two.contains("The full-size originals of 2 images could not be found, so they were sent at their smaller size."));
        for none in [json!(0), json!(null), json!("1")] {
            assert!(matches!(draw_item(&json!({ "kind": "user", "text": "look", "originalImagesMissing": none }), &ctx), Drawn::Block(_)));
        }
    }

    #[test]
    fn only_completion_rows_carry_their_own_hint() {
        assert!(carries_hint(&json!({ "kind": "turndone" })));
        assert!(carries_hint(&json!({ "kind": "statusdone" })));
        assert!(!carries_hint(&json!({ "kind": "user" })));
    }
}
