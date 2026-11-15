//! `Text-Sha256` and `Snapshot-Fingerprint` of `office-com-host.ps1`.
//!
//! A snapshot's fingerprint is the SHA-256 of the UTF-8 text of `$value | ConvertTo-Json -Depth 30 -Compress`, as lower-case
//! hex. The Rust host computes the same text with [`super::json`], so a fingerprint a PowerShell host recorded (the
//! transaction journal keeps them) still verifies after the switch.

use sha2::Digest;
use sha2::Sha256;

use super::Value;
use super::hex_lower;
use super::json;

/// How deep a snapshot is written for its fingerprint.
pub const FINGERPRINT_DEPTH: usize = 30;

/// `Text-Sha256`: SHA-256 of the UTF-8 bytes of `text`, lower-case hex.
pub fn text_sha256(text: &str) -> String {
    hex_lower(&Sha256::digest(text.as_bytes()))
}

/// `Snapshot-Fingerprint`: `Text-Sha256` of the depth-30 text of the value as the pipeline hands it to `ConvertTo-Json`
/// (a one-element array is that element, an empty array writes nothing and so hashes the empty text).
pub fn snapshot_fingerprint(value: &Value) -> String {
    text_sha256(&json::pipeline_text(value, FINGERPRINT_DEPTH).unwrap_or_default())
}
