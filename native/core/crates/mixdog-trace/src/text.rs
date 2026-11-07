//! A JavaScript string can end in a lone high surrogate (`s.slice(0, n)` cutting an emoji in
//! half); a Rust `String` cannot hold one, but `JSON.stringify` writes it as the escape
//! `\ud83d`. `slice_utf16` keeps such a cut as a two-char marker (U+FDD0, a Unicode noncharacter
//! that never occurs in text, then U+E000 + the surrogate's offset), and `stringify` turns each
//! marker into Node's escape, so the bytes match.

use serde_json::Value;

const MARK: char = '\u{FDD0}';
const BASE: u32 = 0xE000;
const HIGH_SURROGATE_FIRST: u32 = 0xD800;

/// `value.slice(0, limit)` by UTF-16 units; a pair cut in half leaves its high surrogate as a marker.
pub fn slice_utf16(value: &str, limit: usize) -> String {
    let cut = mixdog_js::cut_utf16(value, limit);
    let mut out = cut.head.to_owned();
    if let Some(unit) = cut.dangling_high {
        out.push(MARK);
        out.extend(char::from_u32(BASE + u32::from(unit) - HIGH_SURROGATE_FIRST));
    }
    out
}

/// `JSON.stringify(value)` with every marker written as the lone surrogate's `\uXXXX` escape.
pub fn stringify(value: &Value) -> String {
    let text = mixdog_js::json_stringify(value);
    if !text.contains(MARK) {
        return text;
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != MARK {
            out.push(c);
            continue;
        }
        let offset = chars.next().map_or(0, |next| u32::from(next) - BASE);
        out.push_str(&format!("\\u{:04x}", HIGH_SURROGATE_FIRST + offset));
    }
    out
}
