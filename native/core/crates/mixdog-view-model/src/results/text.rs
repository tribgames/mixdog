//! Tool-result content flattened into display text, collapsed-detail and grouped fallbacks, and error framing
//! (`tui/session/tool-result-text.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::json_stringify;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Value;

use crate::tool_primitives::field;
use crate::tool_primitives::text_or_empty;
use crate::tool_primitives::truthy;

const TOOL_RESULT_PART_MAX_DEPTH: usize = 12;
const TOOL_RESULT_JSON_FALLBACK_MAX: usize = 480;
/// Absolute cap for a collapsed tool detail line (the second row under the gutter), independent of the terminal width.
const TOOL_DETAIL_LINE_MAX: usize = 80;

static FRAMED_ERROR: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^(?:Search failed|Fetch failed|No first response|No progress|Cancelled|The .+ went stale|(?:Web search agent|Agent|Tool|Request) (?:stopped|was cancelled))",
        "i",
    )
});
static ERROR_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^error\s*:", "i"));
static SHELL_EXIT_HEADER: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"(^|\n)(?:(?:Error:\s*)?\[shell-run-failed\]\s*)?\[exit code:\s*\d+\][^\n]*\n{0,2}(?:\[outcome:\s*(?:no-match|no-change)\]\n{0,2})?(?:\[completed:[^\n]*\]\n{0,2})?",
        "i",
    )
});

/// The text of a field read as a JavaScript string: a string as it is, any other value `String(value)`.
fn string_field(value: &Value, key: &str) -> Option<String> {
    field(value, key).and_then(Value::as_str).map(str::to_owned)
}

/// Every shape that carries a list of parts flattens the same way: each part at the given depth, the empties dropped, joined
/// with newlines.
fn join_part_texts(parts: &[Value], depth: usize) -> String {
    parts.iter().map(|part| tool_result_part_text(part, depth)).filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n")
}

/// `a || b || c` over parts of an image description, as text.
fn first_truthy_text(values: &[Option<&Value>], fallback: &str) -> String {
    values.iter().find(|value| truthy(**value)).map_or_else(|| fallback.to_owned(), |value| text_or_empty(*value))
}

/// `toolResultText`: any tool-result content shape as the text a card shows.
pub fn tool_result_text(content: &Value) -> String {
    match content {
        Value::Null => return String::new(),
        Value::String(text) => return text.clone(),
        Value::Array(parts) => return join_part_texts(parts, 0),
        Value::Object(_) => {
            match field(content, "content") {
                Some(Value::Array(parts)) => {
                    let nested = join_part_texts(parts, 0);
                    if !nested.is_empty() {
                        return nested;
                    }
                }
                Some(inner @ Value::Object(_)) => {
                    let nested = tool_result_part_text(inner, 0);
                    if !nested.is_empty() {
                        return nested;
                    }
                }
                _ => {}
            }
            if let Some(Value::Array(parts)) = field(content, "parts") {
                let nested = join_part_texts(parts, 0);
                if !nested.is_empty() {
                    return nested;
                }
            }
            let from_part = tool_result_part_text(content, 0);
            if !from_part.is_empty() {
                return from_part;
            }
            if field(content, "type").and_then(Value::as_str) == Some("tool_result") {
                return String::new();
            }
            if let Some(text) = string_field(content, "text") {
                return text;
            }
            if let Some(text) = string_field(content, "content") {
                return text;
            }
        }
        _ => {}
    }
    json_stringify(content)
}

/// `compactToolResultObjectFallback`: the object as JSON, cut to a line.
fn compact_object_fallback(object: &Value) -> String {
    if field(object, "type").and_then(Value::as_str) == Some("tool_result") {
        return String::new();
    }
    let json = json_stringify(object);
    if json.is_empty() || json == "{}" {
        return String::new();
    }
    if utf16_len(&json) <= TOOL_RESULT_JSON_FALLBACK_MAX {
        return json;
    }
    format!("{}…", slice_utf16(&json, TOOL_RESULT_JSON_FALLBACK_MAX - 1))
}

/// `toolResultPartText`: one part of a result.
fn tool_result_part_text(part: &Value, depth: usize) -> String {
    if depth > TOOL_RESULT_PART_MAX_DEPTH {
        return String::new();
    }
    let part_type = field(part, "type").and_then(Value::as_str);
    match part {
        Value::Null => return String::new(),
        Value::String(text) => return text.clone(),
        _ => {}
    }
    if matches!(part_type, Some("image" | "input_image")) {
        let source_type = field(part, "source").and_then(|source| field(source, "media_type"));
        let label = first_truthy_text(&[field(part, "mimeType"), field(part, "mediaType"), source_type], "image");
        return format!("[image: {label}]");
    }
    if part_type == Some("tool_result") {
        return match field(part, "content") {
            Some(Value::String(inner)) => inner.clone(),
            Some(Value::Array(inner)) => join_part_texts(inner, depth + 1),
            Some(inner @ Value::Object(_)) => tool_result_part_text(inner, depth + 1),
            _ => String::new(),
        };
    }
    if matches!(part_type, Some("text" | "output_text" | "input_text")) {
        return match field(part, "text") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(text)) => text.clone(),
            Some(other) => value_to_string(other),
        };
    }
    if let Value::Array(items) = part {
        return join_part_texts(items, depth + 1);
    }
    if !part.is_object() {
        return String::new();
    }
    if let Some(Value::Array(items)) = field(part, "content") {
        let nested = join_part_texts(items, depth + 1);
        if !nested.is_empty() {
            return nested;
        }
    }
    if let Some(inner @ Value::Object(_)) = field(part, "content") {
        let nested = tool_result_part_text(inner, depth + 1);
        if !nested.is_empty() {
            return nested;
        }
    }
    if let Some(Value::Array(items)) = field(part, "parts") {
        let nested = join_part_texts(items, depth + 1);
        if !nested.is_empty() {
            return nested;
        }
    }
    for key in ["text", "output", "message"] {
        if let Some(text) = string_field(part, key).filter(|text| !text.is_empty()) {
            return text;
        }
    }
    if let Some(text) = string_field(part, "content") {
        return text;
    }
    if let Some(source) = field(part, "source")
        && field(source, "type").and_then(Value::as_str) == Some("base64")
        && truthy(field(source, "data"))
    {
        let label = first_truthy_text(&[field(source, "media_type"), field(source, "mediaType")], "base64");
        return format!("[image: {label}]");
    }
    compact_object_fallback(part)
}

/// `toolAggregateDetailFallback`: the aggregate's detail, else the first line of its raw result cut to the detail width.
pub fn tool_aggregate_detail_fallback(detail_text: &str, raw_result: &str) -> String {
    if !js_trim(detail_text).is_empty() {
        return detail_text.to_owned();
    }
    let raw = js_trim(raw_result);
    if raw.is_empty() {
        return detail_text.to_owned();
    }
    let line = raw.split('\n').map(js_trim).find(|line| !line.is_empty()).unwrap_or_default();
    if line.is_empty() {
        return detail_text.to_owned();
    }
    if utf16_len(line) > TOOL_DETAIL_LINE_MAX {
        return format!("{}…", slice_utf16(line, TOOL_DETAIL_LINE_MAX - 3));
    }
    line.to_owned()
}

/// `toolGroupedDisplayFallback`: the result, else the display text, else the raw text.
pub fn tool_grouped_display_fallback(result_text: &str, text: &str, raw_text: &str) -> String {
    if !js_trim(result_text).is_empty() {
        return result_text.to_owned();
    }
    let body = js_trim(if text.is_empty() { raw_text } else { text });
    if !body.is_empty() {
        return if text.is_empty() { raw_text.to_owned() } else { text.to_owned() };
    }
    result_text.to_owned()
}

/// What turns an error value into the sentence a card shows: `(value, surface) -> text` (the error presenter of the errors
/// module, which owns the rules for provider and transport errors).
pub type ErrorPresenter<'a> = &'a dyn Fn(&str, &str) -> String;

/// The framing `toolErrorDisplay` puts around an already presented error: a text that already reads as a status keeps
/// itself, any other gets an `Error: ` lead unless it has one.
pub fn frame_tool_error(presented: &str) -> String {
    if FRAMED_ERROR.is_match(presented) || ERROR_PREFIX.is_match(presented) {
        return presented.to_owned();
    }
    format!("Error: {presented}")
}

/// `toolErrorDisplay`: the presented error of a failed call, framed.
pub fn tool_error_display(value: &str, surface: &str, present: ErrorPresenter<'_>) -> String {
    frame_tool_error(&present(value, surface))
}

/// `stripShellExitHeader`: a command-failure card already renders its exit state, so the machine header (`[exit code: N]`,
/// or its shell-run-failed form) is redundant in the body. Display only: the model-facing result keeps it.
pub fn strip_shell_exit_header(text: &str) -> String {
    match SHELL_EXIT_HEADER.captures(text) {
        Some(found) => {
            let range = found.range();
            let lead = found.get(1).unwrap_or_default();
            format!("{}{lead}{}", &text[..range.start], &text[range.end..])
        }
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn content_shapes_flatten() {
        assert_eq!(tool_result_text(&json!(null)), "");
        assert_eq!(tool_result_text(&json!("plain")), "plain");
        assert_eq!(tool_result_text(&json!([{ "type": "text", "text": "a" }, "", { "type": "text", "text": "b" }])), "a\nb");
        assert_eq!(tool_result_text(&json!({ "content": [{ "type": "text", "text": "x" }] })), "x");
        assert_eq!(tool_result_text(&json!({ "type": "image", "mimeType": "image/png" })), "[image: image/png]");
        assert_eq!(tool_result_text(&json!({ "type": "tool_result", "content": [] })), "");
        assert_eq!(tool_result_text(&json!({ "text": "t" })), "t");
        assert_eq!(tool_result_text(&json!({ "a": 1 })), "{\"a\":1}");
        assert_eq!(tool_result_text(&json!(7)), "7");
        assert_eq!(
            tool_result_text(&json!([{ "source": { "type": "base64", "data": "AAAA", "media_type": "image/jpeg" } }])),
            "[image: image/jpeg]"
        );
    }

    #[test]
    fn a_deep_part_is_dropped_and_a_wide_object_cut() {
        let mut nested = json!({ "type": "text", "text": "deep" });
        for _ in 0..14 {
            nested = json!([nested]);
        }
        assert_eq!(tool_result_text(&nested), "");
        let wide = json!({ "k": "x".repeat(600) });
        let text = tool_result_text(&json!([wide]));
        assert_eq!(utf16_len(&text), TOOL_RESULT_JSON_FALLBACK_MAX);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn fallbacks() {
        assert_eq!(tool_aggregate_detail_fallback("  ", "\n first line \nsecond"), "first line");
        assert_eq!(tool_aggregate_detail_fallback("kept", "raw"), "kept");
        assert_eq!(tool_aggregate_detail_fallback("", &"y".repeat(100)).chars().count(), 78);
        assert_eq!(tool_grouped_display_fallback("r", "t", "w"), "r");
        assert_eq!(tool_grouped_display_fallback(" ", "", "raw"), "raw");
        assert_eq!(tool_grouped_display_fallback(" ", " ", " "), " ");
    }

    #[test]
    fn errors_are_framed() {
        assert_eq!(frame_tool_error("boom"), "Error: boom");
        assert_eq!(frame_tool_error("error: boom"), "error: boom");
        assert_eq!(frame_tool_error("Search failed: x"), "Search failed: x");
        assert_eq!(frame_tool_error("The model went stale"), "The model went stale");
        assert_eq!(tool_error_display("raw", "shell", &|value, surface| format!("{surface}/{value}")), "Error: shell/raw");
    }

    #[test]
    fn the_exit_header_is_stripped() {
        assert_eq!(strip_shell_exit_header("[exit code: 1]\n\nout"), "out");
        assert_eq!(strip_shell_exit_header("a\nError: [shell-run-failed] [exit code: 2]\n[outcome: no-match]\n[completed: x]\nb"), "a\nb");
        assert_eq!(strip_shell_exit_header("no header"), "no header");
    }
}
