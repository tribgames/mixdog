//! `materializePromptSubmission` (`attachments/store.mjs:631-648`): what a submitted prompt keeps of its pasted texts,
//! pasted images, inline media and long texts. Each is kept in the prompt-attachment store and named by reference, the
//! composer's text tokens (`[Pasted text #n …]`, `[File #n …]`) become the stored texts they stand for, and the prompt's
//! text is held to 1 MiB.
//!
//! The one implementation of that intake. A chat's `turn/start` (`session-turns.mjs` `submitAdmitted`) takes its prompt in
//! through it over the session's [`AttachmentStore`] ([`LaneAttachments`]), a room's user message (`agent-room-delivery.mjs`
//! `storedRow`) over the room host's staged store; each writes and measures through a [`PromptStore`].

use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::composer_image::node_base64_decode;
use super::user_facts::AttachmentStore;
use super::user_facts::BlobError;

/// `TEXT_REFERENCE_THRESHOLD_BYTES` (`store.mjs:51`): a plain text this long is kept in the store.
pub const TEXT_REFERENCE_THRESHOLD_BYTES: usize = 800;
/// `MAX_PROMPT_TEXT_BYTES` (`store.mjs:52`).
pub const MAX_PROMPT_TEXT_BYTES: f64 = 1024.0 * 1024.0;

/// The prompt-attachment store as the intake writes and measures it.
pub trait PromptStore {
    /// `saveBuffer(buffer)` (`store.mjs:135-185`): empty bytes and bytes over 64 MiB refused with Node's sentences, else the
    /// reference of the stored bytes (`{ attachmentRef, sizeBytes }`, [`saved`]).
    fn save(&self, bytes: &[u8]) -> Result<Map<String, Value>, String>;
    /// The size of the file the store holds under `reference` (`statSync(..).size`); `None` when it holds none (ENOENT).
    fn stored_len(&self, reference: &str) -> Result<Option<u64>, String>;
}

/// Whether a plain text of [`TEXT_REFERENCE_THRESHOLD_BYTES`] or more is kept in the store (`materializeInlinePart`,
/// `materializePromptContent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LongText {
    /// Stored and named by a text reference without `textKind`, as Node's intake does: a room's message.
    Stored,
    /// Left in the prompt: a chat's `turn/start`. This core's readers of a live prompt's shown text (the prompt history, a
    /// Stop's hand-back, the queue row, the turn's own prompt text) do not read the store, so a long prompt stored whole would
    /// reach them empty, where Node's `promptDisplayText` and `promptContentText` read it back.
    Inline,
}

/// `{ attachmentRef, sizeBytes }`: what `saveBuffer` answers for `len` bytes stored under `reference`.
pub fn saved(reference: &str, len: usize) -> Map<String, Value> {
    let mut stored = Map::new();
    stored.insert("attachmentRef".into(), json!(reference));
    stored.insert("sizeBytes".into(), json!(len));
    stored
}

/// `ATTACHMENT_REF_RE` (`/^[a-f0-9]{64}$/`): a content address of the store.
pub fn is_attachment_ref(reference: &str) -> bool {
    reference.len() == 64 && reference.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `isAttachmentReference(value)` (`store.mjs:275`): the stored attachment a part or pasted entry names.
pub fn reference_of(value: &Value) -> Option<&str> {
    value.get("attachmentRef").and_then(Value::as_str).filter(|reference| is_attachment_ref(reference))
}

/// JavaScript truthiness of a field (`None` is `undefined`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `attachmentBlobSize(reference, claimed)` (`store.mjs:410-417`): the stored file's size, else `Number(claimed) || 0`.
fn blob_size_number(store: &dyn PromptStore, reference: &str, claimed: Option<&Value>) -> Result<f64, String> {
    Ok(match store.stored_len(reference)? {
        Some(len) => len as f64,
        None => {
            let claimed = mixdog_js::to_number_of(claimed);
            if claimed.is_nan() { 0.0 } else { claimed }
        }
    })
}

/// `attachmentBlobSize(reference, claimed)` as the JSON number a part or entry keeps.
pub fn blob_size(store: &dyn PromptStore, reference: &str, claimed: Option<&Value>) -> Result<Value, String> {
    blob_size_number(store, reference, claimed).map(mixdog_js::json_number)
}

/// `Object.entries(value)` in JavaScript's order: an array's elements by index; an object's array-index keys ascending, then
/// its other keys as inserted.
fn js_entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item)).collect(),
        Value::Object(object) => {
            let index = |key: &str| key.parse::<u32>().ok().filter(|n| *n < u32::MAX && n.to_string() == key);
            let mut indexed: Vec<(&String, &Value)> = object.iter().filter(|(key, _)| index(key).is_some()).collect();
            indexed.sort_by_key(|(key, _)| index(key));
            indexed.extend(object.iter().filter(|(key, _)| index(key).is_none()));
            indexed.into_iter().map(|(key, value)| (key.clone(), value)).collect()
        }
        _ => Vec::new(),
    }
}

/// `materializeText(text, metadata)` (`store.mjs:465-476`): `text` stored, as the text part that names it with the metadata's
/// `textKind`, `filename` (200 UTF-16 units) and `mimeType` (100).
fn materialize_text(store: &dyn PromptStore, text: &str, meta: &Value) -> Result<Value, String> {
    let mut part = Map::new();
    part.insert("type".into(), json!("text"));
    part.extend(store.save(text.as_bytes())?);
    if truthy(meta.get("textKind")) {
        part.insert("textKind".into(), meta["textKind"].clone());
    }
    for (key, limit) in [("filename", 200), ("mimeType", 100)] {
        if truthy(meta.get(key)) {
            part.insert(key.into(), json!(mixdog_js::slice_utf16(&mixdog_js::value_to_string(&meta[key]), limit)));
        }
    }
    Ok(Value::Object(part))
}

/// `Number(raw.chars) || (typeof raw.text === 'string' ? raw.text.length : 0)` (`store.mjs:508`): a pasted entry's own count
/// when `Number()` reads one that is not 0, else its text's length in UTF-16 units.
pub fn pasted_chars(supplied: Option<&Value>, text: Option<&str>) -> Value {
    let chars = mixdog_js::to_number_of(supplied);
    if chars.is_nan() || chars == 0.0 {
        json!(text.map_or(0, mixdog_js::utf16_len))
    } else {
        mixdog_js::json_number(chars)
    }
}

/// One entry of `materializePastedTexts` (`store.mjs:478-512`): the stored text part it stands for (the reference it names,
/// sized by the stored file, else its own text stored), and the entry as the submission keeps it, its text replaced by
/// `attachmentRef`, `sizeBytes` and `chars`. `None` for an entry that names neither.
pub fn pasted_text(store: &dyn PromptStore, raw: &Value) -> Result<Option<(Value, Value)>, String> {
    let Value::Object(fields) = raw else { return Ok(None) };
    let text_kind = if raw.get("source").and_then(Value::as_str) == Some("file") { "file" } else { "paste" };
    let text = raw.get("text").and_then(Value::as_str);
    let part = if let Some(reference) = reference_of(raw) {
        let mut part = Map::new();
        part.insert("type".into(), json!("text"));
        part.insert("attachmentRef".into(), json!(reference));
        part.insert("sizeBytes".into(), blob_size(store, reference, raw.get("sizeBytes"))?);
        part.insert("textKind".into(), json!(text_kind));
        for key in ["filename", "mimeType"] {
            if truthy(raw.get(key)) {
                part.insert(key.into(), raw[key].clone());
            }
        }
        Value::Object(part)
    } else if let Some(text) = text {
        let meta = json!({ "textKind": text_kind, "filename": raw.get("filename"), "mimeType": raw.get("mimeType") });
        materialize_text(store, text, &meta)?
    } else {
        return Ok(None);
    };
    let mut entry = fields.clone();
    entry.shift_remove("text");
    entry.insert("attachmentRef".into(), part["attachmentRef"].clone());
    entry.insert("sizeBytes".into(), part["sizeBytes"].clone());
    entry.insert("chars".into(), pasted_chars(raw.get("chars"), text));
    Ok(Some((part, Value::Object(entry))))
}

/// `materializePastedTexts(pastedTexts)` (`store.mjs:478-512`): each entry's stored text part by the entry's id (`raw.id ??
/// key`), and the entries as the submission keeps them (`None` when no entry names a text).
fn materialize_pasted_texts(store: &dyn PromptStore, pasted: Option<&Value>) -> Result<(Map<String, Value>, Option<Map<String, Value>>), String> {
    let (mut refs, mut options) = (Map::new(), Map::new());
    let Some(pasted) = pasted.filter(|pasted| pasted.is_object() || pasted.is_array()) else { return Ok((refs, None)) };
    for (key, raw) in js_entries(pasted) {
        let Some((part, entry)) = pasted_text(store, raw)? else { continue };
        let id = match raw.get("id") {
            None | Some(Value::Null) => key.clone(),
            Some(id) => mixdog_js::value_to_string(id),
        };
        refs.insert(id, part);
        options.insert(key, entry);
    }
    Ok((refs, (!options.is_empty()).then_some(options)))
}

/// `TEXT_TOKEN_RE` (`/\[(?:Pasted text|File) #(\d+)[^\]\r\n]*\]/g`, `store.mjs:50`): each token's byte range and number.
fn text_tokens(text: &str) -> Vec<(usize, usize, &str)> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(open) = text[at..].find('[').map(|offset| at + offset) {
        let rest = &text[open + 1..];
        let after = ["Pasted text #", "File #"].iter().find_map(|head| rest.strip_prefix(head));
        let token = after.and_then(|after| {
            let digits = after.bytes().take_while(u8::is_ascii_digit).count();
            let tail = &after[digits..];
            let close = tail.find(|c| matches!(c, ']' | '\r' | '\n')).filter(|&i| tail.as_bytes()[i] == b']')?;
            (digits > 0).then(|| (&after[..digits], text.len() - tail.len() + close + 1))
        });
        match token {
            Some((number, end)) => {
                found.push((open, end, number));
                at = end;
            }
            None => at = open + 1,
        }
    }
    found
}

/// `expandTextTokens(text, refs)` (`store.mjs:514-529`): the text split around the tokens that name a stored text, each
/// token replaced by that text's part; `None` when no token does.
fn expand_text_tokens(text: &str, refs: &Map<String, Value>) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    let mut offset = 0;
    for (start, end, number) in text_tokens(text) {
        let Some(part) = refs.get(number) else { continue };
        if start > offset {
            out.push(json!({ "type": "text", "text": &text[offset..start] }));
        }
        out.push(part.clone());
        offset = end;
    }
    if offset == 0 {
        return None;
    }
    if offset < text.len() {
        out.push(json!({ "type": "text", "text": &text[offset..] }));
    }
    Some(out)
}

/// `materializeInlinePart(part)` (`store.mjs:531-551`): an image or file part's inline bytes stored and the part naming them
/// instead (a file whose bytes are a PDF labelled `application/pdf`), and with [`LongText::Stored`] a text part of
/// [`TEXT_REFERENCE_THRESHOLD_BYTES`] or more stored as a text reference; a part that names a stored attachment, and anything
/// else, as it is.
fn materialize_inline_part(store: &dyn PromptStore, part: &Value, long_text: LongText) -> Result<Value, String> {
    let Value::Object(fields) = part else { return Ok(part.clone()) };
    if reference_of(part).is_some() {
        return Ok(part.clone());
    }
    let kind = part.get("type").and_then(Value::as_str);
    if let (Some("image" | "file"), Some(data)) = (kind, part.get("data").and_then(Value::as_str).filter(|data| !data.is_empty())) {
        // `Buffer.from(data, 'base64')`.
        let bytes = node_base64_decode(data);
        let mut stored = fields.clone();
        stored.shift_remove("data");
        // The magic header outranks the transport label (`isPdfBuffer`).
        if kind == Some("file") && bytes.starts_with(b"%PDF-") {
            stored.insert("mimeType".into(), json!("application/pdf"));
        }
        stored.extend(store.save(&bytes)?);
        return Ok(Value::Object(stored));
    }
    if long_text == LongText::Stored
        && let (Some("text"), Some(text)) = (kind, part.get("text").and_then(Value::as_str))
        && text.len() >= TEXT_REFERENCE_THRESHOLD_BYTES
    {
        return materialize_text(store, text, part);
    }
    Ok(part.clone())
}

/// `materializePromptContent(prompt, textRefs)` (`store.mjs:553-575`): the tokens of a string prompt, or of each text part,
/// replaced by the pasted texts they name ([`expand_text_tokens`]) and every part materialized ([`materialize_inline_part`]);
/// a string prompt that names none stays a string, stored whole with [`LongText::Stored`] when it is long.
fn materialize_prompt_content(store: &dyn PromptStore, prompt: &Value, refs: &Map<String, Value>, long_text: LongText) -> Result<Value, String> {
    match prompt {
        Value::String(text) => {
            if let Some(pieces) = expand_text_tokens(text, refs) {
                return pieces.iter().map(|piece| materialize_inline_part(store, piece, long_text)).collect::<Result<Vec<_>, _>>().map(Value::Array);
            }
            if long_text == LongText::Stored && text.len() >= TEXT_REFERENCE_THRESHOLD_BYTES {
                return Ok(Value::Array(vec![materialize_text(store, text, &Value::Null)?]));
            }
            Ok(prompt.clone())
        }
        Value::Array(parts) => {
            let mut out = Vec::with_capacity(parts.len());
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(pieces) = part.get("text").and_then(Value::as_str).and_then(|text| expand_text_tokens(text, refs))
                {
                    for piece in &pieces {
                        out.push(materialize_inline_part(store, piece, long_text)?);
                    }
                    continue;
                }
                out.push(materialize_inline_part(store, part, long_text)?);
            }
            Ok(Value::Array(out))
        }
        _ => Ok(prompt.clone()),
    }
}

/// `promptTextBytes(content)` (`store.mjs:577-585`): the bytes of the prompt's texts, a stored one by its file.
fn prompt_text_bytes(store: &dyn PromptStore, content: &Value) -> Result<f64, String> {
    match content {
        Value::String(text) => Ok(text.len() as f64),
        Value::Array(parts) => {
            let mut sum = 0.0;
            for part in parts.iter().filter(|part| part.get("type").and_then(Value::as_str) == Some("text")) {
                sum += match reference_of(part) {
                    Some(reference) => blob_size_number(store, reference, part.get("sizeBytes"))?,
                    // `Buffer.byteLength(String(part.text || ''))`.
                    None => part.get("text").filter(|text| truthy(Some(text))).map_or(0, |text| mixdog_js::value_to_string(text).len()) as f64,
                };
            }
            Ok(sum)
        }
        _ => Ok(0.0),
    }
}

/// `materializePastedImages(pastedImages, imageParts)` (`store.mjs:587-629`): each entry with the stored image it names: its
/// own reference or bytes, else the image part carrying its paste id, else the next part no entry claimed. Position in the
/// entry list never decides.
fn materialize_pasted_images(store: &dyn PromptStore, pasted: &Value, image_parts: &[&Value]) -> Result<Option<Map<String, Value>>, String> {
    if !(pasted.is_object() || pasted.is_array()) {
        return Ok(None);
    }
    let entries: Vec<(String, &Value)> = js_entries(pasted).into_iter().filter(|(_, raw)| raw.is_object()).collect();
    let mut resolved: Vec<Option<Value>> = Vec::with_capacity(entries.len());
    for (_, raw) in &entries {
        resolved.push(if reference_of(raw).is_some() {
            Some((*raw).clone())
        } else if let Some(content) = raw.get("content").and_then(Value::as_str).filter(|content| !content.is_empty()) {
            Some(Value::Object(store.save(&node_base64_decode(content))?))
        } else {
            None
        });
    }
    let mut claimed: Vec<String> = resolved.iter().flatten().filter_map(|r| reference_of(r).map(str::to_owned)).collect();
    for (index, (key, raw)) in entries.iter().enumerate() {
        if resolved[index].is_some() {
            continue;
        }
        let id = match raw.get("id") {
            None | Some(Value::Null) => key.clone(),
            Some(id) => mixdog_js::value_to_string(id),
        };
        let free = |part: &&&Value| !claimed.iter().any(|c| Some(c.as_str()) == reference_of(part));
        let paste_id = |part: &Value| part.get("pasteId").filter(|v| !v.is_null()).map(mixdog_js::value_to_string);
        let part = image_parts
            .iter()
            .filter(free)
            .find(|part| paste_id(part).unwrap_or_default() == id)
            .or_else(|| image_parts.iter().filter(free).find(|part| paste_id(part).is_none()))
            .map(|part| (*part).clone());
        if let Some(reference) = part.as_ref().and_then(reference_of) {
            claimed.push(reference.to_owned());
        }
        resolved[index] = part;
    }
    let mut out = Map::new();
    for ((key, raw), reference) in entries.iter().zip(&resolved) {
        let mut entry = raw.as_object().cloned().unwrap_or_default();
        entry.shift_remove("content");
        if let Some(reference) = reference {
            let at = reference_of(reference).unwrap_or_default().to_owned();
            // `ref.sizeBytes || raw.sizeBytes`.
            let claimed = if truthy(reference.get("sizeBytes")) { reference.get("sizeBytes") } else { raw.get("sizeBytes") };
            entry.insert("attachmentRef".into(), json!(at));
            entry.insert("sizeBytes".into(), blob_size(store, &at, claimed)?);
        }
        out.insert(key.clone(), Value::Object(entry));
    }
    Ok((!out.is_empty()).then_some(out))
}

/// What [`materialize_prompt_submission`] makes of a submission (`{ prompt, options }`).
#[derive(Debug, PartialEq)]
pub struct Submission {
    /// The prompt as it is queued and stored: a string, or its parts with every stored attachment named by reference.
    pub prompt: Value,
    /// The submission's options, `pastedImages` and `pastedTexts` (when given) as the intake keeps them, `null` when no
    /// entry survived.
    pub options: Map<String, Value>,
}

/// The longest file name a prompt part keeps (`requiredPromptContent`: `filename.slice(0, 160)`), in UTF-16 units.
const MAX_PROMPT_FILENAME_UNITS: usize = 160;

/// The office types a file part may name, in their canonical case (`OFFICE_MIME_TYPES`, `shared/prompt-limits.ts`).
const OFFICE_MIME_TYPES: [&str; 7] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/msword",
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-excel",
];

/// `canonicalPromptFileMimeType` (`shared/prompt-limits.ts`): the canonical-case type of a PDF or office type, its
/// parameters ignored. Any other type (a phone sends `text/plain`) is not refused here; it is the trimmed text.
fn canonical_file_mime(mime: &str) -> String {
    let base = mixdog_js::js_to_lowercase(mixdog_js::js_trim(mime.split(';').next().unwrap_or_default()));
    if base == "application/pdf" {
        return base;
    }
    match OFFICE_MIME_TYPES.into_iter().find(|candidate| mixdog_js::js_to_lowercase(candidate) == base) {
        Some(canonical) => canonical.to_owned(),
        None => mixdog_js::js_trim(mime).to_owned(),
    }
}

/// What the desktop host's `requiredPromptContent` cleaned in the parts it accepted, applied to every origin before the
/// intake: an image's type trimmed and lowercased, a file's type in its canonical case, a file's name cut to
/// [`MAX_PROMPT_FILENAME_UNITS`] and left out when it is not text or empty. A part keeps every other field it carries.
fn clean_prompt_parts(prompt: &Value) -> Value {
    let Value::Array(parts) = prompt else { return prompt.clone() };
    let clean = |part: &Value| -> Value {
        let Value::Object(fields) = part else { return part.clone() };
        let mut fields = fields.clone();
        let mime = fields.get("mimeType").and_then(Value::as_str).map(str::to_owned);
        match (fields.get("type").and_then(Value::as_str), mime) {
            (Some("image"), Some(mime)) => {
                fields.insert("mimeType".into(), json!(mixdog_js::js_to_lowercase(mixdog_js::js_trim(&mime))));
            }
            (Some("file"), mime) => {
                if let Some(mime) = mime {
                    fields.insert("mimeType".into(), json!(canonical_file_mime(&mime)));
                }
                let name = fields
                    .get("filename")
                    .and_then(Value::as_str)
                    .map(|name| mixdog_js::slice_utf16(name, MAX_PROMPT_FILENAME_UNITS))
                    .filter(|name| !name.is_empty());
                match name {
                    Some(name) => fields.insert("filename".into(), json!(name)),
                    None => fields.shift_remove("filename"),
                };
            }
            _ => {}
        }
        Value::Object(fields)
    };
    Value::Array(parts.iter().map(clean).collect())
}

/// `materializePromptSubmission(prompt, options)` (`store.mjs:631-648`): the pasted texts stored, the prompt's text tokens and
/// inline media turned into references (`long_text` says what a long plain text becomes), the prompt's text held to
/// [`MAX_PROMPT_TEXT_BYTES`], then the pasted images paired with the images they name. A refusal is Node's sentence.
pub fn materialize_prompt_submission(store: &dyn PromptStore, prompt: &Value, options: &Value, long_text: LongText) -> Result<Submission, String> {
    let pasted_texts = options.get("pastedTexts");
    let (refs, texts) = materialize_pasted_texts(store, pasted_texts)?;
    let prompt = materialize_prompt_content(store, &clean_prompt_parts(prompt), &refs, long_text)?;
    if prompt_text_bytes(store, &prompt)? > MAX_PROMPT_TEXT_BYTES {
        return Err("prompt text exceeds the 1 MiB input limit".into());
    }
    // `{ ...(options || {}), pastedImages?, pastedTexts? }`.
    let mut out = options.as_object().cloned().unwrap_or_default();
    if let Some(pasted) = options.get("pastedImages").filter(|pasted| truthy(Some(pasted))) {
        let image_parts: Vec<&Value> =
            prompt.as_array().into_iter().flatten().filter(|part| part.get("type").and_then(Value::as_str) == Some("image") && reference_of(part).is_some()).collect();
        let images = materialize_pasted_images(store, pasted, &image_parts)?;
        out.insert("pastedImages".into(), images.map_or(Value::Null, Value::Object));
    }
    if truthy(pasted_texts) {
        out.insert("pastedTexts".into(), texts.map_or(Value::Null, Value::Object));
    }
    Ok(Submission { prompt, options: out })
}

/// Whether [`materialize_prompt_submission`] of `prompt` and `options` asks anything of the store: a pasted table with an
/// entry, inline media, a stored text to measure, or with [`LongText::Stored`] a long text. A submission it does not is
/// taken in over [`NoStore`], with no lane job.
pub fn touches_store(prompt: &Value, options: &Value, long_text: LongText) -> bool {
    let has_entries = |key: &str| match options.get(key) {
        Some(Value::Object(entries)) => !entries.is_empty(),
        Some(Value::Array(entries)) => !entries.is_empty(),
        _ => false,
    };
    let long = |text: &str| long_text == LongText::Stored && text.len() >= TEXT_REFERENCE_THRESHOLD_BYTES;
    if has_entries("pastedTexts") || has_entries("pastedImages") {
        return true;
    }
    match prompt {
        Value::String(text) => long(text.as_str()),
        Value::Array(parts) => parts.iter().any(|part| match part.get("type").and_then(Value::as_str) {
            Some("text") => reference_of(part).is_some() || part.get("text").and_then(Value::as_str).is_some_and(|text| long(text)),
            Some("image" | "file") => reference_of(part).is_none() && part.get("data").and_then(Value::as_str).is_some_and(|data| !data.is_empty()),
            _ => false,
        }),
        _ => false,
    }
}

/// The store of a submission [`touches_store`] clears: the intake asks nothing of it.
pub struct NoStore;

impl PromptStore for NoStore {
    fn save(&self, _: &[u8]) -> Result<Map<String, Value>, String> {
        Err("the prompt-attachment store is not open to this intake".into())
    }

    fn stored_len(&self, _: &str) -> Result<Option<u64>, String> {
        Err("the prompt-attachment store is not open to this intake".into())
    }
}

/// The session's [`AttachmentStore`] inside an interactive-io lane job, as a chat's intake writes it: a save is stored at once
/// (`saveBuffer`), a size is the stored file's (`statSync`).
pub struct LaneAttachments<'a> {
    pub store: &'a AttachmentStore,
    pub lane: &'a InLane<InteractiveIo>,
}

/// A refusal (`Invalid`) is Node's own sentence, as `saveBuffer`'s throw reaches the caller.
fn blob_message(error: BlobError) -> String {
    match error {
        BlobError::Invalid(sentence) => sentence,
        other => format!("{other:?}"),
    }
}

impl PromptStore for LaneAttachments<'_> {
    fn save(&self, bytes: &[u8]) -> Result<Map<String, Value>, String> {
        let reference = self.store.write_blob(self.lane, bytes).map_err(blob_message)?;
        Ok(saved(&reference, bytes.len()))
    }

    fn stored_len(&self, reference: &str) -> Result<Option<u64>, String> {
        self.store.blob_len(self.lane, reference).map_err(blob_message)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;

    use super::*;

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes))
    }

    /// A store in memory with `saveBuffer`'s refusals: what was saved, by reference, and files it held beforehand.
    #[derive(Default)]
    struct Memory {
        saved: RefCell<Vec<(String, Vec<u8>)>>,
        held: Vec<(String, u64)>,
    }

    impl PromptStore for Memory {
        fn save(&self, bytes: &[u8]) -> Result<Map<String, Value>, String> {
            if bytes.is_empty() {
                return Err("prompt attachment is empty".into());
            }
            let reference = sha(bytes);
            self.saved.borrow_mut().push((reference.clone(), bytes.to_vec()));
            Ok(saved(&reference, bytes.len()))
        }

        fn stored_len(&self, reference: &str) -> Result<Option<u64>, String> {
            if let Some((_, bytes)) = self.saved.borrow().iter().find(|(saved, _)| saved == reference) {
                return Ok(Some(bytes.len() as u64));
            }
            Ok(self.held.iter().find(|(held, _)| held == reference).map(|(_, len)| *len))
        }
    }

    /// The fixture of `record-pasted-text-chars.mjs`: Node's own `materializePastedTexts` on each entry. The entry the intake
    /// keeps is Node's whole (`chars` by `Number()`, `sizeBytes` in UTF-8 bytes, the reference the text's SHA-256).
    #[test]
    fn a_pasted_entry_is_kept_as_nodes_intake_keeps_it() {
        let recorded: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/pasted-text-chars/pasted-text-chars.json")).unwrap();
        for case in recorded["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let (part, entry) = pasted_text(&Memory::default(), &case["entry"]).unwrap().expect("a pasted text");
            assert_eq!(entry, case["materialized"], "{name}");
            assert_eq!(part["attachmentRef"], case["materialized"]["attachmentRef"], "{name}: the part names the same text");
            assert_eq!(part["textKind"], json!("paste"), "{name}");
        }
    }

    /// The defect this intake closes: the desktop's paste (`see [Pasted text #1 +400 lines]` and its `pastedTexts` entry) reaches
    /// the model as the stored text the token stands for, between the words around it; an entry naming no text is dropped and
    /// a token naming no entry stays text.
    #[test]
    fn a_pasted_texts_token_becomes_the_stored_text_it_stands_for() {
        let body = "PASTED-BODY-7301\n".repeat(40);
        let store = Memory::default();
        let options = json!({
            "clientSubmissionId": "s1",
            "pastedTexts": { "2": { "id": 2, "text": "notes", "source": "file", "filename": "n.md", "mimeType": "text/markdown" }, "1": { "id": 1, "text": body }, "9": { "id": 9 } },
        });
        let got = materialize_prompt_submission(&store, &json!("see [Pasted text #1 +40 lines] and [File #2: n.md] but not [Pasted text #3]"), &options, LongText::Inline).unwrap();
        assert_eq!(
            got.prompt,
            json!([
                { "type": "text", "text": "see " },
                { "type": "text", "attachmentRef": sha(body.as_bytes()), "sizeBytes": body.len(), "textKind": "paste" },
                { "type": "text", "text": " and " },
                { "type": "text", "attachmentRef": sha(b"notes"), "sizeBytes": 5, "textKind": "file", "filename": "n.md", "mimeType": "text/markdown" },
                { "type": "text", "text": " but not [Pasted text #3]" },
            ])
        );
        // The entries in `Object.entries` order, the text replaced by its reference; the one naming nothing is gone.
        assert_eq!(got.options.keys().collect::<Vec<_>>(), ["clientSubmissionId", "pastedTexts"]);
        let texts = got.options["pastedTexts"].as_object().unwrap();
        assert_eq!(texts.keys().collect::<Vec<_>>(), ["1", "2"]);
        assert_eq!(texts["1"], json!({ "id": 1, "attachmentRef": sha(body.as_bytes()), "sizeBytes": body.len(), "chars": body.len() }));
        assert_eq!(store.saved.borrow().len(), 2);
        // A text part's tokens expand as a string prompt's do; a part with no token stays.
        let parts = json!([{ "type": "text", "text": "[Pasted text #1]" }, { "type": "text", "text": "plain" }]);
        let got = materialize_prompt_submission(&Memory::default(), &parts, &options, LongText::Inline).unwrap();
        assert_eq!(got.prompt[0]["attachmentRef"], json!(sha(body.as_bytes())));
        assert_eq!(got.prompt[1], json!({ "type": "text", "text": "plain" }));
        // No table, nothing to expand: the prompt and the options as they came.
        let plain = materialize_prompt_submission(&NoStore, &json!("see [Pasted text #1]"), &json!({ "displayText": "x" }), LongText::Inline).unwrap();
        assert_eq!(plain, Submission { prompt: json!("see [Pasted text #1]"), options: json!({ "displayText": "x" }).as_object().cloned().unwrap() });
    }

    /// `materializeInlinePart`: an inline image and file are stored and named by reference (a PDF by its bytes), a part that
    /// names a stored attachment and a short text part stay as they are, and an empty payload is refused as `saveBuffer`
    /// refuses it. A long text is a text reference with [`LongText::Stored`] and stays with [`LongText::Inline`].
    #[test]
    fn inline_media_and_long_texts_are_stored_and_named_by_reference() {
        let (png, pdf, stored): (Vec<u8>, Vec<u8>, String) = (vec![0x89, b'P', b'N', b'G', 1, 2, 3], b"%PDF-1.4 body".to_vec(), "a".repeat(64));
        let long = "y".repeat(TEXT_REFERENCE_THRESHOLD_BYTES);
        let prompt = json!([
            { "type": "text", "text": "look" },
            { "type": "image", "data": STANDARD.encode(&png), "mimeType": "image/png", "filename": "dot.png" },
            { "type": "file", "data": STANDARD.encode(&pdf), "mimeType": "application/octet-stream", "filename": "r.bin" },
            { "type": "file", "attachmentRef": stored, "mimeType": "text/plain", "sizeBytes": 3 },
            { "type": "text", "text": long, "pasteId": 4 },
        ]);
        let store = Memory::default();
        let out = materialize_prompt_submission(&store, &prompt, &json!({}), LongText::Stored).unwrap().prompt;
        assert_eq!(out[0], prompt[0]);
        assert_eq!(out[1], json!({ "type": "image", "mimeType": "image/png", "filename": "dot.png", "attachmentRef": sha(&png), "sizeBytes": png.len() }));
        assert_eq!(out[2], json!({ "type": "file", "mimeType": "application/pdf", "filename": "r.bin", "attachmentRef": sha(&pdf), "sizeBytes": pdf.len() }));
        assert_eq!(out[3], prompt[3]);
        assert_eq!(out[4], json!({ "type": "text", "attachmentRef": sha(long.as_bytes()), "sizeBytes": long.len() }));
        let kept = materialize_prompt_submission(&Memory::default(), &prompt, &json!({}), LongText::Inline).unwrap().prompt;
        assert_eq!(kept[4], prompt[4]);
        // A string prompt: stored whole, or kept.
        let whole = materialize_prompt_submission(&Memory::default(), &json!(long), &Value::Null, LongText::Stored).unwrap();
        assert_eq!(whole.prompt, json!([{ "type": "text", "attachmentRef": sha(long.as_bytes()), "sizeBytes": long.len() }]));
        assert_eq!(whole.options, Map::new());
        assert_eq!(materialize_prompt_submission(&NoStore, &json!(long), &Value::Null, LongText::Inline).unwrap().prompt, json!(long));
        let empty = materialize_prompt_submission(&Memory::default(), &json!([{ "type": "image", "data": "====", "mimeType": "image/png" }]), &json!({}), LongText::Inline);
        assert_eq!(empty, Err("prompt attachment is empty".into()));
    }

    /// `promptTextBytes` over the materialized prompt: a stored text counts by its file (`attachmentBlobSize`), else by the size
    /// it claims; over 1 MiB the submission is refused with Node's sentence.
    #[test]
    fn the_prompt_text_is_held_to_one_mib_counting_stored_texts_by_their_files() {
        let big = "b".repeat(64);
        let store = Memory { held: vec![(big.clone(), MAX_PROMPT_TEXT_BYTES as u64 + 1)], ..Memory::default() };
        let refused = materialize_prompt_submission(&store, &json!("[Pasted text #1 +1 lines]"), &json!({ "pastedTexts": { "1": { "id": 1, "attachmentRef": big, "sizeBytes": 1 } } }), LongText::Inline);
        assert_eq!(refused, Err("prompt text exceeds the 1 MiB input limit".into()));
        let claimed = "c".repeat(64);
        let parts = json!([{ "type": "text", "text": "x".repeat(10) }, { "type": "text", "attachmentRef": claimed, "sizeBytes": MAX_PROMPT_TEXT_BYTES as u64 - 10 }]);
        assert!(materialize_prompt_submission(&Memory::default(), &parts, &json!({}), LongText::Inline).is_ok(), "at the limit");
        let parts = json!([{ "type": "text", "text": "x".repeat(11) }, { "type": "text", "attachmentRef": claimed, "sizeBytes": MAX_PROMPT_TEXT_BYTES as u64 - 10 }]);
        assert_eq!(materialize_prompt_submission(&Memory::default(), &parts, &json!({}), LongText::Inline), Err("prompt text exceeds the 1 MiB input limit".into()));
    }

    /// `materializePastedImages` (`store.test.mjs` "pasted image metadata pairs to parts by identity, not by position"): an
    /// entry with its own reference keeps it, one without pairs to the image part carrying its paste id, else to the next part
    /// no entry claimed; an empty table is `null`.
    #[test]
    fn pasted_images_pair_to_their_parts_by_identity() {
        let restored_bytes = b"restored image".to_vec();
        let restored = sha(&restored_bytes);
        let store = Memory { held: vec![(restored.clone(), restored_bytes.len() as u64)], ..Memory::default() };
        let fresh = STANDARD.encode(b"fresh image");
        let got = materialize_prompt_submission(
            &store,
            &json!([
                { "type": "image", "data": fresh, "mimeType": "image/png" },
                { "type": "image", "attachmentRef": restored, "sizeBytes": restored_bytes.len(), "mimeType": "image/png" },
            ]),
            &json!({ "pastedImages": {
                "1": { "id": 1, "type": "image", "attachmentRef": restored, "sizeBytes": restored_bytes.len() },
                "2": { "id": 2, "type": "image", "mediaType": "image/png" },
            } }),
            LongText::Inline,
        )
        .unwrap();
        let images = &got.options["pastedImages"];
        assert_eq!(images["1"]["attachmentRef"], json!(restored));
        assert_eq!(images["2"]["attachmentRef"], got.prompt[0]["attachmentRef"]);
        assert_eq!(images["2"]["sizeBytes"], json!(11));
        let tagged = materialize_prompt_submission(
            &Memory::default(),
            &json!([
                { "type": "image", "data": fresh, "mimeType": "image/png", "pasteId": 3 },
                { "type": "image", "data": STANDARD.encode(b"other image"), "mimeType": "image/png", "pasteId": 4 },
            ]),
            &json!({ "pastedImages": { "4": { "id": 4, "type": "image" }, "3": { "id": 3, "type": "image", "content": STANDARD.encode(b"its own") } } }),
            LongText::Inline,
        )
        .unwrap();
        let images = &tagged.options["pastedImages"];
        assert_eq!(images["3"], json!({ "id": 3, "type": "image", "attachmentRef": sha(b"its own"), "sizeBytes": 7 }), "its own bytes, stored");
        assert_eq!(images["4"]["attachmentRef"], tagged.prompt[1]["attachmentRef"], "its paste id");
        let none = materialize_prompt_submission(&NoStore, &json!("p"), &json!({ "pastedImages": {}, "pastedTexts": {} }), LongText::Inline).unwrap();
        assert_eq!(none.options, json!({ "pastedImages": null, "pastedTexts": null }).as_object().cloned().unwrap());
    }

    /// [`touches_store`] clears only a submission the intake asks nothing of the store for.
    #[test]
    fn a_submission_needing_no_store_is_told_apart() {
        let long = "z".repeat(TEXT_REFERENCE_THRESHOLD_BYTES);
        let reference = "d".repeat(64);
        for (prompt, options) in [
            (json!("hello"), json!({})),
            (json!(long), json!({ "pastedTexts": {}, "pastedImages": {} })),
            (json!([{ "type": "text", "text": long }, { "type": "image", "attachmentRef": reference, "mimeType": "image/png" }]), Value::Null),
        ] {
            assert!(!touches_store(&prompt, &options, LongText::Inline), "{prompt} {options}");
            assert!(materialize_prompt_submission(&NoStore, &prompt, &options, LongText::Inline).is_ok(), "{prompt} {options}");
        }
        assert!(touches_store(&json!(long), &json!({}), LongText::Stored));
        assert!(touches_store(&json!("p"), &json!({ "pastedTexts": { "1": { "text": "t" } } }), LongText::Inline));
        assert!(touches_store(&json!("p"), &json!({ "pastedImages": { "1": { "id": 1 } } }), LongText::Inline));
        assert!(touches_store(&json!([{ "type": "text", "attachmentRef": reference }]), &json!({}), LongText::Inline));
        assert!(touches_store(&json!([{ "type": "file", "data": "eA==", "mimeType": "text/plain" }]), &json!({}), LongText::Inline));
    }

    /// The chat's store: a save is the blob `write_blob` publishes under the data folder (an inline image and a pasted text
    /// here), a size its file's, ENOENT none, and a refusal Node's sentence.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "the test reads the stored blobs back")]
    async fn the_sessions_store_writes_and_measures_its_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore(mixdog_store::blobs::BlobStore::new(dir.path()));
        let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3];
        let prompt = json!([{ "type": "text", "text": "see [Pasted text #1]" }, { "type": "image", "data": STANDARD.encode(&png), "mimeType": "image/png" }]);
        let tokens = mixdog_rt::testing::tokens();
        let (got, gone, empty) = mixdog_core_base::support::on_lane(tokens.interactive_io, &tokio_util::sync::CancellationToken::new(), move |lane| {
            let lane = LaneAttachments { store: &store, lane };
            let got = materialize_prompt_submission(&lane, &prompt, &json!({ "pastedTexts": { "1": { "id": 1, "text": "pasted body" } } }), LongText::Inline);
            let empty = materialize_prompt_submission(&lane, &json!([{ "type": "file", "data": "====", "mimeType": "text/plain" }]), &json!({}), LongText::Inline);
            (got, lane.stored_len(&"e".repeat(64)), empty)
        })
        .await
        .unwrap();
        let got = got.unwrap();
        let (text, image) = (sha(b"pasted body"), sha(&png));
        assert_eq!(got.prompt[1], json!({ "type": "text", "attachmentRef": text, "sizeBytes": 11, "textKind": "paste" }));
        assert_eq!(got.prompt[2], json!({ "type": "image", "mimeType": "image/png", "attachmentRef": image, "sizeBytes": png.len() }));
        assert_eq!(gone, Ok(None));
        assert_eq!(empty, Err("prompt attachment is empty".into()));
        for (reference, bytes) in [(&text, b"pasted body".to_vec()), (&image, png)] {
            let at = dir.path().join("prompt-attachments/sha256").join(&reference[..2]).join(reference);
            assert_eq!(std::fs::read(at).unwrap(), bytes);
        }
    }

    #[test]
    fn prompt_parts_are_cleaned_before_the_intake() {
        let long = "n".repeat(200);
        let prompt = json!([
            { "type": "image", "data": "eA==", "mimeType": " IMAGE/PNG " },
            { "type": "file", "data": "eA==", "mimeType": "Application/PDF; charset=x", "filename": long },
            { "type": "file", "data": "eA==", "mimeType": "application/vnd.ms-excel.sheet.macroenabled.12", "filename": "" },
            { "type": "file", "data": "eA==", "mimeType": " text/plain ", "filename": 7 },
        ]);
        let cleaned = clean_prompt_parts(&prompt);
        assert_eq!(cleaned[0]["mimeType"], "image/png");
        assert_eq!(cleaned[1]["mimeType"], "application/pdf");
        assert_eq!(cleaned[1]["filename"].as_str().map(str::len), Some(MAX_PROMPT_FILENAME_UNITS));
        assert_eq!(cleaned[2]["mimeType"], "application/vnd.ms-excel.sheet.macroEnabled.12");
        assert!(cleaned[2].get("filename").is_none(), "an empty name is left out");
        assert_eq!(cleaned[3]["mimeType"], "text/plain");
        assert!(cleaned[3].get("filename").is_none(), "a name that is not text is left out");
        assert_eq!(clean_prompt_parts(&json!("text")), json!("text"));
    }
}
