//! The tool execution cards (`ToolExecution.jsx` and `tool-execution/*`): a tool call and its result.
//!
//! The call line is `● Label (summary)`: the dot is the 2-wide gutter, the label is the user-facing name and the argument
//! summary sits in parentheses. The result hangs under one dim `└` gutter that is placed once, not repeated per wrapped line.
//!
//! * [`standard`]: the normal card; [`aggregate`]: the grouped card ("Read 3 files, searched 2");
//! * [`placeholder`]: the blank rows a freshly started tool reserves while it is inside its pending-show delay;
//! * [`result_body`]: the body under the gutter (collapsed fitted summary or expanded raw body);
//! * [`output_format`]: the post-processing of an expanded body (JSON, diffs, code, links, row caps);
//! * [`text_format`], [`surface_detail`]: width fitting, delta colouring and the status colour.
//!
//! The card is a pure function of its props and the clock the owner passes in: the blink phase and the pending-show delay
//! are derived from [`CardCtx::now_ms`], so a card owns no timer.

pub mod aggregate;
pub mod output_format;
pub mod placeholder;
pub mod result_body;
pub mod standard;
pub mod surface_detail;
pub mod text_format;

use mixdog_js::{js_trim, js_trim_end, to_number_of, value_to_string};
use mixdog_termtext::truncate::{TruncatePosition, truncate};
use mixdog_termtext::{StringWidthOptions, string_width};
use mixdog_tui_style::Key;
use mixdog_view_model::card_model::clamp_failure_count;
use serde_json::Value;

use crate::{Line, Run, runs_to_ansi, themed};

/// How often the blink phase flips while a tool is pending.
pub const TOOL_BLINK_MS: f64 = 500.0;
/// How long a pending tool with nothing to show waits before its card appears.
pub const TOOL_PENDING_SHOW_DELAY_MS: f64 = 1000.0;
/// The cadence the owner re-renders a pending card at: one tick drives both the blink and the elapsed seconds.
pub const TOOL_ANIM_TICK_MS: f64 = TOOL_BLINK_MS;

/// What a card needs besides its props: the columns it is laid out in, the clock and the row cap of an expanded body.
#[derive(Clone, Copy, Debug)]
pub struct CardCtx {
    pub columns: usize,
    /// The current time in epoch milliseconds (`Date.now()`); the card derives its blink and elapsed time from it.
    pub now_ms: f64,
    /// The cap of physical rows an expanded body mounts; 0 disables it.
    pub max_render_lines: usize,
}

impl CardCtx {
    /// A context whose row cap comes from the environment (`MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES`).
    pub fn new(columns: usize, now_ms: f64) -> Self {
        Self { columns, now_ms, max_render_lines: output_format::max_render_lines_from_env() }
    }
}

/// JavaScript truthiness of a prop.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number(value || fallback)`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    if truthy(value) { to_number_of(value) } else { fallback }
}

/// The text of a prop with its trailing whitespace removed; none for an absent or null prop.
fn trailing_trimmed(value: Option<&Value>) -> Option<String> {
    value.filter(|v| !v.is_null()).map(|v| js_trim_end(&value_to_string(v)).to_owned())
}

/// The derived state both card shapes read (the `card` object `ToolExecution` builds).
pub(crate) struct Card<'a> {
    pub props: &'a Value,
    pub ctx: &'a CardCtx,
    pub columns: usize,
    pub expanded: bool,
    pub attached: bool,
    pub group_count: f64,
    pub done_count: f64,
    pub rt: Option<String>,
    pub raw_rt: Option<String>,
    pub pending: bool,
    pub blink_on: bool,
    pub header_pending: bool,
    pub has_result: bool,
    pub has_raw_result: bool,
    pub is_error: bool,
    pub failed_count: f64,
    pub call_failed_count: f64,
    pub exit_failed_count: f64,
    pub partial_mutation: bool,
}

impl<'a> Card<'a> {
    fn new(props: &'a Value, ctx: &'a CardCtx) -> Self {
        let prop = |key: &str| props.get(key);
        let columns = if ctx.columns == 0 { 80 } else { ctx.columns };
        let group_count = number_or(prop("count"), 1.0).max(1.0);
        let result = prop("result").filter(|v| !v.is_null());
        let done_count = number_or(prop("completedCount"), if result.is_none() { 0.0 } else { group_count }).min(group_count).max(0.0);
        let rt = trailing_trimmed(prop("result"));
        let raw_rt = trailing_trimmed(prop("rawResult"));
        let pending = done_count < group_count;
        let non_blank = |text: &Option<String>| text.as_deref().is_some_and(|text| !js_trim(text).is_empty());
        let now = ctx.now_ms;
        // While pending, the dot keeps blinking until the tool resolves; the phase comes from the clock.
        let blink_on = !(pending && Self::display_ready(props, ctx, pending, done_count, &rt)) || (now / TOOL_BLINK_MS).floor() % 2.0 == 0.0;
        let is_error = truthy(prop("isError"));
        // The verb stays active until the engine seals the tool block, so a fast batch does not flip "Finding" to
        // "Found" and back between provider iterations.
        let header_pending = pending || prop("headerFinalized") == Some(&Value::Bool(false));
        let call_failed_count = clamp_failure_count(prop("callErrorCount"), group_count, false);
        // apply_patch can commit an ordered prefix before a later section fails: a runtime diff is evidence of that
        // partial mutation, an empty or missing one means the invocation failed completely.
        let partial_mutation = call_failed_count > 0.0 && prop("uiDiff").and_then(Value::as_str).is_some_and(|diff| !js_trim(diff).is_empty());
        Self {
            props,
            ctx,
            columns,
            expanded: truthy(prop("expanded")),
            attached: truthy(prop("attached")),
            group_count,
            done_count,
            has_result: result.is_some() && non_blank(&rt),
            has_raw_result: prop("rawResult").is_some_and(|v| !v.is_null()) && non_blank(&raw_rt),
            rt,
            raw_rt,
            pending,
            blink_on,
            header_pending,
            is_error,
            // Only a real tool-call failure paints the dot red; a command's own failure is counted in `failed_count`
            // but never in the call count.
            failed_count: clamp_failure_count(prop("errorCount"), group_count, is_error),
            call_failed_count,
            exit_failed_count: clamp_failure_count(prop("exitErrorCount"), group_count, false),
            partial_mutation,
        }
    }

    /// Whether the card paints itself: it is not pending, or its pending-show delay has elapsed, or it already has
    /// something to paint (a result landed, or one of a group's parallel calls completed), or the owner says so. A pending
    /// card with something to show skips the blank placeholder: it appears populated and only grows as more results land.
    fn display_ready(props: &Value, ctx: &CardCtx, pending: bool, done_count: f64, rt: &Option<String>) -> bool {
        if !pending {
            return true;
        }
        let started_at = number_or(props.get("startedAt"), 0.0);
        let age = if started_at != 0.0 { (ctx.now_ms - started_at).max(0.0) } else { 0.0 };
        let delay_elapsed = started_at == 0.0 || age >= TOOL_PENDING_SHOW_DELAY_MS;
        let visible_progress = done_count > 0.0 || rt.as_deref().is_some_and(|text| !js_trim(text).is_empty());
        delay_elapsed || visible_progress || truthy(props.get("deferredDisplayReady"))
    }

    /// A prop; none for an absent or null one.
    pub fn prop(&self, key: &str) -> Option<&'a Value> {
        self.props.get(key).filter(|v| !v.is_null())
    }

    /// The marginTop of a card that does not continue the one above.
    pub fn leading_rows(&self) -> Vec<Line> {
        if self.attached { Vec::new() } else { vec![Line(String::new())] }
    }
}

/// The call line: the status dot in its 2-wide gutter, then the runs of the header, one row that never wraps (what does not
/// fit is cut with an ellipsis). A directional marker carries its own trailing space, so the gap survives a terminal that
/// draws the arrow 2 cells wide.
pub(crate) fn call_line(dot_text: &str, dot_color: Key, text: &[Run], columns: usize) -> Line {
    let cells = |text: &str| string_width(text, StringWidthOptions::default());
    let gutter = cells(dot_text).max(2);
    let rest = truncate(&runs_to_ansi(text), columns.saturating_sub(gutter), TruncatePosition::End);
    let dot = runs_to_ansi(&[(dot_text.to_owned(), themed(dot_color))]);
    Line(format!("{dot}{}{rest}", " ".repeat(gutter - cells(dot_text))))
}

/// One tool card as lines; the number of lines is its exact height. `card` carries the props of the tool item (`name`,
/// `args`, `result`, `rawResult`, `uiDiff`, `isError`, `errorCount`, `callErrorCount`, `exitErrorCount`, `expanded`,
/// `attached`, `count`, `completedCount`, `startedAt`, `completedAt`, `aggregate`, `categories`, `doneCategories`,
/// `headerFinalized`, `deferredDisplayReady`); the columns, the clock and the row cap are the context's.
pub fn render_tool_card(card: &Value, ctx: &CardCtx) -> Vec<Line> {
    let card = Card::new(card, ctx);
    // A freshly started tool inside its pending-show delay reserves the same height the row estimate predicts, blank, so
    // nothing reflows when the real header and detail fill in place.
    if card.pending && !Card::display_ready(card.props, ctx, card.pending, card.done_count, &card.rt) {
        return placeholder::render_pending_placeholder(&card);
    }
    if truthy(card.prop("aggregate")) {
        return aggregate::render_aggregate_card(&card);
    }
    standard::render_standard_card(&card)
}

#[cfg(test)]
mod tests {
    use mixdog_termtext::strip_ansi;
    use serde_json::json;

    use super::*;

    fn show(props: Value, columns: usize) -> Vec<String> {
        let ctx = CardCtx { columns, now_ms: 20_000.0, max_render_lines: 600 };
        render_tool_card(&props, &ctx).iter().map(|line| strip_ansi(&line.0).trim_end().to_owned()).collect()
    }

    fn text(lines: &[String]) -> String {
        lines.join("\n")
    }

    fn merged(base: &Value, extra: Value) -> Value {
        let mut props = base.clone();
        props.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        props
    }

    #[test]
    fn aggregate_cards_retain_status_collapsed_summaries_and_raw_expansion() {
        let base = json!({ "aggregate": true, "categories": { "read": 2 }, "count": 2, "startedAt": 1000 });
        assert!(text(&show(merged(&base, json!({ "completedCount": 0 })), 160)).contains("Running"));
        assert!(text(&show(merged(&base, json!({ "completedCount": 2 })), 160)).contains("Finished"));

        let completed = merged(&base, json!({ "completedCount": 2, "result": "summary alpha\nsummary beta", "rawResult": "raw alpha\nraw beta" }));
        let collapsed = text(&show(completed.clone(), 160));
        assert!(collapsed.contains("summary alpha summary beta"));
        assert!(!collapsed.contains("raw alpha"));
        assert!(collapsed.contains("ctrl+o expand"));
        let expanded = text(&show(merged(&completed, json!({ "expanded": true })), 160));
        assert!(expanded.contains("raw alpha") && expanded.contains("raw beta"));
        assert!(!expanded.contains("summary alpha"));
        assert!(expanded.contains("ctrl+o collapse"));
    }

    #[test]
    fn normal_cards_preserve_shell_agent_and_generic_body_selection_and_expansion_hints() {
        let shell = json!({ "name": "shell", "args": { "command": "echo output" }, "result": "first\nsecond" });
        let collapsed = text(&show(shell.clone(), 160));
        assert!(collapsed.contains("ctrl+o expand"));
        assert!(!collapsed.contains("second"));
        let expanded = text(&show(merged(&shell, json!({ "expanded": true })), 160));
        assert!(expanded.contains("first") && expanded.contains("second"));
        assert!(expanded.contains("ctrl+o collapse"));

        let request = show(json!({ "name": "agent", "args": { "type": "spawn", "agent": "worker" }, "startedAt": 1000 }), 160);
        assert!(request.iter().any(|row| row.starts_with(mixdog_tui_style::theme::AGENT_CALL_MARKER)), "{request:?}");
        assert!(!text(&request).contains("ctrl+o"));

        let response = text(&show(
            json!({
                "name": "agent",
                "args": { "type": "result", "agent": "worker", "status": "completed" },
                "result": "summary alpha\nsummary beta",
                "rawResult": "raw alpha\nraw beta",
                "agentResponseAggregate": true,
                "expanded": true,
            }),
            160,
        ));
        assert!(response.contains(mixdog_tui_style::theme::AGENT_RESPONSE_MARKER));
        assert!(response.contains("summary alpha") && response.contains("summary beta"));
        assert!(!response.contains("raw alpha"));

        let raw_only = text(&show(json!({ "name": "custom", "completedCount": 1, "rawResult": "raw alpha\nraw beta", "expanded": true }), 160));
        assert!(raw_only.contains("raw alpha") && raw_only.contains("raw beta"));
        assert!(!text(&show(json!({ "name": "load_tool", "result": "first\nsecond" }), 160)).contains("ctrl+o"));
    }

    #[test]
    fn a_fresh_pending_card_reserves_blank_rows_until_its_delay_elapses() {
        let fresh = json!({ "name": "read", "args": { "path": "a.rs" }, "completedCount": 0, "startedAt": 19_500 });
        assert_eq!(show(fresh.clone(), 80), vec!["", "", ""]);
        assert_eq!(show(merged(&fresh, json!({ "attached": true })), 80), vec!["", ""]);
        assert!(text(&show(merged(&fresh, json!({ "startedAt": 18_000 })), 80)).contains("Running"));
    }

    #[test]
    fn a_pending_group_with_one_result_skips_the_placeholder() {
        let props = json!({ "aggregate": true, "categories": { "read": 2 }, "count": 2, "completedCount": 1, "startedAt": 19_900, "result": "one done" });
        assert!(text(&show(props, 80)).contains("one done"));
    }
}
