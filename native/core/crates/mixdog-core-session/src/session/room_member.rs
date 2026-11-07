//! A room's rows and a member's session as the room host reads them (`readItems` +
//! `roomRowsOfItems`, `readSession` of `session-host.ts`). Neither needs the thread loaded.

use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::RoomRowKind;
use mixdog_protocol::ThreadItem;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::reads::display_row;
use super::reads::history_items;

/// `roomRowsOfItems` for one item: the room line with the log's message id as `id` and the
/// line's words as `text`. A line without a message id is no row.
fn room_row_of(item: &ThreadItem) -> Option<Value> {
    let ThreadItem::RoomRow { room, text, meta, .. } = item else { return None };
    let id = meta.message_id.clone()?;
    let Value::Object(mut row) = serde_json::to_value(room.as_ref()).ok()? else { return None };
    row.insert("id".into(), json!(id));
    let words = match text {
        MaybeBlob::Inline(text) if matches!(room.kind, RoomRowKind::User | RoomRowKind::Speech) => text.clone(),
        _ => String::new(),
    };
    row.insert("text".into(), json!(words));
    Some(Value::Object(row))
}

/// One transcript row of a session snapshot: the display row, and for a tool its name and the
/// result the row shows (what `toolSummaries` reads).
fn snapshot_row(item: &ThreadItem) -> Value {
    let mut row = display_row(item);
    if let ThreadItem::ToolCall { name, run, .. } = item {
        row["name"] = json!(name);
        if let Some(MaybeBlob::Inline(result)) = &run.result {
            row["result"] = json!(result);
        }
    }
    row
}

impl SessionDirectory {
    /// The room rows of a log thread in log order.
    pub async fn room_rows(&self, thread: &ThreadId) -> Result<Vec<Value>, CoreError> {
        Ok(history_items(self.deps(), thread).await?.iter().filter_map(room_row_of).collect())
    }

    /// A member's session as the turn wait reads it: `{ items, busy }`, `items` the transcript
    /// rows (`kind`, `id`, `at`, and the turn end's `status` / `finalAssistantId` / `reacted`,
    /// an answer's `text` / `streaming`, a tool's `name` / `result`). `busy`: a turn runs or input
    /// is queued. A thread with no stored record fails (`ThreadNotFound`).
    pub async fn member_snapshot(&self, thread: &ThreadId) -> Result<Value, CoreError> {
        let items = history_items(self.deps(), thread).await?;
        Ok(json!({ "items": items.iter().map(snapshot_row).collect::<Vec<_>>(), "busy": self.thread_busy(thread) }))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_store::schema::record::Header;

    use super::super::room_log::{RoomLog, SessionRoomLog};
    use super::super::testing::Rig;
    use super::*;
    use std::sync::Arc;

    /// A room log read back: the rows posted come out as the room host's rows, in order, with the
    /// message id as `id`, and a session that holds no turn is neither busy nor failing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn posted_room_rows_read_back_as_rows_and_the_member_snapshot_is_idle() {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_room_abc123");
        let mut header = Header::new();
        header.insert("createdAt".into(), json!(1));
        header.insert("updatedAt".into(), json!(1));
        directory.create_with_id(thread.clone(), header, json!({})).await.unwrap();
        let message = |id: &str, kind: &str, text: &str, assistant: bool| {
            json!({
                "role": if assistant { "assistant" } else { "user" },
                "content": text,
                "meta": { "source": "agent-room", "room": { "kind": kind, "speaker": "gh" }, "transcript": { "at": 5, "messageId": id } },
            })
        };
        let log = SessionRoomLog::new(directory.clone());
        log.append_rows(thread.as_str(), vec![message("u1", "user", "hi", false), message("s1", "speech", "yo", true)]).await.unwrap();
        let rows = directory.room_rows(&thread).await.unwrap();
        let shown: Vec<(&str, &str, &str)> =
            rows.iter().map(|row| (row["id"].as_str().unwrap(), row["kind"].as_str().unwrap(), row["text"].as_str().unwrap())).collect();
        assert_eq!(shown, [("u1", "user", "hi"), ("s1", "speech", "yo")]);
        let snapshot = directory.member_snapshot(&thread).await.unwrap();
        assert_eq!(snapshot["busy"], json!(false));
        assert!(snapshot["items"].as_array().unwrap().len() >= 2);
        assert!(directory.member_snapshot(&ThreadId::from("sess_none")).await.is_err());
    }
}