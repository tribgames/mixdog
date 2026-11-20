//! The feedback attachment validator (`lib/feedback-attachments.mjs`), shared in the Node tree by the desktop UI and the relay:
//! the same accept and reject answers for every value, the same counting of strings in UTF-16 units, the same base64 rule.

use std::sync::OnceLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_js::JsRegex;
use serde_json::{Map, Value};

use crate::js;

pub const MAX_COUNT: usize = 3;
pub const MAX_BYTES: usize = 2_097_152;
pub const MAX_TOTAL_BYTES: usize = 6_291_456;
pub const MAX_NAME_CHARS: usize = 100;
pub const MIME_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

/// `Math.ceil(FEEDBACK_ATTACHMENT_MAX_BYTES / 3) * 4`.
const MAX_BASE64_CHARS: usize = MAX_BYTES.div_ceil(3) * 4;
const BASE64_ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/// No separators, wildcards or control characters (a leading or trailing dot is refused beside it).
const UNSAFE_NAME: &str = r#"[\u0000-\u001f\u007f-\u009f\u2028\u2029\\/:*?"<>|]"#;

/// One validated attachment: only `{name, mimeType, data}` survive, unknown fields are dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub name: String,
    pub mime_type: String,
    /// Canonical base64 of the file.
    pub data: String,
}

impl Attachment {
    /// The JSON object Node writes: `{name, mimeType, data}` in that order.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("name".to_owned(), Value::String(self.name.clone()));
        map.insert("mimeType".to_owned(), Value::String(self.mime_type.clone()));
        map.insert("data".to_owned(), Value::String(self.data.clone()));
        Value::Object(map)
    }
}

/// `new TypeError('Feedback attachments are invalid.')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid;

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Feedback attachments are invalid.")
    }
}

impl std::error::Error for Invalid {}

/// The byte length base64 text of canonical shape decodes to.
fn decoded_len(data: &str) -> usize {
    let padding = if data.ends_with("==") { 2 } else { usize::from(data.ends_with('=')) };
    data.len() / 4 * 3 - padding
}

/// Raw byte total of already-normalised attachments.
pub fn bytes_of(attachments: &[Attachment]) -> usize {
    attachments.iter().map(|attachment| decoded_len(&attachment.data)).sum()
}

/// The first twelve bytes (`prefixBytes(data, 12)`): sixteen base64 characters at most.
fn head(data: &str) -> Vec<u8> {
    let chars = &data.as_bytes()[..data.len().min(16)];
    STANDARD.decode(chars).unwrap_or_default()
}

fn has_signature(mime_type: &str, data: &str) -> bool {
    let head = head(data);
    match mime_type {
        "image/png" => head.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => head.starts_with(&[0xff, 0xd8, 0xff]),
        _ => head.len() >= 12 && head[..4] == *b"RIFF" && head[8..12] == *b"WEBP",
    }
}

/// Strict canonical base64: alphabet, padding and zeroed trailing bits.
fn canonical_base64(data: &str) -> bool {
    if data.is_empty() || !data.len().is_multiple_of(4) {
        return false;
    }
    let pad = if data.ends_with("==") { 2 } else { usize::from(data.ends_with('=')) };
    let body = &data[..data.len() - pad];
    if !body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
        return false;
    }
    if pad == 0 {
        return true;
    }
    let last = body.as_bytes()[body.len() - 1] as char;
    let modulus = if pad == 2 { 16 } else { 4 };
    BASE64_ALPHABET.find(last).is_some_and(|at| at.is_multiple_of(modulus))
}

fn unsafe_name(name: &str) -> bool {
    static PATTERN: OnceLock<JsRegex> = OnceLock::new();
    PATTERN.get_or_init(|| JsRegex::new_static(UNSAFE_NAME, "")).is_match(name)
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && js::js_len(name) <= MAX_NAME_CHARS && name == js::js_trim(name) && !name.starts_with('.') && !name.ends_with('.') && !unsafe_name(name)
}

/// `normalizeFeedbackAttachments(value)`: an absent value is none; anything invalid is [`Invalid`]. `value` is parsed JSON:
/// `None` is JavaScript's `undefined` (the key is absent), `null` is not an array.
pub fn normalize(value: Option<&Value>) -> Result<Vec<Attachment>, Invalid> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let Value::Array(items) = value else { return Err(Invalid) };
    if items.len() > MAX_COUNT {
        return Err(Invalid);
    }
    let mut total = 0usize;
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(object) = item else { return Err(Invalid) };
        let text = |key: &str| object.get(key).and_then(Value::as_str);
        let (Some(name), Some(mime_type), Some(data)) = (text("name"), text("mimeType"), text("data")) else {
            return Err(Invalid);
        };
        if !MIME_TYPES.contains(&mime_type) || !safe_name(name) {
            return Err(Invalid);
        }
        if data.len() > MAX_BASE64_CHARS || !canonical_base64(data) {
            return Err(Invalid);
        }
        let bytes = decoded_len(data);
        total += bytes;
        if !(12..=MAX_BYTES).contains(&bytes) || total > MAX_TOTAL_BYTES {
            return Err(Invalid);
        }
        if !has_signature(mime_type, data) {
            return Err(Invalid);
        }
        result.push(Attachment { name: name.to_owned(), mime_type: mime_type.to_owned(), data: data.to_owned() });
    }
    Ok(result)
}
