//! Owner: s4-engine-ledgers
//! What a console line actually says (`console-format.ts`). Chromium hands over structured argument objects: reading only their
//! `value` drops every object and array, which is exactly what a failing page logs, and a message without its script and line
//! cannot be traced back to the code that produced it.
//!
//! This file also holds the few JavaScript conversions the ledgers share (`String(x)`, `Number(x)`, truthiness, UTF-16 length
//! limits): the CDP payloads are JSON values and the TypeScript ledgers read them with those rules.

use serde_json::Value;

/// Properties of an object preview that a line lists before it says `, …`.
const MAX_PREVIEW_PROPERTIES: usize = 12;

/// JavaScript truthiness of an optional JSON field (`undefined`, `null`, `false`, `0` and `""` are falsy).
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A number as `String(number)` prints it.
pub(super) fn js_number_string(number: f64) -> String {
    if number.is_nan() {
        "NaN".to_owned()
    } else if number.is_infinite() {
        (if number > 0.0 { "Infinity" } else { "-Infinity" }).to_owned()
    } else if number == 0.0 {
        "0".to_owned()
    } else if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{number:.0}")
    } else {
        format!("{number}")
    }
}

/// `String(value)` of a JSON value.
pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items.iter().map(|item| if item.is_null() { String::new() } else { js_string(item) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String(value || fallback)`.
pub(super) fn js_string_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(value) if truthy(Some(value)) => js_string(value),
        _ => fallback.to_owned(),
    }
}

/// `Number(value)` when it is finite (`Number(undefined)` is NaN, `Number(null)` is 0).
pub(super) fn js_finite_number(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() { 0.0 } else { text.parse::<f64>().ok()? }
        }
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// The length JavaScript's `String.length` reports.
pub(super) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The longest prefix of at most `max_units` UTF-16 code units. A surrogate pair that straddles the limit is dropped whole (a Rust
/// string cannot hold the lone half the TypeScript ledger kept).
pub(super) fn utf16_prefix(text: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max_units {
            return &text[..index];
        }
    }
    text
}

fn formatted_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => js_number_string(number.as_f64().unwrap_or(f64::NAN)),
        other => serde_json::to_string(other).unwrap_or_else(|_| js_string(other)),
    }
}

fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// One argument of `Runtime.consoleAPICalled` (`BrowserConsoleArgument`).
fn format_argument(argument: &Value) -> String {
    if !argument.is_object() {
        return String::new();
    }
    if let Some(value) = argument.get("value") {
        return formatted_value(value);
    }
    let preview = argument.get("preview");
    let properties: Vec<&Value> = preview.and_then(|preview| preview.get("properties")).and_then(Value::as_array).map_or_else(Vec::new, |all| all.iter().collect());
    if !properties.is_empty() {
        let shown = &properties[..properties.len().min(MAX_PREVIEW_PROPERTIES)];
        let body = shown
            .iter()
            .map(|property| {
                let name = property.get("name").map_or_else(|| "undefined".to_owned(), js_string);
                let value = property.get("value").map_or_else(|| "undefined".to_owned(), js_string);
                format!("{name}: {value}")
            })
            .collect::<Vec<_>>()
            .join(", ");
        let overflowed = preview.and_then(|preview| preview.get("overflow")).and_then(Value::as_bool) == Some(true) || properties.len() > shown.len();
        let overflow = if overflowed { ", …" } else { "" };
        let label = preview.and_then(|preview| text_field(preview, "description")).filter(|description| *description != "Object").map_or_else(String::new, |description| format!("{description} "));
        return format!("{label}{{{body}{overflow}}}");
    }
    text_field(argument, "description")
        .or_else(|| preview.and_then(|preview| text_field(preview, "description")))
        .or_else(|| text_field(argument, "subtype"))
        .or_else(|| text_field(argument, "type"))
        .unwrap_or_default()
        .to_owned()
}

/// The arguments of one console call as the line a reader sees.
pub fn format_console_arguments(arguments: &[Value]) -> String {
    arguments.iter().map(format_argument).filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" ")
}

/// ` (url:line)` for a script location; Chromium counts lines from zero, a reader counts from one. Empty for an empty url.
pub fn format_console_source(url: &str, line_number: Option<f64>) -> String {
    if url.is_empty() {
        return String::new();
    }
    match line_number.filter(|line| line.is_finite()) {
        Some(line) => format!(" ({url}:{})", js_number_string(line.trunc() + 1.0)),
        None => format!(" ({url})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn logged_objects_survive_as_a_readable_preview_instead_of_an_empty_message() {
        assert_eq!(format_console_arguments(&[json!({"type": "string", "value": "checkout failed"})]), "checkout failed");
        assert_eq!(
            format_console_arguments(&[
                json!({"type": "string", "value": "order"}),
                json!({"type": "object", "description": "Object", "preview": {"description": "Object", "properties": [{"name": "code", "value": "500"}]}}),
            ]),
            "order {code: 500}"
        );
        assert_eq!(
            format_console_arguments(&[json!({"type": "object", "subtype": "error", "description": "TypeError: cart is undefined\n    at checkout (app.js:12)"})]),
            "TypeError: cart is undefined\n    at checkout (app.js:12)"
        );
        assert_eq!(format_console_arguments(&[json!({"type": "number", "value": 0}), json!({"type": "undefined"})]), "0 undefined");
        // A preview Chromium already cut, and one this cuts itself, both say so.
        assert_eq!(format_console_arguments(&[json!({"type": "object", "preview": {"overflow": true, "properties": [{"name": "id", "value": "7"}]}})]), "{id: 7, …}");
        let wide: Vec<Value> = (0..20).map(|index| json!({"name": format!("k{index}"), "value": index.to_string()})).collect();
        let shown = format_console_arguments(&[json!({"type": "object", "preview": {"properties": wide}})]);
        assert!(shown.starts_with("{k0: 0, ") && shown.contains("k11: 11") && !shown.contains("k12") && shown.ends_with(", …}"), "{shown}");
    }

    #[test]
    fn plain_values_print_as_json_would() {
        assert_eq!(format_console_arguments(&[json!({"value": 1.0}), json!({"value": null}), json!({"value": {"a": [1, "b"]}})]), "1 null {\"a\":[1,\"b\"]}");
    }

    #[test]
    fn a_console_line_names_the_script_and_the_line_a_reader_would_open() {
        assert_eq!(format_console_source("https://example.test/app.js", Some(11.0)), " (https://example.test/app.js:12)");
        assert_eq!(format_console_source("https://example.test/app.js", None), " (https://example.test/app.js)");
        assert_eq!(format_console_source("", None), "");
    }

    #[test]
    fn utf16_prefix_never_splits_a_pair() {
        assert_eq!(utf16_prefix("ab🙂cd", 3), "ab");
        assert_eq!(utf16_prefix("ab🙂cd", 4), "ab🙂");
        assert_eq!(utf16_prefix("abc", 10), "abc");
    }
}
