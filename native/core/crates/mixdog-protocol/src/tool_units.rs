//! The surfaced tool calls of the active-tool summary (`tui/session/active-tool-summary.mjs`) and the work units Node counts them in:
//! `classifyToolCategory` (`tool-work-units.mjs`) for the three surfaced categories, and `aggregateToolCategoryEntries` /
//! `toolWorkUnit` for a call's count (`openToolCard`'s `activeCount`), ported rule for rule.

use mixdog_js::js_trim;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Value;

/// The self-plugin's MCP server: its tools render as their builtin names, not as external MCP calls (`SELF_MCP_SERVER`).
const SELF_MCP_SERVER: &str = "plugin_mixdog_mixdog";

/// `parseMcpToolName`'s `mcp__<server>__<tool>` form, after `rawToolName` drops a `functions.` prefix.
fn mcp_parts(name: &str) -> Option<(&str, &str)> {
    let text = name.strip_prefix("functions.").unwrap_or(name);
    let rest = text.strip_prefix("mcp__")?;
    let from = rest.chars().next()?.len_utf8();
    let at = from + rest[from..].find("__")?;
    let tool = &rest[at + 2..];
    (!tool.is_empty()).then_some((&rest[..at], tool))
}

/// `normalizeToolName`: the MCP form reduced to its tool, dashes to underscores, lower case, `tool_search` as `load_tool`.
fn normalize_tool_name(name: &str) -> String {
    let text = if name.is_empty() { "tool" } else { name };
    let raw = text.strip_prefix("functions.").unwrap_or(text);
    let base = mcp_parts(text).map_or(raw, |(_, tool)| tool).replace('-', "_").to_lowercase();
    if base == "tool_search" { "load_tool".to_owned() } else { base }
}

/// `parseToolArgs`: the call's arguments as an object (a JSON string parsed; `input` of an object that has one; anything else `{ value }`).
fn parse_tool_args(args: &Value) -> Value {
    let wrap = |value: &Value| serde_json::json!({ "value": value });
    match args {
        Value::Null | Value::Bool(false) => Value::Object(Default::default()),
        Value::String(text) if text.is_empty() => Value::Object(Default::default()),
        Value::Number(number) if number.as_f64() == Some(0.0) => Value::Object(Default::default()),
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(parsed) if parsed.is_object() || parsed.is_array() => parsed,
            _ => wrap(args),
        },
        Value::Object(map) => match map.get("input") {
            Some(input) if input.is_object() || input.is_array() => input.clone(),
            _ => args.clone(),
        },
        other => wrap(other),
    }
}

/// `collectionCount` over the values of `keys`: the first array counts its non-blank items, the first object or non-blank scalar is one.
fn collection_count(args: &Value, keys: &[&str]) -> i64 {
    for key in keys {
        match args.get(key) {
            Some(Value::Array(items)) => {
                let count = items.iter().filter(|item| !item.is_null() && !js_trim(&value_to_string(item)).is_empty()).count();
                return i64::try_from(if count > 0 { count } else { items.len() }).unwrap_or(i64::MAX);
            }
            Some(Value::Object(_)) => return 1,
            Some(Value::Null) | None => {}
            Some(Value::Bool(false)) => return 1,
            Some(other) => {
                if !js_trim(&value_to_string(other)).is_empty() {
                    return 1;
                }
            }
        }
    }
    0
}

/// `fetchUnit`: the message limit when it is a positive number, else the messages named.
fn fetch_count(args: &Value) -> i64 {
    let limit = match args.get("limit") {
        Some(value) if !value.is_null() => to_number(value),
        _ => args.get("messages").map_or(f64::NAN, to_number),
    };
    if limit.is_finite() && limit > 0.0 { limit.floor() as i64 } else { collection_count(args, &["messages"]) }
}

/// The surfaced category (`Shell`, `Web Research`, `Agent`) of a tool call and its work-unit count; `None` for any other call.
pub fn surfaced_tool_units(name: &str, input: &Value) -> Option<(&'static str, i64)> {
    if mcp_parts(name).is_some_and(|(server, _)| server != SELF_MCP_SERVER) {
        return None;
    }
    let args = parse_tool_args(input);
    let (category, count) = match normalize_tool_name(name).as_str() {
        "web_search" | "search_query" | "image_query" | "web_search_call" => ("Web Research", collection_count(&args, &["query", "queries", "keywords"])),
        "web_fetch" => ("Web Research", collection_count(&args, &["url", "urls", "uri", "uris"])),
        "fetch" => ("Web Research", fetch_count(&args)),
        "shell" | "bash" | "bash_session" | "shell_command" | "job_wait" => ("Shell", collection_count(&args, &["command", "commands", "cmd"])),
        "agent" | "bridge" => ("Agent", collection_count(&args, &["agents", "roles", "role", "tag", "task_id", "sessionId"])),
        _ => return None,
    };
    Some((category, count.max(1)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The counts `openToolCard` feeds the tracker (`activeCount` of `aggregateToolCategoryEntries`), from `tool-work-units.mjs`.
    #[test]
    fn a_call_counts_in_the_units_node_counts() {
        assert_eq!(surfaced_tool_units("web_search", &json!({ "query": ["a", "b", " "] })), Some(("Web Research", 2)));
        assert_eq!(surfaced_tool_units("web_search", &json!({ "queries": ["a", "b", "c"] })), Some(("Web Research", 3)));
        assert_eq!(surfaced_tool_units("web_search", &json!("{\"keywords\":[\"x\",\"y\"]}")), Some(("Web Research", 2)));
        assert_eq!(surfaced_tool_units("web_fetch", &json!({ "urls": ["u", "v"] })), Some(("Web Research", 2)));
        assert_eq!(surfaced_tool_units("fetch", &json!({ "limit": 5.9 })), Some(("Web Research", 5)));
        assert_eq!(surfaced_tool_units("fetch", &json!({ "limit": 0, "messages": ["m", "n"] })), Some(("Web Research", 2)));
        assert_eq!(surfaced_tool_units("shell", &json!({ "commands": ["a", "b"] })), Some(("Shell", 2)));
        assert_eq!(surfaced_tool_units("bash", &json!({ "command": "ls" })), Some(("Shell", 1)));
        assert_eq!(surfaced_tool_units("agent", &json!({ "agents": [{ "role": "x" }, { "role": "y" }] })), Some(("Agent", 2)));
        assert_eq!(surfaced_tool_units("mcp__plugin_mixdog_mixdog__shell", &json!({})), Some(("Shell", 1)));
        assert_eq!(surfaced_tool_units("mcp__other__shell", &json!({})), None);
        assert_eq!(surfaced_tool_units("read", &json!({})), None);
    }
}
