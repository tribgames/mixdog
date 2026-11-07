//! The production [`HomeDeps`] of the agent home (`agent/home/open`, `agent/home/reset`): the
//! agent catalog for who may have a home and on which route, the session directory for the home
//! threads themselves, and the reset that keeps the old conversation.
//!
//! A reset (`resetSessionConversation` with `archiveAs`) copies the conversation to the fresh
//! archive id with `thread/fork` — durable before anything is wiped — marks the copy archived (it
//! restores with `set_archived(.., false)`, keeping its whole history), and only then clears the
//! home thread in place with `thread/clear`. A conversation without a user turn keeps no copy; a
//! thread running a turn is refused.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::DepError;
use mixdog_core_agents::agents::HomeDeps;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::home::HomePorts;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_core_rooms::rooms::sessions::AgentCatalog;
use mixdog_core_rooms::rooms::sessions::SessionOps;
use mixdog_core_session::session::SessionDirectory;
use mixdog_services::memory::session_search::ingest::StoredSessions;
use serde_json::Value;
use serde_json::json;

const NOT_AVAILABLE_CODE: &str = "SESSION_NOT_AVAILABLE";
const RUNNING: &str = "The agent is running a turn; wait for it to finish before resetting the conversation.";
const NOT_RESET: &str = "The conversation could not be reset; try again in a moment.";

fn room(error: RoomError) -> DepError {
    DepError::new(error.to_string())
}

fn core(error: &CoreError) -> DepError {
    match error {
        CoreError::DomainError { message: Some(message), .. } => DepError::new(message.to_string()),
        other => DepError::new(format!("{other:?}")),
    }
}

/// What a deleted agent's home leaves behind in the rooms: its membership (`forgetRoomMember`).
#[async_trait]
pub trait RoomMembers: Send + Sync {
    /// A bot proven deleted leaves every room, saved, and its room conversations are deleted as a room's are on removal.
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), RoomError>;
}

#[async_trait]
impl<P: HomePorts> RoomMembers for P {
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), RoomError> {
        HomePorts::forget_room_member(self, agent_id).await
    }
}

/// [`HomeDeps`] over the agent catalog, the sessions' marks, the session directory, the stored sessions and the rooms.
pub struct SessionHomeDeps {
    catalog: Arc<dyn AgentCatalog>,
    sessions: Arc<dyn SessionOps>,
    directory: Arc<SessionDirectory>,
    stored: Arc<dyn StoredSessions>,
    rooms: Arc<dyn RoomMembers>,
}

impl SessionHomeDeps {
    pub fn new(catalog: Arc<dyn AgentCatalog>, sessions: Arc<dyn SessionOps>, directory: Arc<SessionDirectory>, stored: Arc<dyn StoredSessions>, rooms: Arc<dyn RoomMembers>) -> Self {
        Self { catalog, sessions, directory, stored, rooms }
    }

    async fn request(&self, thread: &ThreadId, method: &'static str, extra: Value) -> Result<Value, CoreError> {
        let ctx = CallContext::internal("agents");
        let handle = self.directory.open_handle(thread, &ctx).await?;
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        let mut params = json!({ "threadId": thread, "opId": op.as_str() });
        if let (Some(base), Value::Object(more)) = (params.as_object_mut(), extra) {
            base.extend(more);
        }
        match handle.request(CoreRequest { method: Method(method), params, op: Some(op), ctx }).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Ok(Value::Null),
        }
    }

    /// Whether the thread's newest turn is still running: the turn list shows the active turn as
    /// in progress as soon as its first row is durable.
    async fn turn_in_progress(&self, thread: &ThreadId) -> Result<bool, DepError> {
        let params = json!({ "threadId": thread, "limit": 1 });
        let request = CoreRequest { method: Method("thread/turns/list"), params, op: None, ctx: CallContext::internal("agents") };
        match ThreadDirectory::request(&*self.directory, request).await.map_err(|error| core(&error))? {
            Reply::Value(page) => Ok(page["data"].as_array().is_some_and(|turns| turns.iter().any(|turn| turn["status"] == "inProgress"))),
            Reply::Subscribe(_) => Ok(false),
        }
    }}

#[async_trait]
impl HomeDeps for SessionHomeDeps {
    /// The contacts, as the catalog rows `contactAgentRows` keeps.
    async fn list_agents(&self) -> Result<Value, DepError> {
        let agents = self.catalog.agents().await.map_err(room)?;
        Ok(Value::Array(
            agents.into_iter().map(|agent| json!({ "id": agent.id, "custom": true, "kind": "bot", "disabled": false, "route": agent.route })).collect(),
        ))
    }

    async fn mixy_route(&self) -> Result<Value, DepError> {
        Ok(self.catalog.mixy_route().await)
    }

    async fn mixy_created(&self) -> Result<bool, DepError> {
        Ok(self.catalog.mixy_created().await)
    }

    async fn read_session(&self, session_id: &str) -> Result<Value, DepError> {
        match self.sessions.route(session_id).await.map_err(room)? {
            Some(route) => Ok(route),
            None => Err(DepError { message: format!("Session {session_id} is not available"), code: Some(NOT_AVAILABLE_CODE.into()) }),
        }
    }

    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), DepError> {
        self.sessions.create(session_id, params).await.map_err(room)
    }

    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), DepError> {
        self.sessions.set_route(session_id, route).await.map_err(room)
    }

    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), DepError> {
        self.sessions.set_archived(session_id, archived).await.map_err(room)
    }

    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), DepError> {
        self.sessions.set_retired(session_id, retired).await.map_err(room)
    }

    async fn task_workspace(&self) -> Result<String, DepError> {
        Ok(self.catalog.task_workspace().await)
    }

    async fn clear_session(&self, session_id: &str, archive_as: &str) -> Result<(), DepError> {
        let thread = ThreadId::from(session_id);
        let view = match self.request(&thread, "thread/read", json!({})).await {
            Ok(view) => view,
            Err(CoreError::ThreadNotFound { .. }) => return Err(DepError::new(NOT_RESET)),
            Err(error) => return Err(core(&error)),
        };
        let runtime = &view["state"]["runtime"];
        if runtime["busy"] == json!(true) || runtime["commandBusy"] == json!(true) || self.turn_in_progress(&thread).await? {
            return Err(DepError::new(RUNNING));
        }
        // `hasUserConversationMessage`: only a conversation the user took part in is worth a copy.
        let spoken = view["hasOlder"] == json!(true) || view["items"].as_array().is_some_and(|items| items.iter().any(|item| item["type"] == "userMessage"));
        if spoken {
            // The copy is whole on disk before the wipe; the mark keeps it out of the live list.
            self.request(&thread, "thread/fork", json!({ "intoThreadId": archive_as })).await.map_err(|error| core(&error))?;
            self.sessions.set_archived(archive_as, true).await.map_err(room)?;
        }
        self.request(&thread, "thread/clear", json!({})).await.map(|_| ()).map_err(|error| core(&error))
    }

    /// `sess_<pid>_<ms>_<uuid>`: unused by any other session.
    fn mint_archive_id(&self) -> String {
        format!("sess_{}_{}_{}", std::process::id(), chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().simple())
    }

    async fn is_retired(&self, session_id: &str) -> Result<bool, DepError> {
        self.sessions.is_retired(session_id).await.map_err(room)
    }

    async fn name_retired(&self, session_id: &str, name: &str) -> Result<(), DepError> {
        self.sessions.rename(session_id, name).await.map_err(room)
    }

    async fn archived_agent_name(&self, agent_id: &str) -> Result<String, DepError> {
        Ok(self.catalog.archived_name(agent_id).await)
    }

    async fn known_session_ids(&self) -> Result<Vec<String>, DepError> {
        self.stored.session_ids().await.map_err(|error| DepError::new(error.to_string()))
    }

    async fn agent_presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, DepError> {
        self.catalog.presence(agent_ids).await.map_err(room)
    }

    async fn forget_room_member(&self, agent_id: &str) -> Result<(), DepError> {
        self.rooms.forget_room_member(agent_id).await.map_err(room)
    }
}

#[cfg(test)]
#[path = "agent_home_deps_tests.rs"]
mod tests;
