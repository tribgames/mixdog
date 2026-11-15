//! Base64 for fixtures that keep binary data as text (the standard alphabet with padding, as Node's `toString('base64')`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

pub fn base64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Panics when `text` is not base64: a fixture that does not decode is a failed test.
pub fn base64_decode(text: &str) -> Vec<u8> {
    STANDARD.decode(text).unwrap_or_else(|e| panic!("base64: {e}"))
}
