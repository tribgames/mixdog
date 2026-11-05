//! JSON helpers of the old-format readers: the one text conversion (lone UTF-16
//! surrogates → U+FFFD, FORMAT.md §10.9), canonical encodings for digests, and the
//! JavaScript value semantics the 1.4.5 id rule and the corpus digests depend on.

use std::borrow::Cow;
use std::cmp::Ordering;

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

/// `Number.prototype.toString()` of a finite double.
pub fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    // Shortest round-trip digits and the decimal exponent, as ECMAScript's algorithm.
    let sci = format!("{:e}", value.abs());
    let (mantissa, exp) = sci.split_once('e').expect("LowerExp has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n: i32 = exp.parse::<i32>().expect("exponent") + 1;
    let sign = if value < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

fn number_text(number: &serde_json::Number) -> String {
    if let Some(n) = number.as_i64() {
        return js_number(n as f64);
    }
    if let Some(n) = number.as_u64() {
        return js_number(n as f64);
    }
    js_number(number.as_f64().unwrap_or(f64::NAN))
}

/// `JSON.stringify` of a string.
fn js_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string always encodes")
}

/// `String(value)` for the values the 1.4.5 id seed joins (`Array.prototype.join`
/// writes `null`/`undefined` as the empty string, which callers handle).
pub fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_text(n),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub use mixdog_protocol::message_class::js::truthy as js_truthy;

fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The corpus tool's `stable(v)` (`migration-corpus/tools/corpus-lib.cjs`): JSON with
/// object keys sorted by code unit, numbers and strings as `JSON.stringify` writes them.
pub fn js_stable(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_text(n),
        Value::String(s) => js_string(s),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(js_stable).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_order(a, b));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", js_string(k), js_stable(&map[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
