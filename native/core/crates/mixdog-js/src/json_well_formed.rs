//! JSON text `JSON.stringify` wrote, made readable by `serde_json`. `JSON.stringify` writes a lone
//! UTF-16 surrogate (half of an emoji left by a cut, or one a client sent) as its `\ud83d` escape,
//! which `JSON.parse` reads back and `serde_json` refuses. A Rust string cannot hold one, so the
//! core reads each as U+FFFD, the character every UTF-8 conversion of Node gives it.

use std::borrow::Cow;

fn hex_value(b: u8) -> Option<u16> {
    match b {
        b'0'..=b'9' => Some(u16::from(b - b'0')),
        b'a'..=b'f' => Some(u16::from(b - b'a' + 10)),
        b'A'..=b'F' => Some(u16::from(b - b'A' + 10)),
        _ => None,
    }
}

/// The code unit of a `\uXXXX` escape starting at `at` (the backslash), if well formed.
fn unit_at(text: &[u8], at: usize) -> Option<u16> {
    if text.get(at) != Some(&b'\\') || text.get(at + 1) != Some(&b'u') {
        return None;
    }
    let digits = text.get(at + 2..at + 6)?;
    digits.iter().try_fold(0u16, |acc, &b| Some(acc * 16 + hex_value(b)?))
}

/// JSON text with every lone surrogate escape (`\uD800`–`\uDFFF` not forming a pair)
/// replaced by `\ufffd`, one for one, and the number replaced. Both escapes are six
/// bytes, so offsets are unchanged. Raw text never holds a surrogate (UTF-8 cannot).
/// Text that is not JSON comes back as it is apart from those escapes, so a parse of it
/// fails as before.
pub fn without_lone_surrogates(text: &[u8]) -> (Cow<'_, [u8]>, u64) {
    let mut out: Option<Vec<u8>> = None;
    let mut count = 0u64;
    let mut in_string = false;
    let mut i = 0;
    while i < text.len() {
        let b = text[i];
        if !in_string {
            if b == b'"' {
                in_string = true;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                in_string = false;
                i += 1;
            }
            b'\\' => {
                let Some(unit) = unit_at(text, i) else {
                    i += 2;
                    continue;
                };
                if (0xD800..0xDC00).contains(&unit) && unit_at(text, i + 6).is_some_and(|low| (0xDC00..0xE000).contains(&low)) {
                    i += 12;
                    continue;
                }
                if (0xD800..0xE000).contains(&unit) {
                    let buf = out.get_or_insert_with(|| text.to_vec());
                    buf[i..i + 6].copy_from_slice(b"\\ufffd");
                    count += 1;
                }
                i += 6;
            }
            _ => i += 1,
        }
    }
    match out {
        Some(buf) => (Cow::Owned(buf), count),
        None => (Cow::Borrowed(text), 0),
    }
}

/// [`without_lone_surrogates`] of JSON bytes, for `serde_json::from_slice`.
pub fn well_formed(text: &[u8]) -> Cow<'_, [u8]> {
    without_lone_surrogates(text).0
}

/// [`without_lone_surrogates`] of JSON text, for `serde_json::from_str`.
pub fn well_formed_str(text: &str) -> Cow<'_, str> {
    match without_lone_surrogates(text.as_bytes()).0 {
        Cow::Borrowed(_) => Cow::Borrowed(text),
        // Only six ASCII bytes were replaced by six others: still UTF-8.
        Cow::Owned(bytes) => Cow::Owned(String::from_utf8(bytes).expect("ASCII replaced by ASCII")),
    }
}

/// The JSON pointers (RFC 6901) of the strings in JSON text `text` that hold a lone surrogate
/// escape, each key as [`well_formed_str`] reads it (a lone surrogate U+FFFD): where a value read
/// as U+FFFD held a lone code unit in Node, for a caller that must refuse what Node refuses for it
/// (`toUSVString(value) !== value`). Empty for text that is not JSON or holds none.
pub fn lone_surrogate_pointers(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if without_lone_surrogates(text.as_bytes()).1 == 0 {
        return out;
    }
    if let Ok(value) = crate::json_parse::parse(text) {
        collect_pointers(&value, &mut String::new(), &mut out);
    }
    out
}

/// Parsed text (json_parse.rs) as the core reads it, and whether it held a lone surrogate.
fn read_parsed(text: &str) -> (String, bool) {
    let mut out = String::with_capacity(text.len());
    let mut lone = false;
    let mut chars = text.char_indices();
    while let Some((at, c)) = chars.next() {
        if !crate::json_parse::is_esc(c) {
            out.push(c);
            continue;
        }
        let rest = &text[at + c.len_utf8()..];
        let (kept, len) = match crate::json_parse::escape_at(rest) {
            Some((crate::json_parse::Escape::Surrogate(_), len)) => {
                lone = true;
                ('\u{fffd}', len)
            }
            Some((crate::json_parse::Escape::Escaped, len)) => (c, len),
            None => (c, 0),
        };
        out.push(kept);
        let mut skipped = 0;
        while skipped < len {
            skipped += chars.next().map_or(len, |(_, c)| c.len_utf8());
        }
    }
    (out, lone)
}

fn collect_pointers(value: &serde_json::Value, pointer: &mut String, out: &mut Vec<String>) {
    let len = pointer.len();
    match value {
        serde_json::Value::String(text) => {
            if read_parsed(text).1 {
                out.push(pointer.clone());
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                pointer.push('/');
                pointer.push_str(&index.to_string());
                collect_pointers(item, pointer, out);
                pointer.truncate(len);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                pointer.push('/');
                pointer.push_str(&read_parsed(key).0.replace('~', "~0").replace('/', "~1"));
                collect_pointers(item, pointer, out);
                pointer.truncate(len);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogate_pointers_name_the_strings_that_held_one() {
        let text = r#"{"a":"x\ud83dy","b":"\ud83d\ude00","c":["ok","\udc00"],"d":"\\ud800","\udc00/~":{"e":"\ufffd","f":"\uDE00"},"g":"\u{F0000}"}"#;
        let text = text.replace("\\u{F0000}", "\u{F0000}\u{F0000}d800");
        assert_eq!(lone_surrogate_pointers(&text), ["/a", "/c/1", "/\u{fffd}~1~0/f"]);
        assert!(lone_surrogate_pointers(r#"{"a":"\ud83d\ude00","b":"\ufffd"}"#).is_empty());
        assert!(lone_surrogate_pointers(r#"{"a":"\ud800"#).is_empty());
    }

    #[test]
    fn lone_surrogates_become_replacement_characters() {
        let text = br#"{"a":"x\ud83dy","b":"\ud83d\ude00","c":"\udc00","d":"\\ud800","\udc00\ud800":"\ude00 \\ud83d \ud83d!"}"#;
        let (fixed, count) = without_lone_surrogates(text);
        assert_eq!(count, 6);
        assert_eq!(
            std::str::from_utf8(&fixed).unwrap(),
            r#"{"a":"x\ufffdy","b":"\ud83d\ude00","c":"\ufffd","d":"\\ud800","\ufffd\ufffd":"\ufffd \\ud83d \ufffd!"}"#
        );
        assert_eq!(well_formed_str("{\"a\":\"\\ud800\"}"), "{\"a\":\"\\ufffd\"}");
        assert!(matches!(well_formed_str("{\"a\":\"\\ud83d\\ude00\"}"), Cow::Borrowed(_)));
    }
}
