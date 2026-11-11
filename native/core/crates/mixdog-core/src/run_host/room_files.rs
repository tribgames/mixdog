//! [`RoomFiles`] over the session directory: the files a member's turn produced, taken in as the
//! room log's `agent-room-delivery.mjs` does (`speechWithArtifacts`, `storedFileFields`).
//!
//! A speech row carrying `artifactsFrom { sessionId, since }` names the member's own session in
//! this room and when its turn started. The files that turn wrote inside the session's folders
//! are stored and ride on the row as references. A user row's `upload` (the files of the user's
//! message) is taken in as a chat prompt's are (`storedRow`). Any other row comes back as it is.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::composer_image::node_base64_decode;
use mixdog_rt::InLane;
use mixdog_store::fsio::{IoLane, WriteLane};
use mixdog_store::schema::bounded::Digest;

use super::media::{MAX_PDF_BYTES, pdf_intake_facts};
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_rooms::rooms::live::{LogLine, RoomFiles};
use mixdog_core_session::session::SessionDirectory;
use mixdog_js::to_number_of;
use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};
use mixdog_services::bots::delivery::rows::artifact_records;
use mixdog_services::task_reports::artifacts::turn_slice;
use mixdog_services::task_reports::collect::{Options, collect_turn_artifacts, session_roots, store_attachment};
use mixdog_store::blobs::BlobStore;
use serde_json::{Map, Value, json};

pub struct SessionFiles {
    directory: Arc<SessionDirectory>,
    lane: DurabilityIo,
    data_dir: PathBuf,
    /// `sensitive_scopes(&[home, mixdog home, data dir])`: files under them are never taken.
    scopes: Vec<Vec<String>>,
    /// The PDF check of a user's upload (`inspectPdfBuffer`).
    docs: Arc<dyn DocumentText>,
    log: LogLine,
}

impl SessionFiles {
    pub fn new(directory: Arc<SessionDirectory>, lane: DurabilityIo, data_dir: PathBuf, scopes: Vec<Vec<String>>, docs: Arc<dyn DocumentText>, log: LogLine) -> Self {
        Self { directory, lane, data_dir, scopes, docs, log }
    }

    /// `loadSession` + `turnSlice` + `collectTurnArtifacts(.., { cwd, roots: sessionRoots(session) })`.
    async fn collect(&self, session_id: &str, since: f64) -> Result<Vec<Value>, String> {
        let thread = ThreadId::from(session_id);
        let header = self.directory.stored_header(&thread).await.ok_or_else(|| format!("session {session_id} is not available"))?;
        let held = self.directory.model_context(&thread).read().await.map_err(|error| error.to_string())?;
        let messages = Value::Array(held.into_iter().map(|(_, message)| message).collect());
        let text = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or_default().to_owned();
        let cwd = text(header.get("cwd"));
        let workspace = header.get("workspace");
        let candidates = vec![
            cwd.clone(),
            text(workspace.and_then(|w| w.get("projectPath"))),
            text(workspace.and_then(|w| w.get("worktreePath"))),
            text(header.get("desktopSession").and_then(|d| d.get("projectPath"))),
        ];
        let folders = Folders { cwd, candidates };
        collect_from(self.lane, &self.data_dir, &self.scopes, &folders, &messages, since).await
    }
}

/// A session's cwd and the folders its files may come from (`sessionRoots`' candidates).
struct Folders {
    cwd: String,
    candidates: Vec<String>,
}

/// `turnSlice(messages, { since })` + `collectTurnArtifacts(.., { cwd, roots: sessionRoots(..) })`
/// on the durability lane: the files the turn wrote, stored (a file that fits a prompt) or
/// path-only.
async fn collect_from(lane: DurabilityIo, data_dir: &Path, scopes: &[Vec<String>], folders: &Folders, messages: &Value, since: f64) -> Result<Vec<Value>, String> {
    let slice = Value::Array(turn_slice(messages, "", since));
    let (data_dir, scopes) = (data_dir.to_path_buf(), scopes.to_vec());
    let (cwd, candidates) = (folders.cwd.clone(), folders.candidates.clone());
    let found = lane
        .submit(&CancellationToken::new(), move |lane| {
            let options = Options { cwd, roots: session_roots(&candidates), scopes };
            let blobs = BlobStore::new(&data_dir);
            collect_turn_artifacts(lane, &slice, &options, &|bytes| store_attachment(&blobs, lane, bytes)).to_json()
        })
        .map_err(|error| format!("{error:?}"))?
        .await
        .map_err(|error| format!("{error:?}"))?;
    Ok(found.get("files").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// `storedFileFields(files)`: `{ parts, attachments }` for the stored files among `files`; none
/// when none is stored.
pub fn stored_file_fields(files: &[Value]) -> Map<String, Value> {
    let stored: Vec<Value> = files.iter().filter(|file| file.get("id").is_some_and(|id| !id.is_null() && id != "")).cloned().collect();
    let mut out = Map::new();
    if stored.is_empty() {
        return out;
    }
    let parts: Vec<Value> = stored
        .iter()
        .map(|file| {
            let kind = file.get("kind").and_then(Value::as_str);
            let mut part = Map::new();
            part.insert("type".into(), json!(match kind { Some("image") => "image", Some("text") => "text", _ => "file" }));
            part.insert("attachmentRef".into(), file["id"].clone());
            if kind == Some("text") {
                part.insert("textKind".into(), json!("file"));
            }
            for (key, from) in [("mimeType", "mimeType"), ("filename", "name"), ("sizeBytes", "size")] {
                if let Some(value) = file.get(from) {
                    part.insert(key.into(), value.clone());
                }
            }
            Value::Object(part)
        })
        .collect();
    out.insert("parts".into(), Value::Array(parts));
    out.insert("attachments".into(), Value::Array(artifact_records(&stored)));
    out
}

const TEXT_REFERENCE_THRESHOLD_BYTES: usize = 800;
const MAX_PROMPT_TEXT_BYTES: f64 = 1024.0 * 1024.0;
const MAX_MESSAGE_ATTACHMENTS: usize = 64;
const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;

/// JavaScript truthiness of a field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(a || b || fallback).slice(0, limit)`.
fn first_text(values: &[Option<&Value>], fallback: &str, limit: usize) -> String {
    let text = values.iter().find(|value| truthy(**value)).map_or_else(|| fallback.to_owned(), |value| mixdog_js::value_to_string(value.unwrap()));
    mixdog_js::slice_utf16(&text, limit)
}

/// `isAttachmentReference(value)`: the stored reference a part or pasted entry names.
fn reference_of(value: &Value) -> Option<&str> {
    value.get("attachmentRef").and_then(Value::as_str).filter(|r| r.len() == 64 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// `Object.entries(object)` in JavaScript's order: array-index keys ascending, then the rest as inserted.
fn js_entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |key: &str| key.parse::<u32>().ok().filter(|n| *n < u32::MAX && n.to_string() == key);
    let mut indexed: Vec<_> = object.iter().filter(|(key, _)| index(key).is_some()).collect();
    indexed.sort_by_key(|(key, _)| index(key));
    indexed.extend(object.iter().filter(|(key, _)| index(key).is_none()));
    indexed
}

/// The attachment store as the prompt intake writes and measures it (`saveBuffer`, `attachmentBlobSize`).
struct Store<'a, L> {
    blobs: &'a BlobStore,
    lane: &'a InLane<L>,
}

impl<L: WriteLane + IoLane> Store<'_, L> {
    /// `saveBuffer(buffer)`: `{ attachmentRef, sizeBytes }`, the reused blob's time refreshed.
    fn save(&self, bytes: &[u8]) -> Result<Map<String, Value>, String> {
        if bytes.is_empty() {
            return Err("prompt attachment is empty".into());
        }
        if bytes.len() > MAX_BLOB_BYTES {
            return Err("prompt attachment exceeds the 64 MiB input limit".into());
        }
        let pin = self.blobs.put_fresh(self.lane, bytes).map_err(|error| error.to_string())?;
        let mut stored = Map::new();
        stored.insert("attachmentRef".into(), json!(pin.digest().as_str().trim_start_matches("sha256:")));
        stored.insert("sizeBytes".into(), json!(bytes.len()));
        Ok(stored)
    }

    fn stored_len(&self, reference: &str) -> Result<Option<u64>, String> {
        let digest = Digest::try_from(format!("sha256:{reference}")).map_err(|error| error.to_string())?;
        self.blobs.len(self.lane, &digest).map_err(|error| error.to_string())
    }

    /// `attachmentBlobSize(reference, claimed)`: the stored file's size, else `Number(claimed) || 0`.
    fn size(&self, reference: &str, claimed: Option<&Value>) -> Result<Value, String> {
        Ok(match self.stored_len(reference)? {
            Some(len) => json!(len),
            None => {
                let claimed = mixdog_js::to_number_of(claimed);
                mixdog_js::json_number(if claimed.is_nan() { 0.0 } else { claimed })
            }
        })
    }

    /// `materializeText(text, metadata)`.
    fn text(&self, text: &str, meta: &Value) -> Result<Value, String> {
        let mut part = Map::new();
        part.insert("type".into(), json!("text"));
        part.extend(self.save(text.as_bytes())?);
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

    /// `materializeInlinePart(part)`: inline bytes and long text stored, by reference.
    fn inline(&self, part: &Value) -> Result<Value, String> {
        let Value::Object(fields) = part else { return Ok(part.clone()) };
        if reference_of(part).is_some() {
            return Ok(part.clone());
        }
        let kind = part.get("type").and_then(Value::as_str);
        if let (Some("image" | "file"), Some(data)) = (kind, part.get("data").and_then(Value::as_str).filter(|data| !data.is_empty())) {
            let bytes = node_base64_decode(data);
            let mut stored = fields.clone();
            stored.shift_remove("data");
            // The magic header outranks the transport label.
            if kind == Some("file") && bytes.starts_with(b"%PDF-") {
                stored.insert("mimeType".into(), json!("application/pdf"));
            }
            stored.extend(self.save(&bytes)?);
            return Ok(Value::Object(stored));
        }
        if let (Some("text"), Some(text)) = (kind, part.get("text").and_then(Value::as_str))
            && text.len() >= TEXT_REFERENCE_THRESHOLD_BYTES
        {
            return self.text(text, part);
        }
        Ok(part.clone())
    }
}

/// `TEXT_TOKEN_RE` (`/\[(?:Pasted text|File) #(\d+)[^\]\r\n]*\]/g`): each token's byte range and number.
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

/// `expandTextTokens(text, refs)`: the text split around the tokens that name a stored text; `None` when none does.
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

/// A user message's files as the prompt intake takes them in (`materializePromptSubmission`,
/// `attachmentsForIntake`, `promptContentImageMeta`): the materialized prompt, its attachment records and image chips.
struct Intake {
    prompt: Vec<Value>,
    attachments: Vec<Value>,
    images: Vec<Value>,
}

/// `materializePastedTexts`: the stored part of each pasted text by its id, and the entries with their references.
fn pasted_texts<L: WriteLane + IoLane>(store: &Store<'_, L>, pasted: Option<&Value>) -> Result<(Map<String, Value>, Option<Map<String, Value>>), String> {
    let (mut refs, mut options) = (Map::new(), Map::new());
    let Some(Value::Object(pasted)) = pasted else { return Ok((refs, None)) };
    for (key, raw) in js_entries(pasted) {
        if !raw.is_object() {
            continue;
        }
        let text_kind = if raw.get("source").and_then(Value::as_str) == Some("file") { "file" } else { "paste" };
        let part = if let Some(reference) = reference_of(raw) {
            let mut part = Map::new();
            part.insert("type".into(), json!("text"));
            part.insert("attachmentRef".into(), json!(reference));
            part.insert("sizeBytes".into(), store.size(reference, raw.get("sizeBytes"))?);
            part.insert("textKind".into(), json!(text_kind));
            for key in ["filename", "mimeType"] {
                if truthy(raw.get(key)) {
                    part.insert(key.into(), raw[key].clone());
                }
            }
            Value::Object(part)
        } else if let Some(text) = raw.get("text").and_then(Value::as_str) {
            let meta = json!({ "textKind": text_kind, "filename": raw.get("filename"), "mimeType": raw.get("mimeType") });
            store.text(text, &meta)?
        } else {
            continue;
        };
        let id = match raw.get("id") {
            None | Some(Value::Null) => key.clone(),
            Some(id) => mixdog_js::value_to_string(id),
        };
        let mut entry = raw.as_object().cloned().unwrap_or_default();
        entry.shift_remove("text");
        entry.insert("attachmentRef".into(), part["attachmentRef"].clone());
        entry.insert("sizeBytes".into(), part["sizeBytes"].clone());
        let chars = mixdog_js::to_number_of(raw.get("chars"));
        let chars = if chars.is_nan() || chars == 0.0 { raw.get("text").and_then(Value::as_str).map_or(0.0, |text| mixdog_js::utf16_len(text) as f64) } else { chars };
        entry.insert("chars".into(), mixdog_js::json_number(chars));
        refs.insert(id, part);
        options.insert(key.clone(), Value::Object(entry));
    }
    Ok((refs, (!options.is_empty()).then_some(options)))
}

/// `materializePastedImages`: each entry with the stored image it names, by its own bytes or reference, else paired
/// with an image part by paste id, else with the next part no entry claimed.
fn pasted_images<L: WriteLane + IoLane>(store: &Store<'_, L>, pasted: &Value, image_parts: &[&Value]) -> Result<Option<Map<String, Value>>, String> {
    let Value::Object(pasted) = pasted else { return Ok(None) };
    let entries: Vec<(&String, &Value)> = js_entries(pasted).into_iter().filter(|(_, raw)| raw.is_object()).collect();
    let mut resolved: Vec<Option<Value>> = Vec::with_capacity(entries.len());
    for (_, raw) in &entries {
        resolved.push(if reference_of(raw).is_some() {
            Some((*raw).clone())
        } else if let Some(content) = raw.get("content").and_then(Value::as_str).filter(|c| !c.is_empty()) {
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
            None | Some(Value::Null) => (*key).clone(),
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
            entry.insert("sizeBytes".into(), store.size(&at, claimed)?);
        }
        out.insert((*key).clone(), Value::Object(entry));
    }
    Ok((!out.is_empty()).then_some(out))
}

/// `attachmentsForIntake(prompt, options)`: one record per stored image, file and pasted or attached text.
fn intake_attachments<L: WriteLane + IoLane>(store: &Store<'_, L>, prompt: &[Value], images: &[&Value], texts: &[&Value]) -> Result<Vec<Value>, String> {
    let mut found: Vec<(String, Map<String, Value>)> = Vec::new();
    let mut add = |reference: &str, info: Map<String, Value>| {
        if !found.iter().any(|(r, _)| r == reference) && found.len() < MAX_MESSAGE_ATTACHMENTS {
            found.push((reference.to_owned(), info));
        }
    };
    let named = |raw: &Value, fallback: &str| first_text(&[raw.get("filename"), raw.get("name")], fallback, 200);
    // `pickedOriginal`: the file the user picked, when the store still holds it.
    let original = |raw: Option<&Value>| -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        let reference = raw.and_then(|raw| raw.get("originalRef")).map(mixdog_js::value_to_string).unwrap_or_default();
        if reference.len() == 64 && reference.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) && store.stored_len(&reference)?.is_some() {
            let mime = first_text(&[raw.and_then(|raw| raw.get("originalMediaType"))], "", 100);
            out.insert("original".into(), json!({ "attachmentRef": reference, "mimeType": mime }));
        }
        Ok(out)
    };
    let record = |kind: &str, name: String, mime: String, size: Value| {
        let mut info = Map::new();
        info.insert("kind".into(), json!(kind));
        info.insert("name".into(), json!(name));
        info.insert("mimeType".into(), json!(mime));
        info.insert("size".into(), size);
        info
    };
    for part in prompt {
        let Some(reference) = reference_of(part) else { continue };
        let mime = first_text(&[part.get("mimeType"), part.get("mediaType")], "", 100);
        let size = store.size(reference, part.get("sizeBytes"))?;
        match (part.get("type").and_then(Value::as_str), part.get("textKind").and_then(Value::as_str)) {
            (Some("image"), _) => {
                let meta = images.iter().find(|raw| raw.get("attachmentRef").and_then(Value::as_str) == Some(reference)).copied();
                let mime = if mime.is_empty() { first_text(&[meta.and_then(|m| m.get("mediaType"))], "image/png", usize::MAX) } else { mime };
                let mut info = original(meta)?;
                info.extend(record("image", named(meta.unwrap_or(part), "image"), mime, size));
                add(reference, info);
            }
            (Some("file"), _) => {
                let mime = if mime.is_empty() { "application/octet-stream".to_owned() } else { mime };
                add(reference, record("file", named(part, "attachment"), mime, size));
            }
            (Some("text"), Some(kind @ ("paste" | "file"))) => {
                let mime = if mime.is_empty() { "text/plain".to_owned() } else { mime };
                add(reference, record("text", named(part, if kind == "paste" { "pasted-text.txt" } else { "attachment.txt" }), mime, size));
            }
            _ => {}
        }
    }
    // Images the prompt carries only by side table, then the pasted and attached texts.
    for raw in images {
        let Some(reference) = reference_of(raw) else { continue };
        let mut info = original(Some(raw))?;
        let size = store.size(reference, raw.get("sizeBytes"))?;
        info.extend(record("image", named(raw, "image"), first_text(&[raw.get("mediaType")], "image/png", 100), size));
        add(reference, info);
    }
    for raw in texts {
        let Some(reference) = reference_of(raw) else { continue };
        let fallback = if raw.get("source").and_then(Value::as_str) == Some("file") { "attachment.txt" } else { "pasted-text.txt" };
        let size = store.size(reference, raw.get("sizeBytes"))?;
        add(reference, record("text", named(raw, fallback), first_text(&[raw.get("mimeType")], "text/plain", 100), size));
    }
    Ok(found
        .into_iter()
        .map(|(reference, info)| {
            let mut out = Map::new();
            out.insert("id".into(), json!(reference));
            out.insert("attachmentRef".into(), json!(reference));
            out.extend(info);
            Value::Object(out)
        })
        .collect())
}

/// `materializePromptSubmission(prompt, { pastedImages, pastedTexts })`, then its attachment records and image chips.
fn take_upload<L: WriteLane + IoLane>(store: &Store<'_, L>, text: &str, upload: &Value) -> Result<Intake, String> {
    // The words ride along so the composer's text tokens find their pastes.
    let mut prompt = vec![json!({ "type": "text", "text": text })];
    prompt.extend(upload.get("parts").and_then(Value::as_array).cloned().unwrap_or_default());
    let image_table = upload.get("pastedImages").filter(|value| truthy(Some(value)));
    let text_table = upload.get("pastedTexts").filter(|value| truthy(Some(value)));
    let (refs, texts) = pasted_texts(store, text_table)?;
    let mut materialized = Vec::new();
    for part in &prompt {
        let expanded = match (part.get("type").and_then(Value::as_str), part.get("text").and_then(Value::as_str)) {
            (Some("text"), Some(text)) => expand_text_tokens(text, &refs),
            _ => None,
        };
        match expanded {
            Some(pieces) => {
                for piece in &pieces {
                    materialized.push(store.inline(piece)?);
                }
            }
            None => materialized.push(store.inline(part)?),
        }
    }
    let mut text_bytes = 0.0;
    for part in materialized.iter().filter(|part| part.get("type").and_then(Value::as_str) == Some("text")) {
        text_bytes += match reference_of(part) {
            Some(reference) => store.size(reference, part.get("sizeBytes"))?.as_f64().unwrap_or(0.0),
            None => part.get("text").filter(|text| truthy(Some(text))).map_or(0, |text| mixdog_js::value_to_string(text).len()) as f64,
        };
    }
    if text_bytes > MAX_PROMPT_TEXT_BYTES {
        return Err("prompt text exceeds the 1 MiB input limit".into());
    }
    let image_parts: Vec<&Value> = materialized.iter().filter(|part| part.get("type").and_then(Value::as_str) == Some("image") && reference_of(part).is_some()).collect();
    let images = match image_table {
        Some(pasted) => pasted_images(store, pasted, &image_parts)?,
        None => None,
    };
    let image_entries: Vec<&Value> = images.iter().flat_map(|map| map.values()).filter(|raw| raw.is_object()).collect();
    let text_entries: Vec<&Value> = texts.iter().flat_map(|map| map.values()).filter(|raw| raw.is_object()).collect();
    let attachments = intake_attachments(store, &materialized, &image_entries, &text_entries)?;
    let chips = mixdog_core_session::session::transcript::image_meta(&json!({
        "message": materialized,
        "options": { "pastedImages": images.map_or(Value::Null, Value::Object) },
    }));
    Ok(Intake { prompt: materialized, attachments, images: chips })
}

impl SessionFiles {
    /// `storedRow(row)`: a user row's `upload` taken in as a chat prompt's files are; the row keeps the stored
    /// references (`parts`), their attachment records and the bubble's image chips, never the bytes.
    async fn stored_row(&self, room_id: &str, row: Value) -> Result<Value, String> {
        let Value::Object(mut rest) = row else { return Ok(row) };
        let upload = rest.shift_remove("upload").unwrap_or(Value::Null);
        // `String(row.text ?? '')`.
        let text = rest.get("text").filter(|text| !text.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
        let data_dir = self.data_dir.clone();
        let mut intake = self
            .lane
            .submit(&CancellationToken::new(), move |lane| take_upload(&Store { blobs: &BlobStore::new(&data_dir), lane }, &text, &upload))
            .map_err(|error| format!("{error:?}"))?
            .await
            .map_err(|error| format!("{error:?}"))??;
        // `preparePromptSubmissionForProvider(.., { nativePdf: false })`: each stored PDF checked, its page counts kept on the part.
        let thread = ThreadId::from(format!("sess_room_{room_id}"));
        for part in intake.prompt.iter_mut() {
            let mime = first_text(&[part.get("mimeType"), part.get("mediaType")], "", usize::MAX).to_lowercase();
            let Some(reference) = reference_of(part).map(str::to_owned).filter(|_| part.get("type").and_then(Value::as_str) == Some("file") && mime == "application/pdf") else {
                continue;
            };
            let data_dir = self.data_dir.clone();
            let claimed = part.get("sizeBytes").cloned();
            let (bytes, size) = self
                .lane
                .submit(&CancellationToken::new(), move |lane| {
                    let store = Store { blobs: &BlobStore::new(&data_dir), lane };
                    let size = store.size(&reference, claimed.as_ref())?.as_f64().unwrap_or(0.0) as u64;
                    let digest = Digest::try_from(format!("sha256:{reference}")).map_err(|error| error.to_string())?;
                    let bytes = if size > MAX_PDF_BYTES { Vec::new() } else { store.blobs.read(lane, &digest).map_err(|error| error.to_string())? };
                    Ok::<_, String>((bytes, size))
                })
                .map_err(|error| format!("{error:?}"))?
                .await
                .map_err(|error| format!("{error:?}"))??;
            let facts = pdf_intake_facts(self.docs.as_ref(), &thread, &base64::engine::general_purpose::STANDARD.encode(&bytes), size, false).await?;
            part["pageCount"] = json!(facts.page_count.unwrap_or(0));
            part["textPages"] = json!(facts.text_pages.unwrap_or(0));
            part["textChars"] = json!(facts.text_chars.unwrap_or(0));
        }
        let parts: Vec<Value> = intake
            .prompt
            .into_iter()
            .filter(|part| reference_of(part).is_some() && (part.get("type").and_then(Value::as_str) != Some("text") || truthy(part.get("textKind"))))
            .collect();
        rest.insert("parts".into(), Value::Array(parts));
        rest.insert("attachments".into(), Value::Array(intake.attachments));
        rest.insert("images".into(), Value::Array(intake.images));
        Ok(Value::Object(rest))
    }
}

#[async_trait]
impl RoomFiles for SessionFiles {
    async fn take_in(&self, room_id: &str, row: Value) -> Result<Value, String> {
        let kind = row.get("kind").and_then(Value::as_str);
        // `row.upload && typeof row.upload === 'object'`.
        if kind == Some("user") && row.get("upload").is_some_and(|upload| upload.is_object() || upload.is_array()) {
            return self.stored_row(room_id, row).await;
        }
        let Some(from) = row.get("artifactsFrom").filter(|from| kind == Some("speech") && from.is_object()).cloned() else {
            return Ok(row);
        };
        let Value::Object(mut rest) = row else { return Ok(row) };
        rest.shift_remove("artifactsFrom");
        let session_id = from.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let speaker = rest.get("speaker").and_then(Value::as_str).unwrap_or_default().to_owned();
        let belongs = room_member_of_session(&session_id).is_some_and(|member| member.room_id == room_id && member.agent_id == speaker);
        if !belongs {
            return Ok(Value::Object(rest));
        }
        // `Number(from.since) || 0`.
        let since = Some(to_number_of(from.get("since"))).filter(|since| !since.is_nan()).unwrap_or(0.0);
        match self.collect(&session_id, since).await {
            Ok(files) => rest.extend(stored_file_fields(&files)),
            Err(error) => (self.log)(&format!("the files of {session_id} could not be taken in: {error}")),
        }
        Ok(Value::Object(rest))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use mixdog_core_session::session::testing::Rig;

    const REF: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // Node's attachment records are unique by ref, so the three files of the test have three.
    const REF_TEXT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REF_FILE: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    const GOLDEN: &str = include_str!("room_files/golden.json");
    const PNG: &str = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636460f85f0f0002870180eb47ba920000000049454e44ae426082";

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap()).collect()
    }

    /// The real files of a project and a folder beside it, written on the lane.
    async fn tree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let (root, other) = (dir.path().join("proj"), dir.path().join("other"));
        let (a, b) = (root.clone(), other.clone());
        let lane = mixdog_rt::testing::tokens().durability_io;
        let job = lane
            .submit(&CancellationToken::new(), move |lane| {
                mixdog_statefile::create_private_dir_all(lane, &a).unwrap();
                mixdog_statefile::create_private_dir_all(lane, &b).unwrap();
                mixdog_statefile::append_file(lane, &a.join("shot.png"), &bytes(PNG)).unwrap();
                mixdog_statefile::append_file(lane, &a.join("notes.md"), b"# notes\nhello\n").unwrap();
                mixdog_statefile::append_file(lane, &b.join("outside.md"), b"outside\n").unwrap();
            })
            .unwrap();
        job.await.unwrap();
        (dir, root, other)
    }

    /// Node's `speechWithArtifacts` on the same files: the parts and attachment records a member's
    /// turn returns, the order of its reply's links, only its own turn, only inside the session's
    /// folders and only what exists (golden recorded from `createAgentRoomDelivery`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_members_turn_files_become_the_rows_parts_and_attachments_as_node_stores_them() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let (dir, root, other) = tree().await;
        let swap = |text: &str| text.replace("<root>", &root.to_string_lossy().replace('\\', "/")).replace("<other>", &other.to_string_lossy().replace('\\', "/"));
        let folders = Folders { cwd: root.to_string_lossy().into_owned(), candidates: vec![root.to_string_lossy().into_owned()] };
        let data = dir.path().join("data");
        for name in ["chart", "several", "nothing"] {
            let case = &golden[name];
            let messages: Value = serde_json::from_str(&swap(&case["messages"].to_string())).unwrap();
            let lane = mixdog_rt::testing::tokens().durability_io;
            let files = collect_from(lane, &data, &[], &folders, &messages, 1000.0).await.unwrap();
            let got = stored_file_fields(&files);
            let want = &case["row"];
            assert_eq!(got.get("parts"), want.get("parts"), "{name}");
            assert_eq!(got.get("attachments"), want.get("attachments"), "{name}");
        }
    }

    #[test]
    fn only_stored_files_become_parts_and_attachments() {
        assert!(stored_file_fields(&[json!({ "path": "/a", "kind": "file" }), json!({ "id": "" })]).is_empty());
        let fields = stored_file_fields(&[
            json!({ "id": REF, "kind": "image", "name": "a.png", "mimeType": "image/png", "size": 3, "path": "/a.png" }),
            json!({ "path": "/skipped" }),
            json!({ "id": REF_TEXT, "kind": "text", "name": "n.txt", "mimeType": "text/plain", "size": 1 }),
            json!({ "id": REF_FILE, "kind": "file", "name": "d.pdf", "mimeType": "application/pdf", "size": 2 }),
        ]);
        let parts = fields["parts"].as_array().unwrap();
        assert_eq!(parts[0], json!({ "type": "image", "attachmentRef": REF, "mimeType": "image/png", "filename": "a.png", "sizeBytes": 3 }));
        assert_eq!(parts[1], json!({ "type": "text", "attachmentRef": REF_TEXT, "textKind": "file", "mimeType": "text/plain", "filename": "n.txt", "sizeBytes": 1 }));
        assert_eq!(parts[2]["type"], "file");
        assert_eq!(fields["attachments"].as_array().unwrap().len(), 3);
    }

    /// No PDF is taken in by these tests.
    pub(crate) struct NoDocuments;
    #[async_trait]
    impl DocumentText for NoDocuments {
        async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no office text is read")
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no PDF text is read")
        }
        async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<mixdog_core_api::domain::ext::PdfIntake, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no PDF is taken in")
        }
    }

    fn files() -> (Rig, SessionFiles) {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let lane = mixdog_rt::testing::tokens().durability_io;
        let files = SessionFiles::new(directory, lane, std::env::temp_dir(), Vec::new(), Arc::new(NoDocuments), Arc::new(|_: &str| {}));
        (rig, files)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rows_without_a_member_turn_to_read_come_back_unchanged_or_without_the_pointer() {
        let (_rig, files) = files();
        let plain = json!({ "id": "p", "kind": "pass", "speaker": "gh", "artifactsFrom": { "sessionId": "x" } });
        assert_eq!(files.take_in("room01", plain.clone()).await.unwrap(), plain, "only a speech takes files in");
        let speech = |session: &str, speaker: &str| json!({ "id": "s", "kind": "speech", "speaker": speaker, "text": "t", "artifactsFrom": { "sessionId": session, "since": 5 } });
        // Another room's, another member's, and a session that is no member session: no files, no pointer.
        for row in [speech("sess_rmem_room02_gh", "gh"), speech("sess_rmem_room01_ops", "gh"), speech("sess_other", "gh")] {
            assert_eq!(files.take_in("room01", row).await.unwrap(), json!({ "id": "s", "kind": "speech", "speaker": "gh", "text": "t" }));
        }
        // A member session that is not stored cannot be read: logged, the row goes without files.
        assert_eq!(
            files.take_in("room01", speech("sess_rmem_room01_gh", "gh")).await.unwrap(),
            json!({ "id": "s", "kind": "speech", "speaker": "gh", "text": "t" })
        );
    }
}
