//! The one-time classification of 1.4.5 history rows that Node recognised only by their
//! text (`transcript-restore/restore.mjs` `restoredUserTranscriptItems`, room rows from
//! `agent-room.mjs` `roomRowItem`). The core never matches text at runtime: each user-role
//! row gets its restored meaning as a typed fact here.
//!
//! | Node restores | Written |
//! |---|---|
//! | nothing (`meta:'skill'\|'hook'`, internal display text, empty text) | `visible: false` |
//! | a notice (`schedule-result`, `held-request` with an id) | the row as is (`meta.source`, `meta.heldRequest`) |
//! | a tool card (task notification, completion wrapper, synthetic agent message) | `meta.taskCard{name, args, result, rawResult, isError}` |
//! | the cancel line (`turndone` cancelled) | `meta.turnEnd{status:"cancelled", elapsedMs:0}` |
//! | a user bubble (own room lines included) | `ItemRecord.prompt` = the bubble text |
//!
//! `meta.source` stays as stored: its values are the protocol's `MessageSource` names.
//! Assistant rows get their legacy replay fields converted ([`reasoning`]).

pub mod envelope;
mod js;
pub mod reasoning;
pub mod user_text;

#[cfg(test)]
mod tests;

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_protocol::text_class::is_internal_transcript_display_text;
use mixdog_protocol::text_class::is_transcript_cancelled_status_text;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::model::Row;
use crate::framework::ItemContext;
use envelope::card;
use envelope::completion_card_from_execution;
use envelope::parse_model_visible_completion_wrapper;
use envelope::parse_synthetic_agent_message;
use js::str_of;
use js::truthy;
use user_text::Blobs;
use user_text::ReadError;
use user_text::UserText;
use user_text::tool_result_text;

/// The typed fact of a tool card row.
pub const TASK_CARD: &str = "taskCard";
/// The typed fact of an interrupted turn end.
pub const TURN_END: &str = "turnEnd";

static COMPLETION_ERROR_LABEL: LazyLock<JsRegex> =
    LazyLock::new(|| js::re(r"^(failed|error|timeout|killed|cancelled)$", "i"));
static SYNTHETIC_ERROR_LABEL: LazyLock<JsRegex> = LazyLock::new(|| js::re(r"^(failed|error|killed|cancelled)$", "i"));

/// What Node's restore shows for one user-role message.
#[derive(Debug, Clone, PartialEq)]
pub enum Shown {
    Nothing,
    Notice,
    Card(Value),
    TurnEnd,
    /// A user bubble with this text.
    User(String),
}

fn source(message: &Value) -> Option<&str> {
    message.get("meta").and_then(|meta| str_of(meta, "source"))
}

/// `isRoomRowMessage(message)`.
fn is_room_row(message: &Value) -> bool {
    source(message) == Some("agent-room")
        && truthy(message.get("meta").and_then(|m| m.get("room")).and_then(|r| r.get("kind")))
}

/// `restoredUserTranscriptItems(message, …, userText)`.
pub fn user_row(message: &Value, text: &mut UserText<'_>) -> Shown {
    let meta = message.get("meta");
    if let Some(Value::String(kind)) = meta
        && (kind == "skill" || kind == "hook")
    {
        return Shown::Nothing;
    }
    let source = source(message);
    let held = source == Some("held-request")
        && truthy(meta.and_then(|m| m.get("heldRequest")).and_then(|h| h.get("id")));
    if source == Some("schedule-result") || held {
        return Shown::Notice;
    }
    if source == Some("import") {
        let content = message.get("content");
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            other => tool_result_text(other),
        };
        let text = js_trim(&text);
        return if text.is_empty() { Shown::Nothing } else { Shown::User(text.to_owned()) };
    }
    let text = js_trim(&text.text(message.get("content"))).to_owned();
    let completion = if source == Some("task-notification") {
        completion_card_from_execution(meta.and_then(|m| m.get("execution")), &text)
    } else {
        parse_model_visible_completion_wrapper(&text)
    };
    if let Some(parsed) = completion {
        return Shown::Card(card(parsed, &text, &COMPLETION_ERROR_LABEL));
    }
    if text.is_empty() || is_internal_transcript_display_text(&text) {
        return Shown::Nothing;
    }
    if is_transcript_cancelled_status_text(&text) {
        return Shown::TurnEnd;
    }
    match parse_synthetic_agent_message(&text) {
        Some(parsed) => Shown::Card(card(parsed, &text, &SYNTHETIC_ERROR_LABEL)),
        None => Shown::User(text),
    }
}

/// `promptHistoryKey(text)` is not empty.
fn counts(text: &str) -> bool {
    !js_trim(text).is_empty()
}

/// The room line's prompt: a user line's text (`roomRowItem`), when it counts.
fn room_prompt(message: &Value) -> Option<String> {
    let room = message.get("meta")?.get("room")?;
    if str_of(room, "kind") != Some("user") {
        return None;
    }
    let text = message.get("content").and_then(Value::as_str).unwrap_or("");
    counts(text).then(|| text.to_owned())
}

fn set_meta(body: &mut Value, key: &str, fact: Value) {
    let Some(message) = body.as_object_mut() else {
        return;
    };
    let meta = message.entry("meta").or_insert(Value::Null);
    if meta.is_null() {
        *meta = Value::Object(Map::new());
    }
    if let Some(meta) = meta.as_object_mut() {
        meta.insert(key.to_owned(), fact);
    }
}

/// Classifies one transcript load's rows in order (`restoreTranscriptRange`); `blobs` is
/// the attachment store the user text reads offloaded parts from.
pub fn convert<'r>(rows: impl IntoIterator<Item = &'r mut Row>, blobs: &dyn Blobs) {
    let mut text = UserText::new(blobs);
    for row in rows {
        if is_room_row(&row.body) {
            row.prompt = room_prompt(&row.body);
            continue;
        }
        match str_of(&row.body, "role") {
            Some("user") => match user_row(&row.body, &mut text) {
                Shown::Nothing => row.visible = false,
                Shown::Notice => {}
                Shown::Card(card) => set_meta(&mut row.body, TASK_CARD, card),
                Shown::TurnEnd => set_meta(&mut row.body, TURN_END, json!({"status": "cancelled", "elapsedMs": 0})),
                Shown::User(text) => row.prompt = Some(text),
            },
            Some("assistant") => reasoning::convert(&mut row.body),
            _ => {}
        }
    }
}

/// The migration's attachment store (`<D>/prompt-attachments/sha256/<ab>/<hex>`).
pub struct StoreBlobs<'a, 'b>(pub &'a ItemContext<'b>);

impl Blobs for StoreBlobs<'_, '_> {
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        match crate::durable::read_within(&self.0.blob_path(hex), max_bytes) {
            Ok(Some(bytes)) if crate::durable::sha256_hex(&bytes) == hex => {
                Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
            }
            Ok(Some(_)) => Err(ReadError::Other),
            Ok(None) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ReadError::Missing),
            Err(_) => Err(ReadError::Other),
        }
    }
}
