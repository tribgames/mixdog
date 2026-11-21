//! The normal (non-aggregate) tool card (`tool-execution/standard-card.jsx`).
//!
//! The collapsed text (label, casing, status merging, the detail row) comes from the shared card model, the one the desktop
//! tool card reads too; width fitting, colours, the blink and the expansion are the terminal's and live here.

use mixdog_js::json_number;
use mixdog_term::frame::Style;
use mixdog_termtext::{StringWidthOptions, string_width};
use mixdog_tui_style::Key;
use mixdog_tui_style::figures::BULLET_OPERATOR;
use mixdog_tui_style::theme::{AGENT_CALL_MARKER, AGENT_RESPONSE_MARKER, TURN_MARKER};
use mixdog_view_model::card_model::card_input::CardOptions;
use mixdog_view_model::card_model::terminal_status::OutcomeToneInput;
use mixdog_view_model::card_model::{HEADER_FAILURE_STATUS_MAX, SUMMARY_MAX_CHARS, derive_tool_card_model, strip_leading_status_marker_from_text};
use serde_json::{Map, Value};

use super::result_body::{ResultBody, render_result_body};
use super::surface_detail::tool_status_color;
use super::text_format::{result_line_max_chars, truncate_to_width};
use super::{Card, call_line};
use crate::{Line, Run, themed};

/// The item fields the card model reads, with the counts this card normalised.
fn model_input(card: &Card) -> Value {
    let mut input = Map::new();
    for key in
        ["name", "args", "result", "rawResult", "isError", "errorCount", "callErrorCount", "exitErrorCount", "startedAt", "completedAt", "headerFinalized"]
    {
        if let Some(value) = card.props.get(key) {
            input.insert(key.to_owned(), value.clone());
        }
    }
    input.insert("count".to_owned(), json_number(card.group_count));
    input.insert("completedCount".to_owned(), json_number(card.done_count));
    input.insert("nowMs".to_owned(), json_number(card.ctx.now_ms));
    Value::Object(input)
}

/// A single header row that never wraps: the fixed trailing hint, the dot gutter and a one-column last-column safety
/// margin are reserved, then label and summary are cut to fit. The hint slot is reserved for the whole lifecycle so its
/// later appearance does not move the body clip point; the pending elapsed time lives on the detail row.
fn fit_header(label_text: &str, header_summary: &str, failure: &str, hint_text: String, show_hint: bool, columns: usize) -> Vec<Run> {
    let cells = |text: &str| string_width(text, StringWidthOptions::default());
    let failure_text = if failure.is_empty() { String::new() } else { truncate_to_width(failure, HEADER_FAILURE_STATUS_MAX) };
    let inline_failure = if failure_text.is_empty() { String::new() } else { format!(" {BULLET_OPERATOR} {failure_text}") };
    let right_reserve = cells(&hint_text) + cells(&inline_failure);
    let avail = columns.saturating_sub(1 + 2 + right_reserve).max(1);
    let (label_out, summary_out) = if cells(label_text) >= avail {
        (truncate_to_width(label_text, avail), String::new())
    } else {
        let parens = if header_summary.is_empty() { 0 } else { cells(" ()") as i64 };
        let budget = avail as i64 - cells(label_text) as i64 - parens;
        let width = budget.clamp(0, SUMMARY_MAX_CHARS as i64) as usize;
        let truncated = if !header_summary.is_empty() && width > 0 { truncate_to_width(header_summary, width) } else { String::new() };
        (label_text.to_owned(), if truncated.is_empty() { String::new() } else { format!(" ({truncated})") })
    };
    vec![
        (label_out, Style { bold: true, ..themed(Key::Text) }),
        (summary_out, themed(Key::Text)),
        (inline_failure, themed(Key::Error)),
        (if show_hint { hint_text } else { String::new() }, themed(Key::Subtle)),
    ]
}

pub(crate) fn render_standard_card(card: &Card) -> Vec<Line> {
    let columns = card.columns;
    let cells = |text: &str| string_width(text, StringWidthOptions::default());
    let max_result_chars = result_line_max_chars(columns);
    let truncate = |text: &str, width: usize| truncate_to_width(text, width);
    let options = CardOptions { truncate: Some(&truncate), max_result_chars: Some(max_result_chars as f64), ..CardOptions::default() };
    let model = derive_tool_card_model(&model_input(card), &options);
    let text = |key: &str| model.get(key).and_then(Value::as_str).unwrap_or_default();
    let flag = |key: &str| model.get(key).and_then(Value::as_bool).unwrap_or(false);
    let label_text = text("labelText");
    let summary_text = text("summaryText");
    let normalized_name = text("normalizedName");
    let first_result_line = text("firstResultLine");
    let total_lines = model.get("totalLines").and_then(Value::as_f64).unwrap_or(0.0);
    let (is_shell, is_agent_surface, is_agent_response) = (flag("isShellSurface"), flag("isAgentSurfaceCard"), flag("isAgentResponse"));
    let (has_display_body, is_background_metadata) = (flag("hasDisplayBody"), flag("isBackgroundMetadataResult"));
    let has_result_summary = !text("resultSummary").is_empty();
    let shell_collapsed_summary = text("shellCollapsedSummary");

    let first_line_clipped = has_display_body && cells(first_result_line) > max_result_chars;
    let has_hidden_detail = !card.pending && has_display_body && (total_lines > 1.0 || first_line_clipped || has_result_summary);
    let background_metadata_expandable = is_background_metadata && card.has_raw_result && !card.pending;
    let show_raw = card.expanded && (has_display_body || card.has_raw_result) && (!is_background_metadata || card.has_raw_result);
    // Skill and agent collapsed gating lives in the shared model's detail line.
    let collapsed_detail = text("detailLine");
    let detail_lines: Vec<String> = if !show_raw && !collapsed_detail.is_empty() { vec![collapsed_detail.to_owned()] } else { Vec::new() };
    let detail_color = if !show_raw && flag("detailIsPlaceholder") { Key::Subtle } else { Key::Text };
    let dot_color = tool_status_color(&OutcomeToneInput {
        pending: card.pending,
        group_count: card.group_count,
        call_failed_count: card.call_failed_count,
        exit_failed_count: card.exit_failed_count,
        terminal_status: text("terminalStatus"),
        partial_mutation: card.partial_mutation,
    });

    // Agent cards use directional markers: `←` for a request going OUT (spawn, send) and `→` for the response coming back
    // IN; every other tool keeps the turn marker. A directional marker carries a trailing space of its own: some terminals
    // draw the arrow 2 cells wide while the width math counts 1, which would glue the label to it.
    let marker = if is_agent_response {
        format!("{AGENT_RESPONSE_MARKER} ")
    } else if is_agent_surface {
        format!("{AGENT_CALL_MARKER} ")
    } else {
        TURN_MARKER.to_owned()
    };
    let dot_text = if card.pending && !card.blink_on { " ".to_owned() } else { marker };

    // An agent card hides its collapsed body but offers expansion only when that reveals something: a response body, or a
    // multi-line or clipped raw result. A status-only one-liner has nothing extra to show.
    let agent_expandable = is_agent_surface && !card.pending && card.has_result && (is_agent_response || total_lines > 1.0 || first_line_clipped);
    let shell_expandable = is_shell
        && !card.pending
        && flag("hasDisplayResult")
        && has_display_body
        && (total_lines > 1.0 || first_line_clipped || (!shell_collapsed_summary.is_empty() && shell_collapsed_summary != first_result_line));
    let expandable = if is_shell {
        shell_expandable
    } else if is_agent_surface {
        agent_expandable
    } else {
        has_hidden_detail || background_metadata_expandable
    };
    let show_hint = expandable && normalized_name != "load_tool";

    let hint_text = format!(" {BULLET_OPERATOR} ctrl+o {}", if card.expanded { "collapse" } else { "expand" });
    // A shell header stays label-only ("Ran 1 command"): the command line lives in the expanded body.
    let header_summary = if is_shell { "" } else { summary_text };
    let header = fit_header(label_text, header_summary, text("headerFailureText"), hint_text, show_hint, columns);

    let raw_text = if !show_raw {
        String::new()
    } else if has_display_body {
        text("displayedResultBodyText").to_owned()
    } else {
        strip_leading_status_marker_from_text(card.raw_rt.as_deref().unwrap_or_default())
    };
    let mut rows = card.leading_rows();
    rows.push(call_line(&dot_text, dot_color, &header, columns));
    rows.extend(render_result_body(&ResultBody {
        lines: &detail_lines,
        raw_text: &raw_text,
        path_arg: text("toolArgPath"),
        is_shell,
        columns,
        color: if show_raw { Key::Text } else { detail_color },
        raw: show_raw,
        max_render_lines: card.ctx.max_render_lines,
    }));
    rows
}

#[cfg(test)]
mod tests {
    use mixdog_termtext::strip_ansi;
    use serde_json::{Value, json};

    use super::super::{CardCtx, render_tool_card};

    fn show(props: Value, columns: usize) -> Vec<String> {
        let ctx = CardCtx { columns, now_ms: 20_000.0, max_render_lines: 600 };
        render_tool_card(&props, &ctx).iter().map(|line| strip_ansi(&line.0).trim_end().to_owned()).collect()
    }

    #[test]
    fn a_finished_shell_card_is_label_only_with_a_hint_and_a_status_row() {
        let rows = show(json!({ "name": "bash", "args": { "command": "ls" }, "result": "a\nb", "startedAt": 1000, "completedAt": 13_000 }), 80);
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[0], "");
        assert!(rows[1].contains("Ran 1 command"), "{rows:?}");
        assert!(!rows[1].contains("ls"));
        assert!(rows[2].starts_with("  \u{2514}  "));
    }

    #[test]
    fn an_attached_card_has_no_leading_blank_row() {
        let rows = show(json!({ "name": "read", "args": { "path": "a.rs" }, "result": "x", "attached": true }), 80);
        assert!(!rows[0].is_empty());
    }

    #[test]
    fn a_narrow_header_never_wraps() {
        let rows = show(json!({ "name": "read", "args": { "path": "a/very/long/path/to/some/file.rs" }, "result": "1\u{2192}x\n2\u{2192}y" }), 40);
        assert!(rows.iter().all(|row| mixdog_termtext::display_width(row) <= 40), "{rows:?}");
    }
}
