//! `JSON.stringify(value)` and `JSON.stringify(value, null, n)` over a parsed JSON value, byte
//! for byte as V8 writes it.
//!
//! What matters for byte-exact output: numbers print as JavaScript prints a double (`1.0` is `1`,
//! `1e21` is `1e+21`, `-0` is `0`); strings escape only `"`, `\`, the control characters below
//! U+0020 and (well-formed JSON.stringify) lone surrogates; and an object lists its integer-like
//! keys (canonical array indices, below 2^32 - 1) first in ascending order, then the other keys
//! in insertion order, because that is the order a JavaScript object keeps them in.

use serde_json::Map;
use serde_json::Value;

use crate::number::number_to_string;

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write(value, None, 0, &mut out);
    out
}

/// `JSON.stringify(value, null, indent)`; `indent` is clamped to 10 like the `space` argument.
pub fn stringify_indent(value: &Value, indent: usize) -> String {
    let mut out = String::new();
    let indent = indent.min(10);
    write(value, (indent > 0).then_some(indent), 0, &mut out);
    out
}

/// A JSON string literal as `JSON.stringify` writes it.
pub fn quote(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The length in UTF-16 units of `JSON.stringify(value.slice(0, limit))`, quotes included. A
/// cut inside a surrogate pair leaves a lone high surrogate, which `JSON.stringify` writes as
/// the six units `\ud83d`.
pub fn quoted_cut_utf16_len(value: &str, limit: usize) -> usize {
    let cut = crate::text::cut_utf16(value, limit);
    let mut literal = String::new();
    quote(cut.head, &mut literal);
    crate::text::utf16_len(&literal) + if cut.dangling_high.is_some() { 6 } else { 0 }
}

/// `key` is a canonical array index: `"0"` or digits without a leading zero, below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// The keys in the order a JavaScript object enumerates them.
fn ordered_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut indexed: Vec<(u32, &String)> = Vec::new();
    let mut named: Vec<&String> = Vec::new();
    for key in map.keys() {
        match array_index(key) {
            Some(index) => indexed.push((index, key)),
            None => named.push(key),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, key)| key).chain(named).collect()
}

fn newline(indent: Option<usize>, depth: usize, out: &mut String) {
    if let Some(width) = indent {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', width * depth));
    }
}

fn write(value: &Value, indent: Option<usize>, depth: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            let double = number.as_f64().unwrap_or(f64::NAN);
            // JSON.stringify writes a non-finite number as null.
            out.push_str(&if double.is_finite() { number_to_string(double) } else { "null".into() });
        }
        Value::String(text) => quote(text, out),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                write(item, indent, depth + 1, out);
            }
            newline(indent, depth, out);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (at, key) in ordered_keys(map).into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                quote(key, out);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write(&map[key], indent, depth + 1, out);
            }
            newline(indent, depth, out);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `[input, JSON.stringify(JSON.parse(input)), JSON.stringify(JSON.parse(input), null, 2)]`
    /// rows written by Node.
    const ROWS: &str = include_str!("../testdata/json_stringify.json");

    #[test]
    fn stringify_matches_node() {
        let rows: Vec<(String, String, String)> = serde_json::from_str(ROWS).expect("fixture");
        assert!(rows.len() > 50);
        for (input, compact, pretty) in rows {
            let value: Value = serde_json::from_str(&input).expect("input");
            assert_eq!(stringify(&value), compact, "{input}");
            assert_eq!(stringify_indent(&value, 2), pretty, "{input} (indent 2)");
        }
    }

    #[test]
    fn integer_like_keys_come_first_in_ascending_order() {
        let value: Value = serde_json::from_str(r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6,"4294967294":7}"#).expect("json");
        assert_eq!(stringify(&value), r#"{"2":4,"10":2,"4294967294":7,"b":1,"a":3,"01":5,"4294967295":6}"#);
    }
}
