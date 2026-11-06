//! The prompt a forwarded turn submits (Node `handoff-attachments.mjs` `sanitizeHandoffParts` and
//! `handoffContent`): plain text, or the text followed by the attachment parts the caller
//! forwarded, each cut down to its reference fields. A host that runs a turn or queues a prompt
//! for a worker composes its prompt with [`handoff_content`] from the flow's `prompt` and
//! `attachments`.

use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

/// `HANDOFF_LIMITS.count`: attachments one prompt carries.
const MAX_PARTS: usize = 8;

/// `ATTACHMENT_ID`: the 64-character lowercase hex id a stored attachment has.
fn is_attachment_id(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `String(value).slice(0, max)` over UTF-16 code units.
fn slice_units(text: String, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max { text } else { String::from_utf16_lossy(&units[..max]) }
}

/// JavaScript truthiness of a field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

/// `sanitizeHandoffParts`: only the reference fields of `parts`, never inline bytes or paths.
pub fn sanitize_handoff_parts(parts: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for part in parts {
        if out.len() >= MAX_PARTS {
            break;
        }
        let Some(kind) = part.get("type").and_then(Value::as_str).filter(|k| matches!(*k, "image" | "file" | "text")) else { continue };
        let reference = part.get("attachmentRef").map(|v| if v.is_null() { String::new() } else { value_to_string(v) }).unwrap_or_default();
        if !is_attachment_id(&reference) {
            continue;
        }
        let default_mime = if kind == "image" { "image/png" } else { "application/octet-stream" };
        let mime = if truthy(part.get("mimeType")) { value_to_string(&part["mimeType"]) } else { default_mime.to_owned() };
        let name = if truthy(part.get("filename")) { value_to_string(&part["filename"]) } else { "attachment".to_owned() };
        // `Number.isFinite(x) && x >= 0`: a number only, never a numeric string.
        let size = match part.get("sizeBytes") {
            Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.is_finite() && f >= 0.0) => Value::Number(n.clone()),
            _ => Value::from(0),
        };
        let mut entry = Map::new();
        entry.insert("type".into(), kind.into());
        if kind == "text" {
            entry.insert("textKind".into(), "file".into());
        }
        entry.insert("attachmentRef".into(), reference.into());
        entry.insert("sizeBytes".into(), size);
        entry.insert("mimeType".into(), slice_units(mime, 100).into());
        entry.insert("filename".into(), slice_units(name, 200).into());
        out.push(Value::Object(entry));
    }
    out
}

/// `handoffContent`: the text alone, or `[{ type: 'text', text }, ...parts]`.
pub fn handoff_content(text: &str, parts: &[Value]) -> Value {
    let clean = sanitize_handoff_parts(parts);
    if clean.is_empty() {
        return Value::String(text.to_owned());
    }
    let mut content = vec![serde_json::json!({ "type": "text", "text": text })];
    content.extend(clean);
    Value::Array(content)
}
