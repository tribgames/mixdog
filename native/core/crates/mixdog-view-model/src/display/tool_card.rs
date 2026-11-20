//! `ui/tool-card.mjs`: compact one-line cards for tool calls.
//!
//! The raw `[tool: name]` line becomes a styled card that shows the tool name plus a short, human-readable summary of its
//! most relevant argument (the path for read and apply_patch, the command for shell, the pattern for grep, and so on).
//! Pure formatting: a string comes back, nothing is written. A missing or malformed argument object is tolerated (the
//! engine hands over `{ name, arguments, id }`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_object_keys;
use mixdog_js::js_trim;
use mixdog_js::json_parse;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_tui_style::color::Style;
use mixdog_tui_style::color::Styler;
use serde_json::Map;
use serde_json::Value;

use crate::tool_primitives::is_self_mcp_tool_name;
use crate::tool_primitives::parse_mcp_tool_name;

const MAX_SUMMARY: usize = 72;

static PATCH_PATH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\*\*\* (?:Update|Add|Delete) File:\s*(.+)", ""));

/// `args.key` where `null` and `undefined` read as absent (the operand of `??`).
fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|value| !value.is_null())
}

/// `joinMaybe(v)`: an array joined with spaces (an empty element reads empty), anything else as it is.
fn join_maybe(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => {
            Some(Value::String(items.iter().map(|item| if item.is_null() { String::new() } else { value_to_string(item) }).collect::<Vec<_>>().join(" ")))
        }
        other => Some(other.clone()),
    }
}

/// `firstPatchPath(patch)`: the first file a patch updates, adds or deletes.
fn first_patch_path(patch: Option<&Value>) -> Option<Value> {
    let text = patch?.as_str()?;
    let caps = PATCH_PATH.captures(text)?;
    Some(Value::String(js_trim(caps.get(1)?).to_owned()))
}

/// The one-line summary a tool's own rule derives from its arguments, `None` when the rule has nothing.
fn summarize(name: &str, args: &Value) -> Option<Value> {
    let pick = |keys: &[&str]| keys.iter().find_map(|key| arg(args, key)).cloned();
    match name {
        "read" => pick(&["path", "file"]),
        "apply_patch" => pick(&["path", "base_path"]).or_else(|| first_patch_path(args.get("patch"))),
        "list" => pick(&["path", "pattern"]),
        "find" => pick(&["query", "fuzzy", "path"]),
        "glob" => join_maybe(args.get("pattern").filter(|value| !value.is_null())).or_else(|| pick(&["path"])),
        "grep" => join_maybe(args.get("pattern").filter(|value| !value.is_null())),
        "shell" => pick(&["command"]),
        _ => None,
    }
}

/// `firstStringArg(args)`: `key=value` of the first argument that is a non-blank string.
fn first_string_arg(args: &Value) -> Option<String> {
    match args {
        Value::Object(map) => js_object_keys(map).into_iter().find_map(|key| {
            let value = map.get(key)?.as_str()?;
            (!js_trim(value).is_empty()).then(|| format!("{key}={value}"))
        }),
        Value::Array(items) => items.iter().enumerate().find_map(|(index, item)| {
            let value = item.as_str()?;
            (!js_trim(value).is_empty()).then(|| format!("{index}={value}"))
        }),
        _ => None,
    }
}

/// `collapse(s)`: every white-space run one space, trimmed.
fn collapse(text: &str) -> String {
    mixdog_js::js_words(text).collect::<Vec<_>>().join(" ")
}

/// `truncate(s, max)` over UTF-16 units: cut with `...`.
fn truncate(text: &str, max: usize) -> String {
    if utf16_len(text) <= max {
        return text.to_owned();
    }
    if max <= 3 { ".".repeat(max) } else { format!("{}...", slice_utf16(text, max - 3)) }
}

fn mcp_card_label(name: &str) -> String {
    match parse_mcp_tool_name(name) {
        Some(mcp) if !is_self_mcp_tool_name(name) => format!("MCP {}.{}", mcp.server, mcp.tool),
        _ => name.to_owned(),
    }
}

/// The arguments of a call as an object-like value: a JSON string is parsed (text that does not parse is kept as
/// `{ _raw }`); a value that is not an object reads as no arguments.
fn call_arguments(call: &Value) -> Value {
    let args = match call.get("arguments") {
        Some(Value::String(text)) => match json_parse(text) {
            Ok(parsed) => parsed,
            Err(_) => {
                let mut raw = Map::new();
                raw.insert("_raw".to_owned(), Value::String(text.clone()));
                Value::Object(raw)
            }
        },
        Some(other) => other.clone(),
        None => Value::Null,
    };
    if args.is_object() || args.is_array() { args } else { Value::Object(Map::new()) }
}

fn summary_of(name: &str, args: &Value) -> String {
    let value = summarize(name, args).map(|value| value_to_string(&value)).or_else(|| first_string_arg(args));
    value.map(|text| collapse(&text)).unwrap_or_default()
}

/// `renderToolCard(call)`: one tool call as a compact card line (no trailing newline).
pub fn render_tool_card(call: &Value, styler: Styler) -> String {
    let name = match call.get("name") {
        None | Some(Value::Null) => "tool".to_owned(),
        Some(value) => value_to_string(value),
    };
    let args = call_arguments(call);
    let summary = summary_of(&name, &args);
    let bullet = styler.paint(Style::Cyan, ">");
    let label = styler.paint(Style::Bold, &mcp_card_label(&name));
    if summary.is_empty() {
        return format!("  {bullet} {label}");
    }
    format!("  {bullet} {label} {}", styler.paint(Style::Gray, &truncate(&summary, MAX_SUMMARY)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const PLAIN: Styler = Styler::new(false, true);

    fn card(call: Value) -> String {
        render_tool_card(&call, PLAIN)
    }

    #[test]
    fn each_tool_shows_its_most_relevant_argument() {
        assert_eq!(card(json!({ "name": "read", "arguments": { "path": "src/a.rs" } })), "  > read src/a.rs");
        assert_eq!(card(json!({ "name": "read", "arguments": { "file": "b.rs" } })), "  > read b.rs");
        assert_eq!(card(json!({ "name": "shell", "arguments": { "command": "git  status\n-s" } })), "  > shell git status -s");
        assert_eq!(card(json!({ "name": "grep", "arguments": { "pattern": ["a", "b"] } })), "  > grep a b");
        assert_eq!(card(json!({ "name": "glob", "arguments": { "pattern": ["*.rs"], "path": "x" } })), "  > glob *.rs");
        assert_eq!(card(json!({ "name": "glob", "arguments": { "path": "x" } })), "  > glob x");
        assert_eq!(card(json!({ "name": "list", "arguments": { "pattern": "*.md" } })), "  > list *.md");
        assert_eq!(card(json!({ "name": "find", "arguments": { "fuzzy": "foo", "path": "x" } })), "  > find foo");
        assert_eq!(card(json!({ "name": "apply_patch", "arguments": { "base_path": "root" } })), "  > apply_patch root");
    }

    #[test]
    fn apply_patch_reads_the_first_patched_file() {
        let patch = "*** Begin Patch\n*** Update File: src/x.rs  \n@@\n*** End Patch";
        assert_eq!(card(json!({ "name": "apply_patch", "arguments": { "patch": patch } })), "  > apply_patch src/x.rs");
        assert_eq!(card(json!({ "name": "apply_patch", "arguments": { "patch": "*** Add File: n.txt" } })), "  > apply_patch n.txt");
        assert_eq!(card(json!({ "name": "apply_patch", "arguments": { "patch": "none" } })), "  > apply_patch patch=none");
    }

    #[test]
    fn an_unknown_tool_shows_its_first_string_argument() {
        assert_eq!(card(json!({ "name": "other", "arguments": { "n": 3, "blank": "  ", "q": "hi" } })), "  > other q=hi");
        assert_eq!(card(json!({ "name": "other", "arguments": { "n": 3 } })), "  > other");
        assert_eq!(card(json!({ "name": "read", "arguments": { "n": "hi" } })), "  > read n=hi");
    }

    #[test]
    fn arguments_may_be_a_json_string_or_garbage() {
        assert_eq!(card(json!({ "name": "read", "arguments": "{\"path\":\"p\"}" })), "  > read p");
        assert_eq!(card(json!({ "name": "other", "arguments": "not json" })), "  > other _raw=not json");
        assert_eq!(card(json!({ "name": "read", "arguments": "null" })), "  > read");
        assert_eq!(card(json!({ "name": "read", "arguments": 7 })), "  > read");
        assert_eq!(card(json!({ "name": "read" })), "  > read");
        assert_eq!(card(json!({})), "  > tool");
        assert_eq!(card(json!({ "name": "other", "arguments": ["x"] })), "  > other 0=x");
    }

    #[test]
    fn a_long_summary_is_cut_to_72_units() {
        let long = "a".repeat(100);
        let line = card(json!({ "name": "shell", "arguments": { "command": long } }));
        assert_eq!(line, format!("  > shell {}...", "a".repeat(69)));
        let exact = "b".repeat(72);
        assert_eq!(card(json!({ "name": "shell", "arguments": { "command": exact } })), format!("  > shell {}", "b".repeat(72)));
        assert_eq!(truncate("abcdef", 3), "...");
        assert_eq!(truncate("abcdef", 2), "..");
    }

    #[test]
    fn an_mcp_tool_reads_by_server_and_tool_unless_it_is_the_self_server() {
        assert_eq!(card(json!({ "name": "mcp__github__search", "arguments": { "q": "x" } })), "  > MCP github.search q=x");
        assert_eq!(card(json!({ "name": "mcp__plugin_mixdog_mixdog__recall", "arguments": {} })), "  > mcp__plugin_mixdog_mixdog__recall");
    }

    #[test]
    fn styling_wraps_the_bullet_name_and_summary() {
        let styled = render_tool_card(&json!({ "name": "read", "arguments": { "path": "p" } }), Styler::new(true, true));
        assert!(styled.starts_with("  \u{1b}["));
        assert!(styled.contains("\u{1b}[1mread\u{1b}[0m"));
        assert_eq!(mixdog_tui_style::color::strip_ansi(&styled), "  > read p");
    }
}
