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
    write(value, None, 0, Keys::Object, false, &mut out);
    out
}

/// `JSON.stringify` of a value whose every object lists its keys sorted by UTF-16 code unit (the
/// `stableStringify` the cache keys and digests are built on); integer-like keys are not first.
pub fn stringify_sorted(value: &Value) -> String {
    let mut out = String::new();
    write(value, None, 0, Keys::Sorted, false, &mut out);
    out
}

/// openai-ws-delta.mjs `_stableStringify`: object keys sorted by UTF-16 code unit, but an array
/// is written as `JSON.stringify` writes it (order and key order of what is inside it kept).
pub fn stringify_sorted_outside_arrays(value: &Value) -> String {
    let mut out = String::new();
    write(value, None, 0, Keys::SortedOutsideArrays, false, &mut out);
    out
}

/// `JSON.stringify(value, null, indent)`; `indent` is clamped to 10 like the `space` argument.
pub fn stringify_indent(value: &Value, indent: usize) -> String {
    let mut out = String::new();
    let indent = indent.min(10);
    write(value, (indent > 0).then_some(indent), 0, Keys::Object, false, &mut out);
    out
}

/// [`stringify_indent`] for a value [`crate::json_parse`] produced: a character the parser used
/// for a lone surrogate (see [`crate::json_parse`]) is written as the `\udxxx` escape
/// `JSON.stringify` writes, so a parsed document is written back byte for byte.
pub fn stringify_indent_parsed(value: &Value, indent: usize) -> String {
    let mut out = String::new();
    let indent = indent.min(10);
    write(value, (indent > 0).then_some(indent), 0, Keys::Object, true, &mut out);
    out
}

/// A JSON string literal as `JSON.stringify` writes it.
pub fn quote(text: &str, out: &mut String) {
    quote_with(text, false, out);
}

fn quote_with(text: &str, parsed: bool, out: &mut String) {
    out.push('"');
    let mut chars = text.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            c if parsed && crate::json_parse::is_esc(c) => {
                // Parsed text: ESC ESC is a genuine ESC, ESC and four hex digits a lone surrogate;
                // an ESC followed by neither was never parsed and is written as it is.
                let after = at + c.len_utf8();
                match crate::json_parse::escape_at(&text[after..]) {
                    Some((crate::json_parse::Escape::Escaped, len)) => {
                        out.push(c);
                        chars.nth(len_in_chars(&text[after..after + len]) - 1);
                    }
                    Some((crate::json_parse::Escape::Surrogate(unit), len)) => {
                        out.push_str(&format!("\\u{unit:04x}"));
                        chars.nth(len_in_chars(&text[after..after + len]) - 1);
                    }
                    None => out.push(c),
                }
            }
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

fn len_in_chars(text: &str) -> usize {
    text.chars().count()
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
pub fn ordered_keys(map: &Map<String, Value>) -> Vec<&String> {
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

/// The order an object's keys are written in.
#[derive(Clone, Copy)]
enum Keys {
    /// As a JavaScript object enumerates them ([`ordered_keys`]).
    Object,
    /// By UTF-16 code unit.
    Sorted,
    /// By UTF-16 code unit in objects; an array and all inside it is written as in [`Keys::Object`].
    SortedOutsideArrays,
}

fn write(value: &Value, indent: Option<usize>, depth: usize, keys: Keys, parsed: bool, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            let double = number.as_f64().unwrap_or(f64::NAN);
            // JSON.stringify writes a non-finite number as null.
            out.push_str(&if double.is_finite() { number_to_string(double) } else { "null".into() });
        }
        Value::String(text) => quote_with(text, parsed, out),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            let keys = if matches!(keys, Keys::SortedOutsideArrays) { Keys::Object } else { keys };
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                write(item, indent, depth + 1, keys, parsed, out);
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
            let listed = match keys {
                Keys::Object => ordered_keys(map),
                Keys::Sorted | Keys::SortedOutsideArrays => {
                    let mut sorted: Vec<&String> = map.keys().collect();
                    sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                    sorted
                }
            };
            for (at, key) in listed.into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                quote_with(key, parsed, out);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write(&map[key], indent, depth + 1, keys, parsed, out);
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
    fn sorting_outside_arrays_leaves_arrays_as_written() {
        // Node: _stableStringify (openai-ws-delta.mjs) and stableTraceStringify (trace-utils.mjs)
        // on {b:[{z:1,a:2}],a:{y:[{q:1,b:2}],x:1},'10':1,'2':2}.
        let value: Value = serde_json::from_str(r#"{"b":[{"z":1,"a":2}],"a":{"y":[{"q":1,"b":2}],"x":1},"10":1,"2":2}"#).unwrap();
        assert_eq!(
            stringify_sorted_outside_arrays(&value),
            r#"{"10":1,"2":2,"a":{"x":1,"y":[{"q":1,"b":2}]},"b":[{"z":1,"a":2}]}"#
        );
        assert_eq!(
            stringify_sorted(&value),
            r#"{"10":1,"2":2,"a":{"x":1,"y":[{"b":2,"q":1}]},"b":[{"a":2,"z":1}]}"#
        );
    }

    #[test]
    fn sorted_keys_follow_utf16_order_at_every_level() {
        // Node: sorted by `<` on strings, i.e. UTF-16 units: U+1F600 (D83D DE00) before U+FF5E.
        let value: Value = serde_json::from_str("{\"\u{ff5e}\":1,\"\u{1f600}\":2,\"b\":[{\"z\":null,\"10\":1.0,\"2\":1e21}],\"a\":0.5}").expect("json");
        assert_eq!(stringify_sorted(&value), "{\"a\":0.5,\"b\":[{\"10\":1,\"2\":1e+21,\"z\":null}],\"\u{1f600}\":2,\"\u{ff5e}\":1}");
    }

    #[test]
    fn integer_like_keys_come_first_in_ascending_order() {
        let value: Value = serde_json::from_str(r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6,"4294967294":7}"#).expect("json");
        assert_eq!(stringify(&value), r#"{"2":4,"10":2,"4294967294":7,"b":1,"a":3,"01":5,"4294967295":6}"#);
    }
}
