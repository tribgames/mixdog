//! [`SessionOps`] over the session directory: the sessions behind agent homes and rooms.
//!
//! A session's route, archive and retirement marks are header fields (`provider`, `model`,
//! `effort`, `archivedAt`, `retiredAt`), read and patched through `ThreadState`
//! (`thread/header/*`, which the session actor must serve).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::{Method, OpId, ThreadId};
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value, json};

use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::sessions::SessionOps;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::thread_settings::ArchiveStamps;

fn port(error: impl std::fmt::Debug) -> RoomError {
    RoomError::Port(format!("session: {error:?}"))
}

fn missing(error: &CoreError) -> bool {
    matches!(error, CoreError::ThreadNotFound { .. })
}

/// [`SessionOps`] over the session directory.
pub struct DirectorySessions {
    directory: Arc<SessionDirectory>,
    state: Arc<dyn ThreadState>,
    /// The archive stamps the host's own archive hands out too (Node's one `lastArchiveStamp`).
    stamps: Arc<ArchiveStamps>,
}

impl DirectorySessions {
    pub fn new(directory: Arc<SessionDirectory>, state: Arc<dyn ThreadState>) -> Self {
        Self { directory, state, stamps: Arc::default() }
    }

    /// Shares the host's archive stamps (`ThreadSettingsParts::archive_stamps`).
    pub fn with_archive_stamps(self, stamps: Arc<ArchiveStamps>) -> Self {
        Self { stamps, ..self }
    }

    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let ctx = CallContext::internal("rooms");
        let handle = self.directory.open_handle(thread, &ctx).await?;
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        match handle.request(CoreRequest { method: Method(method), params, op: Some(op), ctx }).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Ok(Value::Null),
        }
    }

    fn op_params(thread: &ThreadId, extra: Value) -> Value {
        let mut params = json!({ "threadId": thread, "opId": uuid::Uuid::now_v7().to_string() });
        if let (Some(base), Value::Object(more)) = (params.as_object_mut(), extra) {
            base.extend(more);
        }
        params
    }

    /// The acked header, or `None` when the thread does not exist.
    async fn header(&self, session_id: &str) -> Result<Option<Header>, RoomError> {
        match self.state.header(&ThreadId::from(session_id)).await {
            Ok(header) => Ok(Some(header)),
            Err(PortError::NotFound { .. }) => Ok(None),
            Err(error) => Err(port(error)),
        }
    }

    async fn patch(&self, session_id: &str, set: Map<String, Value>) -> Result<(), RoomError> {
        self.patch_unset(session_id, set, vec![]).await
    }

    async fn patch_unset(&self, session_id: &str, set: Map<String, Value>, unset: Vec<String>) -> Result<(), RoomError> {
        match self.state.patch_header(&ThreadId::from(session_id), set, unset).await {
            Ok(()) | Err(PortError::NotFound { .. }) => Ok(()),
            Err(error) => Err(port(error)),
        }
    }

    /// Whether the header holds the positive stamp `key`.
    async fn stamped(&self, session_id: &str, key: &str) -> Result<bool, RoomError> {
        Ok(self.header(session_id).await?.and_then(|h| h.get(key).and_then(Value::as_f64)).is_some_and(|at| at > 0.0))
    }

    /// The desktop's sidebar marks are the header's own positive stamps (`archivedAt`, `retiredAt`), which the thread rows read
    /// (`summary.rs` `catalog_row`). As `DesktopSessionMetadata.setArchived`/`setRetired` (`desktop-session-metadata.ts:133-171`):
    /// a mark already in the asked state is left as it is, a new one is stamped now on the runtime's clock, a cleared one is removed.
    /// An archive stamp never repeats (`Math.max(Date.now(), lastArchiveStamp + 1)`); a retirement is `Date.now()` as it is.
    async fn mark(&self, session_id: &str, key: &str, on: bool) -> Result<(), RoomError> {
        if self.stamped(session_id, key).await? == on {
            return Ok(());
        }
        if on {
            let now = self.directory.deps().clock.now_ms();
            let stamp = if key == "archivedAt" { self.stamps.take(now) } else { now };
            self.patch(session_id, Map::from_iter([(key.to_owned(), json!(stamp))])).await
        } else {
            self.patch_unset(session_id, Map::new(), vec![key.to_owned()]).await
        }
    }
}

#[async_trait]
impl SessionOps for DirectorySessions {
    async fn route(&self, session_id: &str) -> Result<Option<Value>, RoomError> {
        Ok(self.header(session_id).await?.map(|header| {
            let field = |key: &str| header.get(key).cloned().unwrap_or(Value::Null);
            json!({ "provider": field("provider"), "model": field("model"), "effort": field("effort") })
        }))
    }

    async fn create(&self, session_id: &str, params: &Value) -> Result<(), RoomError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut header = Header::new();
        header.insert("createdAt".into(), json!(now));
        header.insert("updatedAt".into(), json!(now));
        if let Some(fields) = params.as_object() {
            header.extend(fields.clone());
        }
        self.directory
            .create_with_id(ThreadId::from(session_id), header, params.clone())
            .await
            .map_err(port)
    }

    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), RoomError> {
        let set = ["provider", "model", "effort"]
            .iter()
            .filter_map(|key| route.get(*key).filter(|v| !v.is_null()).map(|v| ((*key).to_owned(), v.clone())))
            .collect();
        self.patch(session_id, set).await
    }

    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError> {
        self.mark(session_id, "archivedAt", archived).await
    }

    async fn is_retired(&self, session_id: &str) -> Result<bool, RoomError> {
        self.stamped(session_id, "retiredAt").await
    }

    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), RoomError> {
        self.mark(session_id, "retiredAt", retired).await
    }

    async fn rename(&self, session_id: &str, title: &str) -> Result<(), RoomError> {
        let thread = ThreadId::from(session_id);
        let params = Self::op_params(&thread, json!({ "title": title }));
        self.request(&thread, "thread/name/set", params).await.map(|_| ()).map_err(port)
    }

    async fn set_retired_title(&self, session_id: &str, name: &str) -> Result<(), RoomError> {
        let Some(header) = self.header(session_id).await? else { return Ok(()) };
        // `this.nameMap?.[sessionId]`: a name the user gave (a locked title that no model chose) always wins.
        let user_named = header.get("titleLocked") == Some(&Value::Bool(true)) && header.get("titleSource").and_then(Value::as_str) != Some("ai");
        let title = mixdog_store::title::generated_session_title(name, "", 32);
        if user_named || title.is_empty() || header.get("title").and_then(Value::as_str) == Some(title.as_str()) {
            return Ok(());
        }
        self.patch(session_id, Map::from_iter([("title".to_owned(), json!(title))])).await
    }

    async fn clear(&self, session_id: &str, archive_as: &str) -> Result<(), RoomError> {
        let thread = ThreadId::from(session_id);
        let view = self.request(&thread, "thread/read", json!({ "threadId": thread })).await.map_err(port)?;
        let kept = view.get("items").and_then(Value::as_array).is_some_and(|items| !items.is_empty());
        // No archive id: the conversation is emptied and nothing is kept (`fork: false`).
        if kept && !archive_as.is_empty() {
            // The copy exists before anything is wiped; the mark keeps it out of the live list.
            let params = Self::op_params(&thread, json!({ "intoThreadId": archive_as }));
            self.request(&thread, "thread/fork", params).await.map_err(port)?;
            self.set_archived(archive_as, true).await?;
        }
        self.request(&thread, "thread/clear", Self::op_params(&thread, json!({}))).await.map(|_| ()).map_err(port)
    }

    async fn set_room_members(&self, session_id: &str, members: &[String]) -> Result<(), RoomError> {
        self.patch(session_id, Map::from_iter([("roomMembers".to_owned(), json!(members))])).await
    }

    async fn seed_room_members(&self, session_id: &str, members: &[String]) -> Result<(), RoomError> {
        match self.header(session_id).await? {
            Some(header) if !header.contains_key("roomMembers") => self.set_room_members(session_id, members).await,
            _ => Ok(()),
        }
    }

    async fn delete(&self, session_id: &str) -> Result<(), RoomError> {
        let thread = ThreadId::from(session_id);
        match self.request(&thread, "thread/delete", Self::op_params(&thread, json!({}))).await {
            Ok(_) => Ok(()),
            Err(error) if missing(&error) => Ok(()),
            Err(error) => Err(port(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_session::session::testing::Rig;
    use mixdog_core_session::session::thread_state::SessionThreads;

    /// Over the real session directory: a missing session reads nothing and skips marks; a
    /// created one keeps its route, archive and retirement marks and its title.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_directory_sessions_keep_route_and_marks_and_a_missing_one_is_skipped() {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let sessions = DirectorySessions::new(directory.clone(), Arc::new(SessionThreads::new(directory)));

        assert_eq!(sessions.route("nope").await.unwrap(), None);
        assert!(!sessions.is_retired("nope").await.unwrap());
        sessions.set_archived("nope", true).await.unwrap();
        sessions.delete("nope").await.unwrap();

        sessions.create("home_bench", &json!({ "provider": "openai", "model": "gpt-x" })).await.unwrap();
        assert_eq!(
            sessions.route("home_bench").await.unwrap(),
            Some(json!({ "provider": "openai", "model": "gpt-x", "effort": null }))
        );
        // A null field is never written over the stored one.
        sessions.set_route("home_bench", &json!({ "provider": "anthropic", "model": "opus", "effort": null })).await.unwrap();
        assert_eq!(
            sessions.route("home_bench").await.unwrap(),
            Some(json!({ "provider": "anthropic", "model": "opus", "effort": null }))
        );
        sessions.set_retired("home_bench", true).await.unwrap();
        assert!(sessions.is_retired("home_bench").await.unwrap());
        sessions.set_retired("home_bench", false).await.unwrap();
        assert!(!sessions.is_retired("home_bench").await.unwrap());
        sessions.rename("home_bench", "Bench").await.unwrap();
        // A name the user gave wins over the retired home's: the title stays theirs.
        sessions.set_retired_title("home_bench", "Ada the bot").await.unwrap();
        assert_eq!(sessions.header("home_bench").await.unwrap().unwrap().get("title"), Some(&json!("Bench")));
        // A session nobody named is titled with the bot's name, replacing an earlier title; a name that cleans to nothing changes nothing.
        sessions.create("home_free", &json!({ "provider": "openai", "model": "gpt-x", "title": "Old title" })).await.unwrap();
        sessions.set_retired_title("home_free", "Ada   the bot").await.unwrap();
        assert_eq!(sessions.header("home_free").await.unwrap().unwrap().get("title"), Some(&json!("Ada the bot")));
        sessions.set_retired_title("home_free", "[mixdog-runtime]").await.unwrap();
        assert_eq!(sessions.header("home_free").await.unwrap().unwrap().get("title"), Some(&json!("Ada the bot")));
        sessions.set_retired_title("nope", "Ada").await.unwrap();
        // A log without the record of its room's members is given it; one that has it keeps what its room's changes wrote.
        let members = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        sessions.seed_room_members("home_free", &members(&["lead", "bench"])).await.unwrap();
        assert_eq!(sessions.header("home_free").await.unwrap().unwrap().get("roomMembers"), Some(&json!(["lead", "bench"])));
        sessions.set_room_members("home_free", &members(&["lead"])).await.unwrap();
        sessions.seed_room_members("home_free", &members(&["lead", "bench"])).await.unwrap();
        assert_eq!(sessions.header("home_free").await.unwrap().unwrap().get("roomMembers"), Some(&json!(["lead"])));
        sessions.seed_room_members("nope", &members(&["lead"])).await.unwrap();
        sessions.set_archived("home_bench", true).await.unwrap();
        // An empty conversation keeps no archive copy and clears in place.
        sessions.clear("home_bench", "arch_1").await.unwrap();
        assert_eq!(sessions.route("arch_1").await.unwrap(), None);
    }

    /// `DesktopSessionMetadata.setArchived`'s `Math.max(Date.now(), lastArchiveStamp + 1)`: two archives at one instant of the
    /// runtime's clock take distinct, increasing stamps, and the counter is the one the host's own archive hands out from.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_archives_at_one_instant_take_distinct_increasing_stamps() {
        use mixdog_core_session::session::Clock;
        let rig = Rig::new();
        let now = rig.clock.now_ms();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let stamps: Arc<ArchiveStamps> = Arc::default();
        let sessions = DirectorySessions::new(directory.clone(), Arc::new(SessionThreads::new(directory))).with_archive_stamps(stamps.clone());
        for id in ["room_a", "room_b", "room_c"] {
            sessions.create(id, &json!({})).await.unwrap();
        }
        let stamp = |id: &'static str| {
            let sessions = &sessions;
            async move { sessions.header(id).await.unwrap().unwrap().get("archivedAt").cloned() }
        };
        sessions.set_archived("room_a", true).await.unwrap();
        sessions.set_archived("room_b", true).await.unwrap();
        assert_eq!((stamp("room_a").await, stamp("room_b").await), (Some(json!(now)), Some(json!(now + 1))));
        // The host's archive handed out a later stamp meanwhile: the rooms' next one follows it.
        assert_eq!(stamps.take(now + 5), now + 5);
        sessions.set_archived("room_c", true).await.unwrap();
        assert_eq!(stamp("room_c").await, Some(json!(now + 6)));
    }
}
