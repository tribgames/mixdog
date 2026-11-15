//! `ConvertTo-Json -Compress` of Windows PowerShell 5.1, and the host's `Emit-Json` line.
//!
//! The hosts write every answer as `[Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 20 -Compress))`, a failed
//! cleanup as `ConvertTo-Json -Depth 8` on the error stream, and fingerprint a snapshot by the hash of its `-Depth 30`
//! text. The text is reproduced byte for byte:
//!
//! * key order is the order of the `[ordered]` dictionary or the `PSCustomObject`; an empty one is `{}`, an empty array `[]`;
//! * strings are escaped as `JavaScriptSerializer` escapes them: `\"` `\\` `\b` `\f` `\n` `\r` `\t`, every other control
//!   character below U+0020 and U+0085, U+2028, U+2029 and `<` `>` `&` `'` as `\u00XX` in lower-case hex, everything
//!   else (Hangul, emoji, U+007F) as it is;
//! * a `[double]` and a `[single]` are written with the round-trip format (`0.30000000000000004`, `1E+20`), a `[decimal]`
//!   with its own scale (`1.50`), `NaN` and `Infinity` unquoted, an enum as its number, `DBNull` as `null`;
//! * a `[DateTime]` is `"\/Date(ms)\/"`, milliseconds since 1970 in UTC (a local or unspecified date is converted);
//! * past the depth limit (a container at nesting level greater than the depth) the value is written as the string
//!   PowerShell makes of it: `System.Collections.Specialized.OrderedDictionary`, `System.Object[]` is written as the
//!   elements joined by a space, a `PSCustomObject` as `@{a=1; b=two}`;
//! * a one-element array that reaches `ConvertTo-Json` through the pipeline is that element, no element writes nothing, a
//!   `$null` is dropped, and an array that is itself an item of the pipeline is written as `{"value":[...],"Count":n}`.

use super::DateKind;
use super::Value;
use super::convert;
use super::datetime;
use super::pipeline_items;

/// The depth of an `Emit-Json` answer.
pub const EMIT_DEPTH: usize = 20;

/// The depth of the `MIXDOG_OFFICE_CLEANUP` line (`Write-OfficeCleanupFailure`).
pub const CLEANUP_DEPTH: usize = 8;

/// Ticks of 1970-01-01T00:00:00Z.
const UNIX_EPOCH_TICKS: i64 = 621_355_968_000_000_000;

/// `ConvertTo-Json -InputObject $value -Depth $depth -Compress`: the value as it is (an array stays an array).
pub fn to_json(value: &Value, depth: usize) -> String {
    // `ConvertTo-Json -InputObject $null` writes nothing (a null inside a container is `null`).
    if value.is_null() {
        return String::new();
    }
    let mut out = String::new();
    write_value(&mut out, value, 0, depth);
    out
}

/// `$value | ConvertTo-Json -Depth $depth -Compress`: what the pipeline hands over is written, `None` when nothing is
/// (an empty array, `$null`).
pub fn pipeline_text(value: &Value, depth: usize) -> Option<String> {
    let items: Vec<Value> = pipeline_items(value).into_iter().filter(|item| !item.is_null()).collect();
    match items.len() {
        0 => None,
        1 => Some(pipeline_item_text(&items[0], depth)),
        _ => {
            let mut out = String::new();
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&pipeline_item_text(item, depth));
            }
            out.push(']');
            Some(out)
        }
    }
}

/// One item of the pipeline: an array is wrapped the way PowerShell wraps an array that is a pipeline object.
fn pipeline_item_text(item: &Value, depth: usize) -> String {
    match item {
        Value::Array(elements) => {
            let mut out = String::from("{\"value\":");
            write_value(&mut out, item, 1, depth);
            out.push_str(&format!(",\"Count\":{}}}", elements.len()));
            out
        }
        other => to_json(other, depth),
    }
}

/// The line `Emit-Json` writes: the depth-20 text, then CRLF as `Console.Out.WriteLine` ends a line. Nothing to write is an
/// empty line.
pub fn emit_json(value: &Value) -> String {
    let mut line = pipeline_text(value, EMIT_DEPTH).unwrap_or_default();
    line.push_str("\r\n");
    line
}

/// The text of a failed cleanup (`$cleanup | ConvertTo-Json -Depth 8 -Compress`).
pub fn cleanup_json(value: &Value) -> String {
    pipeline_text(value, CLEANUP_DEPTH).unwrap_or_default()
}

fn write_value(out: &mut String, value: &Value, level: usize, max: usize) {
    match value {
        Value::Null | Value::DbNull => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Int(n) => out.push_str(&n.to_string()),
        Value::Long(n) => out.push_str(&n.to_string()),
        Value::Double(n) => out.push_str(&convert::format_double_round_trip(*n)),
        Value::Single(n) => out.push_str(&convert::format_single_round_trip(*n)),
        Value::Decimal(n) => out.push_str(&n.to_text()),
        Value::String(text) => write_string(out, text),
        Value::DateTime(date) => {
            let utc = if date.kind == DateKind::Utc {
                date.ticks
            } else {
                datetime::local_ticks_to_utc_ticks(date.ticks).unwrap_or(date.ticks)
            };
            out.push_str(&format!("\"\\/Date({})\\/\"", (utc - UNIX_EPOCH_TICKS) / 10_000));
        }
        Value::Array(items) => {
            if level > max {
                write_string(out, &convert::to_ps_string(value));
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item, level + 1, max);
            }
            out.push(']');
        }
        Value::Object(object) => {
            if level > max {
                write_string(out, &convert::to_ps_string(value));
                return;
            }
            out.push('{');
            for (index, (key, item)) in object.entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item, level + 1, max);
            }
            out.push('}');
        }
    }
}

/// A string as `JavaScriptSerializer` writes it.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' || matches!(c, '<' | '>' | '&' | '\'' | '\u{0085}' | '\u{2028}' | '\u{2029}') => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
