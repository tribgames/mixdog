//! [`RoomDaemon`] over the session directory: the calls a room makes on its log and its members'
//! sessions (`appendRoomRows`, `readItems` + `roomRowsOfItems`, `submitToSession`, `readSession`,
//! `abortSession` of `session-host.ts`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_rooms::rooms::live::RoomDaemon;
use mixdog_core_rooms::rooms::member_turn::SubmitOptions;
use mixdog_core_rooms::rooms::turn_prompt::RoomPrompt;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::room_log::{RoomLog, SessionRoomLog};
use serde_json::Value;

pub type Republish = Arc<dyn Fn(&str) + Send + Sync>;
pub type RepublishCatalog = Arc<dyn Fn() + Send + Sync>;

pub struct DirectoryRoomDaemon {
    directory: Arc<SessionDirectory>,
    log: SessionRoomLog,
    republish: Republish,
    republish_catalog: RepublishCatalog,
}

impl DirectoryRoomDaemon {
    /// `republish(session_id)` publishes a room log's held snapshot again; `republish_catalog` is
    /// the room summaries' publish (wp-session-32 `RoomSummaries::republish`).
    pub fn new(directory: Arc<SessionDirectory>, republish: Republish, republish_catalog: RepublishCatalog) -> Self {
        Self { log: SessionRoomLog::new(directory.clone()), directory, republish, republish_catalog }
    }
}

fn failed(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}

/// The model content of a room prompt: its text, or its parts.
fn content_of(prompt: &RoomPrompt) -> Value {
    match prompt {
        RoomPrompt::Text(text) => Value::String(text.clone()),
        RoomPrompt::Parts(parts) => Value::Array(parts.clone()),
    }
}

#[async_trait]
impl RoomDaemon for DirectoryRoomDaemon {
    async fn append_rows(&self, session_id: &str, messages: Vec<Value>) -> Result<(), String> {
        self.log.append_rows(session_id, messages).await.map(drop).map_err(failed)
    }

    async fn room_rows(&self, session_id: &str) -> Result<Vec<Value>, String> {
        self.directory.room_rows(&ThreadId::from(session_id)).await.map_err(failed)
    }

    async fn submit(&self, session_id: &str, prompt: &RoomPrompt, options: &SubmitOptions) -> Result<bool, String> {
        let id = options.id.as_deref().unwrap_or_default();
        let room_row = options.room_row.as_deref().unwrap_or_default();
        Ok(self.directory.submit_member_turn(&ThreadId::from(session_id), &content_of(prompt), id, options.hop.unwrap_or(0), room_row).await)
    }

    async fn read_snapshot(&self, session_id: &str) -> Result<Value, String> {
        self.directory.member_snapshot(&ThreadId::from(session_id)).await.map_err(failed)
    }

    /// `abortSession(id, {})`: a turn running in the session is cancelled; none is no error.
    async fn abort(&self, session_id: &str) -> Result<(), String> {
        self.directory.interrupt_running_turn(&ThreadId::from(session_id)).map(drop).map_err(failed)
    }

    fn republish(&self, session_id: &str) {
        (self.republish)(session_id);
    }

    fn republish_catalog(&self) {
        (self.republish_catalog)();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_store::schema::record::Header;
    use serde_json::json;

    use super::*;
    use mixdog_core_session::session::testing::Rig;

    /// Over the real directory: posted messages read back as rows, the snapshot of an idle session
    /// is not busy, an abort with no turn running is not an error, and the republish hooks are
    /// the caller's.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_room_log_reads_back_and_an_idle_member_aborts_quietly() {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let told = Arc::new(Mutex::new(Vec::<String>::new()));
        let (sessions, catalog) = (told.clone(), told.clone());
        let daemon = DirectoryRoomDaemon::new(
            directory.clone(),
            Arc::new(move |id: &str| sessions.lock().unwrap().push(format!("view {id}"))),
            Arc::new(move || catalog.lock().unwrap().push("catalog".into())),
        );
        let mut header = Header::new();
        header.insert("createdAt".into(), json!(1));
        header.insert("updatedAt".into(), json!(1));
        directory.create_with_id(ThreadId::from("sess_room_abc123"), header, json!({})).await.unwrap();
        let message = json!({
            "role": "assistant",
            "content": "yo",
            "meta": { "source": "agent-room", "room": { "kind": "speech", "speaker": "gh" }, "transcript": { "at": 5, "messageId": "s1" } },
        });
        daemon.append_rows("sess_room_abc123", vec![message]).await.unwrap();
        let rows = daemon.room_rows("sess_room_abc123").await.unwrap();
        assert_eq!((rows[0]["id"].as_str(), rows[0]["text"].as_str()), (Some("s1"), Some("yo")));
        assert_eq!(daemon.read_snapshot("sess_room_abc123").await.unwrap()["busy"], json!(false));
        daemon.abort("sess_room_abc123").await.unwrap();
        assert!(daemon.read_snapshot("sess_none").await.is_err());
        daemon.republish("sess_room_abc123");
        daemon.republish_catalog();
        assert_eq!(*told.lock().unwrap(), ["view sess_room_abc123", "catalog"]);
    }
}
