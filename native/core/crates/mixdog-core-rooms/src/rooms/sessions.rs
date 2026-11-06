//! The sessions behind agent homes and rooms: `SessionOps` over the session directory, and the
//! two seams the rooms module is written against — `HomePorts` (an agent's home thread) and
//! `RoomHost` (a room's log and member sessions) — composed from `SessionOps` plus the agent
//! catalog.
//!
//! A session's route, archive and retirement marks are header fields (`provider`, `model`,
//! `effort`, `archived`, `retired`), read and patched through `ThreadState`
//! (`thread/header/*`, which the session actor must serve).

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use super::RoomError;
use super::home::{HomePlan, HomePorts, Presence};
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use super::records::{RoomStore, Rooms};
use super::service::{KnownAgent, RoomHost, route_params};

/// The agent definitions the rooms module needs (files owned by the agent service).
#[async_trait]
pub trait AgentCatalog: Send + Sync {
    /// Every contact except Mixy.
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError>;
    /// The route Mixy follows (her own, else Main's); `Null` when neither is set.
    async fn mixy_route(&self) -> Value;
    async fn mixy_created(&self) -> bool;
    /// Per-id definition presence from the files themselves.
    async fn presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, RoomError>;
    /// The name a deleted (archived) agent left; empty when none.
    async fn archived_name(&self, agent_id: &str) -> String;
    async fn task_workspace(&self) -> String;
}

/// What the rooms module does to sessions. Operations on a session that does not exist answer
/// as the 1.4.5 host did: `route` and `is_retired` read nothing, marks are skipped.
#[async_trait]
pub trait SessionOps: Send + Sync {
    /// The stored route (`provider`, `model`, `effort`); `None` when the session does not exist.
    async fn route(&self, session_id: &str) -> Result<Option<Value>, RoomError>;
    async fn create(&self, session_id: &str, params: &Value) -> Result<(), RoomError>;
    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), RoomError>;
    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError>;
    async fn is_retired(&self, session_id: &str) -> Result<bool, RoomError>;
    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), RoomError>;
    async fn rename(&self, session_id: &str, title: &str) -> Result<(), RoomError>;
    /// Clear in place, the transcript first copied to `archive_as`; rejects while a turn runs.
    async fn clear(&self, session_id: &str, archive_as: &str) -> Result<(), RoomError>;
    async fn delete(&self, session_id: &str) -> Result<(), RoomError>;
}

fn task_session_params(mut params: Map<String, Value>, workspace: String) -> Value {
    params.insert("cwd".into(), json!(workspace));
    params.insert("desktopSession".into(), json!({ "classification": "task", "projectPath": null }));
    Value::Object(params)
}

/// [`HomePorts`] over the agent catalog, the sessions and the room records.
pub struct SessionHomePorts<S: RoomStore> {
    catalog: Arc<dyn AgentCatalog>,
    sessions: Arc<dyn SessionOps>,
    rooms: Arc<Rooms<S>>,
    room_host: Arc<dyn RoomHost>,
}

impl<S: RoomStore> SessionHomePorts<S> {
    pub fn new(
        catalog: Arc<dyn AgentCatalog>,
        sessions: Arc<dyn SessionOps>,
        rooms: Arc<Rooms<S>>,
        room_host: Arc<dyn RoomHost>,
    ) -> Self {
        Self { catalog, sessions, rooms, room_host }
    }
}

#[async_trait]
impl<S: RoomStore + 'static> HomePorts for SessionHomePorts<S> {
    async fn plan(&self, agent_id: &str) -> Result<HomePlan, RoomError> {
        if agent_id == MIXY_AGENT_ID {
            // Mixy runs on her own model, Main's once she has none.
            let route = route_params(&self.catalog.mixy_route().await);
            return Ok(HomePlan { route: Value::Object(route.clone()), params: Value::Object(route) });
        }
        let agent = self
            .catalog
            .agents()
            .await?
            .into_iter()
            .find(|a| a.id == agent_id)
            .ok_or_else(|| RoomError::Invalid(format!("Agent \"{agent_id}\" is not available.")))?;
        let route = route_params(&agent.route);
        let mut params = route.clone();
        params.insert("sessionProfile".into(), json!({ "homeAgent": agent_id }));
        Ok(HomePlan { route: Value::Object(route), params: Value::Object(params) })
    }

    async fn mixy_created(&self) -> bool {
        self.catalog.mixy_created().await
    }

    async fn session_route(&self, session_id: &str) -> Result<Option<Value>, RoomError> {
        self.sessions.route(session_id).await
    }

    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), RoomError> {
        let fields = params.as_object().cloned().unwrap_or_default();
        self.sessions.create(session_id, &task_session_params(fields, self.catalog.task_workspace().await)).await
    }

    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), RoomError> {
        self.sessions.set_route(session_id, route).await
    }

    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError> {
        self.sessions.set_archived(session_id, archived).await
    }

    async fn is_retired(&self, session_id: &str) -> Result<bool, RoomError> {
        self.sessions.is_retired(session_id).await
    }

    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), RoomError> {
        self.sessions.set_retired(session_id, retired).await
    }

    async fn name_retired(&self, session_id: &str, agent_id: &str) -> Result<(), RoomError> {
        let name = self.catalog.archived_name(agent_id).await;
        if name.is_empty() {
            return Ok(());
        }
        self.sessions.rename(session_id, &name).await
    }

    async fn agent_presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
        self.catalog.presence(agent_ids).await
    }

    /// A bot proven deleted leaves every room, saved, and its room conversations are deleted as a
    /// room's are on removal.
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), RoomError> {
        let left = self.rooms.drop_members(&[agent_id.to_owned()]).await?;
        if left.is_empty() {
            return Ok(());
        }
        self.room_host.republish_catalog();
        let sessions: Vec<String> = left.iter().filter_map(|l| l.session_id()).collect();
        let failed = self.room_host.delete_sessions(&sessions).await;
        if failed > 0 {
            return Err(RoomError::Port(format!(
                "The member left its rooms, but {failed} of its conversations could not be deleted."
            )));
        }
        Ok(())
    }

    async fn clear_session(&self, session_id: &str, archive_as: &str) -> Result<(), RoomError> {
        self.sessions.clear(session_id, archive_as).await
    }

    /// `sess_<pid>_<ms>_<uuid>`: unused by any other session.
    fn mint_archive_id(&self) -> String {
        format!(
            "sess_{}_{}_{}",
            std::process::id(),
            chrono::Utc::now().timestamp_millis(),
            uuid::Uuid::new_v4().simple()
        )
    }
}

/// [`RoomHost`] over the agent catalog and the sessions.
pub struct SessionRoomHost {
    catalog: Arc<dyn AgentCatalog>,
    sessions: Arc<dyn SessionOps>,
    republish: Arc<dyn Fn() + Send + Sync>,
}

impl SessionRoomHost {
    pub fn new(catalog: Arc<dyn AgentCatalog>, sessions: Arc<dyn SessionOps>, republish: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { catalog, sessions, republish }
    }
}

#[async_trait]
impl RoomHost for SessionRoomHost {
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
        self.catalog.agents().await
    }

    async fn mixy_route(&self) -> Value {
        self.catalog.mixy_route().await
    }

    async fn task_workspace(&self) -> String {
        self.catalog.task_workspace().await
    }

    async fn session_exists(&self, session_id: &str) -> bool {
        matches!(self.sessions.route(session_id).await, Ok(Some(_)))
    }

    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), RoomError> {
        self.sessions.create(session_id, params).await
    }

    async fn rename_session(&self, session_id: &str, title: &str) -> Result<(), RoomError> {
        self.sessions.rename(session_id, title).await
    }

    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError> {
        self.sessions.set_archived(session_id, archived).await
    }

    async fn delete_sessions(&self, session_ids: &[String]) -> usize {
        let mut failed = 0;
        for id in session_ids {
            if self.sessions.delete(id).await.is_err() {
                failed += 1;
            }
        }
        failed
    }

    fn republish_catalog(&self) {
        (self.republish)();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rooms::records::RoomDoc;

    struct Catalog;
    #[async_trait]
    impl AgentCatalog for Catalog {
        async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
            Ok(vec![KnownAgent {
                id: "bench".into(),
                route: json!([{ "provider": "openai", "model": "gpt-x", "effort": "high", "fast": true }]),
            }])
        }
        async fn mixy_route(&self) -> Value {
            json!({ "provider": "anthropic", "model": "opus" })
        }
        async fn mixy_created(&self) -> bool {
            true
        }
        async fn presence(&self, _: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
            Ok(HashMap::new())
        }
        async fn archived_name(&self, agent_id: &str) -> String {
            if agent_id == "gone" { "Gone (deleted)".into() } else { String::new() }
        }
        async fn task_workspace(&self) -> String {
            "C:\\Users\\me\\Tasks 한글".into()
        }
    }

    struct Mem(std::sync::Mutex<crate::rooms::records::RoomDoc>);
    #[async_trait]
    impl RoomStore for Mem {
        async fn load(&self) -> Result<RoomDoc, RoomError> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
            *self.0.lock().unwrap() = doc.clone();
            Ok(())
        }
    }

    struct NoHost;
    #[async_trait]
    impl RoomHost for NoHost {
        async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
            Ok(vec![])
        }
        async fn mixy_route(&self) -> Value {
            Value::Null
        }
        async fn task_workspace(&self) -> String {
            String::new()
        }
        async fn session_exists(&self, _: &str) -> bool {
            false
        }
        async fn create_session(&self, _: &str, _: &Value) -> Result<(), RoomError> {
            Ok(())
        }
        async fn rename_session(&self, _: &str, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
        async fn set_archived(&self, _: &str, _: bool) -> Result<(), RoomError> {
            Ok(())
        }
        async fn delete_sessions(&self, _: &[String]) -> usize {
            0
        }
        fn republish_catalog(&self) {}
    }

    /// Records what the home ports ask of sessions.
    #[derive(Default)]
    struct Spy(std::sync::Mutex<Vec<(String, Value)>>);
    #[async_trait]
    impl SessionOps for Spy {
        async fn route(&self, _: &str) -> Result<Option<Value>, RoomError> {
            Ok(None)
        }
        async fn create(&self, id: &str, params: &Value) -> Result<(), RoomError> {
            self.0.lock().unwrap().push((id.into(), params.clone()));
            Ok(())
        }
        async fn set_route(&self, _: &str, _: &Value) -> Result<(), RoomError> {
            Ok(())
        }
        async fn set_archived(&self, _: &str, _: bool) -> Result<(), RoomError> {
            Ok(())
        }
        async fn is_retired(&self, _: &str) -> Result<bool, RoomError> {
            Ok(false)
        }
        async fn set_retired(&self, _: &str, _: bool) -> Result<(), RoomError> {
            Ok(())
        }
        async fn rename(&self, id: &str, title: &str) -> Result<(), RoomError> {
            self.0.lock().unwrap().push((id.into(), json!(title)));
            Ok(())
        }
        async fn clear(&self, _: &str, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
        async fn delete(&self, id: &str) -> Result<(), RoomError> {
            if id == "bad" { Err(RoomError::Port("no".into())) } else { Ok(()) }
        }
    }

    fn ports(spy: Arc<Spy>) -> SessionHomePorts<Mem> {
        let rooms = Arc::new(Rooms::new(Mem(Default::default())));
        SessionHomePorts::new(Arc::new(Catalog), spy, rooms, Arc::new(NoHost))
    }

    /// A task session's create params carry the task workspace as Node's `resolveTaskProject`
    /// gives it for a task without a Project.
    #[tokio::test]
    async fn a_home_session_is_created_as_a_task_in_the_task_workspace_as_node_resolves_it() {
        let golden: Value = serde_json::from_str(include_str!("golden/task_session.json")).unwrap();
        let spy = Arc::new(Spy::default());
        let ports = ports(spy.clone());
        let plan = ports.plan("bench").await.unwrap();
        assert_eq!(
            plan.params,
            json!({ "provider": "openai", "model": "gpt-x", "effort": "high", "fast": true, "sessionProfile": { "homeAgent": "bench" } })
        );
        assert_eq!(plan.route, json!({ "provider": "openai", "model": "gpt-x", "effort": "high", "fast": true }));
        ports.create_session("home_bench", &plan.params).await.unwrap();
        let (id, sent) = spy.0.lock().unwrap()[0].clone();
        assert_eq!(id, "home_bench");
        assert_eq!(sent["cwd"], golden["cwd"]);
        assert_eq!(sent["desktopSession"], golden["desktopSession"]);
        assert_eq!(sent["sessionProfile"], json!({ "homeAgent": "bench" }));
    }

    #[tokio::test]
    async fn mixy_follows_her_route_an_unknown_agent_is_refused_and_a_retired_one_is_named() {
        let spy = Arc::new(Spy::default());
        let ports = ports(spy.clone());
        let mixy = ports.plan(MIXY_AGENT_ID).await.unwrap();
        assert_eq!(mixy.params, json!({ "provider": "anthropic", "model": "opus" }));
        assert_eq!(
            ports.plan("nobody").await.unwrap_err(),
            RoomError::Invalid("Agent \"nobody\" is not available.".into())
        );
        ports.name_retired("home_gone", "gone").await.unwrap();
        ports.name_retired("home_bench", "bench").await.unwrap();
        assert_eq!(*spy.0.lock().unwrap(), vec![("home_gone".to_owned(), json!("Gone (deleted)"))]);
    }

    #[tokio::test]
    async fn deleting_sessions_counts_the_failures() {
        let host = SessionRoomHost::new(Arc::new(Catalog), Arc::new(Spy::default()), Arc::new(|| {}));
        assert_eq!(host.delete_sessions(&["a".into(), "bad".into(), "b".into()]).await, 1);
    }
}