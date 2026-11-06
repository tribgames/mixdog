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
#[cfg(test)]
#[path = "transcript_golden.rs"]
mod transcript_golden;
#[path = "transcript_response.rs"]
mod transcript_response;
#[path = "transcript_rows.rs"]
mod transcript_rows;

pub use self::transcript_response::Completion;
pub use self::transcript_response::Delivery;
pub use self::transcript_response::agent_response;

pub(super) use self::transcript_boundary::fold_model_switches;
pub(super) use self::transcript_rows::normalize_reactions;
pub(super) use self::transcript_rows::truthy;
pub(super) use self::transcript_boundary::divider_model_switches;
pub(super) use self::transcript_boundary::live_divider_model_switch;
pub(super) use self::transcript_boundary::live_model_switch;

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

    /// `{id, text, enqueuedAt?}`: the entry's display text as the composer showed it.
    fn queued(&self, qid: &str, entry: &Value) -> Value {
        let shown = entry
            .pointer("/options/displayText")
            .and_then(Value::as_str)
            .filter(|text| !js_trim(text).is_empty());
        let text = match shown {
            Some(text) => text.to_owned(),
            None => {
                let mut budget = PASTED_LINE_READ_BUDGET_BYTES;
                user_display_text(entry.get("message").unwrap_or(&Value::Null), &mut NoAttachments, &mut budget)
            }
        };
        let mut row = json!({ "id": qid, "text": text });
        if let Some(at) = entry.get("enqueuedAt").filter(|at| at.is_number()) {
            row["enqueuedAt"] = at.clone();
        }
        row
    }

    fn user_message(&self, input: &TurnInput) -> Value {
        let content = match &input.prompt {
            PromptContent::Text(text) => json!(text),
            PromptContent::Parts(parts) => Value::Array(
                parts
                    .iter()
                    .map(|part| match part {
                        PromptPart::Text { text } => json!({ "type": "text", "text": text }),
                        PromptPart::Image { data, mime_type } => {
                            json!({ "type": "image", "data": data, "mimeType": mime_type })
                        }
                        PromptPart::File { data, mime_type, filename } => {
                            let mut part = json!({ "type": "file", "data": data, "mimeType": mime_type });
                            if let Some(name) = filename {
                                part["filename"] = json!(name);
                            }
                            part
                        }
                    })
                    .collect(),
            ),
        };
        let options = input.options.as_ref();
        let message_id = options
            .and_then(|o| o.client_submission_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4().simple()));
        let mut transcript = json!({ "messageId": message_id });
        if let Some(at) = options.and_then(|o| o.submitted_at) {
            transcript["at"] = json!(at);
        }
        if let Some(shown) = options.and_then(|o| o.display_text.as_deref()).filter(|t| !js_trim(t).is_empty()) {
            transcript["displayText"] = json!(shown);
        }
        let bare = |reference: &str| reference.trim_start_matches("sha256:").to_owned();
        let mut stored: Vec<Value> = Vec::new();
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
            stored.push(json!({
                "id": bare(reference), "kind": "text", "name": text.filename,
                "mimeType": text.mime_type, "size": text.size_bytes.unwrap_or(0),
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
            "archived": row.archived,
            "sessionMode": list["sessionMode"],
            "lastMessagePreview": list["lastMessagePreview"],
        });
        for (field, source) in [("parentThreadId", "parentSessionId"), ("forkedFromId", "inheritedFromSessionId")] {
            if let Some(value) = some_text(&list[source]) {
                out[field] = value;
            }
        }
        if let Some(activity) = list["lastUsedAt"].as_f64().filter(|at| *at > 0.0) {
            out["activityAt"] = json!(activity as i64);
        }
        serde_json::from_value(out).expect("summary shape")
    }
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
}
