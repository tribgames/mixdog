//! A JavaScript string can end in a lone high surrogate (`s.slice(0, n)` cutting an emoji in
//! half); a Rust `String` cannot hold one, but `JSON.stringify` writes it as the escape
//! `\ud83d`. Text here is "parsed text" as `mixdog_js::json_parse` produces it: a lone surrogate
//! is the reserved character U+F0000 and the unit's four lowercase hex digits. `slice_utf16`
//! leaves a cut pair that way, and `stringify` writes each as Node's escape, so a parsed record
//! (a lone surrogate it carried) and a cut made here come out the same bytes. A slice is counted
//! in the units of the characters it holds, so text that already carries such an escape is not
//! cut by this function.

use serde_json::Value;

/// The escape character of `mixdog_js::json_parse`'s text (a lone surrogate is this and four hex digits).
const ESC: char = '\u{F0000}';

/// `value.slice(0, limit)` by UTF-16 units; a pair cut in half leaves its high surrogate as an escape.
pub fn slice_utf16(value: &str, limit: usize) -> String {
    let cut = mixdog_js::cut_utf16(value, limit);
    let mut out = cut.head.to_owned();
    if let Some(unit) = cut.dangling_high {
        out.push(ESC);
        out.push_str(&format!("{unit:04x}"));
    }
    out
}

/// `JSON.stringify(value)` over parsed text: every lone surrogate is written as its `\uXXXX` escape.
pub fn stringify(value: &Value) -> String {
    mixdog_js::json_stringify_indent_parsed(value, 0)
}
