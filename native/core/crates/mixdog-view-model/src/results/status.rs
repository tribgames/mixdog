//! Tool-result status and the aggregate records behind a card of several calls (`tui/session/tool-result-status.mjs`): which
//! calls failed and which only exited non-zero, the cancelled marker, the numbered raw output of the members, the member
//! list, the bucket a call merges into, the loading targets, and the patch an aggregate takes when its calls settle.
//!
//! The aggregate passes are cooperative in Node (generators yielding every `STEP` calls); here each has a `_steps` form that
//! calls `yield_point` at the same places, and a plain form that never yields. Call records stay `serde_json::Value`s with
//! Node's field names.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_sort_by;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::json_number;
use mixdog_js::number_to_string;
use mixdog_js::string_to_number;
use mixdog_js::to_number_of;
use serde_json::Map;
use serde_json::Value;

use crate::results::aggregate_detail::format_aggregate_detail_steps;
use crate::results::classification::is_read_only_navigation_miss;
use crate::results::git_media::git_result_error;
use crate::results::git_media::git_result_exit_code;
use crate::results::read_rows::read_rows_for_display;
use crate::results::text::ErrorPresenter;
use crate::results::text::strip_shell_exit_header;
use crate::results::text::tool_error_display;
use crate::tool_primitives::coalesce;
use crate::tool_primitives::field;
use crate::tool_primitives::normalize_tool_name;
use crate::tool_primitives::picked_text;
use crate::tool_primitives::text_of;
use crate::tool_primitives::text_or_empty;
use crate::tool_primitives::truthy;
use crate::tool_status::has_benign_exit_outcome;
use crate::tool_status::normalize_tool_terminal_status;
use crate::tool_status::tool_result_terminal_status;
use crate::tool_surface::AggregateEntry;
use crate::tool_surface::STEP;
use crate::tool_surface::tool_loading_targets;

const CANCELLED_RESULT_STATUS_LINE: &str = "[status: cancelled]";

static OFFLOADED_SHELL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[tool output offloaded:\s*shell\b", "i"));
static NOT_A_PLAIN_EXIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\[timeout:|\[signal:|timed out|aborted|interrupted", "i"));
static RUN_MARKER_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[lines \d+-\d+\]$", "m"));
static MEMBER_HEADER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d+\. (.+)$", ""));
static EXIT_HEADER: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^\s*(?:\[session:[^\n]*\]\s*\n)?(?:Error:\s*)?(?:\[shell-run-failed\]\s*)?\[exit code:\s*(\d+)\]", "i"));

/// `shellCommandExitCode`: the exit code of a shell command that RAN but exited non-zero (a process exit), as opposed to a real
/// tool-call failure (`[shell-tool-failed]`) or a timeout or abort. Results carry a bare `[exit code: N]`; earlier transcripts
/// may use `Error: [shell-run-failed] [exit code: N]`. A persistent shell result can prefix `[session: ...]`.
pub fn shell_command_exit_code(text: &str) -> Option<f64> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if OFFLOADED_SHELL.is_match(js_trim(lines[0])) {
        lines.remove(0);
        while lines.first().is_some_and(|line| js_trim(line).is_empty()) {
            lines.remove(0);
        }
    }
    let header = lines.iter().take(6).copied().collect::<Vec<_>>().join("\n");
    // Timeout, signal and abort are NOT a plain command exit: they stay "Failed".
    if NOT_A_PLAIN_EXIT.is_match(&header) {
        return None;
    }
    let code = string_to_number(EXIT_HEADER.captures(&header)?.get(1)?);
    code.is_finite().then_some(code)
}

/// A call's outcome: a failed invocation, a command that exited non-zero, and its exit code.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolCallOutcome {
    pub is_call_error: bool,
    pub is_exit_error: bool,
    pub exit_code: Option<f64>,
}

impl ToolCallOutcome {
    fn fields(&self, map: &mut Map<String, Value>) {
        map.insert("isCallError".to_owned(), Value::Bool(self.is_call_error));
        map.insert("isExitError".to_owned(), Value::Bool(self.is_exit_error));
        map.insert("exitCode".to_owned(), self.exit_code.map_or(Value::Null, json_number));
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        self.fields(&mut map);
        Value::Object(map)
    }
}

/// `toolCallOutcome`: only provider envelope metadata establishes a failed invocation. Result bodies can contain `Error:`,
/// HTTP, domain or task status text without making the call itself fail. A recognised plain shell exit wins over provider
/// envelope error flags: adapters commonly label non-zero process exits as tool errors although the shell tool ran fine.
pub fn tool_call_outcome(message: &Value, raw_text: &str) -> ToolCallOutcome {
    let tool_name = picked_text(message, &["toolName", "name"]);
    if normalize_tool_name(&tool_name) == "git" {
        if let Some(exit) = git_result_exit_code(raw_text) {
            return ToolCallOutcome { is_call_error: false, is_exit_error: !has_benign_exit_outcome(raw_text), exit_code: Some(exit) };
        }
        if !git_result_error(raw_text).is_empty() {
            return ToolCallOutcome { is_call_error: true, is_exit_error: false, exit_code: None };
        }
    }
    if let Some(exit) = shell_command_exit_code(raw_text) {
        // Every completed shell result carries `[exit code: N]`, 0 included. A non-zero code is a command failure unless
        // execution marked a known successful no-match or no-change outcome.
        let benign = exit != 0.0 && has_benign_exit_outcome(raw_text);
        return ToolCallOutcome { is_call_error: false, is_exit_error: exit != 0.0 && !benign, exit_code: Some(exit) };
    }
    if is_read_only_navigation_miss(&tool_name, raw_text) {
        return ToolCallOutcome { is_call_error: false, is_exit_error: false, exit_code: None };
    }
    let is_call_error = field(message, "isError") == Some(&Value::Bool(true)) || field(message, "toolKind").and_then(Value::as_str) == Some("error");
    ToolCallOutcome { is_call_error, is_exit_error: false, exit_code: None }
}

/// The counts behind a failure detail.
#[derive(Clone, Copy, Debug, Default)]
pub struct FailureCounts {
    pub succeeded: usize,
    pub real_errors: usize,
    pub exit_errors: usize,
    pub exit_code: Option<f64>,
}

/// `failureDetailText`: the collapsed failure or exit detail. Real tool-call and result failures keep the red "Failed"
/// wording; completed non-zero commands render as the distinct warning "Exited" state; a mixed group surfaces both.
pub fn failure_detail_text(counts: &FailureCounts) -> String {
    let mut parts: Vec<String> = Vec::new();
    if counts.succeeded > 0 {
        parts.push(format!("{} Ok", counts.succeeded));
    }
    if counts.real_errors > 0 {
        parts.push(format!("{} Failed", counts.real_errors));
    }
    if counts.exit_errors > 0 {
        let solo = counts.exit_errors == 1 && counts.real_errors == 0 && counts.succeeded == 0;
        match counts.exit_code.filter(|code| solo && code.is_finite()) {
            Some(code) => parts.push(format!("Exited {}", number_to_string(code))),
            None => parts.push(format!("{} Exited non-zero", counts.exit_errors)),
        }
    }
    parts.join(" · ")
}

fn known_terminal_status(item: &Value, texts: &[String]) -> bool {
    let settled = |status: &str| matches!(status, "completed" | "failed" | "cancelled");
    let from_args = field(item, "args").and_then(|args| field(args, "status"));
    if settled(normalize_tool_terminal_status(&text_or_empty(from_args))) {
        return true;
    }
    texts.iter().any(|text| settled(tool_result_terminal_status(text)))
}

/// `withCancelledResultMarker`: a `[status: cancelled]` line in front of the text of a call that was stopped, unless the text
/// already carries a terminal status. The item's `rawResult` is not inspected: an aggregate's raw result is child tool output
/// (`1. grep\n<result>...`) that can incidentally hold a `status:` line, which would wrongly skip the marker. Only `result`,
/// `text` and the body are runtime-controlled collapsed detail (empty, a status word, an existing marker).
pub fn with_cancelled_result_marker(text: &str, item: &Value) -> String {
    let sources = [text_or_empty(field(item, "result")), text_or_empty(field(item, "text")), text.to_owned()];
    if known_terminal_status(item, &sources) {
        return text.to_owned();
    }
    if js_trim(text).is_empty() {
        return format!("{CANCELLED_RESULT_STATUS_LINE}\n");
    }
    format!("{CANCELLED_RESULT_STATUS_LINE}\n{text}")
}

/// `aggregateRawResult`: the members' raw outputs as one numbered text (`1. grep\n...\n\n2. read\n...`).
pub fn aggregate_raw_result(calls: &[Value]) -> String {
    aggregate_raw_result_steps(calls, || {})
}

/// `aggregateRawResultSteps`.
pub fn aggregate_raw_result_steps(calls: &[Value], mut yield_point: impl FnMut()) -> String {
    let mut joined = String::new();
    let mut index = 0usize;
    for (seen, rec) in calls.iter().enumerate() {
        if (seen + 1) % STEP == 0 {
            yield_point();
        }
        if field(rec, "resolved") != Some(&Value::Bool(true)) {
            continue;
        }
        let text = text_of(coalesce(rec, &["rawResultText", "resultText"]));
        let text = js_trim_end(&text);
        if js_trim(text).is_empty() {
            continue;
        }
        let name = picked_text(rec, &["name", "category"]);
        let label = if js_trim(&name).is_empty() { "tool" } else { js_trim(&name) };
        index += 1;
        if index > 1 {
            joined.push_str(&format!("\n\n{index}. {label}\n"));
        } else {
            joined.push_str(&format!("{index}. {label}\n"));
        }
        joined.push_str(text);
    }
    joined
}

/// `stringUiDiffPatch`: stored and member records only copy a string `uiDiff`; other types stay omitted.
pub fn string_ui_diff_patch(value: Option<&Value>) -> Map<String, Value> {
    let mut patch = Map::new();
    if let Some(Value::String(diff)) = value {
        patch.insert("uiDiff".to_owned(), Value::String(diff.clone()));
    }
    patch
}

/// `uiDiffFromMessage`: live tool messages: a present `uiDiff` is always a string (empty if malformed).
pub fn ui_diff_from_message(source: &Value) -> Option<String> {
    let diff = source.as_object()?.get("uiDiff")?;
    Some(diff.as_str().unwrap_or_default().to_owned())
}

/// `uiDiffPatchFromMessage`.
pub fn ui_diff_patch_from_message(source: &Value) -> Map<String, Value> {
    let mut patch = Map::new();
    if let Some(diff) = ui_diff_from_message(source) {
        patch.insert("uiDiff".to_owned(), Value::String(diff));
    }
    patch
}

/// `assignUiDiffFromMessage`: copies the message's `uiDiff` onto `target` (an object) when it has one.
pub fn assign_ui_diff_from_message(target: &mut Value, source: &Value) {
    if let (Some(diff), Some(map)) = (ui_diff_from_message(source), target.as_object_mut()) {
        map.insert("uiDiff".to_owned(), Value::String(diff));
    }
}

/// `aggregateRawResultForDisplay`: the expanded aggregate text with the numbered rows of its read members rebuilt (the
/// model-facing rows carry no numbers and would otherwise lose their gutter). A member opens with its `N. name` header line
/// (the first line, or one after a blank line); only a member whose tool is `read` is renumbered. It runs at display time, so
/// an aggregate that is never expanded is never rebuilt.
pub fn aggregate_raw_result_for_display(text: &str) -> String {
    fn flush<'a>(member: &mut Vec<&'a str>, in_read: bool, out: &mut Vec<String>) {
        if member.is_empty() {
            return;
        }
        let joined = member.join("\n");
        out.push(if in_read { read_rows_for_display(&joined) } else { joined });
        member.clear();
    }
    if !RUN_MARKER_LINE.is_match(text) {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut member: Vec<&str> = Vec::new();
    let mut in_read = false;
    for (i, line) in lines.iter().enumerate() {
        let header = if i == 0 || lines[i - 1].is_empty() { MEMBER_HEADER.captures(line).and_then(|found| found.get(1)) } else { None };
        let Some(name) = header else {
            member.push(*line);
            continue;
        };
        flush(&mut member, in_read, &mut out);
        out.push((*line).to_owned());
        in_read = normalize_tool_name(name) == "read";
    }
    flush(&mut member, in_read, &mut out);
    out.join("\n")
}

/// `aggregateToolMembers`: the atomic calls behind a visual aggregate, kept so a renderer can show the original tool names,
/// arguments and outputs in provider order under one quiet summary row.
pub fn aggregate_tool_members(calls: &[Value]) -> Vec<Value> {
    aggregate_tool_members_steps(calls, || {})
}

/// `aggregateToolMembersSteps`.
pub fn aggregate_tool_members_steps(calls: &[Value], mut yield_point: impl FnMut()) -> Vec<Value> {
    let mut members: Vec<Value> = Vec::new();
    for (seen, rec) in calls.iter().enumerate() {
        if (seen + 1) % STEP == 0 {
            yield_point();
        }
        if !(rec.is_object() || rec.is_array()) {
            continue;
        }
        let is_true = |key: &str| field(rec, key) == Some(&Value::Bool(true));
        let completed = is_true("resolved") || is_true("completedEarly");
        let defined = |key: &str| field(rec, key).filter(|value| !value.is_null()).cloned();
        let mut member = Map::new();
        member.insert("kind".to_owned(), Value::from("tool"));
        if let Some(id) = defined("callId") {
            member.insert("id".to_owned(), id);
        }
        let name = text_or_empty(field(rec, "name"));
        member.insert("name".to_owned(), Value::from(if name.is_empty() { "tool".to_owned() } else { name }));
        member.insert("args".to_owned(), defined("args").unwrap_or_else(|| Value::Object(Map::new())));
        member.insert("result".to_owned(), defined("resultText").unwrap_or(Value::Null));
        member.insert("rawResult".to_owned(), defined("rawResultText").or_else(|| defined("resultText")).unwrap_or(Value::Null));
        member.insert("isError".to_owned(), Value::Bool(is_true("isError")));
        member.insert("errorCount".to_owned(), Value::from(u8::from(is_true("isError"))));
        member.insert("callErrorCount".to_owned(), Value::from(u8::from(is_true("isCallError"))));
        member.insert("exitErrorCount".to_owned(), Value::from(u8::from(is_true("isExitError"))));
        member.insert("count".to_owned(), Value::from(1));
        member.insert("completedCount".to_owned(), Value::from(u8::from(completed)));
        member.insert("headerFinalized".to_owned(), Value::Bool(completed));
        member.extend(string_ui_diff_patch(field(rec, "uiDiff")));
        for key in ["startedAt", "completedAt"] {
            let at = to_number_of(field(rec, key));
            if at > 0.0 {
                member.insert(key.to_owned(), json_number(at));
            }
        }
        members.push(Value::Object(member));
    }
    members
}

/// `aggregateBucketForCategory`: the bucket a call's card merges into. Consecutive calls of the SAME category merge into one
/// card; a different category opens a fresh one. Read and Search share one lookup bucket so a batched turn of reads and greps
/// renders as ONE card; state-changing categories stay separate. Agent actions are grouped only inside the provider callback
/// that emitted them, so a later provider batch never changes an older outbound card above an intervening boundary.
pub fn aggregate_bucket_for_category(category: &str, agent_batch: &str) -> String {
    let key = js_trim(category);
    match key {
        "Read" | "Search" => "category:Read+Search".to_owned(),
        "Agent" if !agent_batch.is_empty() => format!("category:Agent:{agent_batch}"),
        "Agent" => "category:Agent".to_owned(),
        "" => "default".to_owned(),
        other => format!("category:{other}"),
    }
}

/// `mergeAggregateCategoryEntries`: folds one call's category entries into an aggregate's header counts. `categories` holds
/// one entry per key in first-seen order (Node's `categories` map and its `categoryOrder` list in one).
pub fn merge_aggregate_category_entries(categories: &mut Vec<AggregateEntry>, entries: &[AggregateEntry]) {
    for entry in entries {
        let own = if entry.count == 0.0 || entry.count.is_nan() { 1.0 } else { entry.count };
        match categories.iter_mut().find(|known| known.key == entry.key) {
            Some(known) => {
                let before = if known.count == 0.0 || known.count.is_nan() { 0.0 } else { known.count };
                let mut merged = entry.clone();
                merged.count = before + own;
                *known = merged;
            }
            None => {
                let mut added = entry.clone();
                added.count = own;
                categories.push(added);
            }
        }
    }
}

/// `aggregateLoadingTargets`.
pub fn aggregate_loading_targets(calls: &[Value]) -> Vec<String> {
    aggregate_loading_targets_steps(calls, || {})
}

/// `aggregateLoadingTargetsSteps`: the union of the calls' targets in first-seen order, or none when any call has none.
pub fn aggregate_loading_targets_steps(calls: &[Value], mut yield_point: impl FnMut()) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for (count, call) in calls.iter().enumerate() {
        if (count + 1) % STEP == 0 {
            yield_point();
        }
        let own = tool_loading_targets(&text_or_empty(field(call, "name")), field(call, "args").unwrap_or(&Value::Null));
        if own.is_empty() {
            return Vec::new();
        }
        for target in own {
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
    }
    targets
}

/// The calls' summaries in `summarySeq` order, yielding every `STEP` calls. The sort is stable, so a list already in order
/// (every call without a `summarySeq` is) is left as it is and only an out-of-order one is sorted.
fn aggregate_summaries_steps(aggregate_calls: &[Value], yield_point: &mut impl FnMut()) -> Vec<String> {
    let sequence = |record: &Value| to_number_of(field(record, "summarySeq").filter(|value| !value.is_null()).or(Some(&Value::from(0))));
    let mut with_summary: Vec<&Value> = Vec::new();
    let mut ordered = true;
    for (seen, record) in aggregate_calls.iter().enumerate() {
        if (seen + 1) % STEP == 0 {
            yield_point();
        }
        if !truthy(field(record, "summary")) {
            continue;
        }
        if with_summary.last().is_some_and(|last| sequence(record) < sequence(*last)) {
            ordered = false;
        }
        with_summary.push(record);
    }
    // Out of order (only a live card's calls are): one sort, not divisible.
    if !ordered {
        js_sort_by(&mut with_summary, |a, b| sequence(*a) - sequence(*b));
    }
    with_summary.iter().map(|record| text_of(field(record, "summary"))).collect()
}

/// `aggregateResultPatch`.
pub fn aggregate_result_patch(aggregate_calls: &[Value], all_calls: &[Value], completed_count: usize) -> Value {
    aggregate_result_patch_steps(aggregate_calls, all_calls, completed_count, || {})
}

/// `aggregateResultPatchSteps`: what an aggregate takes when its calls settle: the detail text (the failure counts, or the
/// merged summaries), the error counts, and the member list. `aggregate_calls` are the aggregate's own call records (the
/// `calls` map of Node's aggregate), `all_calls` the calls the patch counts.
pub fn aggregate_result_patch_steps(aggregate_calls: &[Value], all_calls: &[Value], completed_count: usize, mut yield_point: impl FnMut()) -> Value {
    let (mut errors, mut call_errors, mut exit_errors) = (0usize, 0usize, 0usize);
    let mut first_exit: Option<&Value> = None;
    for (seen, record) in all_calls.iter().enumerate() {
        if (seen + 1) % STEP == 0 {
            yield_point();
        }
        if truthy(field(record, "isError")) {
            errors += 1;
        }
        if truthy(field(record, "isCallError")) {
            call_errors += 1;
        }
        if truthy(field(record, "isExitError")) {
            exit_errors += 1;
            first_exit.get_or_insert(record);
        }
    }
    let succeeded = completed_count.saturating_sub(errors + exit_errors);
    let display_detail = if errors > 0 || exit_errors > 0 {
        let exit_code = first_exit.and_then(|record| field(record, "exitCode")).and_then(Value::as_f64);
        failure_detail_text(&FailureCounts { succeeded, real_errors: call_errors, exit_errors, exit_code })
    } else {
        let summaries = aggregate_summaries_steps(aggregate_calls, &mut yield_point);
        format_aggregate_detail_steps(&summaries, &mut yield_point)
    };
    let mut patch = Map::new();
    patch.insert("result".to_owned(), Value::from(display_detail.clone()));
    patch.insert("text".to_owned(), Value::from(display_detail));
    patch.insert("isError".to_owned(), Value::Bool(errors > 0));
    patch.insert("errorCount".to_owned(), Value::from(errors));
    patch.insert("callErrorCount".to_owned(), Value::from(call_errors));
    patch.insert("exitErrorCount".to_owned(), Value::from(exit_errors));
    patch.insert("count".to_owned(), Value::from(all_calls.len()));
    patch.insert("toolMembers".to_owned(), Value::Array(aggregate_tool_members_steps(all_calls, &mut yield_point)));
    Value::Object(patch)
}

/// `toolResultDisplay`: a result's outcome and the text a card shows for it (a failure's presented error, a command's body
/// without its exit header). `present` is the error presenter that frames a failure's text.
pub fn tool_result_display(message: &Value, raw_text: &str, tool_name: &str, present: ErrorPresenter<'_>) -> Value {
    let mut named = message.as_object().cloned().unwrap_or_default();
    named.insert("toolName".to_owned(), Value::from(tool_name));
    let outcome = tool_call_outcome(&Value::Object(named), raw_text);
    let text = if outcome.is_call_error {
        tool_error_display(raw_text, if tool_name.is_empty() { "tool" } else { tool_name }, present)
    } else if outcome.exit_code.is_some() {
        strip_shell_exit_header(raw_text)
    } else {
        raw_text.to_owned()
    };
    let mut display = Map::new();
    outcome.fields(&mut display);
    display.insert("isError".to_owned(), Value::Bool(outcome.is_call_error));
    display.insert("text".to_owned(), Value::from(text));
    Value::Object(display)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn exit_codes_of_a_shell_result() {
        assert_eq!(shell_command_exit_code("[exit code: 2]\nboom"), Some(2.0));
        assert_eq!(shell_command_exit_code("[session: s1]\nError: [shell-run-failed] [exit code: 1]"), Some(1.0));
        assert_eq!(shell_command_exit_code("[tool output offloaded: shell x]\n\n[exit code: 3]"), Some(3.0));
        assert_eq!(shell_command_exit_code("[exit code: 1] timed out"), None);
        assert_eq!(shell_command_exit_code("plain"), None);
    }

    #[test]
    fn outcomes() {
        let shell = json!({ "name": "shell", "isError": true });
        let outcome = tool_call_outcome(&shell, "[exit code: 1]\nout");
        assert_eq!((outcome.is_call_error, outcome.is_exit_error, outcome.exit_code), (false, true, Some(1.0)));
        assert!(!tool_call_outcome(&shell, "[exit code: 1]\n[outcome: no-match]").is_exit_error);
        assert!(tool_call_outcome(&json!({ "name": "read", "isError": true }), "oops").is_call_error);
        assert!(tool_call_outcome(&json!({ "toolName": "read", "toolKind": "error" }), "oops").is_call_error);
        assert!(!tool_call_outcome(&json!({ "name": "read", "isError": true }), "ENOENT: no such file").is_call_error);
        let git = tool_call_outcome(&json!({ "name": "git" }), "## main\nexit 1\nx");
        assert_eq!((git.is_exit_error, git.exit_code), (true, Some(1.0)));
        assert!(tool_call_outcome(&json!({ "name": "git" }), "error: command failed: git x").is_call_error);
        assert_eq!(outcome.to_value()["exitCode"], json!(1));
    }

    #[test]
    fn failure_details() {
        let counts = |succeeded, real_errors, exit_errors, exit_code| FailureCounts { succeeded, real_errors, exit_errors, exit_code };
        assert_eq!(failure_detail_text(&counts(2, 1, 0, None)), "2 Ok · 1 Failed");
        assert_eq!(failure_detail_text(&counts(0, 0, 1, Some(7.0))), "Exited 7");
        assert_eq!(failure_detail_text(&counts(1, 0, 1, Some(7.0))), "1 Ok · 1 Exited non-zero");
        assert_eq!(failure_detail_text(&counts(0, 0, 2, None)), "2 Exited non-zero");
    }

    #[test]
    fn the_cancelled_marker() {
        let item = json!({ "result": "", "args": {} });
        assert_eq!(with_cancelled_result_marker("", &item), "[status: cancelled]\n");
        assert_eq!(with_cancelled_result_marker("body", &item), "[status: cancelled]\nbody");
        assert_eq!(with_cancelled_result_marker("body", &json!({ "args": { "status": "failed" } })), "body");
        assert_eq!(with_cancelled_result_marker("[status: done]\nx", &item), "[status: done]\nx");
        assert_eq!(with_cancelled_result_marker("x", &json!({ "rawResult": "status: done" })), "[status: cancelled]\nx");
    }

    #[test]
    fn raw_results_are_numbered() {
        let calls = [
            json!({ "resolved": true, "name": "grep", "rawResultText": "a\n\n" }),
            json!({ "resolved": false, "name": "x", "resultText": "skipped" }),
            json!({ "resolved": true, "resultText": "  ", "name": "empty" }),
            json!({ "resolved": true, "category": "Read", "resultText": "b" }),
            json!({ "resolved": true, "name": " ", "resultText": "c" }),
        ];
        assert_eq!(aggregate_raw_result(&calls), "1. grep\na\n\n2. Read\nb\n\n3. tool\nc");
    }

    #[test]
    fn an_expanded_aggregate_renumbers_its_read_members_only() {
        let joined = aggregate_raw_result(&[
            json!({ "resolved": true, "name": "read", "rawResultText": "a.js [ok]\n[lines 1-2]\nconst a = 1;\n  b();" }),
            json!({ "resolved": true, "name": "git", "rawResultText": "[lines 1-1]\n12\t3\tsrc/a.js" }),
        ]);
        assert_eq!(aggregate_raw_result_for_display(&joined), "1. read\na.js [ok]\n1→const a = 1;\n2→  b();\n\n2. git\n[lines 1-1]\n12\t3\tsrc/a.js");
        assert_eq!(aggregate_raw_result_for_display("1. read\nno markers"), "1. read\nno markers");
    }

    #[test]
    fn members_keep_the_atomic_calls() {
        let calls = [
            json!({ "callId": "c1", "name": "read", "args": { "path": "a" }, "resultText": "r", "resolved": true, "isError": true, "uiDiff": "d", "startedAt": 5, "completedAt": 0 }),
            json!(null),
            json!({}),
        ];
        let members = aggregate_tool_members(&calls);
        assert_eq!(members.len(), 2);
        assert_eq!(
            members[0],
            json!({ "kind": "tool", "id": "c1", "name": "read", "args": { "path": "a" }, "result": "r", "rawResult": "r", "isError": true,
                "errorCount": 1, "callErrorCount": 0, "exitErrorCount": 0, "count": 1, "completedCount": 1, "headerFinalized": true,
                "uiDiff": "d", "startedAt": 5 })
        );
        assert_eq!(members[1]["name"], json!("tool"));
        assert_eq!(members[1]["args"], json!({}));
    }

    #[test]
    fn buckets_and_merges() {
        assert_eq!(aggregate_bucket_for_category(" Read ", ""), "category:Read+Search");
        assert_eq!(aggregate_bucket_for_category("Search", ""), "category:Read+Search");
        assert_eq!(aggregate_bucket_for_category("Agent", "b1"), "category:Agent:b1");
        assert_eq!(aggregate_bucket_for_category("Agent", ""), "category:Agent");
        assert_eq!(aggregate_bucket_for_category("Shell", ""), "category:Shell");
        assert_eq!(aggregate_bucket_for_category("", ""), "default");
        let entry = |key: &str, count: f64| AggregateEntry {
            key: key.to_owned(),
            category: "Read".to_owned(),
            active: String::new(),
            done: String::new(),
            noun: String::new(),
            plural_noun: String::new(),
            effect: false,
            count,
        };
        let mut categories = Vec::new();
        merge_aggregate_category_entries(&mut categories, &[entry("a", 2.0), entry("b", 0.0)]);
        merge_aggregate_category_entries(&mut categories, &[entry("a", 3.0)]);
        assert_eq!(categories.iter().map(|e| (e.key.as_str(), e.count)).collect::<Vec<_>>(), vec![("a", 5.0), ("b", 1.0)]);
    }

    #[test]
    fn a_settled_aggregate_takes_its_detail() {
        let calls = [json!({ "name": "read", "summary": "3 lines", "summarySeq": 2 }), json!({ "name": "read", "summary": "4 lines", "summarySeq": 1 })];
        let patch = aggregate_result_patch(&calls, &calls, 2);
        assert_eq!(patch["result"], json!("7 lines"));
        assert_eq!((patch["count"].clone(), patch["isError"].clone()), (json!(2), json!(false)));
        let failed = [json!({ "isError": true, "isCallError": true }), json!({ "isExitError": true, "exitCode": 3 })];
        let patch = aggregate_result_patch(&[], &failed, 2);
        assert_eq!(patch["text"], json!("1 Failed · 1 Exited non-zero"));
        assert_eq!((patch["errorCount"].clone(), patch["callErrorCount"].clone(), patch["exitErrorCount"].clone()), (json!(1), json!(1), json!(1)));
    }

    #[test]
    fn loading_targets_are_a_union_or_nothing() {
        let load = |names: &[&str]| json!({ "name": "load_tool", "args": { "names": names } });
        assert_eq!(aggregate_loading_targets(&[load(&["a", "b"]), load(&["b", "c"])]), vec!["a", "b", "c"]);
        assert!(aggregate_loading_targets(&[load(&["a"]), json!({ "name": "read", "args": {} })]).is_empty());
    }

    #[test]
    fn a_display_strips_the_exit_header_or_frames_the_error() {
        let present = |value: &str, surface: &str| format!("{surface}: {value}");
        let ran = tool_result_display(&json!({}), "[exit code: 1]\n\nout", "shell", &present);
        assert_eq!((ran["text"].clone(), ran["isError"].clone(), ran["isExitError"].clone()), (json!("out"), json!(false), json!(true)));
        let failed = tool_result_display(&json!({ "isError": true }), "boom", "", &present);
        assert_eq!((failed["text"].clone(), failed["isError"].clone()), (json!("Error: tool: boom"), json!(true)));
        let plain = tool_result_display(&json!({}), "fine", "read", &present);
        assert_eq!((plain["text"].clone(), plain["exitCode"].clone()), (json!("fine"), Value::Null));
    }
}
