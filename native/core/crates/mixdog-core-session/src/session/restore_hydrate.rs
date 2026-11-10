//! The attachments of a `restoreQueued` reply (`take-entries.mjs`): the queued entries' pasted images
//! and texts and file parts come back with their bytes, read from the prompt attachment store
//! (`hydratePastedAttachments`, `hydrateRestorableFileParts`). A referenced blob that is gone for good
//! is dropped alone and counted into `notice`, never the prompt that carried it; a read that may pass
//! (a busy file) fails the call, so nothing is rewritten around it.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::CoreError;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use serde_json::Map;
use serde_json::Value;

use super::user_facts::AttachmentStore;
use super::user_facts::BlobError;

fn reference_of(raw: &Value) -> Option<&str> {
    raw.get("attachmentRef")
        .and_then(Value::as_str)
        .filter(|reference| reference.len() == 64 && reference.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// The blob's bytes; `None` when it is permanently unreadable.
fn read(store: &AttachmentStore, lane: &InLane<InteractiveIo>, reference: &str) -> Result<Option<Vec<u8>>, CoreError> {
    match store.read_blob(lane, reference) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(BlobError::Permanent) => Ok(None),
        Err(BlobError::Invalid(message) | BlobError::Transient(message)) => {
            Err(CoreError::DomainError { domain: "thread".into(), code: None, message: Some(message.into()), detail: None })
        }
    }
}

/// `hydrate(entries, kind, read)`: each referenced entry gets `field` set to what `encode` makes of its bytes, an
/// unreadable one is dropped, anything else stays as queued.
fn hydrate_map(
    store: &AttachmentStore,
    lane: &InLane<InteractiveIo>,
    map: &mut Value,
    field: &str,
    encode: fn(Vec<u8>) -> String,
    unreadable: &mut usize,
) -> Result<(), CoreError> {
    let Value::Object(entries) = map else { return Ok(()) };
    let mut out = Map::new();
    for (key, mut raw) in std::mem::take(entries) {
        let Some(reference) = raw.is_object().then(|| reference_of(&raw).map(str::to_owned)).flatten() else {
            out.insert(key, raw);
            continue;
        };
        match read(store, lane, &reference)? {
            Some(bytes) => {
                raw[field] = Value::String(encode(bytes));
                out.insert(key, raw);
            }
            None => *unreadable += 1,
        }
    }
    *entries = out;
    Ok(())
}

/// `materializePastedTexts` (`attachments/store.mjs:466-499`): an inline pasted text is kept as a content-addressed blob and its entry
/// states `attachmentRef`, `sizeBytes` and `chars` (the text itself stays for the composer). Node does this when the prompt is taken in;
/// the core's intake keeps the entry as sent, so a Stop writes the blob when it hands the prompt back.
pub(super) fn materialize_texts(store: &AttachmentStore, lane: &InLane<InteractiveIo>, map: &mut Value) -> Result<(), CoreError> {
    let Value::Object(entries) = map else { return Ok(()) };
    for raw in entries.values_mut() {
        if !raw.is_object() || reference_of(raw).is_some() {
            continue;
        }
        let Some(text) = raw.get("text").and_then(Value::as_str).map(str::to_owned) else { continue };
        let reference = store.write_blob(lane, text.as_bytes()).map_err(|error| CoreError::DomainError { domain: "thread".into(), code: None, message: Some(format!("{error:?}").into()), detail: None })?;
        let chars = chars_of(raw.get("chars"), &text);
        raw["attachmentRef"] = Value::String(reference);
        raw["sizeBytes"] = Value::from(text.len());
        raw["chars"] = chars;
    }
    Ok(())
}

/// `Number(raw.chars) || raw.text.length` (`store.mjs:496`): `Number()` reads a numeric string, `length` counts UTF-16 units.
pub(super) fn chars_of(supplied: Option<&Value>, text: &str) -> Value {
    let number = match supplied {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let s = mixdog_js::js_trim(s);
            if s.is_empty() { 0.0 } else { s.parse::<f64>().unwrap_or(f64::NAN) }
        }
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Null) | None => 0.0,
        Some(_) => f64::NAN,
    };
    if number != 0.0 && !number.is_nan() {
        if number.fract() == 0.0 && number.abs() < 9e15 { Value::from(number as i64) } else { serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number) }
    } else {
        Value::from(text.encode_utf16().count())
    }
}

/// `hydrateRestorableFileParts(content)`: `{ type: 'file', data, mimeType, filename }` with the bytes inlined as base64.
fn hydrate_files(store: &AttachmentStore, lane: &InLane<InteractiveIo>, parts: &[Value], unreadable: &mut usize) -> Result<Vec<Value>, CoreError> {
    let text = |part: &Value, key: &str| part.get(key).and_then(Value::as_str).map(str::to_owned);
    let mut out = Vec::new();
    for part in parts.iter().filter(|part| part["type"] == "file") {
        let mime_type = text(part, "mimeType").filter(|t| !t.is_empty()).or_else(|| text(part, "mediaType")).unwrap_or_default();
        let filename = text(part, "filename").unwrap_or_default();
        let data = match reference_of(part) {
            None => match text(part, "data").filter(|data| !data.is_empty()) {
                Some(data) => data,
                None => continue,
            },
            Some(reference) => match read(store, lane, reference)? {
                Some(bytes) => STANDARD.encode(bytes),
                None => {
                    *unreadable += 1;
                    continue;
                }
            },
        };
        out.push(serde_json::json!({ "type": "file", "data": data, "mimeType": mime_type, "filename": filename }));
    }
    Ok(out)
}

/// `reply` of [`super::actor`]'s `restored_reply`, its references read: `pastedImages` get `content` (base64),
/// `pastedTexts` get `text`, `content` is the file parts with their data, and `notice` leads when something was dropped.
pub(super) fn hydrate(store: &AttachmentStore, lane: &InLane<InteractiveIo>, mut reply: Value) -> Result<Value, CoreError> {
    let mut unreadable = 0;
    if let Some(images) = reply.get_mut("pastedImages") {
        hydrate_map(store, lane, images, "content", |bytes| STANDARD.encode(bytes), &mut unreadable)?;
    }
    if let Some(texts) = reply.get_mut("pastedTexts") {
        hydrate_map(store, lane, texts, "text", |bytes| String::from_utf8_lossy(&bytes).into_owned(), &mut unreadable)?;
    }
    let Value::Object(mut old) = reply else { return Ok(reply) };
    let files = match old.get("content").and_then(Value::as_array) {
        Some(parts) => hydrate_files(store, lane, parts, &mut unreadable)?,
        None => Vec::new(),
    };
    old.shift_remove("content");
    let mut out = Map::new();
    if unreadable > 0 {
        let verb = if unreadable == 1 { " was" } else { "s were" };
        out.insert("notice".into(), Value::String(format!("{unreadable} attachment{verb} no longer available and dropped.")));
    }
    out.extend(old);
    if !files.is_empty() {
        out.insert("content".into(), Value::Array(files));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod chars_tests {
    use super::chars_of;
    use serde_json::Value;

    /// Node's own `materializePastedTexts` (`record-pasted-text-chars.mjs`) is the oracle for `chars` and `sizeBytes`.
    #[test]
    fn chars_and_size_are_nodes() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/desktop/phone-chat/pasted-text-chars.json");
        let recorded: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in recorded["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let text = case["entry"]["text"].as_str().unwrap();
            assert_eq!(chars_of(case["entry"].get("chars"), text).as_f64(), case["materialized"]["chars"].as_f64(), "{name}: chars");
            assert_eq!(text.len() as u64, case["materialized"]["sizeBytes"].as_u64().unwrap(), "{name}: sizeBytes");
        }
    }
}
