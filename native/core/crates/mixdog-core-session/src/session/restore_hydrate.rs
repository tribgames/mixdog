//! The attachments of a `restoreQueued` reply (`take-entries.mjs`): the queued entries' pasted images
//! and texts and file parts come back with their bytes, read from the prompt attachment store
//! (`hydratePastedAttachments`, `hydrateRestorableFileParts`). A referenced blob that is gone for good
//! is dropped alone and counted into `notice`, never the prompt that carried it; a read that may pass
//! (a busy file) fails the call, so nothing is rewritten around it.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::CoreError;
use mixdog_core_base::support::failed;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use serde_json::Map;
use serde_json::Value;

use super::prompt_submission::LaneAttachments;
use super::prompt_submission::pasted_text;
use super::prompt_submission::reference_of;
use super::user_facts::AttachmentStore;
use super::user_facts::BlobError;

/// The blob's bytes; `None` when it is permanently unreadable.
fn read(store: &AttachmentStore, lane: &InLane<InteractiveIo>, reference: &str) -> Result<Option<Vec<u8>>, CoreError> {
    match store.read_blob(lane, reference) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(BlobError::Permanent) => Ok(None),
        Err(BlobError::Invalid(message) | BlobError::Transient(message)) => Err(failed("session", message)),
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

/// `materializePastedTexts`' entry ([`pasted_text`], `attachments/store.mjs:478-512`) over a Stop's hand-back: an inline pasted text
/// an entry still holds (one queued without the `turn/start` intake, which stores every one) is kept as a content-addressed blob and
/// the entry states `attachmentRef`, `sizeBytes` and `chars` in place of the text, so the reply reads it back as every other
/// ([`hydrate`]). A referenced entry, and anything else, stays as queued.
pub(super) fn materialize_texts(store: &AttachmentStore, lane: &InLane<InteractiveIo>, map: &mut Value) -> Result<(), CoreError> {
    let Value::Object(entries) = map else { return Ok(()) };
    let store = LaneAttachments { store, lane };
    for raw in entries.values_mut() {
        if !raw.is_object() || reference_of(raw).is_some() || !raw.get("text").is_some_and(Value::is_string) {
            continue;
        }
        // A refusal is answered with Node's own sentence, as `saveBuffer`'s throw reaches the caller.
        let taken = pasted_text(&store, raw).map_err(|message| failed("session", message))?;
        if let Some((_, entry)) = taken {
            *raw = entry;
        }
    }
    Ok(())
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

/// `restorableAttachmentsFromPrompt(content, rowText)` (`attachments/prompt-restore.mjs`): the composer's restore
/// payload of a stored, materialized user prompt, as references. The n-th `textKind` reference part belongs to the
/// n-th `[Pasted text #n …]` / `[File #n …]` token of the row's text (a `[File #n: name]` token of a binary file
/// takes none); each image reference part is an entry under its `pasteId`, else the id of the image token at its
/// position, else the next free id. Answers `(pastedTexts, pastedImages)`, each `None` when empty.
pub(super) fn restorable_attachments(content: &[Value], row_text: &str) -> (Option<Value>, Option<Value>) {
    use std::collections::BTreeMap;
    use std::sync::LazyLock;

    use mixdog_js::JsRegex;

    static TEXT_TOKEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\[(Pasted text|File) #(\d+)(?:: ([^\]\r\n]+))?[^\]\r\n]*\]", "g"));
    static IMAGE_TOKEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\[Image #(\d+)[^\]\r\n]*\]", "g"));

    let kind = |part: &Value| part.get("type").and_then(Value::as_str).map(str::to_owned);
    let text_kind = |part: &Value| part.get("textKind").and_then(Value::as_str).map(str::to_owned);
    // `Number(text)` of a digit run; an id is used only when it is not zero.
    let number = |digits: &str| digits.parse::<u64>().unwrap_or(0);
    let truthy_text = |part: &Value, key: &str| part.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
    let text_refs: Vec<&Value> = content
        .iter()
        .filter(|part| kind(part).as_deref() == Some("text") && reference_of(part).is_some() && matches!(text_kind(part).as_deref(), Some("paste" | "file")))
        .collect();
    let image_refs: Vec<&Value> = content.iter().filter(|part| kind(part).as_deref() == Some("image") && reference_of(part).is_some()).collect();

    // An object keyed by integer ids lists them in ascending order.
    let mut texts: BTreeMap<u64, Value> = BTreeMap::new();
    let mut next = 0;
    for token in TEXT_TOKEN.captures_iter(row_text) {
        let Some(part) = text_refs.get(next) else { break };
        let is_file = token.get(1) == Some("File");
        let part_kind = text_kind(part);
        let same = if is_file { part_kind.as_deref() == Some("file") && token.get(3) == part.get("filename").and_then(Value::as_str) } else { part_kind.as_deref() == Some("paste") };
        if !same {
            continue;
        }
        next += 1;
        let id = token.get(2).map_or(0, number);
        if id == 0 || texts.contains_key(&id) {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("id".into(), Value::from(id));
        entry.insert("source".into(), Value::from(if part_kind.as_deref() == Some("file") { "file" } else { "paste" }));
        entry.insert("attachmentRef".into(), part["attachmentRef"].clone());
        if let Some(size) = part.get("sizeBytes") {
            entry.insert("sizeBytes".into(), size.clone());
        }
        for key in ["filename", "mimeType"] {
            if let Some(value) = truthy_text(part, key) {
                entry.insert(key.into(), Value::from(value));
            }
        }
        texts.insert(id, Value::Object(entry));
    }

    let image_ids: Vec<u64> = IMAGE_TOKEN.captures_iter(row_text).map(|token| token.get(1).map_or(0, number)).collect();
    let mut used: std::collections::BTreeSet<u64> = texts.keys().copied().chain(image_ids.iter().copied()).collect();
    let mut next_id = 1;
    let mut images: BTreeMap<u64, Value> = BTreeMap::new();
    for (index, part) in image_refs.iter().enumerate() {
        // `Number(part.pasteId) || imageIds[index] || 0`.
        let paste_id = match part.get("pasteId") {
            Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
            Some(Value::String(s)) => mixdog_js::js_trim(s).parse::<u64>().unwrap_or(0),
            _ => 0,
        };
        let mut id = if paste_id != 0 { paste_id } else { image_ids.get(index).copied().unwrap_or(0) };
        if id == 0 || images.contains_key(&id) {
            while used.contains(&next_id) {
                next_id += 1;
            }
            id = next_id;
            used.insert(id);
        }
        let mut entry = Map::new();
        entry.insert("id".into(), Value::from(id));
        entry.insert("type".into(), Value::from("image"));
        entry.insert("mediaType".into(), Value::from(truthy_text(part, "mimeType").or_else(|| truthy_text(part, "mediaType")).unwrap_or_else(|| "image/png".to_owned())));
        entry.insert("attachmentRef".into(), part["attachmentRef"].clone());
        if let Some(size) = part.get("sizeBytes") {
            entry.insert("sizeBytes".into(), size.clone());
        }
        if let Some(filename) = truthy_text(part, "filename") {
            entry.insert("filename".into(), Value::from(filename));
        }
        images.insert(id, Value::Object(entry));
    }
    let object = |entries: BTreeMap<u64, Value>| (!entries.is_empty()).then(|| Value::Object(entries.into_iter().map(|(id, entry)| (id.to_string(), entry)).collect()));
    (object(texts), object(images))
}

/// The sentence a rewind answers a composer that cannot hold file parts (`rewind.mjs`, `restoreFiles: false`).
pub(super) const REWIND_FILES_REFUSAL: &str = "this message has PDF/Office attachments the terminal composer cannot restore; edit it in the desktop app";

/// The restore payload of a rewind to the stored prompt `content` whose row shows `row_text` (`rewindToItem`,
/// `rewind.mjs`): refused untouched when the composer cannot hold its file parts, else its pasted texts and images
/// and its file parts with their bytes (`hydrateTolerantly`). `None` for a prompt that is plain text.
pub(super) fn rewind_restore(store: &AttachmentStore, lane: &InLane<InteractiveIo>, content: &Value, row_text: &str, restore_files: bool) -> Result<Option<Value>, CoreError> {
    let Some(parts) = content.as_array() else { return Ok(None) };
    if !restore_files && parts.iter().any(|part| part.get("type").and_then(Value::as_str) == Some("file")) {
        return Err(failed("thread", REWIND_FILES_REFUSAL));
    }
    let (texts, images) = restorable_attachments(parts, row_text);
    let mut raw = Map::new();
    if let Some(images) = images {
        raw.insert("pastedImages".into(), images);
    }
    if let Some(texts) = texts {
        raw.insert("pastedTexts".into(), texts);
    }
    raw.insert("content".into(), content.clone());
    hydrate(store, lane, Value::Object(raw)).map(Some)
}

#[cfg(test)]
mod rewind_tests {
    use serde_json::json;

    use super::*;

    fn reference(fill: char) -> String {
        fill.to_string().repeat(64)
    }

    /// `restorableAttachmentsFromPrompt`: tokens take the text references in order and only of their own kind (a
    /// binary `[File #n: name]` token takes none); an image is keyed by its `pasteId`, else its token, else the next
    /// free id; the maps list their ids in ascending order.
    #[test]
    fn a_stored_prompt_gives_back_its_references_as_node_builds_them() {
        let content = [
            json!({ "type": "text", "text": "look " }),
            json!({ "type": "text", "textKind": "paste", "attachmentRef": reference('a'), "sizeBytes": 12 }),
            json!({ "type": "file", "attachmentRef": reference('f'), "mimeType": "application/pdf", "filename": "r.pdf" }),
            json!({ "type": "text", "textKind": "file", "attachmentRef": reference('b'), "sizeBytes": 5, "filename": "n.md", "mimeType": "text/markdown" }),
            json!({ "type": "image", "attachmentRef": reference('c'), "sizeBytes": 9, "mimeType": "image/jpeg", "pasteId": 7 }),
            json!({ "type": "image", "attachmentRef": reference('d'), "sizeBytes": 3, "filename": "shot.png" }),
            json!({ "type": "image", "attachmentRef": "short" }),
            json!({ "type": "text", "textKind": "paste", "text": "inline, no reference" }),
        ];
        let text = "look [Pasted text #3 +2 lines] [File #1: r.pdf] [File #2: n.md] [Image #7] [Image #9]";
        let (texts, images) = restorable_attachments(&content, text);
        assert_eq!(
            texts,
            Some(json!({
                "2": { "id": 2, "source": "file", "attachmentRef": reference('b'), "sizeBytes": 5, "filename": "n.md", "mimeType": "text/markdown" },
                "3": { "id": 3, "source": "paste", "attachmentRef": reference('a'), "sizeBytes": 12 },
            }))
        );
        assert_eq!(texts.unwrap().as_object().unwrap().keys().collect::<Vec<_>>(), ["2", "3"]);
        assert_eq!(
            images,
            Some(json!({
                "7": { "id": 7, "type": "image", "mediaType": "image/jpeg", "attachmentRef": reference('c'), "sizeBytes": 9 },
                "9": { "id": 9, "type": "image", "mediaType": "image/png", "attachmentRef": reference('d'), "sizeBytes": 3, "filename": "shot.png" },
            }))
        );
        // No token, no entry; an image without an id takes the next id nothing uses.
        let (texts, images) = restorable_attachments(&content[..5], "look [Image #1]");
        assert_eq!(texts, None);
        assert_eq!(images.unwrap()["7"]["attachmentRef"], json!(reference('c')));
        let (_, images) = restorable_attachments(&content[3..6], "see [File #1: n.md]");
        assert_eq!(images.unwrap().as_object().unwrap().keys().collect::<Vec<_>>(), ["2", "7"], "the file took 1, the pasteId 7");
        assert_eq!(restorable_attachments(&[json!({ "type": "text", "text": "plain" })], "plain"), (None, None));
    }
}

