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

/// JSON text with every lone surrogate escape replaced by `\ufffd`, and the number replaced.
pub fn replace_lone_surrogates(text: &[u8]) -> (Cow<'_, [u8]>, u64) {
    mixdog_js::json_without_lone_surrogates(text)
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

pub use mixdog_js::json_stringify_sorted as js_stable;
pub use mixdog_js::number_to_string as js_number;
/// `String(value)` for the values the 1.4.5 id seed joins (`Array.prototype.join`
/// writes `null`/`undefined` as the empty string, which callers handle).
pub use mixdog_js::value_to_string as js_to_string;
pub use mixdog_protocol::message_class::js::truthy as js_truthy;

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
