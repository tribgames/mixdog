//! A room's log as the room exchange writes it (`agent-room-delivery.mjs` `commit`): stored rows
//! appended to the room session without a turn, each shown live as it lands.

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use serde_json::Value;

#[async_trait]
pub trait RoomLog: Send + Sync {
    /// Appends `messages` (each `roomRowMessage(row)`: `{role, content, meta: {source, room,
    /// transcript: {at, messageId, attachments?}}}`) to the log of `session_id`, in order after
    /// every earlier append to it. A message whose `meta.transcript.messageId` the log already
    /// holds, or an earlier message of the batch carries, is skipped. Resolves how many were
    /// added. Fails when the session does not exist or is closed (`session <id> is not
    /// available`).
    async fn append_rows(&self, session_id: &str, messages: Vec<Value>) -> Result<usize, CoreError>;
}
