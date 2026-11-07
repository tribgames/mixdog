//! `parseNativeToolSearchPayload` (`session/loop/tool-helpers.mjs`) as `finalizeBatchResults`
//! applies it (`session/tool-batch/finalize.mjs`): a tool result of the tool-loading tools that
//! carries `{"nativeToolSearch": ...}` becomes the message's `native_tool_search` (what the OpenAI
//! and Anthropic codecs lower into the deferred tool definitions), and its summary replaces the
//! result text.

use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Value;
use serde_json::json;

/// The tools whose result may carry a native tool-search payload.
const LOADING_TOOLS: [&str; 4] = ["load_tool", "tool_search", "Skill", "skill_view"];

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

/// `String(value || '')`.
fn text_of(value: Option<&Value>) -> String {
    value.filter(|value| truthy(value)).map_or_else(String::new, value_to_string)
}

/// A `selected.tools.blocked` entry as the summary names it.
fn blocked_label(entry: &Value) -> String {
    match entry {
        Value::Object(map) => {
            let name = js_trim(&text_of(map.get("name"))).to_owned();
            if name.is_empty() {
                return String::new();
            }
            let reason = js_trim(&text_of(map.get("reason"))).to_owned();
            if reason.is_empty() { name } else { format!("{name} ({reason})") }
        }
        // An array has no `name`; any other value is its own text.
        Value::Array(_) => String::new(),
        other => js_trim(&text_of(Some(other))).to_owned(),
    }
}

/// The payload `{provider, toolReferences, openaiTools, summary}` of `result`, the text the tool
/// `tool` returned, or `None` when it carries none.
pub fn parse_native_tool_search(tool: &str, result: &str) -> Option<Value> {
    if !LOADING_TOOLS.contains(&tool) {
        return None;
    }
    let parsed: Value = serde_json::from_str(result).ok()?;
    let native = parsed.get("nativeToolSearch")?.as_object()?;
    let references: Vec<String> = native
        .get("toolReferences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|name| js_trim(name).to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    let tools: Vec<Value> = native
        .get("openaiTools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| {
            tool.as_object().is_some_and(|map| {
                map.get("name").and_then(Value::as_str).is_some_and(|name| !js_trim(name).is_empty())
                    && map.get("type").is_none_or(Value::is_string)
            })
        })
        .cloned()
        .collect();
    let provider = native.get("provider").and_then(Value::as_str).map_or_else(String::new, |p| js_trim(p).to_lowercase());
    if references.is_empty() && tools.is_empty() && provider.is_empty() {
        return None;
    }
    let base = match native.get("summary").and_then(Value::as_str) {
        Some(summary) if !summary.is_empty() => summary.to_owned(),
        _ => {
            let named = if references.is_empty() {
                tools.iter().filter_map(|tool| tool.get("name").and_then(Value::as_str)).filter(|name| !name.is_empty()).collect::<Vec<_>>().join(", ")
            } else {
                references.join(", ")
            };
            format!("Loaded deferred tools: {named}")
        }
    };
    let selected = parsed.get("selected").and_then(|selected| selected.get("tools"));
    let listed = |key: &str, label: &dyn Fn(&Value) -> String| -> Vec<String> {
        selected.and_then(|tools| tools.get(key)).and_then(Value::as_array).into_iter().flatten().map(label).filter(|text| !text.is_empty()).collect()
    };
    let missing = listed("missing", &|name| js_trim(&text_of(Some(name))).to_owned());
    let blocked = listed("blocked", &blocked_label);
    let mut extra: Vec<String> = Vec::new();
    if !missing.is_empty() {
        extra.push(format!("missing: {}", missing.join(", ")));
    }
    if !blocked.is_empty() {
        extra.push(format!("blocked: {}", blocked.join(", ")));
    }
    let summary = if extra.is_empty() { base } else { format!("{base}\n{}", extra.join("; ")) };
    Some(json!({ "provider": provider, "toolReferences": references, "openaiTools": tools, "summary": summary }))
}
