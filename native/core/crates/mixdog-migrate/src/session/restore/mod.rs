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
pub use mixdog_protocol::message_class::TASK_CARD;
pub use mixdog_protocol::message_class::TURN_END;
pub use mixdog_protocol::message_class::envelope;
pub use mixdog_protocol::message_class::is_room_row;
pub use mixdog_protocol::message_class::room_prompt;
pub use mixdog_protocol::message_class::row_facts;
pub use mixdog_protocol::message_class::user_row;
pub use mixdog_protocol::message_class::user_text;

use super::model::Row;
use crate::framework::ItemContext;
use user_text::Blobs;
use user_text::ReadError;
use user_text::UserText;

/// Classifies one transcript load's rows in order (`restoreTranscriptRange`); `blobs` is
/// the attachment store the user text reads offloaded parts from.
pub fn convert<'r>(rows: impl IntoIterator<Item = &'r mut Row>, blobs: &dyn Blobs) {
    let mut text = UserText::new(blobs);
    let rows: Vec<&mut Row> = rows.into_iter().collect();
    let ids = reasoning::session_wire_ids(rows.iter().map(|row| &row.body));
    for row in rows {
        if let Some(facts) = row_facts(&mut row.body, &mut text) {
            row.visible &= facts.visible;
            row.prompt = facts.prompt;
        } else if str_of(&row.body, "role") == Some("assistant") {
            reasoning::convert(&mut row.body, &ids);
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
