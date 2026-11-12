//! The transcript over the store: the stored Node-shaped message bodies the run's history
//! came from, for compaction's hashing and budgets (WP-COMPACT `MessageRows`).

use std::collections::HashMap;
use std::sync::Mutex;

use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::message::AgentMessage;
use mixdog_app_protocol::v2::thread::TurnInput;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::PromptContent;
use mixdog_protocol::PromptPart;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ThreadSummary;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::summary::CatalogHead;
use mixdog_store::summary::MessageStats;
use mixdog_store::summary::catalog_row;
use serde_json::Value;
use serde_json::json;

use super::seams::Shown;
use super::seams::Transcript;
use super::user_text::NoAttachments;
use super::user_text::PASTED_LINE_READ_BUDGET_BYTES;
use super::user_text::js_trim;
use super::user_text::user_display_text;

#[path = "transcript_boundary.rs"]
mod transcript_boundary;
#[path = "transcript_convert.rs"]
mod transcript_convert;
#[path = "transcript_divider.rs"]
mod transcript_divider;
#[path = "transcript_live.rs"]
mod transcript_live;
/// `promptDisplayText` (`queue-helpers.mjs`) of a prompt whose text parts hold no stored attachment: `promptContentText` over the parts
/// that are not media references (`idle-auto-clear-gate.mjs:10-24`, the one `queue-helpers.mjs:10` imports): a string part as it is, the
/// text of a text part, `[Image]` for an image, `[File]` for a file, the text of any other part, one per line.
/// `None` for a prompt with a text part holding a stored attachment (`isAttachmentReference`), whose text Node reads from the store.
fn inline_prompt_text(message: &Value) -> Option<String> {
    let Some(parts) = message.as_array() else { return None };
    let held = |part: &Value| part.get("attachmentRef").and_then(Value::as_str).is_some_and(is_attachment_ref);
    let kind = |part: &Value| part.get("type").and_then(Value::as_str).map(str::to_owned);
    let media_reference = |part: &Value| kind(part).as_deref() == Some("text") && part.get("attachmentReference").is_some_and(|held| held.as_bool() != Some(false) && !held.is_null()) && part.get("text").is_some_and(Value::is_string);
    if parts.iter().any(|part| !media_reference(part) && kind(part).as_deref() == Some("text") && held(part)) {
        return None;
    }
    let lines: Vec<&str> = parts
        .iter()
        .filter(|part| !media_reference(part))
        .map(|part| match (part.as_str(), kind(part).as_deref()) {
            (Some(text), _) => text,
            (None, Some("image")) => "[Image]",
            (None, Some("file")) => "[File]",
            _ => part.get("text").and_then(Value::as_str).unwrap_or_default(),
        })
        .filter(|line| !line.is_empty())
        .collect();
    Some(lines.join("\n"))
}

/// `promptContentImageMeta` (`queue-helpers.mjs:146`): the image parts of a queued prompt, byte-free, each named by the pasted image
/// at its position (`options.pastedImages`, in the order Node's `Object.values` gives).
pub fn image_meta(entry: &Value) -> Vec<Value> {
    let Some(parts) = entry.get("message").and_then(Value::as_array) else { return Vec::new() };
    let named: Vec<&Value> = entry.pointer("/options/pastedImages").and_then(Value::as_object).map(|map| map.values().collect()).unwrap_or_default();
    parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("image"))
        .enumerate()
        .map(|(index, part)| {
            let meta = named.get(index).filter(|meta| meta.is_object());
            let held = |key: &str| meta.and_then(|meta| meta.get(key)).filter(|value| !value.is_null());
            // `part.data` when it is a string, else `part.content` when that is (`queue-helpers.mjs:152-154`); its UTF-16 length is the fallback size.
            let data = part.get("data").and_then(Value::as_str).or_else(|| part.get("content").and_then(Value::as_str)).unwrap_or_default();
            // `Number(part.sizeBytes) || data.length`: a numeric string, a float or a boolean counts; NaN and 0 fall back.
            let size = mixdog_js::to_number_of(part.get("sizeBytes"));
            let bytes = if size.is_nan() || size == 0.0 { data.encode_utf16().count() as f64 } else { size };
            // `String(a || b || c)`: the first truthy of the part's `mimeType`, its `mediaType`, the pasted image's `mediaType`.
            let truthy = |value: &&Value| match value {
                Value::Null => false,
                Value::Bool(flag) => *flag,
                Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
                Value::String(text) => !text.is_empty(),
                _ => true,
            };
            let mime = part.get("mimeType").filter(truthy).or_else(|| part.get("mediaType").filter(truthy)).or_else(|| held("mediaType").filter(truthy));
            let mut image = json!({
                "id": held("id").cloned().unwrap_or(Value::Null),
                "name": held("filename").filter(truthy).map_or_else(|| format!("Image {}", index + 1), mixdog_js::value_to_string),
                "mimeType": mime.map_or_else(|| "image/png".to_owned(), mixdog_js::value_to_string),
                "bytes": mixdog_js::json_number(bytes),
            });
            if let Some(reference) = part.get("attachmentRef").and_then(Value::as_str).filter(|reference| reference.len() == 64 && reference.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))) {
                image["attachmentRef"] = json!(reference);
            }
            image
        })
        .collect()
}

#[path = "transcript_response.rs"]
mod transcript_response;
#[path = "transcript_rows.rs"]
pub(crate) mod transcript_rows;

pub use self::transcript_response::Completion;
pub use self::transcript_response::Delivery;
pub use self::transcript_response::agent_response;
pub use self::transcript_rows::Restored;
pub use self::transcript_rows::restore;

pub(super) use self::transcript_boundary::fold_model_switches;
pub(super) use self::transcript_rows::normalize_reactions;
pub(super) use self::transcript_rows::truthy;
pub(super) use self::transcript_boundary::divider_model_switches;
pub(super) use self::transcript_boundary::live_divider_model_switch;
pub(super) use self::transcript_boundary::live_model_switch;
pub(super) use self::transcript_divider::divider_item;
pub(super) use self::transcript_live::compact_marker_item;
pub(super) use self::transcript_live::idle_notice_item;
pub(super) use self::transcript_live::notice_item;
pub(super) use self::transcript_response::has_body;
pub use self::transcript_convert::live_end;
pub(super) use self::transcript_convert::displayed_id;
pub(super) use self::transcript_convert::position_of_id;
pub(super) use self::transcript_convert::Ctx as RowCtx;
pub(super) use self::transcript_convert::item_of as row_item;

/// `MessageRows` of one run: every history message the run holds is registered with the
/// `item.body` the store holds for it (the `Value` read back at load, or the body the run
/// committed), and `row` returns that exact value.
///
/// Messages are found by `messageId` when they have one, else by equality among the
/// registered messages without one, newest first.
#[derive(Default)]
pub struct StoredRows {
    inner: Mutex<Rows>,
}

#[derive(Default)]
struct Rows {
    by_id: HashMap<String, Value>,
    unkeyed: Vec<(AgentMessage, Value)>,
}

/// `ATTACHMENT_REF_RE`: `^[a-f0-9]{64}$`.
fn is_attachment_ref(reference: &str) -> bool {
    reference.len() == 64 && reference.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The record `attachmentsForIntake` makes of one prompt part that names a stored attachment
/// (an image, a file, or a `paste`/`file` text); `size` is the stored file's (`sizes`, from the
/// submit options), else the part's own claim, as `attachmentBlobSize` falls back.
fn part_attachment(part: &PromptPart, sizes: Option<&std::collections::BTreeMap<String, u32>>) -> Option<Value> {
    let (kind, reference, mime, size, name, default_mime, default_name) = match part {
        PromptPart::Image { attachment_ref, mime_type, size_bytes, filename, .. } => {
            ("image", attachment_ref, Some(mime_type), size_bytes, filename, "image/png", "image")
        }
        PromptPart::File { attachment_ref, mime_type, size_bytes, filename, .. } => {
            ("file", attachment_ref, Some(mime_type), size_bytes, filename, "application/octet-stream", "attachment")
        }
        PromptPart::Text { attachment_ref, text_kind, mime_type, size_bytes, filename, .. } => match text_kind.as_deref() {
            Some("paste") => ("text", attachment_ref, mime_type.as_ref(), size_bytes, filename, "text/plain", "pasted-text.txt"),
            Some("file") => ("text", attachment_ref, mime_type.as_ref(), size_bytes, filename, "text/plain", "attachment.txt"),
            _ => return None,
        },
    };
    let reference = reference.as_deref().filter(|r| is_attachment_ref(r))?;
    let pick = |value: Option<&String>, fallback: &str, max: usize| -> String {
        value.filter(|v| !v.is_empty()).map_or(fallback, String::as_str).chars().take(max).collect()
    };
    Some(json!({
        "id": reference, "kind": kind, "name": pick(name.as_ref(), default_name, 200),
        "mimeType": pick(mime, default_mime, 100),
        "size": sizes.and_then(|s| s.get(reference)).copied().or(size.filter(|s| *s > 0)).unwrap_or(0),
    }))
}

impl StoredRows {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `message` as converted from (or committed as) the stored `body`.
    pub fn record(&self, message: &AgentMessage, body: Value) {
        let mut rows = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match &message.message_id {
            Some(id) => {
                rows.by_id.insert(id.clone(), body);
            }
            None => rows.unkeyed.push((message.clone(), body)),
        }
    }

    /// `f` over the stored body of the message whose `meta.transcript.messageId` is `message_id`.
    pub fn with_body<R>(&self, message_id: &str, f: impl FnOnce(&Value) -> R) -> Option<R> {
        let rows = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        rows.by_id.get(message_id).map(f)
    }
}

impl MessageRows for StoredRows {
    /// `Value::Null` for a message the run never registered: no stored row exists for it.
    fn row(&self, message: &AgentMessage) -> Value {
        let rows = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(id) = &message.message_id {
            if let Some(body) = rows.by_id.get(id) {
                return body.clone();
            }
        }
        rows.unkeyed
            .iter()
            .rev()
            .find(|(known, _)| known == message)
            .map_or(Value::Null, |(_, body)| body.clone())
    }
}

/// The real [`Transcript`]: the projection of the store's typed records into protocol items,
/// the commit-time facts of a user row, and the thread's list row.
///
/// Stateless: every method is a function of its arguments, so one value serves every thread.
#[derive(Clone, Copy, Debug, Default)]
pub struct RecordTranscript;

impl RecordTranscript {
    pub fn new() -> Self {
        Self
    }
}

impl Transcript for RecordTranscript {
    fn items(&self, _lane: &InLane<CpuInteractive>, record: &ItemRecord) -> Vec<Shown> {
        let Slot::Inline(body) = &record.body else {
            return Vec::new();
        };
        if !record.visible {
            return Vec::new();
        }
        match record.form {
            Form::Message => transcript_convert::message_items(record, body),
            Form::Display => transcript_convert::display_item(record, body).map(Shown::Item).into_iter().collect(),
        }
    }

    fn rows(&self, _lane: &InLane<CpuInteractive>, record: &ItemRecord) -> Vec<(ThreadItem, usize)> {
        let Slot::Inline(body) = &record.body else {
            return Vec::new();
        };
        if !record.visible {
            return Vec::new();
        }
        match record.form {
            Form::Message => transcript_convert::message_shown(record, body)
                .into_iter()
                .filter_map(|(shown, bytes)| match (shown, bytes) {
                    (Shown::Item(item), Some(bytes)) => Some((item, bytes)),
                    _ => None,
                })
                .collect(),
            Form::Display => transcript_convert::display_item(record, body)
                .zip(transcript_convert::display_bytes(record, body))
                .into_iter()
                .collect(),
        }
    }

    /// `{id, text, enqueuedAt?, clientSubmissionId?}`: the entry's display text as the composer showed it, and the submission it
    /// answers (Node's queue entry is named by it, `makeQueueEntry`; a client matches its pending bubble by that id).
    fn queued(&self, qid: &str, entry: &Value) -> Value {
        let shown = entry
            .pointer("/options/displayText")
            .and_then(Value::as_str)
            .filter(|text| !js_trim(text).is_empty());
        let text = match shown {
            Some(text) => text.to_owned(),
            None => {
                let message = entry.get("message").unwrap_or(&Value::Null);
                match inline_prompt_text(message) {
                    Some(text) => text,
                    None => {
                        let mut budget = PASTED_LINE_READ_BUDGET_BYTES;
                        user_display_text(message, &mut NoAttachments, &mut budget)
                    }
                }
            }
        };
        // The fields Node's client projection reads of a queue entry (`session-state-projection.mjs:33-49`): the text cut to 2000 UTF-16
        // units, the mode (`prompt` when the entry names none), the priority (`next` when none, `defaultQueuePriority`), the sender's
        // source fields (`transcriptSourceFields`) and the image list when the prompt has images (`promptContentImageMeta`).
        let mut row = json!({
            "id": qid,
            "text": mixdog_js::slice_utf16(&text, 2_000),
            "mode": entry.get("mode").and_then(Value::as_str).filter(|mode| !mode.is_empty()).unwrap_or("prompt"),
            "priority": entry.get("priority").and_then(Value::as_str).filter(|priority| !priority.is_empty()).unwrap_or("next"),
        });
        for key in ["sender", "device", "fromAgent"] {
            if let Some(held) = entry.pointer(&format!("/transcriptMeta/{key}")).and_then(Value::as_str).filter(|held| !held.is_empty()) {
                row[key] = json!(held);
            }
        }
        let images = image_meta(entry);
        if !images.is_empty() {
            row["images"] = Value::Array(images);
        }
        if let Some(at) = entry.get("enqueuedAt").filter(|at| at.is_number()) {
            row["enqueuedAt"] = at.clone();
        }
        if let Some(submission) = entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            row["clientSubmissionId"] = json!(submission);
        }
        row
    }

    fn user_message(&self, input: &TurnInput) -> Value {
        let content = match &input.prompt {
            PromptContent::Text(text) => json!(text),
            // The parts are the model content as they are: the same fields on the wire, a stored
            // attachment named by its `attachmentRef` included.
            // `mergePromptContents` (`queue-helpers.mjs:120`): one inline text part is its plain string.
            PromptContent::Parts(parts) if matches!(parts.as_slice(), [PromptPart::Text { text: Some(_), .. }]) => {
                let PromptPart::Text { text: Some(text), .. } = &parts[0] else { unreachable!() };
                json!(text)
            }
            PromptContent::Parts(parts) => Value::Array(parts.iter().map(|part| serde_json::to_value(part).expect("protocol types serialize")).collect()),
        };
        let options = input.options.as_ref();
        // `stableMessageId` (`transcript-metadata.mjs`): every prompt gets its own `msg_` id. The client's
        // submission id is not one: Node keeps it as the queue entry's id and the turn's `submissionIds`.
        let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let mut transcript = json!({ "messageId": message_id });
        if let Some(at) = options.and_then(|o| o.submitted_at) {
            transcript["at"] = json!(at);
        }
        if let Some(shown) = options.and_then(|o| o.display_text.as_deref()).filter(|t| !js_trim(t).is_empty()) {
            transcript["displayText"] = json!(shown);
        }
        let bare = |reference: &str| reference.trim_start_matches("sha256:").to_owned();
        let mut stored: Vec<Value> = Vec::new();
        // `attachmentsForIntake`: the stored attachments the prompt's own parts name come first.
        if let PromptContent::Parts(parts) = &input.prompt {
            for part in parts {
                if let Some(entry) = part_attachment(part, input.options.as_ref().and_then(|o| o.attachment_sizes.as_ref())).filter(|e| !stored.iter().any(|s| s["id"] == e["id"])) {
                    stored.push(entry);
                }
            }
        }
        for image in options.and_then(|o| o.pasted_images.as_ref()).into_iter().flat_map(|m| m.values()) {
            let Some(reference) = image.attachment_ref.as_deref() else {
                continue;
            };
            let mut entry = json!({
                "id": bare(reference), "kind": "image", "name": image.filename,
                "mimeType": image.media_type, "size": image.size_bytes.unwrap_or(0),
            });
            if let Some(original) = image.original_ref.as_deref() {
                entry["original"] = json!({ "attachmentRef": bare(original), "mimeType": image.original_media_type });
            }
            stored.push(entry);
        }
        for text in options.and_then(|o| o.pasted_texts.as_ref()).into_iter().flat_map(|m| m.values()) {
            let Some(reference) = text.attachment_ref.as_deref() else {
                continue;
            };
            // `attachmentsForIntake` (`attachments/store.mjs:707-715`): a text names itself by its source.
            let file = text.source.as_deref() == Some("file");
            let name = text.filename.clone().filter(|name| !name.is_empty()).unwrap_or_else(|| (if file { "attachment.txt" } else { "pasted-text.txt" }).to_owned());
            stored.push(json!({
                "id": bare(reference), "kind": "text", "name": name,
                "mimeType": text.mime_type.as_deref().filter(|mime| !mime.is_empty()).unwrap_or("text/plain"), "size": text.size_bytes.unwrap_or(0),
            }));
        }
        let stored = transcript_rows::normalize_attachments(Some(&Value::Array(stored)));
        if !stored.is_empty() {
            transcript["attachments"] = Value::Array(stored);
        }
        json!({ "role": "user", "content": content, "meta": { "transcript": transcript } })
    }

    fn summary(&self, id: &ThreadId, header: &Header) -> ThreadSummary {
        let head = CatalogHead {
            session: id.as_str().to_owned(),
            log_id: String::new(),
            base_session: None,
            header: header.clone(),
        };
        let row = catalog_row(&head, &MessageStats::default(), 0.0);
        let list: Value = serde_json::from_str(&row.summary).unwrap_or(Value::Null);
        summary_of_list_row(id, &list, row.archived)
    }
}

/// The thread's list row as the catalog index keeps it (`list`, Node's `_sessionSummary`) and
/// the archived flag beside it.
pub(super) fn summary_of_list_row(id: &ThreadId, list: &Value, archived: bool) -> ThreadSummary {
    let desktop = list.get("desktopSession").unwrap_or(&Value::Null);
    let some_text = |value: &Value| value.as_str().filter(|s| !s.is_empty()).map(|s| json!(s));
    let mut out = json!({
        "id": id,
        "preview": list["preview"],
        "title": list["title"],
        "updatedAt": list["updatedAt"],
        "messageCount": list["messageCount"],
        "cwd": list["cwd"],
        "classification": desktop.get("classification").cloned().unwrap_or_else(|| json!({})),
        "projectPath": desktop.get("projectPath").cloned().unwrap_or(Value::Null),
        "compactCount": list["compactCount"],
    });
    // The roster states these only when they are so (`desktop-state.ts:273-276`, `withArchiveFlags`).
    if archived {
        out["archived"] = json!(true);
    }
    if list["sessionMode"] == "agent" {
        out["sessionMode"] = json!("agent");
    }
    if let Some(preview) = list["lastMessagePreview"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        out["lastMessagePreview"] = json!(preview);
    }
    // `cleanIncomingTail`: whole places, at most the last hundred.
    if let Some(tail) = list["incomingTail"].as_array() {
        let places: Vec<i64> = tail.iter().filter_map(|place| place.as_i64().filter(|place| *place > 0)).collect();
        out["incomingTail"] = json!(&places[places.len().saturating_sub(100)..]);
    }
    // The roster names no parent: an agent's child session is marked `agentSession` (`on_roster`), not linked.
    if let Some(value) = some_text(&list["inheritedFromSessionId"]) {
        out["forkedFromId"] = value;
    }
    if let Some(activity) = list["lastUsedAt"].as_f64().filter(|at| *at > 0.0) {
        out["activityAt"] = json!(activity as i64);
    }
    if let Some(created) = list["createdAt"].as_f64().filter(|at| *at > 0.0) {
        out["createdAt"] = json!(created as i64);
    }
    // `withFavoriteFlags`, `withReadCursors`, `withRetiredFlags` of `desktop-session-metadata.ts`.
    if list["favoriteAt"].as_f64().is_some_and(|at| at > 0.0) {
        out["favorite"] = json!(true);
    }
    if list["retiredAt"].as_f64().is_some_and(|at| at > 0.0) {
        out["agentDeleted"] = json!(true);
    }
    if let Some(cursor) = super::thread_settings::settle_read_cursor(list["readState"].as_object(), list.get("compactCount"), list.get("messageCount")) {
        out["readMessageCount"] = json!(cursor.get("messageCount").and_then(Value::as_f64).unwrap_or(0.0) as i64);
        out["readRevision"] = json!(cursor.get("revision").and_then(Value::as_f64).unwrap_or(0.0) as i64);
    }
    serde_json::from_value(out).expect("summary shape")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rows_are_the_stored_bodies_by_message_id_or_equality() {
        let rows = StoredRows::new();
        let mut keyed = AgentMessage::user("hi");
        keyed.message_id = Some("m1".into());
        let stored = json!({ "role": "user", "content": "hi", "meta": { "transcript": { "messageId": "m1" } } });
        rows.record(&keyed, stored.clone());
        let call = AgentMessage::assistant("", Vec::new());
        let call_body = json!({ "role": "assistant", "content": "" });
        rows.record(&call, call_body.clone());

        assert_eq!(rows.row(&keyed), stored);
        assert_eq!(rows.row(&call), call_body);
        assert_eq!(rows.row(&AgentMessage::user("never stored")), Value::Null);
    }

    /// `handoffContent`'s parts are prompt parts as they are, and each stored attachment is a
    /// record of the message (`attachmentsForIntake`: kinds, defaults, `text` only for `paste` and
    /// `file`, a ref that is no digest skipped).
    #[test]
    fn a_forwarded_attachment_part_round_trips_and_is_recorded() {
        let digest = "b".repeat(64);
        let wire = json!([
            { "type": "text", "text": "look" },
            { "type": "text", "textKind": "file", "attachmentRef": digest, "sizeBytes": 5, "mimeType": "text/markdown", "filename": "n.md" },
            { "type": "image", "attachmentRef": "c".repeat(64), "sizeBytes": 0, "mimeType": "image/png", "filename": "attachment" },
            { "type": "file", "attachmentRef": "short", "mimeType": "x/y" },
        ]);
        let parts: Vec<PromptPart> = serde_json::from_value(wire.clone()).expect("parts");
        assert_eq!(serde_json::to_value(&parts).unwrap(), wire);
        let records: Vec<Option<Value>> = parts.iter().map(|part| part_attachment(part, None)).collect();
        let sizes = std::collections::BTreeMap::from([(digest.clone(), 9_u32)]);
        assert_eq!(part_attachment(&parts[1], Some(&sizes)).unwrap()["size"], json!(9), "the stored file's size wins");
        assert_eq!(records[0], None);
        assert_eq!(records[1], Some(json!({ "id": digest, "kind": "text", "name": "n.md", "mimeType": "text/markdown", "size": 5 })));
        assert_eq!(records[2], Some(json!({ "id": "c".repeat(64), "kind": "image", "name": "attachment", "mimeType": "image/png", "size": 0 })));
        assert_eq!(records[3], None);
    }
}
