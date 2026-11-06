//! `RoutineHost` over the process services: who may own or execute a routine
//! (`routine-owner.mjs` `routineOwnerProblem`, `routine-executor.mjs` `defaultProbe`) is decided
//! here from the agent definitions, and whether a thread is a heartbeat's from the process marks.
//! What only the session core can do — queueing a routine turn behind a thread's own work,
//! running a headless executor, queueing a result in the owner's thread — stays behind
//! `RoutineSessions`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::{AgentDefinitions, ContactIds};
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_services::bots::{
    AnnouncedRun, DeliveryItem, ExecutorFacts, ExecutorRun, HeartbeatSessions, OwnerProblem, RoutineHost, RoutineTurn, TurnSettle,
};
use tokio_util::sync::CancellationToken;

/// The agent-definition reads the routine rules ask.
#[async_trait]
pub trait RoutineAgents: Send + Sync {
    /// `readMixyExists(null, { ownsRoutine: stored })`.
    async fn mixy_exists(&self, stored: bool) -> Result<bool, String>;
    /// `agentDefinitionPresence([id])[id]`.
    async fn presence(&self, agent_id: &str) -> Result<Presence, String>;
    /// `Boolean(archivedAgentIdentities([id])[id])`.
    async fn archived(&self, agent_id: &str) -> Result<bool, String>;
    /// The fresh scan: a listed custom agent (never a built-in slot), a bot, a disabled one.
    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String>;
}

/// What only the session core can do for a routine.
#[async_trait]
pub trait RoutineSessions: Send + Sync {
    /// The thread exists and is not closed (`loadSession(id)` and `closed !== true`).
    async fn home_thread_open(&self, session_id: &str) -> Result<bool, String>;
    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle;
    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String>;
    async fn deliver_result(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String>;
    async fn announce_run(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> Result<(), String>;
}

/// `RoutineAgents` over the agent definitions.
pub struct DefinitionAgents {
    definitions: Arc<AgentDefinitions>,
    contacts: ContactIds,
}

impl DefinitionAgents {
    pub fn new(definitions: Arc<AgentDefinitions>) -> Self {
        Self { contacts: ContactIds::new(definitions.clone()), definitions }
    }
}

#[async_trait]
impl RoutineAgents for DefinitionAgents {
    async fn mixy_exists(&self, stored: bool) -> Result<bool, String> {
        if !stored {
            return self.definitions.mixy_exists().await.map_err(|error| format!("{error:?}"));
        }
        // A routine she owns is itself evidence of her: only `created: false` says no.
        let status = self.definitions.lead_status().await.map_err(|error| format!("{error:?}"))?;
        Ok(status.created != Some(false))
    }

    async fn presence(&self, agent_id: &str) -> Result<Presence, String> {
        let mut found = self.definitions.presence(&[agent_id.to_owned()]).await.map_err(|error| format!("{error:?}"))?;
        Ok(found.remove(agent_id).unwrap_or(Presence::Unknown))
    }

    async fn archived(&self, agent_id: &str) -> Result<bool, String> {
        Ok(self.definitions.archived_identity(agent_id).await.map_err(|error| format!("{error:?}"))?.is_some())
    }

    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String> {
        let rows = self.definitions.rows().await.map_err(|error| format!("{error:?}"))?;
        let Some(row) = rows.iter().find(|row| row.id == agent_id) else {
            return Ok(ExecutorFacts::default());
        };
        let listed = !row.fixed && row.definition.is_some();
        Ok(ExecutorFacts { listed, contact: listed && self.contacts.is_contact_bot(agent_id).await, disabled: row.disabled })
    }
}

pub struct SessionRoutineHost {
    agents: Arc<dyn RoutineAgents>,
    sessions: Arc<dyn RoutineSessions>,
    marks: Arc<HeartbeatSessions>,
}

impl SessionRoutineHost {
    pub fn new(agents: Arc<dyn RoutineAgents>, sessions: Arc<dyn RoutineSessions>, marks: Arc<HeartbeatSessions>) -> Arc<Self> {
        Arc::new(Self { agents, sessions, marks })
    }
}

#[async_trait]
impl RoutineHost for SessionRoutineHost {
    /// A routine Mixy owns is itself evidence of her, so only `created: false` pauses one; a new
    /// one needs her to exist. Only a proven deletion counts for a bot (archived: restorable).
    async fn owner_problem(&self, owner_agent_id: &str, stored: bool) -> Result<Option<OwnerProblem>, String> {
        if owner_agent_id == MIXY_AGENT_ID {
            return Ok((!self.agents.mixy_exists(stored).await?).then_some(OwnerProblem::NoMixy));
        }
        if self.agents.presence(owner_agent_id).await? != Presence::Deleted {
            return Ok(None);
        }
        Ok(Some(if self.agents.archived(owner_agent_id).await? { OwnerProblem::OwnerArchived } else { OwnerProblem::OwnerDeleted }))
    }

    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String> {
        self.agents.executor_facts(agent_id).await
    }

    async fn home_thread_open(&self, session_id: &str) -> Result<bool, String> {
        self.sessions.home_thread_open(session_id).await
    }

    fn is_heartbeat_session(&self, session_id: &str) -> bool {
        self.marks.is_marked(session_id)
    }

    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle {
        self.sessions.run_turn(turn, cancel).await
    }

    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String> {
        self.sessions.run_executor(run, cancel).await
    }

    async fn deliver_result(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String> {
        self.sessions.deliver_result(owner_agent_id, name, item).await
    }

    async fn announce_run(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> Result<(), String> {
        self.sessions.announce_run(owner_agent_id, name, run).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Agents {
        mixy: Mutex<Option<Result<bool, String>>>,
        asked_stored: Mutex<Vec<bool>>,
        presence: HashMap<&'static str, Presence>,
        archived: Vec<&'static str>,
    }

    #[async_trait]
    impl RoutineAgents for Agents {
        async fn mixy_exists(&self, stored: bool) -> Result<bool, String> {
            self.asked_stored.lock().unwrap().push(stored);
            self.mixy.lock().unwrap().clone().unwrap()
        }
        async fn presence(&self, id: &str) -> Result<Presence, String> {
            Ok(self.presence.get(id).copied().unwrap_or(Presence::Present))
        }
        async fn archived(&self, id: &str) -> Result<bool, String> {
            Ok(self.archived.contains(&id))
        }
        async fn executor_facts(&self, _id: &str) -> Result<ExecutorFacts, String> {
            Ok(ExecutorFacts { listed: true, contact: false, disabled: false })
        }
    }

    struct Sessions;

    #[async_trait]
    impl RoutineSessions for Sessions {
        async fn home_thread_open(&self, id: &str) -> Result<bool, String> {
            Ok(id == "sess_home_open")
        }
        async fn run_turn(&self, _turn: RoutineTurn, _cancel: CancellationToken) -> TurnSettle {
            TurnSettle::Done { result: "ok".into() }
        }
        async fn run_executor(&self, _run: ExecutorRun, _cancel: CancellationToken) -> Result<String, String> {
            Ok("report".into())
        }
        async fn deliver_result(&self, _owner: &str, _name: &str, _item: &DeliveryItem) -> Result<(), String> {
            Ok(())
        }
        async fn announce_run(&self, _owner: &str, _name: &str, _run: &AnnouncedRun) -> Result<(), String> {
            Ok(())
        }
    }

    fn host(agents: Agents) -> (Arc<SessionRoutineHost>, Arc<Agents>, Arc<HeartbeatSessions>) {
        let agents = Arc::new(agents);
        let marks = HeartbeatSessions::new();
        (SessionRoutineHost::new(agents.clone(), Arc::new(Sessions), marks.clone()), agents, marks)
    }

    #[tokio::test]
    async fn mixy_owns_a_routine_only_while_she_exists_and_a_stored_one_is_asked_as_such() {
        let (host, agents, _) = host(Agents::default());
        *agents.mixy.lock().unwrap() = Some(Ok(false));
        assert_eq!(host.owner_problem(MIXY_AGENT_ID, false).await, Ok(Some(OwnerProblem::NoMixy)));
        *agents.mixy.lock().unwrap() = Some(Ok(true));
        assert_eq!(host.owner_problem(MIXY_AGENT_ID, true).await, Ok(None));
        assert_eq!(*agents.asked_stored.lock().unwrap(), [false, true]);
        *agents.mixy.lock().unwrap() = Some(Err("unreadable".into()));
        assert_eq!(host.owner_problem(MIXY_AGENT_ID, true).await, Err("unreadable".into()), "a read fault never pauses anything");
    }

    #[tokio::test]
    async fn a_bot_pauses_its_routines_only_when_proven_deleted_and_archived_ones_wait_for_the_restore() {
        let presence = HashMap::from([("gone", Presence::Deleted), ("shelved", Presence::Deleted), ("odd", Presence::Unknown)]);
        let (host, ..) = host(Agents { presence, archived: vec!["shelved"], ..Agents::default() });
        assert_eq!(host.owner_problem("gone", true).await, Ok(Some(OwnerProblem::OwnerDeleted)));
        assert_eq!(host.owner_problem("shelved", true).await, Ok(Some(OwnerProblem::OwnerArchived)));
        assert_eq!(host.owner_problem("odd", true).await, Ok(None));
        assert_eq!(host.owner_problem("fine", true).await, Ok(None));
    }

    #[tokio::test]
    async fn a_thread_is_a_heartbeat_session_exactly_while_it_is_marked() {
        let (host, _, marks) = host(Agents::default());
        assert!(!host.is_heartbeat_session("sess_hb"));
        marks.mark("sess_hb");
        assert!(host.is_heartbeat_session("sess_hb"));
        marks.unmark("sess_hb");
        assert!(!host.is_heartbeat_session("sess_hb"));
        assert!(host.home_thread_open("sess_home_open").await.unwrap());
    }
}
