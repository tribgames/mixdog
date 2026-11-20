//! The raw tool item fields normalised into the counts, progress flags, elapsed label and row budgets every card model
//! shares (`shared/tool-card-model/card-input.mjs`).

use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::json_number;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use mixdog_tui_style::time_format::format_elapsed;
use serde_json::Map;
use serde_json::Value;

use super::inline_text::MIN_RESULT_LINE_CHARS;
use super::inline_text::RESULT_LINE_HARD_MAX;
use super::inline_text::clip_plain;
use super::terminal_status::clamp_failure_count;
use crate::errors::js_value::system_now_ms;
use crate::results::summary::Translate;
use crate::tool_primitives::field;
use crate::tool_primitives::truthy;

/// `(text, width) -> text` fitting a row; the surface's own width fitting.
pub type Truncate<'a> = &'a dyn Fn(&str, usize) -> String;

/// The options of a card derivation: the surface's width fitting, its result row budget and its catalog.
#[derive(Clone, Copy, Default)]
pub struct CardOptions<'a> {
    pub truncate: Option<Truncate<'a>>,
    pub max_result_chars: Option<f64>,
    pub translate: Option<Translate<'a>>,
}

/// The item fields every card model reads, normalised.
pub struct CardBase<'a> {
    pub name: String,
    pub args: Value,
    pub is_error: bool,
    pub aggregate: bool,
    pub categories: Value,
    pub done_categories: Option<Value>,
    pub truncate: Truncate<'a>,
    pub max_result_chars: usize,
    pub group_count: f64,
    pub done_count: f64,
    /// The result with trailing whitespace removed; `None` while there is no result.
    pub rt: Option<String>,
    pub pending: bool,
    pub header_pending: bool,
    pub has_result: bool,
    pub has_raw_result: bool,
    pub elapsed: String,
    pub failed_count: f64,
    pub call_failed_count: f64,
    pub exit_failed_count: f64,
}

/// `Number(value || fallback)` of a field.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    if truthy(value) { value.map_or(fallback, |v| to_number_of(Some(v))) } else { fallback }
}

/// `trimTrailing`: the value as text without trailing whitespace; `None` for an absent or null value.
fn trim_trailing(value: Option<&Value>) -> Option<String> {
    value.filter(|v| !v.is_null()).map(|v| js_trim_end(&value_to_string(v)).to_owned())
}

/// `readCardInput`: `name` and `args` are the call as shown (after a `call_tool` request is unwrapped).
pub fn read_card_input<'a>(input: &Value, name: &str, args: Value, options: &CardOptions<'a>) -> CardBase<'a> {
    let default_truncate: Truncate<'a> = &clip_plain;
    let truncate = options.truncate.unwrap_or(default_truncate);
    let max_result_chars = options.max_result_chars.unwrap_or(RESULT_LINE_HARD_MAX as f64).min(RESULT_LINE_HARD_MAX as f64).max(MIN_RESULT_LINE_CHARS as f64);
    let result = field(input, "result");
    let result_absent = result.is_none_or(Value::is_null);
    let group_count = number_or(field(input, "count"), 1.0).max(1.0);
    let completed = field(input, "completedCount").filter(|v| !v.is_null());
    let done_count = completed.map_or(if result_absent { 0.0 } else { group_count }, |value| to_number_of(Some(value))).min(group_count).max(0.0);
    let rt = trim_trailing(result);
    let raw_rt = trim_trailing(field(input, "rawResult"));
    let pending = done_count < group_count;
    let started_at = number_or(field(input, "startedAt"), 0.0);
    let completed_at = number_or(field(input, "completedAt"), 0.0);
    let now = number_or(field(input, "nowMs"), system_now_ms());
    let end = if pending {
        now
    } else if completed_at != 0.0 && !completed_at.is_nan() {
        completed_at
    } else {
        now
    };
    let elapsed_ms = if started_at != 0.0 && !started_at.is_nan() { (end - started_at).max(0.0) } else { 0.0 };
    let is_error = truthy(field(input, "isError"));
    let header_finalized = field(input, "headerFinalized") != Some(&Value::Bool(false));
    CardBase {
        name: name.to_owned(),
        args,
        is_error,
        aggregate: truthy(field(input, "aggregate")),
        categories: field(input, "categories").cloned().unwrap_or_else(|| Value::Object(Map::new())),
        done_categories: field(input, "doneCategories").filter(|v| truthy(Some(v))).cloned(),
        truncate,
        max_result_chars: if max_result_chars.is_nan() { 1 } else { max_result_chars.floor() as usize },
        group_count,
        done_count,
        pending,
        header_pending: pending || !header_finalized,
        has_result: result.is_some_and(|v| !v.is_null()) && rt.as_deref().is_some_and(|text| !js_trim(text).is_empty()),
        has_raw_result: field(input, "rawResult").is_some_and(|v| !v.is_null()) && raw_rt.as_deref().is_some_and(|text| !js_trim(text).is_empty()),
        rt,
        elapsed: if elapsed_ms >= 1000.0 { format_elapsed(elapsed_ms) } else { String::new() },
        failed_count: clamp_failure_count(field(input, "errorCount"), group_count, is_error),
        call_failed_count: clamp_failure_count(field(input, "callErrorCount"), group_count, false),
        exit_failed_count: clamp_failure_count(field(input, "exitErrorCount"), group_count, false),
    }
}

/// `commonCardFields`: the fields every card model (aggregate or single tool) reports.
pub fn common_card_fields(base: &CardBase, terminal_status: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("pending".to_owned(), Value::Bool(base.pending));
    map.insert("headerPending".to_owned(), Value::Bool(base.header_pending));
    map.insert("groupCount".to_owned(), json_number(base.group_count));
    map.insert("doneCount".to_owned(), json_number(base.done_count));
    map.insert("elapsed".to_owned(), Value::from(base.elapsed.clone()));
    map.insert("failedCount".to_owned(), json_number(base.failed_count));
    map.insert("callFailedCount".to_owned(), json_number(base.call_failed_count));
    map.insert("exitFailedCount".to_owned(), json_number(base.exit_failed_count));
    map.insert("terminalStatus".to_owned(), Value::from(terminal_status.to_owned()));
    map.insert("hasResult".to_owned(), Value::Bool(base.has_result));
    map.insert("hasRawResult".to_owned(), Value::Bool(base.has_raw_result));
    map
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn read(input: Value) -> CardBase<'static> {
        read_card_input(&input, "read", json!({}), &CardOptions::default())
    }

    #[test]
    fn progress_follows_the_completed_count() {
        let pending = read(json!({ "nowMs": 20_000, "startedAt": 5_000 }));
        assert!(pending.pending && pending.header_pending && !pending.has_result);
        assert_eq!(pending.elapsed, "15s");
        let done = read(json!({ "result": "ok  \n", "count": 3, "nowMs": 9, "startedAt": 5, "completedAt": 47_000 }));
        assert!(!done.pending && done.has_result);
        assert_eq!((done.rt.as_deref(), done.group_count, done.done_count, done.elapsed.as_str()), (Some("ok"), 3.0, 3.0, "46s"));
        let partial = read(json!({ "result": "x", "count": 3, "completedCount": 1 }));
        assert!(partial.pending);
        assert!(read(json!({ "result": "x", "headerFinalized": false })).header_pending);
    }

    #[test]
    fn failure_counts_default_to_the_error_flag() {
        let failed = read(json!({ "result": "x", "count": 2, "isError": true }));
        assert_eq!((failed.failed_count, failed.call_failed_count, failed.exit_failed_count), (2.0, 0.0, 0.0));
        let explicit = read(json!({ "result": "x", "count": 4, "errorCount": 3, "callErrorCount": 9, "exitErrorCount": 1 }));
        assert_eq!((explicit.failed_count, explicit.call_failed_count, explicit.exit_failed_count), (3.0, 4.0, 1.0));
    }

    #[test]
    fn the_row_budget_is_clamped() {
        let budget = |chars: Option<f64>| {
            let options = CardOptions { max_result_chars: chars, ..CardOptions::default() };
            read_card_input(&json!({}), "read", json!({}), &options).max_result_chars
        };
        assert_eq!((budget(None), budget(Some(10.0)), budget(Some(500.0)), budget(Some(40.0))), (80, 24, 80, 40));
    }

    #[test]
    fn a_blank_result_is_no_result() {
        let blank = read(json!({ "result": " \n", "rawResult": "raw" }));
        assert!(!blank.has_result && blank.has_raw_result);
        assert_eq!(blank.rt.as_deref(), Some(""));
    }
}
