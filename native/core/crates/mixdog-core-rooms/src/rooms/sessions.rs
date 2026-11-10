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
use super::records::{Left, RoomStore, Rooms};
use super::service::{KnownAgent, ListingEnd, RoomHost, RoomRunner, join, route_params};
use mixdog_rt::CancellationToken;

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
    /// A deleted bot's archived home titled with the bot's name at that deletion (`rememberRetiredTitle`),
    /// replacing an earlier title; a name the user gave to the session still wins.
    async fn set_retired_title(&self, session_id: &str, name: &str) -> Result<(), RoomError>;
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
    /// What is owed to a member who left a room ends with it (`cancelOwedTo`).
    runner: Arc<dyn RoomRunner>,
}

impl<S: RoomStore> SessionHomePorts<S> {
    pub fn new(
        catalog: Arc<dyn AgentCatalog>,
        sessions: Arc<dyn SessionOps>,
        rooms: Arc<Rooms<S>>,
        room_host: Arc<dyn RoomHost>,
        runner: Arc<dyn RoomRunner>,
    ) -> Self {
        Self { catalog, sessions, rooms, room_host, runner }
    }

    /// Node's `pruneDeleted` (`agent-room-membership.ts:64-76`), which the rooms' first load runs (`agent-rooms.ts:353-361`
    /// `ready`, reached at start-up by `recover`, `:465-469`, whenever rooms exist): members whose definition is proven deleted
    /// leave every room, saved; the catalog is republished and their room conversations are deleted. How many of those could
    /// not be (Node logs it; the load does not fail on it).
    pub async fn prune_deleted(&self) -> Result<usize, RoomError> {
        let mut ids: Vec<String> = Vec::new();
        for room in self.rooms.list().await? {
            for id in room.config.members {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        if !ids.iter().any(|id| id != MIXY_AGENT_ID) {
            return Ok(0);
        }
        // An unknown or failed check proves nothing (`.catch(() => null)`).
        let Ok(presence) = self.catalog.presence(&ids).await else { return Ok(0) };
        let deleted: Vec<String> = ids.into_iter().filter(|id| presence.get(id) == Some(&Presence::Deleted)).collect();
        let left = self.rooms.drop_members(&deleted).await?;
        if left.is_empty() {
            return Ok(0);
        }
        self.leave(&left).await
    }

    /// Members that left their rooms (`dropMembers`, saved): what was owed to them ends, the catalog is republished and their room
    /// conversations are deleted; how many could not be. No client waits on it (`forgetMember`, `agent-rooms.ts:345-346`;
    /// `pruneDeleted`, `agent-room-membership.ts:72-74`): the deletions follow the start at once, and the first joins the listing
    /// in flight (`session-host-lifecycle.ts:527`, `session-host.ts:790`).
    async fn leave(&self, left: &[Left]) -> Result<usize, RoomError> {
        // `removeFromRoom` of `dropMembers`: the calls owed to the member end, room by room.
        for gone in left {
            self.runner.cancel_owed_to(&gone.room_id, std::slice::from_ref(&gone.agent_id));
        }
        let publish = CancellationToken::new();
        let listing = self.room_host.republish_catalog(&publish).await?;
        let sessions: Vec<String> = left.iter().filter_map(|l| l.session_id()).collect();
        join(&publish, listing).await;
        Ok(self.room_host.delete_sessions(&sessions).await)
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
        self.sessions.set_retired_title(session_id, &name).await
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
        let failed = self.leave(&left).await?;
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
    republish: Republish,
}

/// A catalog publish that ends when the catalog is published, or says why it was not; or, before the catalog is loaded, starts
/// the background listing, whose rows go out once the given token is cancelled, and answers its end.
pub type Republish =
    Arc<dyn Fn(CancellationToken) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<ListingEnd>, RoomError>> + Send>> + Send + Sync>;

impl SessionRoomHost {
    pub fn new(catalog: Arc<dyn AgentCatalog>, sessions: Arc<dyn SessionOps>, republish: Republish) -> Self {
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

    async fn republish_catalog(&self, publish: &CancellationToken) -> Result<Option<ListingEnd>, RoomError> {
        (self.republish)(publish.clone()).await
    }

    /// As an agent home's reset: the archive mark is written before the copy exists, so the copy never lists as a live chat.
    async fn start_over(&self, session_id: &str) -> Result<Option<String>, RoomError> {
        let archive_id = format!("sess_{}_{}_{}", std::process::id(), chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().simple());
        self.sessions.set_archived(&archive_id, true).await?;
        if let Err(error) = self.sessions.clear(session_id, &archive_id).await {
            let _ = self.sessions.set_archived(&archive_id, false).await;
            return Err(error);
        }
        if self.sessions.route(&archive_id).await?.is_some() {
            return Ok(Some(archive_id));
        }
        self.sessions.set_archived(&archive_id, false).await?;
        Ok(None)
    }

    async fn reset_member(&self, session_id: &str) -> Result<(), RoomError> {
        self.sessions.clear(session_id, "").await
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
        async fn republish_catalog(&self, _: &CancellationToken) -> Result<Option<ListingEnd>, RoomError> {
            Ok(None)
        }
        async fn start_over(&self, _: &str) -> Result<Option<String>, RoomError> {
            Ok(None)
        }
        async fn reset_member(&self, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
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
        async fn set_retired_title(&self, id: &str, name: &str) -> Result<(), RoomError> {
            self.0.lock().unwrap().push((id.into(), json!(name)));
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

    /// A runner that runs nothing and records who it was told left which room.
    #[derive(Default)]
    struct NoRun(std::sync::Mutex<Vec<(String, Vec<String>)>>);
    #[async_trait]
    impl RoomRunner for NoRun {
        fn is_running(&self, _: &str) -> bool {
            false
        }
        fn stop(&self, _: &str) {}
        async fn start(&self, _: &str, _: Vec<String>) -> Result<(), RoomError> {
            Ok(())
        }
        fn cancel_owed_to(&self, room_id: &str, gone: &[String]) {
            self.0.lock().unwrap().push((room_id.to_owned(), gone.to_vec()));
        }
    }

    fn ports(spy: Arc<Spy>) -> SessionHomePorts<Mem> {
        let rooms = Arc::new(Rooms::new(Mem(Default::default())));
        SessionHomePorts::new(Arc::new(Catalog), spy, rooms, Arc::new(NoHost), Arc::new(NoRun::default()))
    }

    /// A deleted bot leaves every room it was in, and what was owed to it ends in each.
    #[tokio::test]
    async fn a_member_forgotten_everywhere_has_what_is_owed_to_it_cancelled_room_by_room() {
        use crate::rooms::config::RoomConfigInput;
        let rooms = Arc::new(Rooms::new(Mem(Default::default())));
        let input = |members: &[&str]| RoomConfigInput { name: "Plan".into(), members: members.iter().map(|m| (*m).into()).collect(), ..Default::default() };
        rooms.create(&input(&["gh", "ops"]), "room01", 1).await.unwrap();
        rooms.create(&input(&["ops", "bench"]), "room02", 2).await.unwrap();
        rooms.create(&input(&["gh", "bench"]), "room03", 3).await.unwrap();
        let runner = Arc::new(NoRun::default());
        let ports = SessionHomePorts::new(Arc::new(Catalog), Arc::new(Spy::default()), rooms.clone(), Arc::new(NoHost), runner.clone());
        ports.forget_room_member("gh").await.unwrap();
        assert_eq!(
            *runner.0.lock().unwrap(),
            [("room01".to_owned(), vec!["gh".to_owned()]), ("room03".to_owned(), vec!["gh".to_owned()])]
        );
        ports.forget_room_member("gh").await.unwrap();
        assert_eq!(runner.0.lock().unwrap().len(), 2, "a member in no room cancels nothing");
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

    /// Records the clears a room reset asks for: the log's keeps a copy under a fresh archived id, a member's keeps none.
    #[derive(Default)]
    struct Clears(std::sync::Mutex<Vec<(String, String)>>, std::sync::Mutex<Vec<(String, bool)>>);
    #[async_trait]
    impl SessionOps for Clears {
        async fn route(&self, id: &str) -> Result<Option<Value>, RoomError> {
            let copied = self.0.lock().unwrap().iter().any(|(_, archive)| archive == id);
            Ok(copied.then(|| json!({})))
        }
        async fn create(&self, _: &str, _: &Value) -> Result<(), RoomError> {
            Ok(())
        }
        async fn set_route(&self, _: &str, _: &Value) -> Result<(), RoomError> {
            Ok(())
        }
        async fn set_archived(&self, id: &str, archived: bool) -> Result<(), RoomError> {
            self.1.lock().unwrap().push((id.into(), archived));
            Ok(())
        }
        async fn is_retired(&self, _: &str) -> Result<bool, RoomError> {
            Ok(false)
        }
        async fn set_retired(&self, _: &str, _: bool) -> Result<(), RoomError> {
            Ok(())
        }
        async fn set_retired_title(&self, _: &str, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
        async fn rename(&self, _: &str, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
        async fn clear(&self, id: &str, archive_as: &str) -> Result<(), RoomError> {
            self.0.lock().unwrap().push((id.into(), archive_as.into()));
            Ok(())
        }
        async fn delete(&self, _: &str) -> Result<(), RoomError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_room_reset_archives_the_log_and_empties_a_member_keeping_nothing() {
        let clears = Arc::new(Clears::default());
        let host = SessionRoomHost::new(Arc::new(Catalog), clears.clone(), Arc::new(|_| Box::pin(async { Ok(None) })));
        let archived = host.start_over("room_log").await.unwrap().expect("the log had a conversation to keep");
        assert!(archived.starts_with("sess_"));
        assert_eq!(clears.0.lock().unwrap()[0], ("room_log".to_owned(), archived.clone()));
        assert_eq!(clears.1.lock().unwrap()[0], (archived, true), "the copy is marked archived before it exists");
        host.reset_member("member").await.unwrap();
        assert_eq!(clears.0.lock().unwrap()[1], ("member".to_owned(), String::new()));
    }

    #[tokio::test]
    async fn deleting_sessions_counts_the_failures() {
        let host = SessionRoomHost::new(Arc::new(Catalog), Arc::new(Spy::default()), Arc::new(|_| Box::pin(async { Ok(None) })));
        assert_eq!(host.delete_sessions(&["a".into(), "bad".into(), "b".into()]).await, 1);
    }
}