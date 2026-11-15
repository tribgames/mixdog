//! The transcript components (`Message.jsx`, `TranscriptItem.jsx`, `TurnDone.jsx`, `QueuedCommands.jsx`, `Markdown.jsx`,
//! `MarkdownTable.jsx`, `AnsiText.jsx`, `user-message-skills.mjs`, `transcript-tool-failures.mjs`).
//!
//! Every component renders to lines (text carrying SGR and OSC 8 escapes, no line break) and the number of lines is its
//! exact height: the transcript window sizes its rows from it instead of an estimate. A component lays itself out
//! first (it knows its rows before it paints), paints onto a grid of the terminal's width with the painter the other widgets
//! use, and the grid is written back as lines. The live theme is read while a component lays out, so a theme switch needs
//! no epoch.
//!
//! * [`render_item`]: one store item by its kind (`user`, `assistant`, `tool` hook denials and failed batches, `notice`,
//!   `turndone`, `statusdone`), with the right hint the transcript overprints; a tool card is laid out by
//!   [`crate::tool_cards`], which gets the item with `expanded` already resolved (the transcript-wide switch or the
//!   item's own).
//! * [`render_assistant_message`], [`render_user_message`], [`render_notice`], [`render_turn_done`], [`render_status_done`],
//!   [`render_tool_hook_denial`], [`render_queued_commands`]: the components on their own.
//! * [`render_markdown`], [`render_streaming_markdown`], [`render_markdown_table`], [`render_ansi_text`]: the markdown
//!   renderer, whose stable blocks come from the streaming split and whose tail is lexed again as it grows.
//! * [`skills`] and [`tool_failures`]: the pure rules the rows use.

use mixdog_markdown_ansi::lexer::Token;
use mixdog_markdown_ansi::table::build_table_render;
use mixdog_term::frame::{Color, Grid, Style};
use mixdog_term::paint::{Painter, TextWrap};
use serde_json::Value;

use crate::Line;

mod ansi_text;
mod item;
mod layout;
mod lines;
mod markdown;
mod message;
mod queued;
pub mod skills;
pub mod tool_failures;
mod turn_done;

use item::{Drawn, HookDenialCard, carries_hint, draw_item};
use layout::{Block, TextBox};
use turn_done::RightHint;

/// What an item needs to render: the columns it is laid out in and what the transcript knows around it.
#[derive(Clone, Debug)]
pub struct ItemCtx {
    pub columns: usize,
    /// The kind of the row above it (a user message after a user message stacks flush).
    pub prev_kind: Option<String>,
    /// The transcript-wide switch that expands every tool card.
    pub tool_output_expanded: bool,
    /// The hint overprinted on the item's last row (a completion row draws it in its own line), and its tone.
    pub right_message: String,
    pub right_tone: String,
    /// The width of the hint cell (`Number(width) || 24`).
    pub right_message_width: f64,
    /// The rows a plain streaming assistant text is cut to (0: not cut).
    pub streaming_window_rows: usize,
    /// The current time in epoch milliseconds: a tool card derives its blink and elapsed time from it.
    pub now_ms: f64,
}

impl ItemCtx {
    /// A context with no neighbour, no hint and no expansion.
    pub fn new(columns: usize) -> Self {
        Self {
            columns,
            prev_kind: None,
            tool_output_expanded: false,
            right_message: String::new(),
            right_tone: "info".to_owned(),
            right_message_width: 24.0,
            streaming_window_rows: 0,
            now_ms: 0.0,
        }
    }
}

/// The lines of a tool card, as a component: the transcript overprints a hint on them like on any row.
struct CardLines(Vec<Line>);

impl Block for CardLines {
    fn rows(&self) -> u16 {
        u16::try_from(self.0.len()).unwrap_or(u16::MAX)
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        for (offset, line) in self.0.iter().enumerate() {
            painter.line(x, y + offset as i32, &line.0, Style::default());
        }
    }
}

/// A component painted onto a grid `columns` wide, with the hint overprinted on its last row, as lines.
fn render_block(block: &dyn Block, columns: usize, hint: Option<&RightHint>) -> Vec<Line> {
    let rows = block.rows();
    let width = u16::try_from(columns).unwrap_or(u16::MAX);
    let mut grid = Grid::new(width, rows);
    let mut painter = Painter::new(&mut grid);
    block.paint(&mut painter, 0, 0);
    if let Some(hint) = hint {
        if rows > 0 {
            hint.paint(&mut painter, 0, i32::from(rows) - 1, columns);
        }
    }
    lines::grid_lines(&grid)
}

/// One transcript item (a store item object) as lines; the number of lines is its exact height.
pub fn render_item(item: &Value, ctx: &ItemCtx) -> Vec<Line> {
    let hint = if carries_hint(item) { None } else { RightHint::new(&ctx.right_message, &ctx.right_tone, ctx.right_message_width) };
    match draw_item(item, ctx) {
        Drawn::Nothing => Vec::new(),
        Drawn::Lines(lines) if hint.is_none() => lines,
        Drawn::Lines(lines) => render_block(&CardLines(lines), ctx.columns, hint.as_ref()),
        Drawn::Block(block) => render_block(block.as_ref(), ctx.columns, hint.as_ref()),
    }
}

/// `AssistantMessage`: the answer of the model in `columns` columns. `assistant_id` keys the streaming caches.
pub fn render_assistant_message(
    text: &str,
    streaming: bool,
    columns: usize,
    assistant_id: Option<&str>,
    streaming_window_rows: usize,
) -> Vec<Line> {
    render_block(&message::AssistantMessage::new(text, streaming, columns, assistant_id, streaming_window_rows), columns, None)
}

/// `UserMessage`: `attached` when the row above is a user message too.
pub fn render_user_message(text: Option<&str>, attached: bool, columns: usize, applied_skills: Option<&Value>) -> Vec<Line> {
    render_block(&message::UserMessage::new(text, attached, columns, applied_skills), columns, None)
}

/// `NoticeMessage` of a `tone` (`error`, `warn`, `info`, `plain`).
pub fn render_notice(text: &str, tone: Option<&str>, columns: usize) -> Vec<Line> {
    render_block(&message::Notice::new(text, tone, columns), columns, None)
}

/// The right hint of a completion line: its message, its tone and the width of its cell.
pub type Hint<'a> = (&'a str, &'a str, f64);

/// `TurnDone`: the line that closes a turn (`elapsed_ms`, a JavaScript number, may be NaN), `margin_top` rows below the
/// row above.
pub fn render_turn_done(
    elapsed_ms: f64,
    status: &str,
    tool_count: f64,
    verb: &str,
    margin_top: u16,
    hint: Option<Hint<'_>>,
    columns: usize,
) -> Vec<Line> {
    let hint = hint.and_then(|(message, tone, width)| RightHint::new(message, tone, width));
    render_block(&turn_done::turn_done(elapsed_ms, status, tool_count, verb, margin_top, hint, columns), columns, None)
}

/// `StatusDone`.
pub fn render_status_done(label: &str, detail: &str, margin_top: u16, hint: Option<Hint<'_>>, columns: usize) -> Vec<Line> {
    let hint = hint.and_then(|(message, tone, width)| RightHint::new(message, tone, width));
    render_block(&turn_done::status_done(label, detail, margin_top, hint, columns), columns, None)
}

/// `ToolHookDenialCard`: a tool call a hook or a person denied.
pub fn render_tool_hook_denial(item: &Value, columns: usize) -> Vec<Line> {
    render_block(&HookDenialCard::new(item, columns), if columns == 0 { 80 } else { columns }, None)
}

/// `QueuedCommands`: the lines typed while a turn is busy (`{ id, text, displayText }` entries); `compact` cuts each to
/// one row.
pub fn render_queued_commands(queued: &[Value], columns: usize, compact: bool) -> Vec<Line> {
    render_block(&queued::QueuedCommands::new(queued, columns, compact), columns, None)
}

/// `Markdown`: `text` as blocks laid out at `columns` (a table, the length of a rule; without it a rule spans 80
/// columns), in a box `width` wide.
pub fn render_markdown(text: &str, trim_partial_fences: bool, columns: Option<usize>, width: usize) -> Vec<Line> {
    render_block(&markdown::markdown(text, trim_partial_fences, columns, width), width, None)
}

/// `StreamingMarkdown`: a settled text, or a growing one split into its settled blocks and its live tail by `stream_key`.
pub fn render_streaming_markdown(text: &str, columns: Option<usize>, stream_key: Option<&str>, streaming: bool, width: usize) -> Vec<Line> {
    render_block(&markdown::streaming_markdown(text, columns, stream_key, streaming, width), width, None)
}

/// `MarkdownTable`: a table token in a box `terminal_columns` wide, laid out at `force_width` when there is one.
pub fn render_markdown_table(token: &Token, force_width: Option<usize>, terminal_columns: usize) -> Vec<Line> {
    let table = build_table_render(token, force_width.unwrap_or(terminal_columns)).join("\n");
    render_block(&TextBox::new(table, Style::default(), TextWrap::Wrap, terminal_columns), terminal_columns, None)
}

/// `AnsiText`: text with SGR escapes as styled spans over `default_color`, in a box `width` wide.
pub fn render_ansi_text(text: &str, default_color: Color, width: usize) -> Vec<Line> {
    render_block(&ansi_text::ansi_text_box(text, default_color, width), width, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_markdown_ansi::lexer::TokenKind;
    use mixdog_markdown_ansi::render::{LexOptions, lex_markdown};
    use serde_json::json;

    fn text(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|line| mixdog_termtext::strip_ansi(&line.0).into_owned()).collect()
    }

    /// The rows without the cells a band is padded with to its right edge (a band is a background: its rows are blank-filled).
    fn trimmed(lines: &[Line]) -> Vec<String> {
        text(lines).into_iter().map(|row| row.trim_end().to_owned()).collect()
    }

    #[test]
    fn an_item_is_its_lines_and_the_count_is_its_height() {
        let lines = render_item(&json!({ "kind": "assistant", "id": "a", "text": "one\n\ntwo" }), &ItemCtx::new(40));
        assert_eq!(lines.len(), 4);
        assert_eq!(text(&lines)[0], "");
        assert!(text(&lines)[1].ends_with("one") && text(&lines)[3].ends_with("two"));
    }

    #[test]
    fn an_item_that_draws_nothing_has_no_lines() {
        assert!(render_item(&json!({ "kind": "unknown" }), &ItemCtx::new(40)).is_empty());
        assert!(render_item(&json!({ "kind": "tool", "name": "read", "isError": true, "result": "" }), &ItemCtx::new(40)).is_empty());
    }

    #[test]
    fn the_hint_is_overprinted_on_the_last_row_of_an_item_without_taking_one() {
        let mut ctx = ItemCtx::new(40);
        ctx.right_message = "hint here".to_owned();
        let with = text(&render_item(&json!({ "kind": "user", "text": "hi" }), &ctx));
        let without = text(&render_item(&json!({ "kind": "user", "text": "hi" }), &ItemCtx::new(40)));
        assert_eq!(with.len(), without.len());
        assert!(with[1].starts_with("  hi") && with[1].ends_with("hint here"));
        assert_eq!(with[0], "");
        // The hint cell is 24 wide with a cell of margin at the right edge.
        assert_eq!(mixdog_termtext::display_width(&with[1]), 39);
    }

    #[test]
    fn a_completion_row_draws_the_hint_in_its_own_line_and_a_blank_hint_draws_nothing() {
        // Wide enough for the copy: the hint takes its 24 cells and the copy is cut to what is left.
        let mut ctx = ItemCtx::new(60);
        ctx.right_message = "next".to_owned();
        let done = text(&render_item(&json!({ "kind": "turndone", "elapsedMs": 12000 }), &ctx));
        assert_eq!(done.len(), 2);
        assert!(done[1].starts_with("\u{25c8} Thought for 12s") && done[1].trim_end().ends_with("next"));
        ctx.right_message = " \n ".to_owned();
        let blank = trimmed(&render_item(&json!({ "kind": "user", "text": "hi" }), &ctx));
        assert_eq!(blank, ["", "  hi"]);
    }

    #[test]
    fn a_completion_item_reads_its_fields_like_the_component() {
        let ctx = ItemCtx::new(60);
        let row = |item: Value| text(&render_item(&item, &ctx)).remove(1);
        assert_eq!(row(json!({ "kind": "turndone" })), "\u{25c8} Thought");
        assert_eq!(row(json!({ "kind": "turndone", "elapsedMs": 5000 })), "\u{25c8} Response complete");
        assert_eq!(row(json!({ "kind": "turndone", "elapsedMs": 12000, "toolCount": 2 })), "\u{25c8} Work complete in 12s");
        assert_eq!(row(json!({ "kind": "turndone", "elapsedMs": 12000, "status": "cancelled" })), "\u{25c8} Cancelled after 12s");
        assert_eq!(row(json!({ "kind": "turndone", "elapsedMs": 12000, "verb": "Mapped" })), "\u{25c8} Mapped for 12s");
        assert_eq!(row(json!({ "kind": "statusdone", "label": "Done", "detail": "2 tasks" })), "\u{25c8} Done \u{b7} 2 tasks");
    }

    #[test]
    fn a_tool_denial_is_a_card_and_stays_visible() {
        let item = json!({ "kind": "tool", "name": "read", "args": { "file_path": "a.txt" }, "isError": true, "result": "Error: tool \"read\" denied by hook: nope" });
        let lines = text(&render_item(&item, &ItemCtx::new(60)));
        assert_eq!(lines.len(), 3);
        assert!(lines[1].ends_with("Read (a.txt) \u{b7} Denied") && lines[2].ends_with("denied by hook: nope"));
        assert_eq!(text(&render_tool_hook_denial(&item, 60)), lines);
    }

    #[test]
    fn the_queue_and_the_ansi_text_render_to_their_own_rows() {
        let queued = render_queued_commands(&[json!({ "id": "a", "text": "queued" })], 30, false);
        assert_eq!(trimmed(&queued), ["  queued"]);
        assert!(render_queued_commands(&[], 30, false).is_empty());
        let ansi = render_ansi_text("\x1b[1mBold\x1b[22m plain", Color::Default, 20);
        assert_eq!(text(&ansi), ["Bold plain"]);
        assert!(ansi[0].0.contains("\x1b[1mBold"));
        assert!(render_ansi_text("\x1b[31m", Color::Default, 20).is_empty());
    }

    #[test]
    fn markdown_blocks_are_a_blank_row_apart_and_a_table_follows_the_forced_width() {
        assert_eq!(text(&render_markdown("# Title\n\nbody", false, Some(30), 30)), ["Title", "", "body"]);
        let tokens = lex_markdown("| A | B |\n|---|---|\n|  | ok |", LexOptions::default());
        let table = tokens.iter().find(|token| token.kind == TokenKind::Table).expect("a table token");
        assert_eq!(text(&render_markdown_table(table, Some(10), 40)), ["A:", "B: ok"]);
    }

    #[test]
    fn a_streaming_text_keeps_every_visible_word_as_it_grows() {
        let key = Some("transcript-grow");
        let prefix = "**stable**\n\n```txt\nlive";
        let first = text(&render_streaming_markdown(prefix, Some(37), key, true, 40)).join("\n");
        assert_eq!(first.matches("stable").count(), 1);
        let grown = text(&render_streaming_markdown(&format!("{prefix}\nmore"), Some(37), key, true, 40)).join("\n");
        assert_eq!(grown.matches("stable").count(), 1);
        assert!(grown.contains("live") && grown.contains("more"));
        assert!(text(&render_streaming_markdown("**tail**", Some(37), key, true, 40)).join("\n").contains("tail"));
    }

    #[test]
    fn user_notice_and_assistant_components_render_as_lines() {
        assert_eq!(trimmed(&render_user_message(Some("hello"), false, 30, None)), ["", "  hello"]);
        assert_eq!(trimmed(&render_notice("hello", Some("warn"), 30)), ["", "  \u{b7} hello"]);
        assert_eq!(text(&render_assistant_message("hello", false, 30, None, 0)).len(), 2);
        assert_eq!(trimmed(&render_turn_done(5000.0, "done", 0.0, "Thought", 0, None, 40)), ["\u{25c8} Response complete"]);
        assert!(text(&render_status_done("Done", "", 0, Some(("next step", "info", 12.0)), 60))[0].trim_end().ends_with("next step"));
    }
}
