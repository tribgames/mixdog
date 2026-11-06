//! [`SessionOps`] over the session directory: the sessions behind agent homes and rooms.
//!
//! A session's route, archive and retirement marks are header fields (`provider`, `model`,
//! `effort`, `archived`, `retired`), read and patched through `ThreadState`
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
}

impl DirectorySessions {
    pub fn new(directory: Arc<SessionDirectory>, state: Arc<dyn ThreadState>) -> Self {
        Self { directory, state }
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
        match self.state.patch_header(&ThreadId::from(session_id), set, vec![]).await {
            Ok(()) | Err(PortError::NotFound { .. }) => Ok(()),
            Err(error) => Err(port(error)),
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
        self.patch(session_id, Map::from_iter([("archived".to_owned(), json!(archived))])).await
    }

    async fn is_retired(&self, session_id: &str) -> Result<bool, RoomError> {
        Ok(self.header(session_id).await?.and_then(|h| h.get("retired").and_then(Value::as_bool)).unwrap_or(false))
    }

    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), RoomError> {
        self.patch(session_id, Map::from_iter([("retired".to_owned(), json!(retired))])).await
    }

    async fn rename(&self, session_id: &str, title: &str) -> Result<(), RoomError> {
        let thread = ThreadId::from(session_id);
        let params = Self::op_params(&thread, json!({ "title": title }));
        self.request(&thread, "thread/name/set", params).await.map(|_| ()).map_err(port)
    }

    async fn clear(&self, session_id: &str, archive_as: &str) -> Result<(), RoomError> {
        let thread = ThreadId::from(session_id);
        let view = self.request(&thread, "thread/read", json!({ "threadId": thread })).await.map_err(port)?;
        let kept = view.get("items").and_then(Value::as_array).is_some_and(|items| !items.is_empty());
        if kept {
            // The copy exists before anything is wiped; the mark keeps it out of the live list.
            let params = Self::op_params(&thread, json!({ "intoThreadId": archive_as }));
            self.request(&thread, "thread/fork", params).await.map_err(port)?;
            self.set_archived(archive_as, true).await?;
        }
        self.request(&thread, "thread/clear", Self::op_params(&thread, json!({}))).await.map(|_| ()).map_err(port)
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
        sessions.set_archived("home_bench", true).await.unwrap();
        // An empty conversation keeps no archive copy and clears in place.
        sessions.clear("home_bench", "arch_1").await.unwrap();
        assert_eq!(sessions.route("arch_1").await.unwrap(), None);
    }
}
