//! The grouped (aggregate) tool card (`tool-execution/aggregate-card.jsx`): category counts in the header ("Read 6 files,
//! Searched 5 files"), one detail row under the gutter.

use mixdog_js::{to_number_of, value_to_string};
use mixdog_termtext::{StringWidthOptions, string_width};
use mixdog_tui_style::Key;
use mixdog_tui_style::figures::BULLET_OPERATOR;
use mixdog_tui_style::theme::TURN_MARKER;
use mixdog_view_model::card_model::terminal_status::OutcomeToneInput;
use mixdog_view_model::card_model::{display_terminal_status, normalize_count_map, result_terminal_status, safe_inline_text};
use mixdog_view_model::results::status::aggregate_raw_result_for_display;
use mixdog_view_model::tool_surface::{AggregateHeaderOptions, format_aggregate_header};
use serde_json::{Map, Value};

use super::result_body::{ResultBody, render_result_body};
use super::surface_detail::tool_status_color;
use super::text_format::truncate_to_width;
use super::{Card, call_line};
use crate::{Line, Run, themed};

/// `Number(value.count || 0)` of an entry, or `Number(value || 0)` of a bare count.
fn count_of(value: &Value) -> f64 {
    let source = if matches!(value, Value::Object(_) | Value::Array(_)) { value.get("count") } else { Some(value) };
    if super::truthy(source) { to_number_of(source) } else { 0.0 }
}

pub(crate) fn render_aggregate_card(card: &Card) -> Vec<Line> {
    let columns = card.columns;
    // A pending header omits counts so intermediate batches do not bounce between "Reading 1 item" and "Reading 4 items";
    // the final counts appear after completion.
    let order: Option<Vec<String>> = card.prop("args").and_then(|args| args.get("categoryOrder")).and_then(Value::as_array).map(|items| items.iter().map(value_to_string).collect());
    let order_refs: Option<Vec<&str>> = order.as_ref().map(|items| items.iter().map(String::as_str).collect());
    let empty = Value::Object(Map::new());
    let display_categories = normalize_count_map(card.prop("categories").filter(|v| super::truthy(Some(*v))).unwrap_or(&empty));
    // In the done state the engine's doneCategories count ATTEMPTS (failures included) so the header total matches the
    // "N Ok · N Failed" detail; an all-failed group collapses them to zero counts, so the call-time counts show instead.
    let done_categories = card.prop("doneCategories").filter(|v| super::truthy(Some(*v))).map_or_else(|| display_categories.clone(), normalize_count_map);
    let has_done_counts = done_categories.as_object().is_some_and(|map| map.values().any(|count| count_of(count) > 0.0));
    let display_done = if has_done_counts { done_categories } else { display_categories.clone() };
    let header_text = safe_inline_text(&format_aggregate_header(
        if card.header_pending { &display_categories } else { &display_done },
        &AggregateHeaderOptions { pending: card.header_pending, order: order_refs.as_deref(), failed: card.failed_count > 0.0 && card.failed_count >= card.group_count, ..AggregateHeaderOptions::default() },
    ));
    // The card keeps one detail row whatever happens, so it never grows when the summary lands: the summary can be
    // several lines, which are made one logical line here and fitted to the width by the body.
    let detail_text = if card.has_result { safe_inline_text(card.rt.as_deref().unwrap_or_default()) } else { String::new() };

    // The dot colour follows the status of the summary (a cancelled group carries its marker) or the failures; a pending
    // group stays running and a clean completion succeeds.
    let terminal_status = if card.pending {
        "running"
    } else {
        match result_terminal_status(card.rt.as_deref().unwrap_or_default()) {
            "" => if card.is_error || card.failed_count > 0.0 { "failed" } else { "completed" },
            reported => reported,
        }
    };
    let dot_color = tool_status_color(&OutcomeToneInput {
        pending: card.pending,
        group_count: card.group_count,
        call_failed_count: card.call_failed_count,
        exit_failed_count: card.exit_failed_count,
        terminal_status,
        partial_mutation: card.partial_mutation,
    });
    let dot_text = if card.pending && !card.blink_on { " " } else { TURN_MARKER };

    let hint_text = format!(" {BULLET_OPERATOR} ctrl+o {}", if card.expanded { "collapse" } else { "expand" });
    // The hint slot is reserved for the whole lifecycle so the clip point stays fixed when the hint appears.
    let avail = columns.saturating_sub(1 + 2 + string_width(&hint_text, StringWidthOptions::default())).max(1);
    let clipped_header = if string_width(&header_text, StringWidthOptions::default()) > avail { truncate_to_width(&header_text, avail) } else { header_text };
    let trailing = if card.has_raw_result { hint_text } else { String::new() };

    let show_raw = card.expanded && card.has_raw_result;
    let is_placeholder = !show_raw && detail_text.is_empty();
    // The placeholder states the real outcome (a failed batch never says Finished); it tracks real completion, not the header.
    let placeholder = if card.pending {
        "Running".to_owned()
    } else {
        match display_terminal_status(terminal_status) {
            "" => "Finished".to_owned(),
            word => word.to_owned(),
        }
    };
    let detail_lines: Vec<String> = if show_raw { Vec::new() } else { vec![if detail_text.is_empty() { placeholder } else { detail_text }] };

    let mut rows = card.leading_rows();
    let header: Vec<Run> = vec![(clipped_header, mixdog_term::frame::Style { bold: true, ..themed(Key::Text) }), (trailing, themed(Key::Subtle))];
    rows.push(call_line(dot_text, dot_color, &header, columns));
    let raw_text = if show_raw { aggregate_raw_result_for_display(card.raw_rt.as_deref().unwrap_or_default()) } else { String::new() };
    rows.extend(render_result_body(&ResultBody {
        lines: &detail_lines,
        raw_text: &raw_text,
        path_arg: "",
        is_shell: false,
        columns,
        color: if is_placeholder { Key::Subtle } else { Key::Text },
        raw: show_raw,
        max_render_lines: card.ctx.max_render_lines,
    }));
    rows
}
