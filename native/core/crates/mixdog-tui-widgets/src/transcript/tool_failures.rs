//! `src/tui/transcript-tool-failures.mjs`: which fully failed tool batches the transcript hides. A hook or approval denial
//! is user-actionable and stays visible; a batch that failed all over with nothing to read is hidden.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, to_number_of, value_to_string};
use mixdog_view_model::tool_primitives::parse_tool_args;
use serde_json::Value;

/// The denial the orchestrator writes at the START of a result: `Error: tool "<name>" denied by hook[: ...]`, or
/// `Error: tool "<name>" was not approved: <reason>` when a person said no. Matching the phrase anywhere would hide
/// ordinary results that merely contain it.
static HOOK_DENIAL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"^Error:\s*tool\s*"[^"]*"\s*(?:denied by hook|was not approved)\b"#, "im"));
/// The not-approved denial's instruction to the model, not shown to the user.
static NOT_APPROVED_INSTRUCTION: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\s*Do not retry it or reach the same result another way; report it\.\s*$", ""));
static APPROVAL_UNAVAILABLE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"denied by hook:\s*approval required but no approval UI is available", "i"));
static ERROR_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"^Error:\s*tool\s*"[^"]*"\s*"#, "i"));
static TERMINAL_STATUS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(failed|error|timeout|cancelled|canceled|killed)$", ""));

/// JavaScript truthiness of a parsed value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Math.max` and `Math.min`: a NaN stays NaN.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

fn is_tool(item: &Value) -> bool {
    item.get("kind").and_then(Value::as_str) == Some("tool")
}

/// `toolItemResultText(item)`: the result and the raw result when it differs, joined and trimmed.
pub fn tool_item_result_text(item: &Value) -> String {
    let present = |key: &str| item.get(key).filter(|value| !value.is_null());
    let mut chunks: Vec<String> = Vec::new();
    let result = present("result");
    if let Some(result) = result {
        chunks.push(value_to_string(result));
    }
    if let Some(raw) = present("rawResult")
        && Some(raw) != result
    {
        chunks.push(value_to_string(raw));
    }
    js_trim(&chunks.join("\n")).to_owned()
}

fn is_hook_approval_denial_result(text: &str) -> bool {
    let value = js_trim(text);
    !value.is_empty() && (HOOK_DENIAL.is_match(value) || APPROVAL_UNAVAILABLE.is_match(value))
}

/// `isHookApprovalDenialToolItem(item)`: a genuine denial is always an ERROR result, so a successful result whose body only
/// contains the phrase (a read of the hook source) is not one.
pub fn is_hook_approval_denial_tool_item(item: &Value) -> bool {
    is_tool(item) && truthy(item.get("isError")) && is_hook_approval_denial_result(&tool_item_result_text(item))
}

/// `formatHookDenialDetail(text)`: the denial without the orchestrator's `Error: tool "name"` prefix and its instruction to
/// the model, for a compact line.
pub fn format_hook_denial_detail(text: &str) -> String {
    let raw = js_trim(text);
    if raw.is_empty() {
        return String::new();
    }
    let without_prefix = match ERROR_PREFIX.find(raw) {
        Some(range) => &raw[range.end..],
        None => raw,
    };
    let without_instruction = match NOT_APPROVED_INSTRUCTION.find(without_prefix) {
        Some(range) => &without_prefix[..range.start],
        None => without_prefix,
    };
    let stripped = js_trim(without_instruction);
    if stripped.is_empty() { raw.to_owned() } else { stripped.to_owned() }
}

/// `isFullyFailedToolBatch(item)`: every call of the batch finished and every one failed. A task call whose status is
/// terminal reports the task, not a failed call.
pub fn is_fully_failed_tool_batch(item: &Value) -> bool {
    if !is_tool(item) {
        return false;
    }
    let args = parse_tool_args(item.get("args").unwrap_or(&Value::Null));
    let has_task_id = truthy(args.get("task_id")) || truthy(args.get("taskId"));
    let status_value = args.get("status");
    let status = if truthy(status_value) { value_to_string(status_value.unwrap_or(&Value::Null)) } else { String::new() };
    if has_task_id && TERMINAL_STATUS.is_match(&mixdog_js::js_to_lowercase(&status)) {
        return false;
    }
    let number_or_one = |value: Option<&Value>| if truthy(value) { to_number_of(value) } else { 1.0 };
    let count = js_max(1.0, number_or_one(item.get("count")));
    let completed = item.get("completedCount");
    let completed_number = if truthy(completed) {
        to_number_of(completed)
    } else if item.get("result").is_none_or(Value::is_null) {
        0.0
    } else {
        count
    };
    let done = js_max(0.0, js_min(count, completed_number));
    let explicit = to_number_of(item.get("errorCount"));
    let mut failed = if truthy(item.get("isError")) { count } else { 0.0 };
    if explicit.is_finite() {
        failed = js_max(0.0, js_min(count, explicit.floor()));
    }
    done >= count && failed >= count
}

/// `shouldSuppressFullyFailedToolItem(item)`: hides an all-failed internal tool card, except a hook or approval denial and
/// one whose result body the user can expand and inspect.
pub fn should_suppress_fully_failed_tool_item(item: &Value) -> bool {
    is_fully_failed_tool_batch(item) && !is_hook_approval_denial_tool_item(item) && tool_item_result_text(item).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_js::{number_to_string, to_number};
    use serde_json::json;

    fn tool(extra: Value) -> Value {
        let mut item = json!({ "kind": "tool", "name": "read", "args": {} });
        for (key, value) in extra.as_object().unwrap() {
            item[key] = value.clone();
        }
        item
    }

    #[test]
    fn a_denial_is_an_error_result_that_starts_with_the_envelope() {
        let denied = tool(json!({ "isError": true, "result": "Error: tool \"read\" denied by hook: nope" }));
        assert!(is_hook_approval_denial_tool_item(&denied));
        let refused = tool(json!({ "isError": true, "result": "Error: tool \"x\" was not approved: no. Do not retry it or reach the same result another way; report it." }));
        assert!(is_hook_approval_denial_tool_item(&refused));
        let later_line = tool(json!({ "isError": true, "result": "output\nERROR: tool \"x\" DENIED BY HOOK" }));
        assert!(is_hook_approval_denial_tool_item(&later_line));
        let unavailable = tool(json!({ "isError": true, "result": "x denied by hook:  approval required but no approval UI is available" }));
        assert!(is_hook_approval_denial_tool_item(&unavailable));
    }

    #[test]
    fn a_not_approved_call_stays_a_visible_denial_and_its_model_instruction_is_not_shown() {
        let result = "Error: tool \"github\" was not approved: denied by user. Do not retry it or reach the same result another way; report it.";
        assert!(is_hook_approval_denial_tool_item(&json!({ "kind": "tool", "isError": true, "result": result })));
        assert_eq!(format_hook_denial_detail(result), "was not approved: denied by user.");
        let hook = "Error: tool \"shell\" denied by hook: blocked";
        assert!(is_hook_approval_denial_tool_item(&json!({ "kind": "tool", "isError": true, "result": hook })));
        assert_eq!(format_hook_denial_detail(hook), "denied by hook: blocked");
    }

    #[test]
    fn a_successful_result_that_contains_the_phrase_is_not_a_denial() {
        let read_of_source = tool(json!({ "result": "Error: tool \"read\" denied by hook" }));
        assert!(!is_hook_approval_denial_tool_item(&read_of_source));
        let mentioned = tool(json!({ "isError": true, "result": "see denied by hook in the docs" }));
        assert!(!is_hook_approval_denial_tool_item(&mentioned));
        let word_boundary = tool(json!({ "isError": true, "result": "Error: tool \"x\" denied by hooks" }));
        assert!(!is_hook_approval_denial_tool_item(&word_boundary));
        assert!(!is_hook_approval_denial_tool_item(&json!({ "kind": "user", "isError": true, "result": "Error: tool \"x\" denied by hook" })));
    }

    #[test]
    fn the_detail_loses_the_envelope_and_the_instruction() {
        assert_eq!(format_hook_denial_detail("Error: tool \"read\" denied by hook: nope"), "denied by hook: nope");
        assert_eq!(
            format_hook_denial_detail("Error: tool \"x\" was not approved: reason. Do not retry it or reach the same result another way; report it.  "),
            "was not approved: reason."
        );
        assert_eq!(format_hook_denial_detail("  plain  "), "plain");
        assert_eq!(format_hook_denial_detail(""), "");
        assert_eq!(format_hook_denial_detail("Error: tool \"x\" "), "Error: tool \"x\"");
    }

    #[test]
    fn the_result_text_joins_the_result_and_a_different_raw_result() {
        assert_eq!(tool_item_result_text(&tool(json!({ "result": "a", "rawResult": "a" }))), "a");
        assert_eq!(tool_item_result_text(&tool(json!({ "result": "a", "rawResult": "b" }))), "a\nb");
        assert_eq!(tool_item_result_text(&tool(json!({ "result": 5 }))), "5");
        assert_eq!(tool_item_result_text(&tool(json!({ "result": null }))), "");
        assert_eq!(tool_item_result_text(&json!(null)), "");
    }

    #[test]
    fn a_batch_is_fully_failed_when_every_call_finished_and_failed() {
        assert!(is_fully_failed_tool_batch(&tool(json!({ "isError": true, "result": "boom" }))));
        assert!(!is_fully_failed_tool_batch(&tool(json!({ "isError": false, "result": "ok" }))));
        assert!(!is_fully_failed_tool_batch(&tool(json!({ "isError": true }))));
        assert!(is_fully_failed_tool_batch(&tool(json!({ "count": 3, "completedCount": 3, "errorCount": 3, "result": "x" }))));
        assert!(!is_fully_failed_tool_batch(&tool(json!({ "count": 3, "completedCount": 3, "errorCount": 2, "result": "x" }))));
        assert!(!is_fully_failed_tool_batch(&tool(json!({ "count": 3, "completedCount": 2, "isError": true }))));
        assert!(!is_fully_failed_tool_batch(&json!({ "kind": "notice", "isError": true })));
    }

    #[test]
    fn a_failed_task_report_is_not_a_failed_batch() {
        let item = tool(json!({ "args": { "task_id": "t1", "status": "Failed" }, "isError": true, "result": "x" }));
        assert!(!is_fully_failed_tool_batch(&item));
        let without_task = tool(json!({ "args": { "status": "failed" }, "isError": true, "result": "x" }));
        assert!(is_fully_failed_tool_batch(&without_task));
    }

    #[test]
    fn only_a_failed_batch_with_nothing_to_read_is_hidden() {
        assert!(should_suppress_fully_failed_tool_item(&tool(json!({ "isError": true, "result": "  " }))));
        assert!(!should_suppress_fully_failed_tool_item(&tool(json!({ "isError": true, "result": "boom" }))));
        let denied = tool(json!({ "isError": true, "result": "Error: tool \"read\" denied by hook" }));
        assert!(!should_suppress_fully_failed_tool_item(&denied));
        assert!(!should_suppress_fully_failed_tool_item(&tool(json!({ "result": "ok" }))));
    }

    #[test]
    fn the_numbers_follow_javascript() {
        assert_eq!(number_to_string(to_number(&json!("2"))), "2");
        assert!(is_fully_failed_tool_batch(&tool(json!({ "count": "2", "completedCount": "2", "errorCount": 2, "result": "x" }))));
        // A count that is not a number makes every comparison false.
        assert!(!is_fully_failed_tool_batch(&tool(json!({ "count": "many", "isError": true, "result": "x" }))));
    }
}
