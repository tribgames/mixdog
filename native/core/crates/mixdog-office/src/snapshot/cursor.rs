//! The opaque cursor of a paged snapshot (`encodeCursor`, `decodeCursor` of `core/pagination.mjs`): JSON text in
//! base64url without padding. Decoding reads the text as Node's `Buffer.from(text, 'base64url')` does: both alphabets are
//! accepted, a character outside them is skipped, `=` ends the data and bits that do not make a whole byte are dropped.

use mixdog_js::{json_parse, json_stringify};
use serde_json::Value;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// The text of a cursor refused for any reason.
pub const INVALID_CURSOR: &str = "Invalid Office snapshot cursor";

/// `encodeCursor(value)`.
pub fn encode_cursor(value: &Value) -> String {
    let bytes = json_stringify(value).into_bytes();
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 2);
    for chunk in bytes.chunks(3) {
        let mut group = u32::from(chunk[0]) << 16;
        if let Some(second) = chunk.get(1) {
            group |= u32::from(*second) << 8;
        }
        if let Some(third) = chunk.get(2) {
            group |= u32::from(*third);
        }
        for position in 0..=chunk.len() {
            let sextet = (group >> (18 - 6 * position)) & 63;
            out.push(char::from(ALPHABET[sextet as usize]));
        }
    }
    out
}

fn sextet(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'-' | b'+' => Some(62),
        b'_' | b'/' => Some(63),
        _ => None,
    }
}

fn base64_bytes(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut bits = 0_u32;
    let mut held = 0_u32;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let Some(value) = sextet(byte) else { continue };
        bits = (bits << 6) | value;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push(((bits >> held) & 0xff) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

/// `decodeCursor(value)`: the cursor's object, or the one error text of an unreadable, not-JSON or foreign-version cursor.
pub fn decode_cursor(text: &str) -> Result<Value, String> {
    let decoded = json_parse(&String::from_utf8_lossy(&base64_bytes(text))).map_err(|_| INVALID_CURSOR.to_owned())?;
    let version = decoded.get("version").and_then(Value::as_f64);
    if version == Some(1.0) { Ok(decoded) } else { Err(INVALID_CURSOR.to_owned()) }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_cursor_round_trips_and_is_url_safe() {
        let value = json!({ "version": 1, "session": "office_1", "selector": { "sheet": "요약?>" }, "offset": 2000 });
        let text = encode_cursor(&value);
        assert!(text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
        assert_eq!(decode_cursor(&text), Ok(value));
    }

    #[test]
    fn encoding_matches_the_known_base64url_of_a_text() {
        // Buffer.from('{"version":1}').toString('base64url')
        assert_eq!(encode_cursor(&json!({ "version": 1 })), "eyJ2ZXJzaW9uIjoxfQ");
    }

    #[test]
    fn decoding_reads_the_standard_alphabet_and_padding_as_node_does() {
        assert_eq!(decode_cursor("eyJ2ZXJzaW9uIjoxfQ=="), Ok(json!({ "version": 1 })));
        assert_eq!(decode_cursor("ey J2ZXJz\naW9uIjoxfQ"), Ok(json!({ "version": 1 })));
    }

    #[test]
    fn anything_else_is_one_invalid_cursor_error() {
        let wrong_version = encode_cursor(&json!({ "version": 2 }));
        let array = encode_cursor(&json!([1]));
        let null = encode_cursor(&Value::Null);
        for text in ["", "not a cursor", "!!!", wrong_version.as_str(), array.as_str(), null.as_str()] {
            assert_eq!(decode_cursor(text), Err(INVALID_CURSOR.to_owned()), "{text}");
        }
    }
}
