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

pub mod reasoning;

#[cfg(test)]
mod tests;

use mixdog_protocol::message_class::js::str_of;
pub use mixdog_protocol::message_class::Shown;
pub use mixdog_protocol::message_class::envelope;
pub use mixdog_protocol::message_class::is_room_row;
pub use mixdog_protocol::message_class::room_prompt;
pub use mixdog_protocol::message_class::user_row;
pub use mixdog_protocol::message_class::user_text;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::model::Row;
use crate::framework::ItemContext;
use user_text::Blobs;
use user_text::ReadError;
use user_text::UserText;

/// The typed fact of a tool card row.
pub const TASK_CARD: &str = "taskCard";
/// The typed fact of an interrupted turn end.
pub const TURN_END: &str = "turnEnd";

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
