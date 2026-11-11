//! JSON helpers of the old-format readers: the one text conversion (lone UTF-16
//! surrogates → U+FFFD, FORMAT.md §10.9), canonical encodings for digests, and the
//! JavaScript value semantics the 1.4.5 id rule and the corpus digests depend on.

use std::borrow::Cow;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 15)] as char);
    }
    out
}

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
    digits
        .iter()
        .try_fold(0u16, |acc, &b| Some(acc * 16 + hex_value(b)?))
}

/// JSON text with every lone surrogate escape (`\uD800`–`\uDFFF` not forming a pair)
/// replaced by `\ufffd`, one for one, and the number replaced. Both escapes are six
/// bytes, so offsets are unchanged. Raw text never holds a surrogate (UTF-8 cannot).
pub fn replace_lone_surrogates(text: &[u8]) -> (Cow<'_, [u8]>, u64) {
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
                if (0xD800..0xDC00).contains(&unit)
                    && unit_at(text, i + 6).is_some_and(|low| (0xDC00..0xE000).contains(&low))
                {
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

/// A parsed old-format JSON document and the lone surrogates replaced on the way.
pub struct Parsed {
    pub value: Value,
    pub replaced_surrogates: u64,
}

/// Strict JSON parse of an old-format file after the surrogate replacement.
pub fn parse_source(text: &[u8]) -> Result<Parsed, String> {
    let (fixed, replaced_surrogates) = replace_lone_surrogates(text);
    let value = serde_json::from_slice(&fixed).map_err(|e| e.to_string())?;
    Ok(Parsed {
        value,
        replaced_surrogates,
    })
}

/// Whether the top-level object of `text` names one key twice (`hasUniqueTopLevelKeys`,
/// `lifecycle-scan.mjs`): a parse keeps the last copy, where 1.4.5 found the record unreadable.
/// Keys compare as JSON decodes them, in UTF-16 code units before any surrogate substitution:
/// `"a"` and `"\u0061"` are one key, `"\ud800"` and `"\ud801"` two.
pub fn repeats_a_top_level_key(text: &[u8]) -> bool {
    let (fixed, _) = replace_lone_surrogates(text);
    if !serde_json::from_slice::<Value>(&fixed).is_ok_and(|v| v.is_object()) {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    let (mut depth, mut i) = (0usize, 0usize);
    while i < text.len() {
        match text[i] {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            b'"' => {
                let start = i + 1;
                i = start;
                while text[i] != b'"' {
                    i += if text[i] == b'\\' { 2 } else { 1 };
                }
                let raw = &text[start..i];
                let next = text[i + 1..].iter().find(|b| !b.is_ascii_whitespace());
                if depth == 1 && next == Some(&b':') && !seen.insert(utf16_key(raw)) {
                    return true;
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// A JSON string body decoded to UTF-16 code units, as `JSON.parse` keeps it.
fn utf16_key(raw: &[u8]) -> Vec<u16> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let run = raw[i..].iter().position(|&b| b == b'\\').map_or(raw.len(), |p| i + p);
        out.extend(String::from_utf8_lossy(&raw[i..run]).encode_utf16());
        if run == raw.len() {
            break;
        }
        let unit = match raw[run + 1] {
            b'u' => {
                let hex = std::str::from_utf8(&raw[run + 2..run + 6]).unwrap_or("0");
                i = run + 6;
                out.push(u16::from_str_radix(hex, 16).unwrap_or(0));
                continue;
            }
            b'b' => 0x08,
            b'f' => 0x0c,
            b'n' => 0x0a,
            b'r' => 0x0d,
            b't' => 0x09,
            other => u16::from(other),
        };
        out.push(unit);
        i = run + 2;
    }
    out
}

/// `value` with every object's keys in sorted order, whatever map type serde_json uses.
pub fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), canonical(&map[key]));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `sha256:<hex>` of the canonical `serde_json` encoding of `value` (FORMAT.md §10.6).
pub fn digest_of(value: &Value) -> String {
    let bytes = serde_json::to_vec(&canonical(value)).expect("a Value always encodes");
    format!("sha256:{}", hex(&Sha256::digest(bytes)))
}

/// The digest of a computed `sha256:<hex>` text.
pub fn digest(text: &str) -> mixdog_store::schema::bounded::Digest {
    mixdog_store::schema::bounded::Digest::try_from(text.to_string())
        .expect("a computed sha256 digest is well formed")
}

/// The digest of a computed bare SHA-256 hex.
pub fn hex_digest(hex: &str) -> mixdog_store::schema::bounded::Digest {
    digest(&format!("sha256:{hex}"))
}

// ── JavaScript semantics ─────────────────────────────────────────────────────

/// `String.prototype.length` (UTF-16 code units).
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub use mixdog_js::json_stringify_sorted as js_stable;
pub use mixdog_js::number_to_string as js_number;
/// `String(value)` for the values the 1.4.5 id seed joins (`Array.prototype.join`
/// writes `null`/`undefined` as the empty string, which callers handle).
pub use mixdog_js::value_to_string as js_to_string;
pub use mixdog_protocol::message_class::js::truthy as js_truthy;

#[cfg(test)]
mod tests {
    use super::*;

    /// Keys compare as 1.4.5's `JSON.parse` decodes them: escaped equivalents repeat, two
    /// distinct lone surrogates do not, and a repeat below the top level passes.
    #[test]
    fn top_level_keys_compare_as_decoded_utf16() {
        assert!(repeats_a_top_level_key(br#"{"id":"s","a":1,"\u0061":2}"#));
        assert!(!repeats_a_top_level_key(br#"{"id":"sess_dup","messages":[],"\ud800":1,"\ud801":2}"#));
        assert!(repeats_a_top_level_key(br#"{"\ud800":1, "\uD800" :2}"#));
        assert!(!repeats_a_top_level_key(br#"{"id":"s","m":{"a":1,"a":2},"k":"a\":"}"#));
    }

    #[test]
    fn lone_surrogates_become_replacement_characters() {
        let text = br#"{"a":"x\ud83dy","b":"\ud83d\ude00","c":"\udc00","d":"\\ud800"}"#;
        let (fixed, count) = replace_lone_surrogates(text);
        assert_eq!(count, 2);
        let value: Value = serde_json::from_slice(&fixed).unwrap();
        assert_eq!(value["a"], "x\u{fffd}y");
        assert_eq!(value["b"], "\u{1f600}");
        assert_eq!(value["c"], "\u{fffd}");
        assert_eq!(value["d"], "\\ud800");
    }

    #[test]
    fn numbers_print_as_javascript_does() {
        for (n, text) in [
            (1.0, "1"),
            (1793869481675.8567, "1793869481675.8567"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (-12.5, "-12.5"),
            (123456789012345680000.0, "123456789012345680000"),
        ] {
            assert_eq!(js_number(n), text);
        }
    }
}
