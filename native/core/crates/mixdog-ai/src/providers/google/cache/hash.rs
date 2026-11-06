//! `traceHash` and `stableTraceStringify` of `trace-utils.mjs`: the hash a
//! cache prefix is identified by must equal Node's byte for byte, because a
//! session's saved state carries it across the two runtimes.

use sha2::Digest;
use sha2::Sha256;

/// `traceHash(text)`: the first 16 hex digits of SHA-256 over the UTF-8 bytes.
pub fn trace_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// `stableTraceStringify(value)` for parsed JSON: `JSON.stringify` with object keys sorted.
pub use mixdog_js::json_stringify_sorted as stable_stringify;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_sort_by_utf16_unit_not_by_byte() {
        // U+FF5E (BMP, one unit 0xFF5E) sorts after U+1F600 (units D83D DE00) in UTF-16,
        // and before it in UTF-8 byte order.
        let value = json!({"\u{ff5e}": 1, "\u{1f600}": 2, "b": 3, "a": [{"z": null, "y": 1.0}]});
        assert_eq!(
            stable_stringify(&value),
            "{\"a\":[{\"y\":1,\"z\":null}],\"b\":3,\"\u{1f600}\":2,\"\u{ff5e}\":1}"
        );
    }

    #[test]
    fn hash_is_sixteen_hex_digits_of_sha256() {
        // sha256("") = e3b0c44298fc1c14...
        assert_eq!(trace_hash(""), "e3b0c44298fc1c14");
    }
}
