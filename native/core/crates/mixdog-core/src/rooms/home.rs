//! Agent home threads: each agent contact owns ONE persistent user session whose id is the fixed
//! key of its agent id (`ids::agent_home_session_id`). Every surface resolves it through the same
//! method; it is created on first open and archived when its agent is gone. Open, reset, retire
//! and restore of one agent are serialized (`KeyedSerial`); different agents never wait.

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::Value;

use super::RoomError;
use super::ids::{MIXY_AGENT_ID, agent_home_session_id, agent_id_of_home_session};
use super::serial::KeyedSerial;

/// What an agent's home thread is created and routed with.
#[derive(Clone, Debug, PartialEq)]
pub struct HomePlan {
    /// The model route fields of the definition (`provider`, `model`, optional `effort`).
    pub route: Value,
    /// The full create params (route plus profile).
    pub params: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    Present,
    /// The definition is proven gone from the files; an unknown or failed check proves nothing.
    Deleted,
    Unknown,
}

#[async_trait]
pub trait HomePorts: Send + Sync {
    /// The route and create params for `agent_id`; `Invalid` when the agent is not available.
    async fn plan(&self, agent_id: &str) -> Result<HomePlan, RoomError>;
    /// Whether the representative bot exists: its thread is never created before it does.
    async fn mixy_created(&self) -> bool;
    /// The stored route of the session, `None` when it does not exist.
    async fn session_route(&self, session_id: &str) -> Result<Option<Value>, RoomError>;
    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), RoomError>;
    /// Select `route` for this thread alone from its next turn.
    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), RoomError>;
    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError>;
    async fn is_retired(&self, session_id: &str) -> Result<bool, RoomError>;
    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), RoomError>;
    /// Title a retired home with its bot's last known name.
    async fn name_retired(&self, session_id: &str, agent_id: &str) -> Result<(), RoomError>;
    async fn agent_presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, RoomError>;
    /// An agent proven deleted leaves every room's members.
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), RoomError>;
    /// Clear `session_id` in place, its transcript first copied durably to `archive_as`; rejects
    /// while the session runs a turn.
    async fn clear_session(&self, session_id: &str, archive_as: &str) -> Result<(), RoomError>;
    fn mint_archive_id(&self) -> String;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reset {
    pub session_id: String,
    pub archived_session_id: Option<String>,
}

/// The definition's route when the thread runs on another one; `None` when they agree. Effort
/// counts only when the definition names one.
fn route_change(definition: &Value, current: &Value) -> bool {
    let field = |value: &'_ Value, key: &str| value.get(key).filter(|v| !v.is_null()).cloned();
    if field(definition, "provider").is_none() {
        return false;
    }
    field(definition, "provider") != field(current, "provider")
        || field(definition, "model") != field(current, "model")
        || (field(definition, "effort").is_some() && field(definition, "effort") != field(current, "effort"))
}

pub struct AgentHomes<P: HomePorts> {
    ports: P,
    serial: KeyedSerial,
}

impl<P: HomePorts> AgentHomes<P> {
    pub fn new(ports: P) -> Self {
        Self { ports, serial: KeyedSerial::new() }
    }

    fn session_id_of(agent_id: &str) -> Result<String, RoomError> {
        agent_home_session_id(agent_id).ok_or_else(|| RoomError::Invalid("agent id is invalid.".into()))
    }

    async fn resolve(&self, agent_id: &str) -> Result<String, RoomError> {
        let session_id = Self::session_id_of(agent_id)?;
        let plan = self.ports.plan(agent_id).await?;
        // A bot made again under a deleted one's id owns its thread again.
        if agent_id != MIXY_AGENT_ID {
            self.ports.set_retired(&session_id, false).await?;
        }
        // Reopening a contact brings its thread back from the archive.
        self.ports.set_archived(&session_id, false).await?;
        if let Some(current) = self.ports.session_route(&session_id).await? {
            // An existing thread follows its definition's current model and effort from its next
            // turn. A route the runtime refuses (provider signed out) never blocks opening.
            if route_change(&plan.route, &current) {
                let _ = self.ports.set_route(&session_id, &plan.route).await;
            }
            return Ok(session_id);
        }
        // A Mixy the user never created gets no chat, whichever surface asks.
        if agent_id == MIXY_AGENT_ID && !self.ports.mixy_created().await {
            return Err(RoomError::Invalid("Create the representative bot first.".into()));
        }
        self.ports.create_session(&session_id, &plan.params).await?;
        Ok(session_id)
    }

    /// `agent/home/open`.
    pub async fn open(&self, agent_id: &str) -> Result<String, RoomError> {
        let _turn = self.serial.lock(agent_id).await;
        self.resolve(agent_id).await
    }

    /// `agent/home/reset`: the agent keeps its one fixed home id; the conversation so far moves to
    /// a new archived id. The archive mark is written before the copy exists, so the copy never
    /// lists as a live chat; the clear wipes nothing until the copy is on disk.
    pub async fn reset(&self, agent_id: &str) -> Result<Reset, RoomError> {
        let _turn = self.serial.lock(agent_id).await;
        let session_id = self.resolve(agent_id).await?;
        let archive_id = self.ports.mint_archive_id();
        self.ports.set_archived(&archive_id, true).await?;
        if let Err(error) = self.ports.clear_session(&session_id, &archive_id).await {
            let _ = self.ports.set_archived(&archive_id, false).await;
            return Err(error);
        }
        if self.ports.session_route(&archive_id).await?.is_some() {
            return Ok(Reset { session_id, archived_session_id: Some(archive_id) });
        }
        // It had no user turn, so nothing was kept.
        self.ports.set_archived(&archive_id, false).await?;
        Ok(Reset { session_id, archived_session_id: None })
    }

    /// Archive the home thread of each agent whose definition is proven deleted. Absence from a
    /// list read never counts: only a per-id `Deleted` answer does. With `on_transition` only a
    /// home not yet retired for this deletion is archived, so an archived one is never rewritten
    /// and a hand-restored one stays restored.
    async fn archive_deleted(&self, agent_ids: &[String], on_transition: bool) -> Result<(), RoomError> {
        let mut ids: Vec<String> = Vec::new();
        for id in agent_ids {
            if id != MIXY_AGENT_ID && agent_home_session_id(id).is_some() && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        if ids.is_empty() {
            return Ok(());
        }
        let presence = self.ports.agent_presence(&ids).await?;
        for id in &ids {
            let session_id = Self::session_id_of(id)?;
            let _turn = self.serial.lock(id).await;
            match presence.get(id).copied().unwrap_or(Presence::Unknown) {
                Presence::Present => {
                    if on_transition {
                        self.ports.set_retired(&session_id, false).await?;
                    }
                }
                Presence::Unknown => {}
                Presence::Deleted => {
                    if !(on_transition && self.ports.is_retired(&session_id).await?) {
                        let _ = self.ports.name_retired(&session_id, id).await;
                        self.ports.set_archived(&session_id, true).await?;
                        self.ports.set_retired(&session_id, true).await?;
                    }
                    // Its membership goes with it: the one place a deletion is proven here.
                    self.ports.forget_room_member(id).await?;
                }
            }
        }
        Ok(())
    }

    /// An explicit delete event: always archives the deleted agent's home.
    pub async fn retire(&self, agent_ids: &[String]) -> Result<(), RoomError> {
        self.archive_deleted(agent_ids, false).await
    }

    /// Deletions that did not pass through here: every known home thread's agent is checked, and
    /// only a newly observed deletion archives.
    pub async fn reconcile(&self, known_session_ids: &[String]) -> Result<(), RoomError> {
        let ids: Vec<String> = known_session_ids.iter().filter_map(|id| agent_id_of_home_session(id)).collect();
        self.archive_deleted(&ids, true).await
    }

    /// A restored bot: its home is no longer a deleted bot's chat.
    pub async fn restore(&self, agent_id: &str) -> Result<(), RoomError> {
        let Some(session_id) = agent_home_session_id(agent_id) else {
            return Ok(());
        };
        if agent_id == MIXY_AGENT_ID {
            return Ok(());
        }
        let _turn = self.serial.lock(agent_id).await;
        self.ports.set_retired(&session_id, false).await?;
        self.ports.set_archived(&session_id, false).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct World {
        sessions: HashMap<String, Value>,
        archived: HashSet<String>,
        retired: HashSet<String>,
        forgotten: Vec<String>,
        calls: Vec<String>,
        presence: HashMap<String, Presence>,
        mixy_created: bool,
        next_archive: u32,
        clear_fails: bool,
        route_set: Vec<Value>,
    }

    #[derive(Default)]
    struct Fake(Mutex<World>);

    #[async_trait]
    impl HomePorts for Fake {
        async fn plan(&self, agent_id: &str) -> Result<HomePlan, RoomError> {
            if agent_id == "ghost" {
                return Err(RoomError::Invalid("Agent \"ghost\" is not available.".into()));
            }
            let route = json!({"provider": "p", "model": "m2"});
            Ok(HomePlan { route: route.clone(), params: json!({"provider": "p", "model": "m2", "agent": agent_id}) })
        }
        async fn mixy_created(&self) -> bool {
            self.0.lock().unwrap().mixy_created
        }
        async fn session_route(&self, id: &str) -> Result<Option<Value>, RoomError> {
            Ok(self.0.lock().unwrap().sessions.get(id).cloned())
        }
        async fn create_session(&self, id: &str, params: &Value) -> Result<(), RoomError> {
            let mut w = self.0.lock().unwrap();
            w.calls.push(format!("create {id}"));
            w.sessions.insert(id.into(), params.clone());
            Ok(())
        }
        async fn set_route(&self, _id: &str, route: &Value) -> Result<(), RoomError> {
            self.0.lock().unwrap().route_set.push(route.clone());
            Ok(())
        }
        async fn set_archived(&self, id: &str, archived: bool) -> Result<(), RoomError> {
            let mut w = self.0.lock().unwrap();
            if archived { w.archived.insert(id.into()) } else { w.archived.remove(id) };
            Ok(())
        }
        async fn is_retired(&self, id: &str) -> Result<bool, RoomError> {
            Ok(self.0.lock().unwrap().retired.contains(id))
        }
        async fn set_retired(&self, id: &str, retired: bool) -> Result<(), RoomError> {
            let mut w = self.0.lock().unwrap();
            if retired { w.retired.insert(id.into()) } else { w.retired.remove(id) };
            Ok(())
        }
        async fn name_retired(&self, _id: &str, _agent: &str) -> Result<(), RoomError> {
            Ok(())
        }
        async fn agent_presence(&self, ids: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
            let w = self.0.lock().unwrap();
            Ok(ids.iter().filter_map(|id| w.presence.get(id).map(|p| (id.clone(), *p))).collect())
        }
        async fn forget_room_member(&self, agent_id: &str) -> Result<(), RoomError> {
            self.0.lock().unwrap().forgotten.push(agent_id.into());
            Ok(())
        }
        async fn clear_session(&self, id: &str, archive_as: &str) -> Result<(), RoomError> {
            let mut w = self.0.lock().unwrap();
            if w.clear_fails {
                return Err(RoomError::Port("running".into()));
            }
            // A conversation with a user turn is copied; the home itself stays.
            if w.sessions.get(id).is_some_and(|s| s.get("turns").is_some()) {
                let copy = w.sessions[id].clone();
                w.sessions.insert(archive_as.into(), copy);
            }
            Ok(())
        }
        fn mint_archive_id(&self) -> String {
            let mut w = self.0.lock().unwrap();
            w.next_archive += 1;
            format!("sess_archive_{}", w.next_archive)
        }
    }

    fn homes() -> AgentHomes<Fake> {
        AgentHomes::new(Fake::default())
    }
    fn world(homes: &AgentHomes<Fake>) -> std::sync::MutexGuard<'_, World> {
        homes.ports.0.lock().unwrap()
    }

    #[tokio::test]
    async fn home_identity_is_stable_across_reset_and_archive() {
        let homes = homes();
        let id = homes.open("gh").await.unwrap();
        assert_eq!(id, "sess_home_gh");
        assert_eq!(homes.open("gh").await.unwrap(), id);
        assert_eq!(world(&homes).calls, ["create sess_home_gh"], "created once");
        world(&homes).sessions.get_mut(&id).unwrap()["turns"] = json!(1);
        let reset = homes.reset("gh").await.unwrap();
        assert_eq!(reset.session_id, id);
        let archived = reset.archived_session_id.expect("a conversation with a user turn is kept");
        assert!(world(&homes).archived.contains(&archived));
        // Deleted → archived under the same id → reopened: still the same id.
        world(&homes).presence.insert("gh".into(), Presence::Deleted);
        homes.retire(&["gh".into()]).await.unwrap();
        assert!(world(&homes).archived.contains(&id));
        assert_eq!(world(&homes).forgotten, ["gh"]);
        assert_eq!(homes.open("gh").await.unwrap(), id);
        assert!(!world(&homes).archived.contains(&id));
        assert!(!world(&homes).retired.contains(&id));
    }

    #[tokio::test]
    async fn an_empty_conversation_keeps_no_archive_and_a_failed_clear_unmarks_it() {
        let homes = homes();
        homes.open("gh").await.unwrap();
        let reset = homes.reset("gh").await.unwrap();
        assert_eq!(reset.archived_session_id, None);
        assert!(world(&homes).archived.is_empty());
        world(&homes).clear_fails = true;
        assert!(homes.reset("gh").await.is_err());
        assert!(world(&homes).archived.is_empty());
    }

    #[tokio::test]
    async fn mixy_is_not_created_before_the_bot_exists_and_unknown_agents_are_refused() {
        let homes = homes();
        assert!(homes.open("lead").await.is_err());
        world(&homes).mixy_created = true;
        assert_eq!(homes.open("lead").await.unwrap(), "sess_home_lead");
        assert!(homes.open("ghost").await.is_err());
        assert!(homes.open("Bad Id").await.is_err());
    }

    #[tokio::test]
    async fn an_existing_thread_follows_its_definitions_route() {
        let homes = homes();
        world(&homes).sessions.insert("sess_home_gh".into(), json!({"provider": "p", "model": "m1"}));
        homes.open("gh").await.unwrap();
        assert_eq!(world(&homes).route_set, [json!({"provider": "p", "model": "m2"})]);
        world(&homes).sessions.insert("sess_home_gh".into(), json!({"provider": "p", "model": "m2"}));
        homes.open("gh").await.unwrap();
        assert_eq!(world(&homes).route_set.len(), 1, "an agreeing route is left alone");
    }

    #[tokio::test]
    async fn reconcile_archives_only_a_newly_observed_deletion() {
        let homes = homes();
        homes.open("gh").await.unwrap();
        world(&homes).presence.insert("gh".into(), Presence::Deleted);
        let known = ["sess_home_gh".to_string(), "sess_desktop_x".to_string()];
        homes.reconcile(&known).await.unwrap();
        assert!(world(&homes).archived.contains("sess_home_gh"));
        // Restored by hand while the definition is still gone: left alone.
        homes.restore("gh").await.unwrap();
        world(&homes).retired.insert("sess_home_gh".into());
        homes.reconcile(&known).await.unwrap();
        assert!(!world(&homes).archived.contains("sess_home_gh"));
        // An unknown presence proves nothing.
        world(&homes).presence.insert("gh".into(), Presence::Unknown);
        world(&homes).retired.clear();
        homes.reconcile(&known).await.unwrap();
        assert!(!world(&homes).archived.contains("sess_home_gh"));
    }
}
