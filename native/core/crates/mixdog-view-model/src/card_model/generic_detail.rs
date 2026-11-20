//! The completed-detail row for tools without a dedicated surface, plus the `load_tool` and web-search conventions
//! (`shared/tool-card-model/generic-detail.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_parse;
use serde_json::Value;

use super::shell_surface::is_shell_tool;
use crate::tool_primitives::field;
use crate::tool_primitives::text_or_empty;

static LOADED_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Loaded deferred tools:\s*(.+)$", "m"));
static ALREADY_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Already active:\s*(.+)$", "m"));

/// The tools whose collapsed completed row is the first line of their output.
const OUTPUT_DETAIL_TOOL_NAMES: [&str; 25] = [
    "shell",
    "bash",
    "bash_session",
    "shell_command",
    "job_wait",
    "read",
    "view_image",
    "read_mcp_resource",
    "grep",
    "glob",
    "search_query",
    "image_query",
    "web_search",
    "web_search_call",
    "web_fetch",
    "fetch",
    "list",
    "ls",
    "code_graph",
    "recall",
    "recall_memory",
    "search_memories",
    "remember",
    "save_memory",
    "update_memory",
];

fn is_output_detail_tool(normalized_name: &str, label: &str) -> bool {
    OUTPUT_DETAIL_TOOL_NAMES.contains(&normalized_name) || matches!(label, "read" | "search" | "web search" | "run")
}

/// The fields [`generic_completed_detail`] reads.
#[derive(Clone, Copy, Debug)]
pub struct GenericDetailInput<'a> {
    pub normalized_name: &'a str,
    pub label: &'a str,
    pub has_result: bool,
    pub first_result_line: &'a str,
    pub is_error: bool,
}

/// `genericCompletedDetail`.
pub fn generic_completed_detail(input: &GenericDetailInput) -> String {
    let n = js_to_lowercase(input.normalized_name);
    let l = js_to_lowercase(input.label);
    if input.is_error {
        return if input.has_result { input.first_result_line.to_owned() } else { "Failed".to_owned() };
    }
    // Name-only on purpose: a `run`-labelled non-shell tool keeps the output row below, which passing the label to
    // `is_shell_tool` would suppress.
    if is_shell_tool(&n, "") {
        return String::new();
    }
    if is_output_detail_tool(&n, &l) && input.has_result {
        return input.first_result_line.to_owned();
    }
    String::new()
}

/// Each name once, in order, trimmed and non-empty.
fn unique_tool_names<'a>(names: impl Iterator<Item = Option<&'a Value>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let text = js_trim(&text_or_empty(name)).to_owned();
        if !text.is_empty() && !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

fn list_of(value: Option<&Value>) -> Vec<Option<&Value>> {
    match value {
        Some(Value::Array(items)) => items.iter().map(Some).collect(),
        _ => Vec::new(),
    }
}

/// What a bridge `load_tool` result described, missed and blocked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeDescribe {
    pub described: Vec<String>,
    pub missing: Vec<String>,
    pub blocked: Vec<String>,
}

/// `bridgeDescribeResult`: `None` for a loader result (or anything that is not a describe result).
pub fn bridge_describe_result(result_text: &str) -> Option<BridgeDescribe> {
    let parsed = json_parse(result_text).ok()?;
    let entries = match field(&parsed, "entries") {
        Some(Value::Array(entries)) => entries,
        _ => return None,
    };
    let blocked = list_of(field(&parsed, "blocked"));
    Some(BridgeDescribe {
        described: unique_tool_names(entries.iter().map(|entry| field(entry, "name"))),
        missing: unique_tool_names(list_of(field(&parsed, "missing")).into_iter()),
        blocked: unique_tool_names(blocked.into_iter().map(|entry| entry.and_then(|entry| field(entry, "name")))),
    })
}

/// `bridgeDescribedToolNames`: the names a bridge `load_tool` result described, or `None` for a loader result.
pub fn bridge_described_tool_names(result_text: &str) -> Option<Vec<String>> {
    bridge_describe_result(result_text).map(|describe| describe.described)
}

/// `toolSearchLoadedSummary`: "Loaded: a, b · Already active: c" (or what a describe result missed or blocked).
pub fn tool_search_loaded_summary(result_text: &str) -> String {
    let Ok(parsed) = json_parse(result_text) else {
        let loaded = LOADED_LINE.captures(result_text).and_then(|found| found.get(1)).unwrap_or_default();
        let already = ALREADY_LINE.captures(result_text).and_then(|found| found.get(1)).unwrap_or_default();
        let mut parts = Vec::new();
        if !loaded.is_empty() {
            parts.push(format!("Loaded: {loaded}"));
        }
        if !already.is_empty() {
            parts.push(format!("Already active: {already}"));
        }
        return parts.join(" \u{b7} ");
    };
    // A bridge describe result: nothing was loaded; report what was not described.
    if let Some(describe) = bridge_describe_result(result_text) {
        let mut parts = Vec::new();
        if !describe.missing.is_empty() {
            parts.push(format!("Missing: {}", describe.missing.join(", ")));
        }
        if !describe.blocked.is_empty() {
            parts.push(format!("Blocked: {}", describe.blocked.join(", ")));
        }
        return parts.join(" \u{b7} ");
    }
    let Some(tools) = field(&parsed, "selected").and_then(|selected| field(selected, "tools")) else { return String::new() };
    if !matches!(tools, Value::Object(_) | Value::Array(_)) {
        return String::new();
    }
    let loaded = unique_tool_names(list_of(field(tools, "added")).into_iter());
    let already = unique_tool_names(list_of(field(tools, "already")).into_iter());
    let mut parts = Vec::new();
    if !loaded.is_empty() {
        parts.push(format!("Loaded: {}", loaded.join(", ")));
    }
    if !already.is_empty() {
        parts.push(format!("Already active: {}", already.join(", ")));
    }
    parts.join(" \u{b7} ")
}

/// `shouldPrefixSyncElapsed`: a web search shows its elapsed time because it ran synchronously.
pub fn should_prefix_sync_elapsed(normalized_name: &str, label: &str) -> bool {
    js_to_lowercase(normalized_name) == "web_search" || matches!(js_to_lowercase(label).as_str(), "search" | "web search")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_details() {
        let input = |name: &'static str, label: &'static str, has: bool, error: bool| GenericDetailInput {
            normalized_name: name,
            label,
            has_result: has,
            first_result_line: "first",
            is_error: error,
        };
        assert_eq!(generic_completed_detail(&input("read", "Read", true, false)), "first");
        assert_eq!(generic_completed_detail(&input("read", "Read", false, false)), "");
        assert_eq!(generic_completed_detail(&input("bash", "Run", true, false)), "");
        assert_eq!(generic_completed_detail(&input("custom", "Run", true, false)), "first");
        assert_eq!(generic_completed_detail(&input("custom", "X", true, false)), "");
        assert_eq!(generic_completed_detail(&input("custom", "X", false, true)), "Failed");
        assert_eq!(generic_completed_detail(&input("custom", "X", true, true)), "first");
    }

    #[test]
    fn load_tool_results() {
        let loaded = r#"{"selected":{"tools":{"added":["a"," a","b"],"already":["c"]}}}"#;
        assert_eq!(tool_search_loaded_summary(loaded), "Loaded: a, b \u{b7} Already active: c");
        let described = r#"{"entries":[{"name":"x"},{"name":"x"}],"missing":["m"],"blocked":[{"name":"b"}]}"#;
        assert_eq!(bridge_described_tool_names(described), Some(vec!["x".to_owned()]));
        assert_eq!(tool_search_loaded_summary(described), "Missing: m \u{b7} Blocked: b");
        assert_eq!(bridge_described_tool_names(loaded), None);
        assert_eq!(tool_search_loaded_summary("Loaded deferred tools: a, b\nAlready active: c"), "Loaded: a, b \u{b7} Already active: c");
        assert_eq!(tool_search_loaded_summary("plain"), "");
        assert_eq!(tool_search_loaded_summary("5"), "");
    }

    #[test]
    fn sync_elapsed_tools() {
        assert!(should_prefix_sync_elapsed("web_search", ""));
        assert!(should_prefix_sync_elapsed("x", "Web Search"));
        assert!(!should_prefix_sync_elapsed("grep", "Search "));
    }
}
